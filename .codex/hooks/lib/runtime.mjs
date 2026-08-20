import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

export const MAX_CONTEXT_BYTES = 10 * 1024;
export const CONTEXT_PREFIX_BUDGET = 512;
export const CONTEXT_BLOCK_BUDGETS = Object.freeze({
  sessionState: 2 * 1024,
  latestHumanReport: 3 * 1024,
  todo: 2 * 1024,
  codemap: 2 * 1024,
});
export const REPORT_CAP = CONTEXT_BLOCK_BUDGETS.latestHumanReport;

function byteLength(text) {
  return Buffer.byteLength(String(text || ''), 'utf8');
}

export function readPayload(text = '') {
  if (!text.trim()) return {};
  const parsed = JSON.parse(text);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('hook payload must be an object');
  return parsed;
}

export function rootFor(cwd = process.cwd()) {
  let cursor = path.resolve(cwd);
  for (;;) {
    if (fs.existsSync(path.join(cursor, '.codex', 'hooks.json')) && fs.existsSync(path.join(cursor, 'AGENTS.md')))
      return cursor;
    const parent = path.dirname(cursor);
    if (parent === cursor) break;
    cursor = parent;
  }
  try {
    return execFileSync('git', ['-C', cwd, 'rev-parse', '--show-toplevel'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    return path.resolve(cwd);
  }
}

export function taskDir(root, cwd = root) {
  const rel = path.relative(root, cwd).split(path.sep).join('/');
  const match = rel.match(/^dev\/([^/]+)(?:\/|$)/);
  return match ? path.join(root, 'dev', match[1], 'tasks') : path.join(root, 'tasks');
}

export function dateParts(date = new Date()) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return { year, month, day };
}

export function journalPath(root, date = new Date()) {
  const { year, month, day } = dateParts(date);
  return path.join(root, 'tasks', 'journal', year + '-' + month, day + '.md');
}

export function legacyJournalPath(root, date = new Date()) {
  const { year, month, day } = dateParts(date);
  return path.join(root, 'tasks', 'journal', String(year), month, day + '.md');
}

export function humanJournalPaths(root, date = new Date()) {
  return [journalPath(root, date), legacyJournalPath(root, date)];
}

export function machineJournalPath(root, date = new Date()) {
  const { year, month, day } = dateParts(date);
  return path.join(root, 'tasks', 'journal', '.machine', year + '-' + month, day + '.log');
}

export function isSafeWorkspacePath(root, target) {
  if (typeof root !== 'string' || !root || typeof target !== 'string' || !target) return false;
  const base = path.resolve(root);
  const resolved = path.resolve(target);
  const relative = path.relative(base, resolved);
  if (relative === '..' || relative.startsWith('..' + path.sep) || path.isAbsolute(relative)) return false;
  try {
    const stat = fs.lstatSync(base);
    if (!stat.isDirectory() || stat.isSymbolicLink()) return false;
  } catch {
    return false;
  }
  let current = base;
  for (const part of relative ? relative.split(path.sep) : []) {
    current = path.join(current, part);
    try {
      if (fs.lstatSync(current).isSymbolicLink()) return false;
    } catch (error) {
      if (error?.code === 'ENOENT') return true;
      return false;
    }
  }
  return true;
}

function pathHasSymlink(boundary, target) {
  return !isSafeWorkspacePath(boundary, target);
}

function appendLine(target, line) {
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.appendFileSync(target, String(line || '').replace(/[\u0000-\u001f\u007f-\u009f]+/g, ' ').replace(/\s+/g, ' ').trim() + '\n', 'utf8');
}

export function appendMachineEvent(root, line, date = new Date()) {
  const target = machineJournalPath(root, date);
  if (pathHasSymlink(root, target)) return false;
  appendLine(target, line);
  return true;
}

export function stamp(date = new Date()) {
  return [date.getHours(), date.getMinutes(), date.getSeconds()].map((value) => String(value).padStart(2, '0')).join(':');
}

export function shortId(payload) {
  return String(payload.session_id || payload.turn_id || 'unknown').replace(/[^a-zA-Z0-9-]/g, '').slice(0, 8) || 'unknown';
}

export function clip(text, limit = 120) {
  const value = String(text || '').replace(/\s+/g, ' ').trim();
  return value.length > limit ? value.slice(0, Math.max(0, limit - 1)) + '…' : value;
}

export function readOptional(file, boundary = null) {
  try {
    if (boundary && pathHasSymlink(boundary, file)) return null;
    return fs.readFileSync(file, 'utf8');
  } catch {
    return null;
  }
}

export function trimUtf8(text, limit, fromTail = false) {
  const buffer = Buffer.from(String(text || ''), 'utf8');
  if (buffer.length <= limit) return String(text || '');
  const slice = fromTail ? buffer.subarray(Math.max(0, buffer.length - limit)) : buffer.subarray(0, limit);
  return slice.toString('utf8').replace(fromTail ? /^�+/ : /�+$/, '');
}

function latestHumanSection(text) {
  if (text == null) return null;
  const normalized = String(text).replace(/\r\n?/g, '\n');
  const matches = [...normalized.matchAll(/^## \d\d:\d\d [^\n]*$/gm)];
  if (!matches.length) return null;
  return normalized.slice(matches.at(-1).index);
}

export function latestReport(root, date = new Date()) {
  for (const offset of [0, 1]) {
    const candidate = new Date(date.getTime() - offset * 24 * 60 * 60 * 1000);
    for (const file of humanJournalPaths(root, candidate)) {
      const report = latestHumanSection(readOptional(file, root));
      if (report != null) return trimUtf8(report, REPORT_CAP);
    }
  }
  return null;
}

export function todoPointer(tasks, boundary = path.dirname(tasks)) {
  const text = readOptional(path.join(tasks, 'todo.md'), boundary);
  if (text == null) return null;
  const lines = text.replace(/\r\n?/g, '\n').split('\n');
  const now = lines.findIndex((line) => /^##\s+Now(?:\s|$)/i.test(line));
  if (now < 0) return text;
  const title = lines.find((line) => /^#(?!#)\s+/.test(line));
  const output = title ? [title] : [];
  for (let index = now; index < lines.length; index += 1) {
    if (index > now && /^##\s+/.test(lines[index])) break;
    output.push(lines[index]);
  }
  return output.join('\n');
}

export function codemapPointer(tasks, root) {
  const file = path.join(tasks, 'codemap.md');
  const text = readOptional(file, root);
  if (text == null) return null;
  const headings = text.replace(/\r\n?/g, '\n').split('\n').filter((line) => /^##\s+/.test(line)).join('\n');
  const rel = path.relative(root, file).split(path.sep).join('/');
  return rel + '\n' + trimUtf8(headings, CONTEXT_BLOCK_BUDGETS.codemap) + '\n構造を調べ直す前にこの地図を読む。';
}

function boundedBlock(label, text, budget) {
  if (text == null || !String(text).trim()) return null;
  const header = '=== ' + label + ' ===\n';
  return header + trimUtf8(text, Math.max(0, budget - byteLength(header)));
}

export function buildContext(payload, now = new Date()) {
  const root = rootFor(payload.cwd);
  const tasks = taskDir(root, payload.cwd || root);
  const prefix = trimUtf8('このセッションの journal ID: [' + shortId(payload) + ']。保存レポートの既存IDがある場合だけ SAVE マーカーに使うこと。', CONTEXT_PREFIX_BUDGET);
  const blocks = [
    boundedBlock('SESSION STATE', readOptional(path.join(tasks, 'session-state.md'), root), CONTEXT_BLOCK_BUDGETS.sessionState),
    boundedBlock('LATEST HUMAN REPORT', latestReport(root, now), CONTEXT_BLOCK_BUDGETS.latestHumanReport),
    boundedBlock('TODO', todoPointer(tasks, root), CONTEXT_BLOCK_BUDGETS.todo),
    boundedBlock('CODEMAP', codemapPointer(tasks, root), CONTEXT_BLOCK_BUDGETS.codemap),
  ].filter(Boolean);
  return trimUtf8([prefix, ...blocks].join('\n\n'), MAX_CONTEXT_BYTES);
}

export function hookContext(eventName, context) {
  return JSON.stringify({
    hookSpecificOutput: { hookEventName: eventName, additionalContext: context },
  });
}

function patchInput(input, depth = 0) {
  if (typeof input === 'string') return input;
  if (!input || typeof input !== 'object' || Array.isArray(input)) return null;
  const hasPatch = Object.hasOwn(input, 'patch');
  const hasInput = Object.hasOwn(input, 'input');
  if (hasPatch && hasInput) {
    if (typeof input.patch !== 'string' || typeof input.input !== 'string' || input.patch !== input.input) return null;
    return input.patch;
  }
  if (hasPatch && typeof input.patch === 'string') return input.patch;
  if (
    hasInput
    && depth < 2
    && input.input
    && typeof input.input === 'object'
    && !Array.isArray(input.input)
    && Object.keys(input).length === 1
  ) return patchInput(input.input, depth + 1);
  return hasInput && typeof input.input === 'string' ? input.input : null;
}

export function extractFilePaths(payload) {
  const input = payload.tool_input;
  const found = new Set();
  const add = (value) => {
    if (typeof value === 'string' && value.trim()) found.add(path.resolve(payload.cwd || process.cwd(), value.trim()));
  };

  const addAll = (value) => {
    if (Array.isArray(value)) {
      for (const entry of value) add(entry);
      return;
    }
    add(value);
  };

  const tool = String(payload.tool_name || '');
  if (tool === 'apply_patch') {
    const patch = patchInput(input);
    if (patch != null) {
      for (const match of patch.matchAll(/^\*\*\* (?:Add|Update|Delete) File: (.+)$/gm)) add(match[1]);
    }
    return [...found];
  }

  if (tool === 'Move' && input && typeof input === 'object' && !Array.isArray(input)) {
    for (const key of [
      'to', 'destination', 'destination_path', 'destinationPath', 'target', 'target_path', 'targetPath',
      'new_path', 'newPath', 'output_path', 'outputPath', 'write_path', 'writePath',
      'to_path', 'toPath', 'to_paths', 'toPaths', 'destinations', 'destination_paths', 'destinationPaths',
      'target_paths', 'targetPaths',
    ]) addAll(input[key]);
    return [...found];
  }

  if (!['Edit', 'Write'].includes(tool) || !input || typeof input !== 'object' || Array.isArray(input))
    return [];
  for (const key of ['file_path', 'filePath', 'path', 'target_path', 'notebook_path']) add(input[key]);
  if (Array.isArray(input.paths)) {
    for (const value of input.paths) add(value);
  }
  return [...found];
}
