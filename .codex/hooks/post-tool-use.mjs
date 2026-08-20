import path from 'node:path';
import { appendMachineEvent, extractFilePaths, readPayload, rootFor, shortId, stamp } from './lib/runtime.mjs';

const EDIT_TOOLS = new Set(['apply_patch', 'Edit', 'Write', 'Move']);

function outcome(payload) {
  const response = payload.tool_response || payload.tool_result;
  const failed = payload.is_error === true
    || payload.isError === true
    || payload.tool_error === true
    || (response && typeof response === 'object' && (response.isError === true || response.success === false));
  return failed ? 'failed' : 'ok';
}

function editDescription(payload, root) {
  const tool = String(payload.tool_name || '');
  if (!EDIT_TOOLS.has(tool)) return null;
  const files = extractFilePaths(payload)
    .map((file) => path.relative(root, file).split(path.sep).join('/'))
    .filter(Boolean);
  if (!files.length) return null;
  return 'EDIT ' + tool + ' ' + files.join(', ') + ' (' + outcome(payload) + ')';
}

let raw = '';
process.stdin.on('data', (chunk) => { raw += chunk; });
process.stdin.on('end', () => {
  try {
    const payload = readPayload(raw);
    const root = rootFor(payload.cwd);
    const line = editDescription(payload, root);
    if (line) appendMachineEvent(root, '- ' + stamp() + ' [' + shortId(payload) + '] ' + line);
  } catch (error) {
    process.stderr.write('codex post-tool-use skipped: ' + error.message + '\n');
  }
});
