import path from 'node:path';
import { appendJournal, clip, extractFilePaths, readPayload, rootFor, runFormatter, shortId, stamp } from './lib/runtime.mjs';

function description(payload, root) {
  const tool = String(payload.tool_name || '');
  const input = payload.tool_input;
  const files = extractFilePaths(payload).map((file) => path.relative(root, file).split(path.sep).join('/'));
  if (files.length) return `${tool.toLowerCase()} ${files.join(', ')}`;
  const command = typeof input === 'object' ? input.command || input.cmd : input;
  if (typeof command === 'string') {
    const safe = /(?:api[_-]?key|password|secret|bearer\s+)/i.test(command) ? '[redacted]' : clip(command);
    return `${tool.toLowerCase()} "${safe}"`;
  }
  return tool ? `${tool.toLowerCase()}` : null;
}

let raw = '';
process.stdin.on('data', (chunk) => { raw += chunk; });
process.stdin.on('end', () => {
  try {
    const payload = readPayload(raw);
    const root = rootFor(payload.cwd);
    const line = description(payload, root);
    if (line) appendJournal(root, `- ${stamp()} [${shortId(payload)}] ${line}`);
    for (const file of extractFilePaths(payload).slice(0, 1)) runFormatter(file, root);
  } catch (error) {
    process.stderr.write(`codex post-tool-use skipped: ${error.message}\n`);
  }
});
