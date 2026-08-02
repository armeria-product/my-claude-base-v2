#!/usr/bin/env node
// PreToolUse hook: block destructive git operations
// Input:  Claude Code hook event JSON on stdin
// Output: if the command matches, write a message to stderr + exit 2 (block); otherwise exit 0
//
// Blocked operations (matches the destructive-operation policy in CLAUDE.md §1.5):
//   - force push (--force / -f / -fu / any combined short flag containing f, OR +refspec).
//     --force-with-lease is allowed.
//   - git reset --hard (discards worktree). mixed/soft reset and unstage are allowed
//   - git checkout that discards the worktree (checkout . / checkout -- <path> / checkout -f)
//   - git restore that discards the worktree (--staged only is allowed = safe unstage)
//   - git clean force variants (anything with -f, e.g. -fd / -fdx / -xf)
//   - branch -D or -Dr / -Dv / any combined short flag containing D (force delete).
//     -d (lowercase) is allowed.
//
// Chained commands (&& || ; |) are inspected segment by segment.
// Shell indirection (bash -c "...") is parsed recursively via shared tokenizer.

const { segments } = require('./lib/parse-cmd');

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

  const verdict = checkCommand(command);
  if (verdict) {
    console.error(
      `BLOCKED: Destructive git operation detected (${verdict}). Confirm with user before proceeding.`
    );
    process.exit(2);
  }
  process.exit(0);
});

/**
 * Git global flags that consume the next token as a value (space-separated form).
 * These must be skipped when searching for the subcommand so that their values
 * are not mistaken for the subcommand name.
 *   -C /repo reset --hard  →  value "/repo" must be skipped before "reset"
 *   -c k=v push --force    →  value "k=v" must be skipped before "push"
 * The = form (--git-dir=x) is a single token and is already non-alphanumeric,
 * so it is naturally skipped by !a.startsWith('-') being false only for values.
 */
const GIT_GLOBAL_VALUE_FLAGS = new Set(['-C', '-c', '--git-dir', '--work-tree', '--namespace', '--exec-path']);

/**
 * Find the index of the git subcommand in args[], skipping global flags and
 * their value tokens so that e.g. ['-C', '/repo', 'reset'] → index 2.
 */
function findSubcmdIndex(args) {
  let i = 0;
  while (i < args.length) {
    const a = args[i];
    if (GIT_GLOBAL_VALUE_FLAGS.has(a)) {
      i += 2; // skip flag + its value token
    } else if (a.startsWith('-')) {
      i += 1; // other flag: skip just the flag itself
    } else {
      return i; // first non-flag, non-value token = subcommand
    }
  }
  return -1;
}

function checkCommand(command) {
  for (const { cmd, args, raw } of segments(command)) {
    if (cmd !== 'git') continue;

    // Determine the git subcommand, skipping global value-consuming flags
    const subIdx = findSubcmdIndex(args);
    if (subIdx === -1) continue;
    const sub = args[subIdx];
    const rest = args.slice(subIdx + 1);
    // Flags that appear anywhere in the argument list
    const flags = args.filter((a) => a.startsWith('-'));

    // Helper: does any short-flag bundle contain character c (case-sensitive)?
    // Matches -f, -rf, -fu, -Drf etc.  Ignores long flags (--foo).
    const hasShortFlag = (c) => flags.some((f) => /^-[a-zA-Z]/.test(f) && !f.startsWith('--') && f.includes(c));

    // --- push ---------------------------------------------------------------
    if (sub === 'push') {
      // --force-with-lease alone is allowed, but an explicit --force / -f / +refspec is a real
      // force push and must be blocked even when --force-with-lease is also present: git honors
      // whichever comes last, so `push --force-with-lease --force` is a full force push. These
      // checks don't false-match --force-with-lease itself (includes('--force') is an exact match;
      // hasShortFlag skips long -- flags).
      const longForce = flags.includes('--force');
      // short flag -f (alone or combined: -fu, -rf, etc.)
      const shortForce = hasShortFlag('f');
      // +refspec:  git push origin +main  or  git push origin +refs/heads/main:refs/heads/main
      const refspecForce = rest.some((a) => a.startsWith('+'));
      if (longForce || shortForce || refspecForce) return 'force push';
    }

    // --- reset --------------------------------------------------------------
    if (sub === 'reset' && flags.includes('--hard')) return 'reset --hard';

    // --- checkout -----------------------------------------------------------
    if (sub === 'checkout') {
      if (
        rest.includes('.') ||
        rest.includes('--') ||
        hasShortFlag('f')
      ) return 'checkout discards worktree';
    }

    // --- restore ------------------------------------------------------------
    if (sub === 'restore') {
      const hasStaged = flags.includes('--staged');
      if (flags.includes('--worktree') || !hasStaged) return 'restore discards worktree';
    }

    // --- clean --------------------------------------------------------------
    if (sub === 'clean') {
      if (hasShortFlag('f') || flags.includes('--force')) return 'clean -f';
    }

    // --- branch -------------------------------------------------------------
    if (sub === 'branch') {
      // -D (uppercase) = force delete. -d (lowercase) is safe.
      if (hasShortFlag('D')) return 'branch -D';
    }
  }
  return null;
}
