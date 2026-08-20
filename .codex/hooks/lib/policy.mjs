import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { extractFilePaths, rootFor, taskDir } from './runtime.mjs';

const SECRET_PATH = /(^|[\s'"\\/])(\.env(?:\.|$)|[^\\/\s]*\.(?:pem|key|p12|pfx)|credentials(?:\.|$)|secrets?(?:[\\/]|\.|$)|id_rsa(?:\.|$))/i;
const READ_COMMAND = /\b(?:cat|type|more|less|head|tail|Get-Content|gc|Select-String|rg|grep)\b/i;
const GIT_MUTATION = /\bgit\b[\s\S]*\b(?:commit|push|merge|pull|rebase|reset|checkout|restore|switch)\b/i;
const DESTRUCTIVE_GIT = /\bgit\b[\s\S]*(?:\breset\s+--hard\b|\bclean\b[^\n;|&]*-[a-z]*f|\bcheckout\s+--\b|\brestore\b[^\n;|&]*--source\b|\bpush\b[^\n;|&]*(?:--force(?:-with-lease)?\b|\s-f\b))/i;
const DESTRUCTIVE_FS = /(?:\brm\b[^\n;|&]*-[a-z]*r|\bRemove-Item\b[^\n;|&]*-Recurse|\bdel\b[^\n;|&]*\/(?:s|q|f)|\brmdir\b[^\n;|&]*\/s\b|\bshred\b|\bformat\b)/i;
const PROTECTED_SWITCH = /\bgit\b[^\n;|&]*(?:\bswitch\s+|\bcheckout\s+)(?:["']?(?:main|master|trunk)["']?)(?=\s|;|&|\||$)/i;
const WRITE_AFTER_SWITCH = /\b(?:commit|push|merge|pull|rebase|reset)\b/i;

export function commandFrom(payload) {
  const input = payload.tool_input;
  if (typeof input === 'string') return input;
  if (!input || typeof input !== 'object') return '';
  for (const key of ['command', 'cmd', 'patch', 'input', 'content']) {
    if (typeof input[key] === 'string') return input[key];
  }
  return '';
}

export function hasSecretPath(text) {
  return SECRET_PATH.test(String(text || '').replace(/['"]/g, ''));
}

function branchFor(cwd) {
  try {
    return execFileSync('git', ['-C', cwd, 'branch', '--show-current'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch {
    return '';
  }
}

function gitCwd(command, cwd) {
  const target = String(command).match(/\bgit\s+-C\s+(?:"([^"]+)"|'([^']+)'|(\S+))/i);
  return target ? path.resolve(cwd, target[1] || target[2] || target[3]) : cwd;
}

function branchStartedAt(cwd, branch) {
  try {
    const values = execFileSync('git', ['-C', cwd, 'reflog', 'show', '--format=%ct', branch], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
      .trim().split(/\s+/).map(Number).filter(Number.isFinite);
    if (values.length) return Math.min(...values) * 1000;
  } catch {}
  try {
    return Number(execFileSync('git', ['-C', cwd, 'log', '-1', '--format=%ct'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim()) * 1000;
  } catch {
    return Number.POSITIVE_INFINITY;
  }
}

export function prTodoIsFresh(cwd) {
  const root = rootFor(cwd);
  const todo = path.join(taskDir(root, cwd), 'todo.md');
  const branch = branchFor(cwd);
  try {
    return fs.statSync(todo).mtimeMs >= branchStartedAt(cwd, branch);
  } catch {
    return false;
  }
}

export function checkPolicy(payload) {
  const tool = String(payload.tool_name || '');
  const input = payload.tool_input;
  if (!input || (typeof input !== 'object' && typeof input !== 'string')) return '安全ポリシーの入力を解釈できないため実行を止めました。';
  const command = commandFrom(payload);
  const nativePaths = extractFilePaths(payload);
  if (nativePaths.some((file) => hasSecretPath(file))) return '秘密情報の可能性があるファイルには Codex フックからアクセスできません。';
  if (tool !== 'apply_patch' && tool !== 'Edit' && tool !== 'Write' && !command) return '安全ポリシーのコマンドを解釈できないため実行を止めました。';
  if (hasSecretPath(command) && READ_COMMAND.test(command)) return '秘密情報の可能性があるファイルの読み取りを止めました。';
  if (/\b(?:git\b[^\n;|&]*--no-verify|--no-verify\b)/i.test(command)) return '--no-verify はこのワークスペースでは使えません。';
  if (DESTRUCTIVE_GIT.test(command)) return '破壊的な Git 操作を止めました。必要なら対象と復旧方法を明示してユーザーの承認を得てください。';
  if (DESTRUCTIVE_FS.test(command)) return '破壊的なファイル操作を止めました。対象を確認し、ユーザーの承認を得てください。';
  const cwd = payload.cwd || process.cwd();
  if (GIT_MUTATION.test(command) && /\b(?:cd|Set-Location|pushd)\b/i.test(command) && !/\bgit\s+-C\s+/i.test(command))
    return '作業ディレクトリを途中で切り替える Git 書き込みは安全に検証できないため止めました。git -C <path> を使ってください。';
  if (PROTECTED_SWITCH.test(command) && WRITE_AFTER_SWITCH.test(command.replace(PROTECTED_SWITCH, '')))
    return '同じコマンド列で保護ブランチへ切り替えて書き込む Git 操作を止めました。作業ブランチと PR を使ってください。';
  if (GIT_MUTATION.test(command) && /^(main|master|trunk)$/i.test(branchFor(gitCwd(command, cwd))))
    return '保護ブランチへ直接書き込む Git 操作を止めました。作業ブランチと PR を使ってください。';
  if (/\bgh\b[\s\S]*\bpr\s+create\b/i.test(command) && !prTodoIsFresh(cwd)) return 'PR 作成前に、このブランチで更新した tasks/todo.md を用意してください。';
  return null;
}

export function denial(reason) {
  return JSON.stringify({
    decision: 'block',
    reason,
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny',
      permissionDecisionReason: reason,
    },
  });
}
