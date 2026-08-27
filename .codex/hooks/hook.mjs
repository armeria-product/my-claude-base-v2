import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const WORKSPACE_ROOT = path.resolve(import.meta.dirname, '..', '..');
export const MAX_CONTEXT_BYTES = 8 * 1024;

const EDIT_TOOLS = new Set(['apply_patch', 'Edit', 'Write']);
const PROTECTED_BRANCH = /^(?:main|master|trunk)$/i;
const GIT_MUTATIONS = new Set([
  'add', 'am', 'apply', 'branch', 'checkout', 'cherry-pick', 'clean', 'commit', 'config',
  'merge', 'mv', 'pull', 'push', 'rebase', 'reset', 'restore', 'revert', 'rm', 'stash',
  'submodule', 'switch', 'tag', 'update-index', 'update-ref', 'worktree',
]);

export function readPayload(text = '') {
  const value = JSON.parse(text || '{}');
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('hook payload must be a JSON object');
  }
  return value;
}

function posix(value) {
  return String(value).split(path.sep).join('/');
}

function inside(root, target) {
  const relative = path.relative(path.resolve(root), path.resolve(target));
  return relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative);
}

export function safeWorkspacePath(root, target) {
  const base = path.resolve(root);
  const resolved = path.resolve(target);
  if (!inside(base, resolved)) return false;
  let cursor = base;
  try {
    const stat = fs.lstatSync(cursor);
    if (!stat.isDirectory() || stat.isSymbolicLink()) return false;
  } catch {
    return false;
  }
  const relative = path.relative(base, resolved);
  for (const part of relative ? relative.split(path.sep) : []) {
    cursor = path.join(cursor, part);
    try {
      if (fs.lstatSync(cursor).isSymbolicLink()) return false;
    } catch (error) {
      if (error?.code === 'ENOENT') break;
      return false;
    }
  }
  return true;
}

export function secretPath(target) {
  const normalized = posix(path.resolve(target)).toLowerCase();
  const parts = normalized.split('/').filter(Boolean);
  const base = parts.at(-1) || '';
  if (/^\.env\.(?:example|sample|template)$/.test(base)) return false;
  return /^\.env(?:\.|$)/.test(base)
    || /\.(?:pem|key|p12|pfx)$/.test(base)
    || /^(?:credentials?|auth|tokens?)(?:\..+)?$/.test(base)
    || /^id_(?:rsa|dsa|ecdsa|ed25519)(?:\.pub)?$/.test(base)
    || parts.some((part) => /^(?:secrets?|\.ssh|\.aws)$/.test(part));
}

function patchText(input) {
  if (typeof input === 'string') return input;
  if (!input || typeof input !== 'object' || Array.isArray(input)) return null;
  const values = ['command', 'patch', 'input']
    .filter((key) => Object.hasOwn(input, key))
    .map((key) => input[key]);
  if (!values.length || values.some((value) => typeof value !== 'string')) return null;
  return values.every((value) => value === values[0]) ? values[0] : null;
}

function addPath(found, root, cwd, value) {
  if (typeof value !== 'string' || !value.trim() || value.includes('\0')) return;
  found.add(path.resolve(cwd || root, value.trim()));
}

export function extractEditPaths(payload, root = WORKSPACE_ROOT) {
  const tool = String(payload.tool_name || '');
  if (!EDIT_TOOLS.has(tool)) return [];
  const cwd = path.resolve(payload.cwd || root);
  const input = payload.tool_input;
  const found = new Set();

  if (tool === 'apply_patch') {
    const patch = patchText(input);
    if (patch == null) return [];
    for (const match of patch.matchAll(/^\*\*\* (?:(?:Add|Update|Delete) File|Move to): (.+)$/gm)) {
      addPath(found, root, cwd, match[1]);
    }
    return [...found];
  }

  if (!input || typeof input !== 'object' || Array.isArray(input)) return [];
  for (const key of ['file_path', 'filePath', 'path', 'target_path', 'notebook_path']) {
    addPath(found, root, cwd, input[key]);
  }
  if (Array.isArray(input.paths)) {
    for (const value of input.paths) addPath(found, root, cwd, value);
  }
  return [...found];
}

