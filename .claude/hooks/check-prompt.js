#!/usr/bin/env node
// UserPromptSubmit hook (merged, all non-blocking):
//   1. Vague request detection → inject a non-blocking hint (was: exit 2 BLOCK. It
//      misfired on requests like "変更して" and stalled the conversation, so it was
//      downgraded from gatekeeper to receptionist hint)
//   2. repo-state injection (branch / dirty count / latest commit) → always, one line
//   3. Build/change-intent keyword detection → inject a receptionist hint into additionalContext
//
// Input: Claude Code hook event JSON on stdin (prompt field)
// Output: JSON with additionalContext (vague-hint + repo-state + receptionist hint if needed) + exit 0
//         This hook never blocks user input (fail-open)

const { execSync } = require('node:child_process');

// === Vague detection ===
// Note: degree adverbs (ちょっと/もっと) are not indicators of vagueness, so they are excluded.
// 「変」 is also excluded: it partially matched 変更/変える/大変 etc. and misfired on clear requests like 「変更して」.
const VAGUE_WORDS = [
  '微妙', 'なんか', 'なんとか', 'いい感じ', '良い感じ', 'うまく',
  '適当', 'だめ', 'ダメ', 'しっくりこない',
];

const ACTION_WORDS = [
  'して', '直して', '変えて', '修正', '改善', 'お願い', 'ほしい', '欲しい',
];

// === Receptionist (plan-routing) detection ===
const GROUP_A = [
  { re: /作(りたい|って|成(し(たい|て)|する))/, tag: '作成' },
  { re: /(実装|構築|開発)(し(たい|て)|する)/, tag: '実装' },
  { re: /(追加|導入)(し(たい|て)|する)/, tag: '追加' },
  { re: /(機能|ツール|画面|ページ|ダッシュボード|API|エンドポイント|コマンド|フック|スクリプト|仕組み|ワークフロー)を/, tag: '機能名詞+を' },
];

const GROUP_B = [
  { re: /(作り)?変え(たい|て)|変更(し(たい|て)|する)/, tag: '変更' },
  { re: /リファクタ(リング)?(し(たい|て)|する)/, tag: 'リファクタ' },
];

const FEATURE_NOUN_ANY_RE = /(機能|ツール|画面|ページ|ダッシュボード|API|エンドポイント|コマンド|フック|スクリプト|仕組み|ワークフロー)/;
const ALREADY_PLAN_RE = /(\/plan\b|計画|リサーチ|調査|要件整理)/;

// Detect user corrections → lessons-logging hint (automates CLAUDE.md §4 "log immediately on correction")
// The false-positive cost is only a one-line hint, so restrict this to strong signals
const CORRECTION_RE =
  /(そうじゃなく|それじゃなく|間違って(る|いる|た)|やり直し|戻して|同じミス|前も言った|さっきも言った|また間違|勝手に(変え|消し|やら))/;
const TRIVIAL_RENAME_RE = /(変数名|関数名|ファイル名|型名|クラス名|プロパティ名|キー名)を\S{1,30}(に|へ)(変|リネーム)/;
const TYPO_FIX_RE = /(typo|タイポ|誤字|スペル)/i;

// === Shared: concrete anchors ===
const CONCRETE_ANCHORS = [
  /[\w\-./]+\.(ts|tsx|js|jsx|py|rs|go|java|rb|php|cs|cpp|c|h|md|json|yml|yaml|toml|sh|sql)\b/i,
  /[a-zA-Z_][\w./\\-]*[/\\][\w./\\-]+/,
  /:\d+/,
  /`[^`]+`/,
  /#\d+/,
  /https?:\/\/\S+/,
];

// Receptionist hint (compact version — the old 50-line one was a heavy context tax)
const RECEPTIONIST_HINT = `[receptionist-hint] Build/change intent detected ({matched}). Steps:
1. If specific enough and a trivial 1-2 file change → ignore this hint and implement directly
2. Otherwise → ask all 3 questions at once in a single AskUserQuestion:
   Q1 Nature: (a) new build (b) modification (c) cleanup/refactor (d) investigation only (e) independent review (f) high-stakes/irreversible decision needing multiple viewpoints
   Q2 Scope: (a) 1-2 files (b) 3+/cross-cutting (c) parallel scale (d) unknown
   Q3 Requirements: (a) clear (b) direction only (c) fuzzy
3. Routing (evaluate top-down): Q1=e→quality-loop (+security track if the target is risk-sensitive) / Q1=f→quality-loop (Fusion Composition) / Q1=c→code-cleaner / Q3=c→plan(light) /
   Q2=c→harness / Q2=b∧Q3∈{a,b}→plan(heavy) / Q1=d→normal investigation / all light→implement directly
