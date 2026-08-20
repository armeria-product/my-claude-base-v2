#!/usr/bin/env node
// PreToolUse hook (Bash|PowerShell): keep .claude/.fable-status user-owned.
// Scope enforcement deliberately does not live here. The workspace has no scope lock.

const { extractTargets, extractProtectionCandidates } = require('./lib/cmd-targets');
const { stamp, id8, projectRoot, appendLine } = require('./lib/journal-util');
const { normalizeRel } = require('./lib/path-util');
const { stripHeredocs } = require('./lib/parse-cmd');

const FABLE_STATUS_RE = /\.claude[\\/]+\.fable-status/i;
const WRITE_INDICATOR_RE =
  /(?:^|[\s;|&(])(?:\d?>>?|&>>?)|\btee\b|\bsed\s+-i|\b(?:mv|cp|rm|dd|truncate|ln|shred|mkdir|touch)\b|Out-File|Set-Content|Add-Content|New-Item|Copy-Item|Move-Item|Remove-Item|Rename-Item|Export-Csv|Export-Clixml|Tee-Object|Start-Transcript|writeFileSync|writeFile\b|appendFile|createWriteStream|\bopen\s*\([^)]*['"](?:w|a)|git\s+(?:checkout|restore)\b/i;
const NULL_REDIR_RE = /(?:\d?>>?|&>>?)\s*(?:\/dev\/null|NUL)\b/gi;
const DENY_REASON =
  '[fable-status] .claude/.fable-status は CLAUDE.md §1.11 のユーザー専用スイッチです。' +
  'Claude はシェル経由でも変更できません。Fable を使う場合はユーザー本人に編集を依頼してください。';

let data = '';
process.stdin.on('data', (chunk) => (data += chunk));
process.stdin.on('end', () => {
  try {
    main();
  } catch (err) {
    process.stderr.write(`block-fable-status-write: skipped (${err.message})\n`);
  }
  process.exit(0);
});

function deny(root, payload, command) {
  appendLine(
    root,
    `- ${stamp()} [${id8(payload)}] DENY ${payload.tool_name.toLowerCase()} (fable-status-protect) "${command.replace(/\s+/g, ' ').slice(0, 100)}"`
  );
  console.log(
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'deny',
        permissionDecisionReason: DENY_REASON,
      },
    })
  );
}

function isFableStatusFile(root, target) {
  const { rel, outside } = normalizeRel(root, target);
  return !outside && rel.toLowerCase() === '.claude/.fable-status';
}

function main() {
  const payload = JSON.parse(data || '{}');
  if (!['Bash', 'PowerShell'].includes(payload.tool_name)) return;
  const command = String(payload.tool_input?.command || '');
  if (!command) return;

  const root = projectRoot(payload);
  const cwd = payload.cwd || root;
  const noHeredoc = stripHeredocs(command);
  const hasWrite = WRITE_INDICATOR_RE.test(noHeredoc.replace(NULL_REDIR_RE, ' '));
  if (!hasWrite) return;

  if (FABLE_STATUS_RE.test(noHeredoc)) {
    deny(root, payload, command);
    return;
  }

  let targets = [];
  try {
    targets = [
      ...extractTargets(payload.tool_name, command, cwd).targets,
      ...extractProtectionCandidates(payload.tool_name, command, cwd),
    ];
  } catch (err) {
    process.stderr.write(`block-fable-status-write: target extraction failed (${err.message})\n`);
    return;
  }

  if (targets.some((target) => isFableStatusFile(root, target))) {
    deny(root, payload, command);
  }
}
