import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

export const CONTEXT_CAP = 24 * 1024;
export const REPORT_CAP = 4 * 1024;

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
  return path.join(root, 'tasks', 'journal', String(year), month, `${day}.md`);
}

export function appendJournal(root, line, date = new Date()) {
  const target = journalPath(root, date);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.appendFileSync(target, `${line}\n`, 'utf8');
}

export function stamp(date = new Date()) {
  return [date.getHours(), date.getMinutes(), date.getSeconds()].map((value) => String(value).padStart(2, '0')).join(':');
}

export function shortId(payload) {
  return String(payload.session_id || payload.turn_id || 'unknown').replace(/[^a-zA-Z0-9-]/g, '').slice(0, 8) || 'unknown';
}

export function clip(text, limit = 120) {
  const value = String(text || '').replace(/\s+/g, ' ').trim();
  return value.length > limit ? `${value.slice(0, Math.max(0, limit - 1))}…` : value;
}

export function readOptional(file) {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch {
    return null;
  }
}

export function trimUtf8(text, limit, fromTail = false) {
  const buffer = Buffer.from(text, 'utf8');
  if (buffer.length <= limit) return text;
  const slice = fromTail ? buffer.subarray(Math.max(0, buffer.length - limit)) : buffer.subarray(0, limit);
  return slice.toString('utf8').replace(fromTail ? /^�+/ : /�+$/, '');
}

export function latestReport(root, date = new Date()) {
  for (const offset of [0, 1]) {
    const candidate = new Date(date.getTime() - offset * 24 * 60 * 60 * 1000);
    const text = readOptional(journalPath(root, candidate));
    if (!text) continue;
    const matches = [...text.matchAll(/^## \d\d:\d\d .*$/gm)];
    const view = matches.length ? text.slice(matches.at(-1).index) : text;
    return trimUtf8(view, REPORT_CAP, true);
  }
  return null;
}

export function codemapPointer(tasks, root) {
  const file = path.join(tasks, 'codemap.md');
  const text = readOptional(file);
  if (text == null) return null;
  const headings = text.split(/\r?\n/).filter((line) => /^##\s+/.test(line)).join('\n');
  const rel = path.relative(root, file).split(path.sep).join('/');
  return `${rel}\n${trimUtf8(headings, 2 * 1024)}\n構造を調べ直す前にこの地図を読む。`;
}

export function buildContext(payload, now = new Date()) {
  const root = rootFor(payload.cwd);
  const tasks = taskDir(root, payload.cwd || root);
  const blocks = [
    ['SESSION STATE', readOptional(path.join(tasks, 'session-state.md'))],
    ['TODO', readOptional(path.join(tasks, 'todo.md'))],
    ['LATEST JOURNAL REPORT', latestReport(root, now)],
    ['LESSONS', readOptional(path.join(tasks, 'lessons.md'))],
  ];
  const prefix = `このセッションの journal ID: [${shortId(payload)}]。保存レポートの既存IDがある場合だけ SAVE マーカーに使うこと。`;
  const output = [prefix];
  for (const [label, text] of blocks) {
    if (text != null) output.push(`=== ${label} ===\n${text}`);
  }
  const map = codemapPointer(tasks, root);
  if (map) output.push(`=== CODEMAP ===\n${map}`);
  return trimUtf8(output.join('\n\n'), CONTEXT_CAP);
}

export function hookContext(eventName, context) {
  return JSON.stringify({
    hookSpecificOutput: { hookEventName: eventName, additionalContext: context },
  });
}

export function extractFilePaths(payload) {
  const input = payload.tool_input;
  const found = new Set();
  const add = (value) => {
    if (typeof value === 'string' && value.trim()) found.add(path.resolve(payload.cwd || process.cwd(), value.trim()));
  };
  if (input && typeof input === 'object' && !Array.isArray(input)) {
    for (const key of ['file_path', 'filePath', 'path', 'target_path', 'notebook_path']) add(input[key]);
    for (const value of input.paths || []) add(value);
  }
  const patch = typeof input === 'string' ? input : input?.patch || input?.input || input?.content || input?.command;
  if (typeof patch === 'string') {
    for (const match of patch.matchAll(/^\*\*\* (?:Add|Update|Delete) File: (.+)$/gm)) add(match[1]);
  }
  return [...found];
}

export function runFormatter(file, root) {
  const absolute = path.resolve(file);
  if (!fs.existsSync(absolute) || !fs.statSync(absolute).isFile()) return false;
  const rel = path.relative(root, absolute).split(path.sep).join('/');
  const match = rel.match(/^dev\/([^/]+)\//);
  if (!match) return false;
  const product = path.join(root, 'dev', match[1]);
  const has = (...names) => names.some((name) => fs.existsSync(path.join(product, name)));
  const ext = path.extname(absolute).toLowerCase();
  const run = (command, args) => spawnSync(command, args, { cwd: product, stdio: 'ignore', timeout: 15_000 }).status === 0;
  const packageText = readOptional(path.join(product, 'package.json')) || '';
  const prettier = /"prettier"\s*:/.test(packageText) || has('.prettierrc', '.prettierrc.json', '.prettierrc.js', '.prettierrc.cjs', 'prettier.config.js', 'prettier.config.cjs');
  if (/\.(js|jsx|ts|tsx|mjs|cjs|css|scss|less|json|md|html|vue|ya?ml)$/i.test(absolute) && prettier)
    return run('npx', ['--no-install', 'prettier', '--write', absolute]);
  const pyproject = readOptional(path.join(product, 'pyproject.toml')) || '';
  if (ext === '.py' && (has('ruff.toml', '.ruff.toml') || pyproject.includes('[tool.ruff]'))) return run('ruff', ['format', absolute]);
  if (ext === '.py' && pyproject.includes('[tool.black]')) return run('black', ['-q', absolute]);
  if (ext === '.rs' && has('rustfmt.toml', '.rustfmt.toml')) return run('rustfmt', [absolute]);
  if (ext === '.go' && has('go.mod')) return run('gofmt', ['-w', absolute]);
  return false;
}
