#!/usr/bin/env node
// PreToolUse hook (Edit|Write|NotebookEdit): while the scope lock is armed, deny writes
// outside the approved allow-globs. The mechanical core of "承認後は自走、ただし承認した範囲だけ".
//
//   - No lock / not locked -> exit 0 immediately (casual sessions cost one failed read)
//   - Locked -> decision chain in lib/scope-decision.js
//   - Deny  -> JSON permissionDecision:"deny" with a reason the model can act on,
//              and THIS hook writes the journal DENY line (PostToolUse never fires for
//              denied calls, so journal.js cannot record it)
//
// Fail-open on unexpected errors: enforcement must not break normal work; the git-status
// conformance check in /save-session and the reviewer's Scope Conformance lens are the backstop.

const { stamp, id8, projectRoot, appendLine } = require('./lib/journal-util');
const { readLock, decide, denyReason } = require('./lib/scope-decision');

let data = '';
process.stdin.on('data', (c) => (data += c));
process.stdin.on('end', () => {
  try {
    main();
  } catch (err) {
    process.stderr.write(`scope-guard: skipped (${err.message})\n`);
  }
  process.exit(0);
});

function main() {
  const payload = JSON.parse(data || '{}');
  if (!['Edit', 'Write', 'NotebookEdit'].includes(payload.tool_name)) return;

  const root = projectRoot(payload);
  const lock = readLock(root);
  if (!lock || lock.status !== 'locked') return;

  const p = payload.tool_input?.file_path || payload.tool_input?.notebook_path;
  if (!p) return;

  const verdict = decide(root, lock, p);
  if (!verdict) return;

  const via = payload.agent_type ? ` (via ${payload.agent_type})` : '';
  appendLine(
    root,
    `- ${stamp()} [${id8(payload)}] DENY ${payload.tool_name.toLowerCase()} ${verdict.rel} (scope: ${lock.slug}, ${verdict.why})${via}`
  );

  console.log(
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'deny',
        permissionDecisionReason: denyReason(verdict, lock),
      },
    })
  );
}
