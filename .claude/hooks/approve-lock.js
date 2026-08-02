#!/usr/bin/env node
// UserPromptSubmit hook: the ONLY path that arms/disarms the scope lock.
//
// Why a hook: the lock must be armed by the USER's own words, mechanically. This hook is an
// OS process outside the model — permissions.deny keeps Claude's tools out of .claude/state/,
// and subagents/file contents can never emit a user prompt, so neither Claude nor observed
// content can flip the lock. (CLAUDE.md §7)
//
//   「承認」        (whole message; optional slug) -> transcribe the pending
//                   plans/{slug}/scope.json (status:"proposed") into .claude/state/scope-lock.json
//   「解除」        (whole message)                -> unlock
//   near-miss 承認 (e.g. 「承認、進めて」)         -> inject a "NOT armed" notice (no silent failure)
//   negated 承認   (承認しない / 承認の前に…)      -> inject nothing
//
// Output: UserPromptSubmit additionalContext JSON. Never blocks the prompt. Fail-open.

const fs = require('node:fs');
const path = require('node:path');
const { stamp, id8, projectRoot, appendLine } = require('./lib/journal-util');

// ARM: the entire message must be 承認 (+ optional slug + polite suffix + punctuation)
const APPROVE_RE =
  /^[\s　]*承認(?:[\s　]+(?<slug>[A-Za-z0-9][\w.-]*))?(?:します|する|です|だ)?[\s　]*[。．.!！]?[\s　]*$/;
// UNLOCK: whole-message 解除 / ロック解除
const UNLOCK_RE =
  /^[\s　]*(?:ロック)?解除(?:します|する|して(?:ください)?|です)?[\s　]*[。．.!！]?[\s　]*$/;
// Negated forms -> not an approval, and not worth a notice either
const NEGATED_RE =
  /承認(?:し(?:ない|ません|かねる)|でき(?:ない|ません)|は(?:まだ|しない)|の前|より前|待って|保留|やめ)/;

const STALE_MS = 7 * 24 * 60 * 60 * 1000;

let data = '';
process.stdin.on('data', (c) => (data += c));
process.stdin.on('end', () => {
  try {
    main();
  } catch (err) {
    process.stderr.write(`approve-lock: skipped (${err.message})\n`);
  }
  process.exit(0);
});

function inject(text) {
  console.log(
    JSON.stringify({
      hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: text },
    })
  );
}

function main() {
  const payload = JSON.parse(data || '{}');
  const prompt = String(payload.prompt || '');
  if (!prompt) return;

  const root = projectRoot(payload);
  const stateDir = path.join(root, '.claude', 'state');
  const lockPath = path.join(stateDir, 'scope-lock.json');

  if (UNLOCK_RE.test(prompt)) return unlock(root, lockPath, payload);

  const m = prompt.match(APPROVE_RE);
  if (m) return arm(root, stateDir, lockPath, payload, m.groups?.slug);

  // near-miss: mentions 承認 but neither armed nor negated -> tell the model the lock did NOT arm
  if (prompt.includes('承認') && !NEGATED_RE.test(prompt)) {
    inject(
      '[scope-lock] 承認らしき発言を検知しましたがロックは作動していません（作動条件はメッセージ全体が「承認」または「承認 {slug}」のみ）。ロックして自走を開始するつもりなら、その旨をユーザーに案内してください。'
    );
  }
}

function readLock(lockPath) {
  try {
    return JSON.parse(fs.readFileSync(lockPath, 'utf8'));
  } catch {
    return null;
  }
}

function unlock(root, lockPath, payload) {
  const lock = readLock(lockPath);
  if (!lock || lock.status !== 'locked') {
    inject('[scope-lock] 現在ロックはありません（解除操作は不要でした）。');
    return;
  }
  const history = (lock.history || []).concat([
    { slug: lock.slug, plan: lock.plan, approvedAt: lock.approvedAt, endedAt: new Date().toISOString(), endedBy: 'unlock' },
  ]).slice(-5);
  fs.writeFileSync(
    lockPath,
    JSON.stringify({ status: 'unlocked', unlockedAt: new Date().toISOString(), history }, null, 2)
  );
  appendLine(root, `- ${stamp()} [${id8(payload)}] UNLOCK (slug: ${lock.slug})`);
  inject(
    `[scope-lock] ロックを解除しました（slug: ${lock.slug}）。以後は通常モード（書き込み範囲の機械的制限なし）です。ユーザーに一言報告してください。`
  );
}

