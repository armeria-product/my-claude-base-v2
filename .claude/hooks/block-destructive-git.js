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
//   - ANY `git ...` segment (regardless of subcommand -- deliberately not another enumeration)
//     whose stdout/stderr is redirected with a TRUNCATING redirect onto a path that already
//     exists as a regular file (e.g. `git show HEAD:a.js > a.js`, `git cat-file -p HEAD:a.js >
//     a.js`) -- this achieves the same worktree-discard effect as `checkout --`/`restore` without
//     going through a subcommand this file's enumeration above ever sees. Exempt when the
//     resolved path lies under a `tmp`/`temp` path segment (CLAUDE.md §0 scratch area).
//
// Not covered (known, deliberate):
//   - append redirects (`>>`, `&>>`) -- appending does not discard existing content, so they are
//     intentionally excluded from the redirect-overwrite check above.
//   - anything routed through a PIPE: segments() splits `|` into independent segments and
//     discards pipeline structure, so the git origin of a downstream write is invisible to this
//     hook -- e.g. `git show HEAD:a.js | tee a.js`, `git archive HEAD | tar -x`, and the
//     PowerShell spellings `git show HEAD:a.js | Out-File a.js` / `| Set-Content a.js` (this hook
//     is registered for `Bash|PowerShell`).
//   - write-to-new-then-move (`git show HEAD:a.js > new && mv new a.js`) -- the `mv` half is
//     block-destructive-fs.js / cmd-write-guard.js territory, not this file's.
//   - cwd tracking (for resolving redirect targets) covers plain `cd <path>` only -- no
//     pushd/subshell/variable tracking, same known limit as lib/cmd-targets.js's precise model.
//   - everything already known-open in lib/parse-cmd.js (newline-separated commands, `( ... )`
//     grouping) -- see tasks/todo.md.
//
// Chained commands (&& || ; |) are inspected segment by segment.
// Shell indirection (bash -c "...") is parsed recursively via shared tokenizer.

const fs = require('node:fs');
const path = require('node:path');
const { segments } = require('./lib/parse-cmd');
const { findSubcmdIndex } = require('./lib/git-parse');

let data = '';
process.stdin.on('data', (c) => (data += c));
process.stdin.on('end', () => {
  let command = '';
  let startCwd = process.cwd();
  try {
    const payload = JSON.parse(data);
    command = payload.tool_input?.command || '';
    startCwd = payload.cwd || process.cwd();
  } catch {
    process.exit(0);
  }

  const verdict = checkCommand(command, startCwd);
  if (verdict) {
    console.error(
      `BLOCKED: Destructive git operation detected (${verdict}). Confirm with user before proceeding.`
    );
    process.exit(2);
  }
  process.exit(0);
});

// Truncating-redirect matchers, deliberately separate and narrower than lib/cmd-targets.js's
// REDIR_FULL/REDIR_ATTACHED pair: that pair answers "is this a write?" (so it also matches the
// append forms `>>`/`&>>`, which never discard content); this check needs to tell truncating
// apart from appending, so it must NOT reuse that pair. Full-token forms: `>`, `>|`, `1>`, `2>`,
// `&>`. Attached forms: `>path`, `2>path`, `&>path` -- the `(?!>)` lookahead after the operator
// keeps an attached-looking append (`>>file`, `&>>file`) from being misread as a truncating
// redirect glued to a target starting with `>`.
const REDIR_FULL_TRUNC = /^(\d?>|&>|>\|)$/;
const REDIR_ATTACHED_TRUNC = /^(?:\d?>|&>)(?!>)(.+)$/;

function isSkippableRedirectTarget(t) {
  return /^&\d$/.test(t) || /^\/dev\/null$|^NUL$/i.test(t);
}

// Deny when a `git ...` segment's redirect target already exists as a regular file (worktree
// overwrite), unless the resolved path is under a `tmp`/`temp` scratch segment. `cur` is the
// running cwd tracked by the caller. Any fs error is treated as "does not exist" -> allow
// (fail-open, consistent with the other hooks in this repo).
function checkGitRedirectOverwrite(args, cur) {
  for (let i = 0; i < args.length; i++) {
    const t = args[i];
    let target = null;
    if (REDIR_FULL_TRUNC.test(t)) {
      target = args[i + 1];
      i++;
    } else {
      const m = t.match(REDIR_ATTACHED_TRUNC);
      if (m) target = m[1];
    }
    if (!target || isSkippableRedirectTarget(target)) continue;

    const resolved = path.resolve(cur, target);
    let stat;
    try {
      stat = fs.statSync(resolved);
    } catch {
      continue;
    }
    if (!stat.isFile()) continue;

    // Scratch exemption: CLAUDE.md §0 makes tmp/ the sanctioned untracked scratch area, and
    // .claude/agents/verifier.md:55 tells agents to dump `git show <rev>:<file>` evidence there
    // as read-only proof -- the natural spelling of that is a redirect into tmp/, which must keep
    // working even on a re-run that overwrites the previous dump. Compared after path.resolve so
    // `tmp/../src/a.js` (which normalizes the tmp/ segment away) does not qualify.
    const resolvedSegs = resolved.split(path.sep).map((s) => s.toLowerCase());
    if (resolvedSegs.includes('tmp') || resolvedSegs.includes('temp')) continue;

    return `redirect overwrites existing file: ${resolved} (dump to a tmp/ path instead)`;
  }
  return null;
}

function checkCommand(command, startCwd) {
  let cur = startCwd;
  for (const { cmd, args, raw } of segments(command)) {
    if (cmd === 'cd') {
      const dest = args.find((a) => !a.startsWith('-'));
      if (dest) cur = path.resolve(cur, dest);
    }
    if (cmd !== 'git') continue;

    const redirectVerdict = checkGitRedirectOverwrite(args, cur);
    if (redirectVerdict) return redirectVerdict;

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