4. Declare "Handing off to <X>. Reason: <one line>" and launch the Skill (at most 1 follow-up question)
Ignore this hint if the immediately preceding conversation already skipped it.`;

function repoState() {
  try {
    const opt = { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 3000 };
    const branch = execSync('git rev-parse --abbrev-ref HEAD', opt).trim();
    const dirty = execSync('git status --porcelain', opt).split('\n').filter(Boolean).length;
    const last = execSync('git log -1 "--format=%h %s"', opt).trim().slice(0, 60);
    return `[repo-state] branch=${branch} dirty=${dirty} last="${last}"`;
  } catch {
    return null; // outside git / git absent → silently skip (fail-open)
  }
}

let data = '';
process.stdin.on('data', (c) => (data += c));
process.stdin.on('end', () => {
  let prompt = '';
  try {
    const payload = JSON.parse(data);
    prompt = payload.prompt || '';
  } catch {
    process.exit(0);
  }

  if (!prompt) process.exit(0);

  const hasAnchors = CONCRETE_ANCHORS.some((re) => re.test(prompt));

  // === Step 1: Vague check → non-blocking hint (was: exit 2 BLOCK. It misfired on requests
  //     like 「変更して」 and stalled the conversation, so it was downgraded). Skip if anchors present ===
  let vagueHint = null;
  if (!hasAnchors) {
    const hitVague = VAGUE_WORDS.filter((w) => prompt.includes(w));
    const hitAction = ACTION_WORDS.filter((w) => prompt.includes(w));
    if (hitVague.length > 0 && hitAction.length > 0) {
      vagueHint =
        `[vague-hint] The request may be vague (detected: vague[${hitVague.join(', ')}] + action[${hitAction.join(', ')}]).` +
        ' If the target, the current problem, or the expected result is unclear, consider clarifying before implementing via plan mode or a single AskUserQuestion (CLAUDE.md §1.1).' +
        ' If the intent is clear enough, you may ignore this hint.';
    }
  }

  // === Step 2: assemble additionalContext (all non-blocking) ===
  const parts = [];

  if (vagueHint) parts.push(vagueHint);

  const state = repoState();
  if (state) parts.push(state);

  // Correction detection is independent of anchors (corrections tend to quote code)
  if (CORRECTION_RE.test(prompt)) {
    parts.push(
      '[lesson-hint] User correction detected. After handling it, consider recording it in lessons.md per CLAUDE.md §4 (quality gate: only codebase-specific or hard-won knowledge, in actionable rule form. Do not record Googleable items).'
    );
  }

  const IRREVERSIBLE_RE = /本番|\bproduction\b|\bmigration\b|データ移行|削除|\bdrop\b|破壊的|不可逆|ロールバック不可/i;
  const irreversibleMatches = (prompt.match(IRREVERSIBLE_RE) || []).filter((v, i, a) => a.indexOf(v) === i);
  if (irreversibleMatches.length > 0 && !hasAnchors) {
    parts.push(
      `[fusion-hint] 不可逆性の高い操作の可能性（検出: ${irreversibleMatches.join(', ')}）。判断が重い/多視点が要るなら quality-loop の Fusion Composition（多視点統合）の検討を（CLAUDE.md §1.5）。意図が明確なら無視可。`
    );
  }

  // Receptionist: trigger conditions are unchanged (suppressed by short text / slash / plan mention / trivial / anchors)
  const receptionistEligible =
    Buffer.byteLength(prompt, 'utf8') >= 15 &&
    !/^\s*\//.test(prompt) &&
    !ALREADY_PLAN_RE.test(prompt) &&
    !TRIVIAL_RENAME_RE.test(prompt) &&
    !TYPO_FIX_RE.test(prompt) &&
    !hasAnchors;

  if (receptionistEligible) {
    const hitA = GROUP_A.filter(({ re }) => re.test(prompt));
    const hitB = GROUP_B.filter(({ re }) => re.test(prompt));
    if (hitA.length > 0 || (hitB.length > 0 && FEATURE_NOUN_ANY_RE.test(prompt))) {
      const matched = [...hitA, ...hitB].map(({ tag }) => tag).join(', ');
      parts.push(RECEPTIONIST_HINT.replace('{matched}', matched));
    }
  }

  if (parts.length) {
    console.log(
      JSON.stringify({
        hookSpecificOutput: {
          hookEventName: 'UserPromptSubmit',
          additionalContext: parts.join('\n'),
        },
      })
    );
  }
  process.exit(0);
});