function commandFrom(input) {
  if (typeof input === 'string') return input.trim() || null;
  if (!input || typeof input !== 'object' || Array.isArray(input)) return null;
  const values = ['command', 'cmd']
    .filter((key) => Object.hasOwn(input, key))
    .map((key) => input[key]);
  if (!values.length || values.some((value) => typeof value !== 'string')) return null;
  return values.every((value) => value === values[0]) && values[0].trim() ? values[0] : null;
}

function referencesSecret(command) {
  const source = String(command)
    .replace(/\.env\.(?:example|sample|template)\b/gi, '')
    .replace(/(?:^|[\\/])[^\s'\"]+\.pub\b/gi, '');
  return /(?:^|[\s'\"=:/\\])\.env(?:\.[a-z0-9_-]+)?(?=$|[\s'\";|&:/\\])/i.test(source)
    || /(?:^|[\s'\"=:/\\])(?:\.ssh|\.aws|secrets?)[\\/][^\s'\"]*/i.test(source)
    || /(?:^|[\s'\"=:/\\])(?:credentials?|auth|tokens?|secrets?)\.(?:json|ya?ml|toml|ini|conf|txt|db|sqlite)(?=$|[\s'\";|&])/i.test(source)
    || /(?:^|[\s'\"=:/\\])id_(?:rsa|dsa|ecdsa|ed25519)\b/i.test(source)
    || /\.(?:pem|key|p12|pfx)(?=$|[\s'\";|&])/i.test(source);
}

function destructiveFilesystem(command) {
  const source = String(command);
  if (/\b(?:shred|sdelete)\b|\bcipher\s+\/w:/i.test(source)) return true;
  if (/\brm\b[^\r\n;&|]*(?:\s-[a-z]{0,2}r[a-z]{0,2}\b|--recursive\b|-Recurse\b)/i.test(source)) return true;
  if (/\b(?:remove-item|ri)\b[^\r\n;&|]*\s-(?:r|recurse)\b/i.test(source)) return true;
  if (/\b(?:rmdir|rd)\b[^\r\n;&|]*(?:\/s\b|-Recurse\b)/i.test(source)) return true;
  if (/\b(?:del|erase)\b[^\r\n;&|]*(?:\/s\b|\/q\b|\/f\b)/i.test(source)) return true;
  if (/\brobocopy\b[^\r\n;&|]*\/mir\b/i.test(source)) return true;
  const moves = /\b(?:mv|move|move-item|rename-item|ren)\b/i.test(source);
  const protectedRoot = /(?:^|[\s'\"])(?:\.\.?[\\/])?(?:\.git|\.codex|\.agents|\.claude|tasks|plans|dev)(?=$|[\\/\s'\"])/i.test(source);
  return moves && protectedRoot;
}

function dangerousGit(command) {
  const git = '\\bgit(?:\\.exe)?\\b[^\\r\\n;&|]{0,500}\\b';
  if (/\bgit(?:\.exe)?\b[^\r\n;&|]{0,500}\b(?:checkout\b[^\r\n;&|]*\s-B|switch\b[^\r\n;&|]*\s-C)\b/.test(command)) return true;
  const patterns = [
    new RegExp(git + 'reset\\b[^\\r\\n;&|]*--hard\\b', 'i'),
    new RegExp(git + 'clean\\b', 'i'),
    new RegExp(git + 'restore\\b', 'i'),
    new RegExp(git + 'checkout\\b[^\\r\\n;&|]*(?:\\s--\\s|\\s-f\\b)', 'i'),
    new RegExp(git + 'branch\\b[^\\r\\n;&|]*\\s-D\\b', 'i'),
    new RegExp(git + 'tag\\b[^\\r\\n;&|]*\\s-d\\b', 'i'),
    new RegExp(git + 'push\\b[^\\r\\n;&|]*(?:--force(?:-with-lease)?\\b|\\s-f\\b)', 'i'),
    new RegExp(git + 'stash\\b[^\\r\\n;&|]*\\b(?:drop|clear)\\b', 'i'),
    new RegExp(git + 'reflog\\b[^\\r\\n;&|]*\\bexpire\\b', 'i'),
    new RegExp(git + 'update-ref\\b[^\\r\\n;&|]*\\s-d\\b', 'i'),
    new RegExp(git + 'worktree\\b[^\\r\\n;&|]*\\bremove\\b', 'i'),
  ];
  return patterns.some((pattern) => pattern.test(command));
}

function words(source) {
  const output = [];
  for (const match of String(source).matchAll(/"([^"]*)"|'([^']*)'|([^\s]+)/g)) {
    output.push(match[1] ?? match[2] ?? match[3]);
  }
  return output;
}

function executableName(value) {
  return path.basename(String(value || '')).replace(/\.exe$/i, '').toLowerCase();
}

export function gitCalls(command) {
  const calls = [];
  for (const segment of String(command).split(/(?:&&|\|\||[;\r\n])/)) {
    const tokens = words(segment);
    for (let start = 0; start < tokens.length; start += 1) {
      if (executableName(tokens[start]) !== 'git') continue;
      let index = start + 1;
      while (index < tokens.length) {
        const token = tokens[index];
        if (/^(?:-C|-c|--git-dir|--work-tree|--namespace|--exec-path)$/i.test(token)) {
          index += 2;
          continue;
        }
        if (token.startsWith('-')) {
          index += 1;
          continue;
        }
        calls.push({ subcommand: token.toLowerCase(), args: tokens.slice(index + 1) });
        break;
      }
      break;
    }
  }
  return calls;
}

function configMutation(call) {
  if (call.subcommand !== 'config') return false;
  const joined = call.args.join(' ');
  if (/--(?:get|list|get-all|get-regexp|show-origin|show-scope)\b/i.test(joined)) return false;
  const positional = call.args.filter((arg) => !arg.startsWith('-'));
  return positional.length >= 2 || /--(?:add|replace-all|unset|unset-all|rename-section|remove-section)\b/i.test(joined);
}

function protectedPush(call) {
  if (call.subcommand !== 'push') return false;
  return call.args.some((arg) => /(?:^|:)(?:refs\/heads\/)?(?:main|master|trunk)$/i.test(arg));
}

function allowedProtectedBranchExit(calls) {
  if (calls.length !== 1) return false;
  const call = calls[0];
  if (call.subcommand === 'pull') return call.args.some((arg) => arg === '--ff-only');
  if (call.subcommand === 'switch') return call.args.some((arg) => arg === '-c' || arg === '--create');
  return call.subcommand === 'checkout' && call.args.some((arg) => arg === '-b');
}

function resolveWorkdir(payload, root) {
  const cwd = path.resolve(payload.cwd || root);
  const input = payload.tool_input;
  const requested = input && typeof input === 'object' && !Array.isArray(input)
    ? (input.workdir ?? input.cwd)
    : null;
  return requested ? path.resolve(cwd, String(requested)) : cwd;
}

function gitWorkdirs(command, base) {
  const workdirs = [];
  for (const segment of String(command).split(/(?:&&|\|\||[;\r\n])/)) {
    const tokens = words(segment);
    const start = tokens.findIndex((token) => executableName(token) === 'git');
    if (start < 0) continue;
    let current = base;
    for (let index = start + 1; index < tokens.length; index += 1) {
      const token = tokens[index];
      if (token === '-C') {
        const value = tokens[index + 1];
        if (!value || /[$%`]/.test(value)) return { invalid: true, workdirs };
        current = path.resolve(current, value);
        workdirs.push(current);
        index += 1;
        continue;
      }
      if (token === '-c' || token === '--namespace') {
        index += 1;
        continue;
      }
      if (/^(?:--git-dir|--work-tree|--exec-path)(?:=|$)/i.test(token)) {
        return { invalid: true, workdirs };
      }
      if (token.startsWith('-')) continue;
      workdirs.push(current);
      break;
    }
  }
  return { invalid: false, workdirs };
}

function gitRepository(workdir) {
  try {
    return execFileSync('git', ['-C', workdir, 'rev-parse', '--show-toplevel'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 1500,
    }).trim();
  } catch {
    return null;
  }
}

function currentBranch(workdir) {
  try {
    return execFileSync('git', ['-C', workdir, 'branch', '--show-current'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 1500,
    }).trim();
  } catch {
    return '';
  }
}

export function shellPolicy(payload, root = WORKSPACE_ROOT) {
  const command = commandFrom(payload.tool_input);
  if (!command) return 'シェル入力を安全に解釈できないため実行を止めました。';
  if (referencesSecret(command)) return '秘密情報の可能性があるファイルへのアクセスを止めました。';
  if (destructiveFilesystem(command)) return '再帰的・強制的なファイル削除または重要ディレクトリの移動を止めました。';
  if (/--no-verify\b/i.test(command)) return '--no-verify はこのワークスペースでは使えません。';
  if (dangerousGit(command)) return '復旧しにくい Git 操作を止めました。対象と復旧方法を確認してください。';

  const calls = gitCalls(command);
  const mutations = calls.filter((call) => GIT_MUTATIONS.has(call.subcommand));
  for (const call of calls) {
    if (!configMutation(call)) continue;
    const joined = call.args.join(' ');
    if (/--(?:global|system)\b/i.test(joined)) return 'ワークスペース外の Git 設定変更を止めました。';
    if (/(?:core\.hooksPath|core\.sshCommand|credential\.|protocol\.|safe\.directory|url\..*\.insteadOf)/i.test(joined)) {
      return 'Git の安全境界や認証経路を変える設定変更を止めました。';
    }
  }
  if (calls.some(protectedPush)) return '保護ブランチへの直接 push を止めました。作業ブランチと PR を使ってください。';
  if (!mutations.length) return null;

  const workdir = resolveWorkdir(payload, root);
  const overrides = gitWorkdirs(command, workdir);
  if (overrides.invalid) return '動的または外部化可能な Git 作業場所の上書きを止めました。';
  const workdirs = [...new Set(overrides.workdirs.length ? overrides.workdirs : [workdir])];
  for (const candidate of workdirs) {
    if (!safeWorkspacePath(root, candidate)) return 'ワークスペース外または symlink 経由の Git 書き込みを止めました。';
    const repository = gitRepository(candidate);
    if (repository && !safeWorkspacePath(root, repository)) return '別リポジトリへの Git 書き込みを止めました。';
    if (PROTECTED_BRANCH.test(currentBranch(candidate)) && !allowedProtectedBranchExit(mutations)) {
      return '保護ブランチへの直接書き込みを止めました。作業ブランチを作成してください。';
    }
  }
  return null;
}

export function checkPreToolUse(payload, root = WORKSPACE_ROOT) {
  const tool = String(payload.tool_name || '');
  if (EDIT_TOOLS.has(tool)) {
    const targets = extractEditPaths(payload, root);
    if (!targets.length) return '編集対象のパスを解釈できないため実行を止めました。';
    if (targets.some((target) => !safeWorkspacePath(root, target))) {
      return 'ワークスペース外または symlink 経由の編集を止めました。';
    }
    if (targets.some(secretPath)) return '秘密情報の可能性があるファイルの編集を止めました。';
    return null;
  }
  if (tool === 'Bash' || tool === 'exec_command' || tool === 'PowerShell') {
    return shellPolicy(payload, root);
  }
  return null;
}

export function denial(reason) {
  return JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny',
      permissionDecisionReason: reason,
    },
  });
}

export function trimUtf8(text, limit, tail = false) {
  const value = String(text || '');
  const buffer = Buffer.from(value, 'utf8');
  if (buffer.length <= limit) return value;
  const slice = tail ? buffer.subarray(buffer.length - limit) : buffer.subarray(0, limit);
  return slice.toString('utf8').replace(tail ? /^�+/ : /�+$/, '');
}

function readOptional(file, root) {
  try {
    if (!safeWorkspacePath(root, file) || !fs.statSync(file).isFile()) return null;
    return fs.readFileSync(file, 'utf8');
  } catch {
    return null;
  }
}

function tasksFor(root, cwd) {
  const relative = posix(path.relative(root, path.resolve(cwd || root)));
  const product = relative.match(/^dev\/([^/]+)(?:\/|$)/);
  return product ? path.join(root, 'dev', product[1], 'tasks') : path.join(root, 'tasks');
}

function reportSection(text) {
  if (!text) return null;
  const normalized = String(text).replace(/\r\n?/g, '\n');
  const matches = [...normalized.matchAll(/^## \d\d:\d\d\b[^\n]*$/gm)];
  return matches.length ? normalized.slice(matches.at(-1).index) : null;
}

function journalFromPointer(root, state) {
  const match = String(state || '').match(/(?:→|->)\s*([^\s]+?\.md)(?=\s+(?:の|at)(?:\s|$)|\s*$)/u);
  if (!match) return null;
  const raw = match[1].replace(/[\\/]/g, path.sep);
  if (path.isAbsolute(raw) || raw.split(path.sep).includes('..')) return null;
  const target = path.resolve(root, raw);
  const relative = posix(path.relative(root, target));
  if (!/^tasks\/journal\/(?:\d{4}-\d{2}\/\d{2}|\d{4}\/\d{2}\/\d{2})\.md$/.test(relative)) return null;
  return reportSection(readOptional(target, root));
}

function dateParts(date) {
  return {
    year: String(date.getFullYear()),
    month: String(date.getMonth() + 1).padStart(2, '0'),
    day: String(date.getDate()).padStart(2, '0'),
  };
}

function recentReport(root, state, now) {
  const pointed = journalFromPointer(root, state);
  if (pointed) return pointed;
  for (const offset of [0, 1]) {
    const date = new Date(now.getTime() - offset * 24 * 60 * 60 * 1000);
    const { year, month, day } = dateParts(date);
    for (const candidate of [
      path.join(root, 'tasks', 'journal', `${year}-${month}`, `${day}.md`),
      path.join(root, 'tasks', 'journal', year, month, `${day}.md`),
    ]) {
      const report = reportSection(readOptional(candidate, root));
      if (report) return report;
    }
  }
  return null;
}

function nowSection(text) {
  if (!text) return null;
  const lines = String(text).replace(/\r\n?/g, '\n').split('\n');
  const start = lines.findIndex((line) => /^##\s+Now(?:\s|$)/i.test(line));
  if (start < 0) return text;
  let end = lines.length;
  for (let index = start + 1; index < lines.length; index += 1) {
    if (/^##\s+/.test(lines[index])) {
      end = index;
      break;
    }
  }
  return lines.slice(start, end).join('\n');
}

function codemapSummary(tasks, root) {
  const file = path.join(tasks, 'codemap.md');
  const text = readOptional(file, root);
  if (!text) return null;
  const headings = text.replace(/\r\n?/g, '\n').split('\n').filter((line) => /^##\s+/.test(line));
  return `${posix(path.relative(root, file))}\n${headings.join('\n')}\n構造を再調査する前にこの地図を読む。`;
}

function block(label, text, budget) {
  if (!text || !String(text).trim()) return null;
  const header = `=== ${label} ===\n`;
  return header + trimUtf8(text, Math.max(0, budget - Buffer.byteLength(header)));
}

export function buildContext(payload, root = WORKSPACE_ROOT, now = new Date()) {
  const tasks = tasksFor(root, payload.cwd || root);
  const state = readOptional(path.join(tasks, 'session-state.md'), root);
  const content = [
    `journal ID: [${shortId(payload)}]（実在する ID だけを SAVE marker に使う）`,
    block('SESSION STATE', state, 1200),
    block('LATEST HUMAN REPORT', recentReport(root, state, now), 2400),
    block('TODO NOW', nowSection(readOptional(path.join(tasks, 'todo.md'), root)), 1800),
    block('CODEMAP', codemapSummary(tasks, root), 1600),
  ].filter(Boolean).join('\n\n');
  return trimUtf8(content, MAX_CONTEXT_BYTES);
}

export function shortId(payload) {
  return String(payload.session_id || payload.turn_id || 'unknown')
    .replace(/[^a-z0-9-]/gi, '')
    .slice(0, 8) || 'unknown';
}

function stamp(date = new Date()) {
  return [date.getHours(), date.getMinutes(), date.getSeconds()]
    .map((value) => String(value).padStart(2, '0'))
    .join(':');
}

function machinePath(root, date = new Date()) {
  const { year, month, day } = dateParts(date);
  return path.join(root, 'tasks', 'journal', '.machine', `${year}-${month}`, `${day}.log`);
}

export function appendMachine(root, message, date = new Date()) {
  const target = machinePath(root, date);
  if (!safeWorkspacePath(root, target)) return false;
  const line = String(message).replace(/[\u0000-\u001f\u007f-\u009f]+/g, ' ').replace(/\s+/g, ' ').trim();
  fs.mkdirSync(path.dirname(target), { recursive: true });
  if (!safeWorkspacePath(root, target)) return false;
  fs.appendFileSync(target, `- ${stamp(date)} ${line}\n`, 'utf8');
  return true;
}

function editOutcome(payload) {
  const response = payload.tool_response ?? payload.tool_result;
  return payload.is_error === true || payload.isError === true
    || (response && typeof response === 'object' && (response.isError === true || response.success === false))
    ? 'failed'
    : 'ok';
}

export function handleHook(payload, root = WORKSPACE_ROOT, now = new Date()) {
  const event = String(payload.hook_event_name || '');
  if (event === 'PreToolUse') {
    const reason = checkPreToolUse(payload, root);
    return reason ? denial(reason) : '';
  }
  if (event === 'PostToolUse') {
    const files = extractEditPaths(payload, root)
      .filter((file) => safeWorkspacePath(root, file))
      .map((file) => posix(path.relative(root, file)));
    if (files.length) appendMachine(root, `[${shortId(payload)}] EDIT ${files.join(', ')} (${editOutcome(payload)})`, now);
    return '';
  }
  if (event === 'SessionStart') {
    const source = String(payload.source || 'startup').replace(/\s+/g, ' ').slice(0, 40);
    appendMachine(root, `[${shortId(payload)}] ${source === 'compact' ? 'SESSION CONTEXT' : 'SESSION START'} (${source})`, now);
    return JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'SessionStart',
        additionalContext: buildContext(payload, root, now),
      },
    });
  }
  if (event === 'SessionEnd') {
    const reason = String(payload.reason || 'other').replace(/\s+/g, ' ').slice(0, 40);
    appendMachine(root, `[${shortId(payload)}] SESSION END (${reason})`, now);
  }
  return '';
}

export async function runHook(root = WORKSPACE_ROOT) {
  let raw = '';
  for await (const chunk of process.stdin) raw += chunk;
  const preToolUse = /"hook_event_name"\s*:\s*"PreToolUse"/.test(raw);
  try {
    const output = handleHook(readPayload(raw), root);
    if (output) process.stdout.write(output);
  } catch (error) {
    if (preToolUse) {
      process.stdout.write(denial(`安全ポリシーの確認に失敗したため実行を止めました: ${error.message}`));
    } else {
      process.stderr.write(`codex hook skipped: ${error.message}\n`);
    }
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await runHook();
}