// Find scope.json proposals: plans/*/scope.json + dev/*/plans/*/scope.json (skip done/)
function findProposals(root) {
  const out = [];
  const tryDir = (plansDir, prefix) => {
    let entries;
    try {
      entries = fs.readdirSync(plansDir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (!e.isDirectory() || e.name === 'done') continue;
      const p = path.join(plansDir, e.name, 'scope.json');
      try {
        const scope = JSON.parse(fs.readFileSync(p, 'utf8'));
        out.push({ path: p, rel: `${prefix}${e.name}/scope.json`, dir: e.name, scope });
      } catch {
        /* no scope.json or unparsable -> skip */
      }
    }
  };
  tryDir(path.join(root, 'plans'), 'plans/');
  let devEntries;
  try {
    devEntries = fs.readdirSync(path.join(root, 'dev'), { withFileTypes: true });
  } catch {
    devEntries = [];
  }
  for (const d of devEntries) {
    if (!d.isDirectory()) continue;
    tryDir(path.join(root, 'dev', d.name, 'plans'), `dev/${d.name}/plans/`);
  }
  return out;
}

function arm(root, stateDir, lockPath, payload, namedSlug) {
  const all = findProposals(root);
  let proposed = all.filter((p) => p.scope.status === 'proposed');

  if (namedSlug) {
    proposed = proposed.filter((p) => (p.scope.slug || p.dir) === namedSlug);
    if (!proposed.length) {
      inject(
        `[scope-lock] slug "${namedSlug}" の承認待ち scope.json が見つかりません。ロックは作動していません。既存の提案: ${all.filter((p) => p.scope.status === 'proposed').map((p) => p.scope.slug || p.dir).join(', ') || 'なし'}`
      );
      return;
    }
  } else {
    const fresh = proposed.filter(
      (p) => !p.scope.proposedAt || Date.now() - Date.parse(p.scope.proposedAt) < STALE_MS
    );
    const stale = proposed.filter((p) => !fresh.includes(p));
    if (!fresh.length && stale.length) {
      inject(
        `[scope-lock] 承認待ちの scope.json は7日以上前の提案のみです（${stale.map((p) => p.scope.slug || p.dir).join(', ')}）。ロックは作動していません。意図的に使うなら「承認 {slug}」と slug 付きで指定してください。`
      );
      return;
    }
    proposed = fresh;
  }

  if (!proposed.length) {
    inject(
      '[scope-lock] 承認待ちの scope.json がありません。ロックは作動していません。/plan（または直前の計画）から plans/{slug}/scope.json（status:"proposed"）を書き出し、改めて「承認」を求めてください。'
    );
    return;
  }
  if (proposed.length > 1) {
    inject(
      `[scope-lock] 承認待ちの scope.json が複数あります: ${proposed.map((p) => p.scope.slug || p.dir).join(', ')}。ロックは作動していません。「承認 {slug}」と対象を指定するようユーザーに案内してください。`
    );
    return;
  }

  const target = proposed[0];
  const scope = target.scope;
  const slug = scope.slug || target.dir;
  const planRel = scope.plan || `${path.dirname(target.rel)}/PLAN.md`;
  // Normalize: trailing "/" -> "/**" at transcription time (the matcher does this too — belt and braces)
  const norm = (arr) => (Array.isArray(arr) ? arr.map((g) => String(g).replace(/\/+$/, '/**')) : []);
  const allow = norm(scope.allow);
  const forbid = norm(scope.forbid);

  const prev = readLock(lockPath);
  const history = (prev?.history || []).concat(
    prev && prev.status === 'locked'
      ? [{ slug: prev.slug, plan: prev.plan, approvedAt: prev.approvedAt, endedAt: new Date().toISOString(), endedBy: 'replaced' }]
      : []
  ).slice(-5);

  fs.mkdirSync(stateDir, { recursive: true });
  fs.writeFileSync(
    lockPath,
    JSON.stringify(
      { status: 'locked', slug, plan: planRel, allow, forbid, tasks: scope.tasks || [], approvedAt: new Date().toISOString(), history },
      null,
      2
    )
  );
  // Flip the proposal so it never re-matches a later scan
  try {
    fs.writeFileSync(target.path, JSON.stringify({ ...scope, status: 'approved', approvedAt: new Date().toISOString() }, null, 2));
  } catch {
    /* non-fatal */
  }

  appendLine(root, `- ${stamp()} [${id8(payload)}] LOCK ARMED (slug: ${slug}, allow: ${allow.length} patterns)`);

  const broad = allow.filter((g) => g === '**' || g === '*' || g === '**/*');
  const parts = [
    `[scope-lock] 🔒 ロックしました — slug: ${slug} / 計画: ${planRel}`,
    `allow(${allow.length}): ${allow.slice(0, 3).join(', ')}${allow.length > 3 ? ' …' : ''}${forbid.length ? ` / forbid(${forbid.length}): ${forbid.slice(0, 2).join(', ')}${forbid.length > 2 ? ' …' : ''}` : ''}`,
    '常時書き込み可: journal/ tasks/ tmp/ と計画フォルダ自身。範囲外への書き込みはフックが拒否し、その意図は plans/' + slug + '/deviations.md に記録して提案に回すこと（実装は再承認後）。',
    prev && prev.status === 'locked' ? `旧ロック（${prev.slug}）は置き換えました。` : null,
    broad.length ? `⚠ allow に過度に広いパターン（${broad.join(', ')}）が含まれます — ロックの意味が薄いことをユーザーに一言伝えてください。` : null,
    'ユーザーに1行で開始を報告し、計画（' + planRel + '）の Phase 1 から自走を開始してください。',
  ].filter(Boolean);
  inject(parts.join('\n'));
}
