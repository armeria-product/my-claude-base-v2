#!/usr/bin/env node
// PreToolUse hook (Bash|PowerShell): command-pathway counterpart of scope-guard.js.
//
// Two duties:
//   1. UNCONDITIONAL (lock state irrelevant): deny any command that writes into .claude/state —
//      the lock file must not be writable via the shell. Two arms:
//        Arm A: lexical (STATE_RE against the raw command text) — cheap, can't throw, runs
//          before extraction and still catches forms extraction can't resolve (e.g. an mv/rm
//          whose target text mentions .claude/state). Over-detects by design: it fires on ANY
//          command whose text contains contiguous ".claude/state" plus a write-indicator
//          character, even a `git commit -m "..."` whose message merely mentions the path, or a
//          `ls .claude/state/ 2>&1` diagnostic. This is an intentional throw-safe tradeoff (Arm A
//          runs on raw text before any parsing that could fail) — split the state-mentioning text
//          into its own command, or pipe/redirect to avoid tripping WRITE_INDICATOR_RE, to route
//          around a false positive.
//        Arm B: resolved-absolute-path check (isStateDir) against each extracted write target,
//          after cd-tracking/redirect-target resolution — catches indirect routes (e.g.
//          `cd .claude && echo x > state/f`) Arm A's raw-text regex can't see. In addition to the
//          precise extractTargets() list, Arm B also checks lib/cmd-targets.js's deliberately
//          over-detecting extractStateCandidates() — `pushd`, a subshell-entry `(cd`, and
//          PowerShell Set-Location/sl/pushd into .claude are tracked liberally (no
//          subshell/pipeline scoping) SPECIFICALLY for this check, because for state protection a
//          false DENY is cheap (split the command) while a false ALLOW is a tamper — the opposite
//          of Duty 2's precision requirement, so this tracking is intentionally NOT shared with
//          extractTargets()/Duty 2.
//      A command whose only redirect targets /dev/null or NUL (e.g. `cat f 2>/dev/null`) is not
//      treated as a write for either arm — NULL_REDIR_RE neutralizes it before the write-
//      indicator test, so a null-redirected read never extraction-costs or Arm-A-false-trips.
//   2. While locked: extract write targets (lib/cmd-targets: bash tokens via lib/parse-cmd,
//      PowerShell cmdlets via exact-name regex) and run them through the shared decision
//      chain. A write whose target cannot be resolved (e.g. a $variable path, or inline
//      node/python code with a write API but no path literal) is denied fail-closed with
//      "use the Write tool or an explicit path". Extraction runs in an isolated try/catch so a
//      thrown exception can't silently disarm Arm B/Duty 2 — it sets unresolved=true instead,
//      which the existing fail-closed-while-locked policy already handles. Known gap (LOW, not a
//      regression — Arm B is new and no throwing input is known): if extraction itself throws
//      AND the session is unlocked, Duty 2 returns early before its fail-closed unresolved check
//      runs, so Arm B's extra liberal candidates are skipped for that one command too.
//
// cd tracking (bash path only, lib/cmd-targets.js extractTargets): NOT tracked — subshells `( )`,
// a cd inside one pipeline stage (separate process), pushd/popd, variable-expanded cd targets.
// The PowerShell path does no cd tracking at all — its targets resolve against payload.cwd only.
// This precise/limited model is intentional for Duty 2 (over-detecting there falsely denies
// legitimate writes). The state check (Arm B) additionally consults extractStateCandidates(),
// which DOES track pushd/subshell-cd/Set-Location — see lib/cmd-targets.js header for the
// over-detection rationale specific to that check.
//
// This parser is a tripwire, not a wall: script files on disk, package managers, and
// obfuscated commands can slip through. The after-the-fact backstop is the git-status
// conformance check (/save-session) and the reviewer's Scope Conformance lens.
// Read-only commands (no write indicator) are never touched.

const { extractTargets, extractStateCandidates } = require('./lib/cmd-targets');
const { stamp, id8, projectRoot, appendLine } = require('./lib/journal-util');
const { readLock, decide, denyReason } = require('./lib/scope-decision');
const { normalizeRel } = require('./lib/scope-match');

