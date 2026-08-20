import { appendJournal, buildContext, hookContext, readPayload, rootFor, shortId, stamp } from './lib/runtime.mjs';

let raw = '';
process.stdin.on('data', (chunk) => { raw += chunk; });
process.stdin.on('end', () => {
  try {
    const payload = readPayload(raw);
    const root = rootFor(payload.cwd);
    appendJournal(root, `- ${stamp()} [${shortId(payload)}] SESSION START (${payload.source || 'startup'})`);
    process.stdout.write(hookContext('SessionStart', buildContext(payload)));
  } catch (error) {
    process.stderr.write(`codex session-start skipped: ${error.message}\n`);
  }
});
