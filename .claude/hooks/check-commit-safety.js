#!/usr/bin/env node
// PreToolUse hook: on git commit, detect secrets / leftover debug statements in the staged diff
// Input: Claude Code hook event JSON on stdin
// Output: if a dangerous pattern is found, write a message to stderr + exit 2 (block); otherwise exit 0
// Known limitation: `git -C <path> commit -am` scans the diff from the hook's own cwd, not the -C target repo (separate from the -C resolution used for commit detection itself; rare case).

const { execSync } = require('node:child_process');
const { segments } = require('./lib/parse-cmd');
const { findSubcmdIndex } = require('./lib/git-parse');

// Large enough to hold multi-MB diffs without ENOBUFS (default execSync maxBuffer is 1MB).
const DIFF_MAX_BUFFER = 64 * 1024 * 1024;

const DEBUG_PATTERN = /(console\.log\s*\(|debugger;)/;
const SECRET_PATTERN =
  /(sk-[a-zA-Z0-9]{20,}|sk-proj-[a-zA-Z0-9_-]{20,}|ghp_[a-zA-Z0-9]{36,}|github_pat_[a-zA-Z0-9_]{20,}|AKIA[A-Z0-9]{16}|-----BEGIN (RSA |EC )?PRIVATE KEY)/i;

// Detect a `git commit` invocation (any global flags) via the shared tokenizer, and whether
// it passes -a/--all (including combined short flags like -am).
function findCommit(command) {
  for (const { cmd, args } of segments(command)) {
    if (cmd !== 'git') continue;
    const subIdx = findSubcmdIndex(args);
    if (subIdx === -1) continue;
    if (args[subIdx] !== 'commit') continue;
    const rest = args.slice(subIdx + 1);
    const flags = rest.filter((a) => a.startsWith('-'));
    const all = flags.includes('--all') || flags.some((f) => /^-[a-zA-Z]*a/.test(f) && !f.startsWith('--'));
    return { isCommit: true, all };
  }
  return { isCommit: false, all: false };
}

let data = '';
process.stdin.on('data', (c) => (data += c));
process.stdin.on('end', () => {
  let command = '';
  try {
    const payload = JSON.parse(data);
    command = payload.tool_input?.command || '';
  } catch {
    process.exit(0);
  }

  // Not a git commit -> no check needed.
  const { isCommit, all } = findCommit(command);
  if (!isCommit) process.exit(0);

  // Only run the debug-leftover check on code files (exclude doc references like .md)
  const CODE_GLOBS = [
    '*.js', '*.jsx', '*.ts', '*.tsx', '*.mjs', '*.cjs',
    '*.py', '*.rb', '*.php', '*.rs', '*.go', '*.java',
    '*.kt', '*.swift', '*.cs', '*.cpp', '*.c', '*.h', '*.hpp',
  ];
  // Exclude the harness's own CLI tooling (hooks + scripts): these legitimately use
  // console.log/console.error as their output mechanism, so the debug-leftover check would
  // otherwise self-block on their own output. Secret detection below still covers all files.
  const EXCLUDE_PATHSPECS = [
    ':(exclude).claude/hooks',
    ':(exclude).claude/scripts',
  ];
  let stagedCode = '';
  let stagedAll = '';
  try {
    stagedCode = execSync(
      `git diff --cached --diff-filter=ACM -- ${[...CODE_GLOBS, ...EXCLUDE_PATHSPECS]
        .map((g) => `"${g}"`)
        .join(' ')}`,
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: DIFF_MAX_BUFFER }
    );
    // Secret detection covers all files (secrets can also leak into .env or config files)
    stagedAll = execSync('git diff --cached --diff-filter=ACM', {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      maxBuffer: DIFF_MAX_BUFFER,
    });
    // `git commit -a`/`--all` (incl. combined short flags like -am) stages tracked-file changes
    // at commit time, so the PreToolUse index snapshot above misses them. Also scan the unstaged
    // diff of already-tracked files (--diff-filter=ACM, no untracked files) with the same patterns.
    if (all) {
      const unstagedCode = execSync(
        `git diff --diff-filter=ACM -- ${[...CODE_GLOBS, ...EXCLUDE_PATHSPECS]
          .map((g) => `"${g}"`)
          .join(' ')}`,
        { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: DIFF_MAX_BUFFER }
      );
      const unstagedAll = execSync('git diff --diff-filter=ACM', {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
        maxBuffer: DIFF_MAX_BUFFER,
      });
      stagedCode += '\n' + unstagedCode;
      stagedAll += '\n' + unstagedAll;
    }
  } catch (e) {
    // Distinguish "not a git repo / no commit here" (normal non-applicability -> fail-open) from
    // "diff exists but couldn't be inspected" (e.g. ENOBUFS on a huge diff -> fail-CLOSED: a
    // security gate must never treat "couldn't scan" as "allowed").
    let isRepo = true;
    try {
      execSync('git rev-parse --is-inside-work-tree', { stdio: ['ignore', 'ignore', 'ignore'] });
    } catch {
      isRepo = false;
    }
    if (!isRepo) process.exit(0);
    console.error(
      'BLOCKED: 差分が大きすぎて秘密スキャンできません。分割するか `git add` で明示ステージしてから commit してください。' +
        `\n(detail: ${e.message || e})`
    );
    process.exit(2);
  }

  // Only inspect "added lines" in the diff (those starting with +, excluding the +++ header).
  // Matching deleted lines (-) or context lines (leading whitespace) would wrongly block commits
  // that "remove" console.log or secrets (false positive). Only newly added content matters for leftovers/secrets.
  const addedOnly = (diff) =>
    diff
      .split('\n')
      .filter((l) => l.startsWith('+') && !l.startsWith('+++'))
      .join('\n');
  const addedCode = addedOnly(stagedCode);
  const addedAll = addedOnly(stagedAll);

  if (DEBUG_PATTERN.test(addedCode)) {
    console.error(
      'WARNING: Staged code changes contain console.log or debugger statements. Clean up before committing.'
    );
    process.exit(2);
  }

  if (SECRET_PATTERN.test(addedAll)) {
    console.error(
      'BLOCKED: Staged changes appear to contain secrets or private keys. Remove them before committing.'
    );
    process.exit(2);
  }

  process.exit(0);
});
