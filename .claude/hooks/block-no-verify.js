#!/usr/bin/env node
// PreToolUse hook: blocks the --no-verify flag and its short equivalent -n
// Input: Claude Code hook event JSON on stdin
// Output: for a matching command, message on stderr + exit 2 (block); otherwise exit 0
//
// --no-verify (-n) prevents pre-commit/pre-push hooks from running.
// -n has different meanings in other commands (e.g. grep -n = line numbers),
// so the -n check is scoped to git commit / git merge / git push only.

const { segments, stripQuotedContent, stripHeredocs } = require('./lib/parse-cmd');
const { findSubcmdIndex } = require('./lib/git-parse');

const NO_VERIFY_LONG = /--no-verify\b/;

// git subcommands where the SHORT flag -n means --no-verify. Only `commit`: for `push` -n is
// --dry-run and for `merge` -n is --no-stat (both safe), so blocking -n there is a false positive.
// The long form --no-verify (valid on commit/merge/push) is still caught by the fast path above.
const NO_VERIFY_SUBCOMMANDS = new Set(['commit']);

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

  // Fast path: long form anywhere in the command. Strip heredoc bodies AND quoted text first,
  // so a commit message (heredoc or -m "...") that merely mentions "--no-verify" is not itself
  // blocked. Heredocs must be stripped before quotes — a `<<'EOF'` delimiter contains quotes.
  if (NO_VERIFY_LONG.test(stripQuotedContent(stripHeredocs(command)))) {
    console.error(
      'BLOCKED: --no-verify is not allowed. Fix the underlying hook issue instead.'
    );
    process.exit(2);
  }

  // Check for -n short form, scoped to relevant git subcommands
  for (const { cmd, args } of segments(command)) {
    if (cmd !== 'git') continue;
    const subIdx = findSubcmdIndex(args);
    if (subIdx === -1) continue;
    const sub = args[subIdx];
    if (!NO_VERIFY_SUBCOMMANDS.has(sub)) continue;
    const flags = args.filter((a) => a.startsWith('-') && !a.startsWith('--'));
    // -n alone or combined: -nm, -mn, etc.
    if (flags.some((f) => /^-[a-zA-Z]*n[a-zA-Z]*$/.test(f))) {
      console.error(
        'BLOCKED: "git ' + sub + ' -n" (--no-verify shorthand) is not allowed. Fix the underlying hook issue instead.'
      );
      process.exit(2);
    }
  }

  process.exit(0);
});