const STATE_RE = /\.claude[\\/]+state/i;
const WRITE_INDICATOR_RE =
  /(?:^|[\s;|&(])(?:\d?>>?|&>>?)|\btee\b|\bsed\s+-i|\b(?:mv|cp|rm|dd|truncate|ln|shred)\b|Out-File|Set-Content|Add-Content|New-Item|Copy-Item|Move-Item|Remove-Item|Rename-Item|Export-Csv|Export-Clixml|Tee-Object|Start-Transcript|writeFileSync|writeFile\b|appendFile|createWriteStream|\bopen\s*\([^)]*['"](?:w|a)|git\s+(?:checkout|restore)\b/i;
const NULL_REDIR_RE = /(?:\d?>>?|&>>?)\s*(?:\/dev\/null|NUL)\b/gi;

let data = '';
process.stdin.on('data', (c) => (data += c));
process.stdin.on('end', () => {
  try {
    main();
  } catch (err) {
    process.stderr.write(`cmd-write-guard: skipped (${err.message})\n`);
  }
  process.exit(0);
});

function deny(reason) {
  console.log(
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'deny',
        permissionDecisionReason: reason,
      },
    })
  );
}

const STATE_PROTECT_REASON =
  '[scope-lock] .claude/state/ はフック専用の状態置き場で、シェル経由の書き込み・移動・復元は常に禁止です（ロックの改ざん耐性の根幹）。' +
  '読み取り（cat 等）は自由です。このコマンドが state を書く意図でないなら、state に触れる部分と書き込み操作を別コマンドに分けて実行してください。';

function denyStateProtect(root, payload, command) {
  appendLine(root, `- ${stamp()} [${id8(payload)}] DENY ${payload.tool_name.toLowerCase()} (state-protect) "${command.replace(/\s+/g, ' ').slice(0, 100)}"`);
  deny(STATE_PROTECT_REASON);
}

// isStateDir: is the resolved absolute path t inside <root>/.claude/state ?
function isStateDir(root, t) {
  const { rel, outside } = normalizeRel(root, t);
  if (outside) return false;
  const r = rel.toLowerCase();
  return r === '.claude/state' || r.startsWith('.claude/state/');
}

function main() {
  const payload = JSON.parse(data || '{}');
  if (!['Bash', 'PowerShell'].includes(payload.tool_name)) return;
  const command = String(payload.tool_input?.command || '');
  if (!command) return;

  const root = projectRoot(payload);
  const cwd = payload.cwd || root;

  const cmdForIndicator = command.replace(NULL_REDIR_RE, ' ');
  const hasWrite = WRITE_INDICATOR_RE.test(cmdForIndicator);

  // --- Arm A: lexical, unconditional -----------------------------------------------------
  if (hasWrite && STATE_RE.test(command)) {
    denyStateProtect(root, payload, command);
    return;
  }

  if (!hasWrite) return; // read-only commands stop here — extraction never runs

  // --- extraction isolated: a thrown exception must not disarm Arm B / Duty 2 -------------
  let targets = [];
  let unresolved = false;
  let stateCandidates = [];
  try {
    ({ targets, unresolved } = extractTargets(payload.tool_name, command, cwd));
    stateCandidates = extractStateCandidates(payload.tool_name, command, cwd);
  } catch (e) {
    process.stderr.write(`cmd-write-guard: target extraction failed (${e.message})\n`);
    unresolved = true; // while locked, the existing unresolved policy fails closed
  }

  // --- Arm B: resolved-path state check, unconditional (lock state irrelevant) ------------
  for (const t of [...targets, ...stateCandidates]) {
    if (isStateDir(root, t)) {
      denyStateProtect(root, payload, command);
      return;
    }
  }

  // --- Duty 2: scope enforcement while locked ----------------------------------------------
  const lock = readLock(root);
  if (!lock || lock.status !== 'locked') return;

  for (const t of targets) {
    const verdict = decide(root, lock, t);
    if (verdict) {
      appendLine(
        root,
        `- ${stamp()} [${id8(payload)}] DENY ${payload.tool_name.toLowerCase()} ${verdict.rel} (scope: ${lock.slug}, ${verdict.why}) cmd="${command.replace(/\s+/g, ' ').slice(0, 80)}"`
      );
      deny(denyReason(verdict, lock));
      return;
    }
  }

  if (unresolved) {
    appendLine(
      root,
      `- ${stamp()} [${id8(payload)}] DENY ${payload.tool_name.toLowerCase()} (unresolved-target) cmd="${command.replace(/\s+/g, ' ').slice(0, 80)}"`
    );
    deny(
      `[scope-lock] ロック中（slug: ${lock.slug}）は、書き込み先を機械判定できないコマンド（変数宛て・パス文字列の無いインラインコード等）は実行できません。` +
        'Edit/Write ツールを使うか、書き込み先パスをコマンド内に明示してください。'
    );
  }
}
