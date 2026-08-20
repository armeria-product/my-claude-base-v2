// Shared decision chain for the scope lock (used by scope-guard.js and cmd-write-guard.js).
// Decision order (first hit wins):
//   implicit forbid (the enforcement chain itself) -> lock.forbid -> always-allow -> lock.allow -> deny
// Rationale: while locked, the guards/settings/validator must not be editable (a lock you can
// edit is not a lock), and the record layer must stay writable (autonomy needs its journal).

const fs = require('node:fs');
const path = require('node:path');
const { matches, normalizeRel } = require('./scope-match');

// The lock's own enforcement chain — implicitly forbidden while locked, allow cannot override.
// Consequence (stated in CLAUDE.md §7 / README): a plan whose target IS the harness runs unlocked.
const IMPLICIT_FORBID = [
  '.claude/settings.json',
  '.claude/settings.local.json',
  '.claude/hooks/**',
  '.claude/scripts/validate.mjs',
  '.claude/state/**',
];

function alwaysAllow(lock) {
  // tasks/** covers the journal too (tasks/journal/**) and the session-state history
  const list = ['tasks/**', 'dev/*/tasks/**', 'tmp/**', 'dev/*/tmp/**'];
  const plan = String(lock.plan || '').replace(/\\/g, '/');
  const planDir = plan.includes('/') ? plan.replace(/\/[^/]*$/, '') : '';
  // scope.json (the allowlist itself) is deliberately excluded: a lock whose own approved
  // allowlist can be rewritten while armed is not a lock. Only the deviation log and the plan
  // body stay writable — PLAN.md is kept because post-implementation result notes need it
  // (user ruling Q3, plans/2026-08-06-backlog-sweep/PLAN.md §7).
  if (planDir) {
    list.push(planDir + '/deviations.md');
    list.push(planDir + '/PLAN.md');
  }
  return list;
}

function readLock(root) {
  try {
    return JSON.parse(fs.readFileSync(path.join(root, '.claude', 'state', 'scope-lock.json'), 'utf8'));
  } catch {
    return null;
  }
}

// null = allowed; otherwise { rel, why: 'outside-project'|'enforcement-chain'|'forbid'|'not-in-allow' }
function decide(root, lock, p) {
  const { rel, outside, abs } = normalizeRel(root, p);
  if (outside) {
    // Session scratchpads and OS temp live outside the repo and stay writable
    if (/[\\/](tmp|temp)[\\/]/i.test(abs)) return null;
    return { rel: abs.split(path.sep).join('/'), why: 'outside-project' };
  }
  if (matches(rel, IMPLICIT_FORBID)) return { rel, why: 'enforcement-chain' };
  if (matches(rel, lock.forbid || [])) return { rel, why: 'forbid' };
  if (matches(rel, alwaysAllow(lock))) return null;
  if (matches(rel, lock.allow || [])) return null;
  return { rel, why: 'not-in-allow' };
}

function denyReason(verdict, lock) {
  if (verdict.why === 'enforcement-chain') {
    return (
      `[scope-lock] ${verdict.rel} はロックの施錠装置そのもの（settings / hooks / validate）のため、ロック中は変更できません。` +
      'ハーネス自身の改修が必要なら、ユーザーに「解除」を依頼してロックを外した上で通常フローで行ってください。回避や再試行はしないこと。'
    );
  }
  return (
    `[scope-lock] ${verdict.rel} は承認済み計画 '${lock.slug}' の範囲外です（${verdict.why}）。回避や再試行をしないこと。` +
    `この変更意図を plans/${lock.slug}/deviations.md に1行追記し（この拒否自体は journal に記録済み）、範囲内の残タスクを続行してください。` +
    '範囲外の作業は /save-session が提案として報告し、実装はユーザーの再承認後です。' +
    'サブエージェントとして動作中の場合は、最終報告にこの拒否を必ず含めてください。'
  );
}

module.exports = { IMPLICIT_FORBID, alwaysAllow, readLock, decide, denyReason };
