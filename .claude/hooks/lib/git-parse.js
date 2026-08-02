// Shared git-argument subcommand resolution (used by block-destructive-git.js,
// block-direct-to-main.js, block-no-verify.js, check-commit-safety.js — previously duplicated
// identically in each).
//
// Git global flags that consume the next token as a value (space-separated form).
// These must be skipped when searching for the subcommand so that their values
// are not mistaken for the subcommand name.
//   -C /repo reset --hard  →  value "/repo" must be skipped before "reset"
//   -c k=v push --force    →  value "k=v" must be skipped before "push"
// The = form (--git-dir=x) is a single token and is already non-alphanumeric,
// so it is naturally skipped by !a.startsWith('-') being false only for values.
const GIT_GLOBAL_VALUE_FLAGS = new Set(['-C', '-c', '--git-dir', '--work-tree', '--namespace', '--exec-path']);

// Find the index of the subcommand in args[], skipping global flags and their value tokens so
// that e.g. ['-C', '/repo', 'reset'] → index 2. valueFlags defaults to GIT_GLOBAL_VALUE_FLAGS so
// existing git-only callers are unaffected; a different flag set (e.g. gh's) can be passed
// explicitly by callers that parse a different CLI's argv.
function findSubcmdIndex(args, valueFlags = GIT_GLOBAL_VALUE_FLAGS) {
  let i = 0;
  while (i < args.length) {
    const a = args[i];
    if (valueFlags.has(a)) {
      i += 2; // skip flag + its value token
    } else if (a.startsWith('-')) {
      i += 1; // other flag: skip just the flag itself
    } else {
      return i; // first non-flag, non-value token = subcommand
    }
  }
  return -1;
}

module.exports = { GIT_GLOBAL_VALUE_FLAGS, findSubcmdIndex };
