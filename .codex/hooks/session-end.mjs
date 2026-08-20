import { appendMachineEvent, clip, readPayload, rootFor, shortId, stamp } from './lib/runtime.mjs';

let raw = '';
process.stdin.on('data', (chunk) => { raw += chunk; });
process.stdin.on('end', () => {
  try {
    const payload = readPayload(raw);
    const reason = clip(payload.reason || 'other', 80);
    appendMachineEvent(rootFor(payload.cwd), '- ' + stamp() + ' [' + shortId(payload) + '] SESSION END (' + reason + ')');
  } catch (error) {
    process.stderr.write('codex session-end skipped: ' + error.message + '\n');
  }
});
