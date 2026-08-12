#!/usr/bin/env node
// PreToolUse hook: blocks destructive file deletion (last-resort guard in bypassPermissions environments)
// Enforces CLAUDE.md §1.5 "File/data deletion -> always confirm".
//
// Policy:
//   - rm/shred: user ruling 2026-08-12 (AskUserQuestion, "ワークスペース直下なら何でも許可") relaxed
//     this from a leaf-name allowlist to workspace-root CONTAINMENT. Each target is resolved against
//     the command's cwd (payload.cwd, falling back to the workspace root) to an absolute path, then:
//       ALLOWED  - the resolved path is strictly INSIDE the workspace root, whatever its original
//                  spelling (relative or absolute) and whatever its leaf name. This supersedes
//                  SAFE_LEAF for rm/shred: a leaf name no longer matters once containment is proven.
//       BLOCKED  - the resolved path is OUTSIDE the workspace root (/, another drive, ~/HOME, a
//                  `../` that actually escapes, ...).
//       BLOCKED  - the resolved path IS the workspace root itself (`rm -rf .` run at the root, or
//                  the root's own absolute path spelled out) — "below the hierarchy" was granted,
//                  not the hierarchy itself.
//       BLOCKED  - the target can't be resolved to a path at all: a `~`-prefix (shell-expanded home,
//                  never expanded by this hook), or anything containing a glob character (* ? [ ])
//                  or `$` (variable/command-substitution expansion, which also covers $HOME). This
//                  hook parses the command STRING, not a shell's post-expansion argv, so it cannot
//                  know what these expand to — verified empirically (tmp/path-probe.js, 2026-08-12)
//                  that Node's path.resolve treats "*", "$HOME", "~" as LITERAL path segments, so
//                  skipping this check would let `rm -rf *` resolve to "<root>/*" and be wrongly
//                  allowed as "inside the root". Deliberate limit, not an oversight.
//     Only rm and shred are touched by this ruling (it named "rm" specifically) — find/xargs/dd/
//     truncate below, and the PowerShell delete cmdlets/Clear-Content further down (still gated by
//     the original FORBIDDEN_TARGET + SAFE_LEAF leaf-allowlist), are unchanged.
//
//   Disclosure (CLAUDE.md §1.5, user ruling 2026-08-12):
//     1. What's newly allowed: any rm/shred target below the workspace root, any leaf name.
//     2. What's still blocked, and why: outside the root; the root itself; targets this hook
//        cannot resolve (globs, $-expansion, ~) — see BLOCKED cases above.
//     3. Recovery fact the user already accepted when making this ruling: tasks/journal/**,
//        tasks/history/**, tasks/*.md, plans/**, and dev/** are all gitignored (CLAUDE.md §0) — an
//        rm under this new policy can delete any of them with NO git history to recover from.
//     4. .claude/state/ stays protected regardless of this change, by a DIFFERENT hook: every
//        Bash/PowerShell call runs cmd-write-guard.js and block-destructive-fs.js independently
//        (same PreToolUse "Bash|PowerShell" matcher, settings.json) and either can veto. cmd-write-
//        guard.js's write-indicator regex matches `rm` (\brm\b) and its Arm B unconditionally checks
//        the resolved target against the state dir via isStateDir() — this hook allowing an rm
//        under .claude/state/ (it resolves inside the root) does not make it succeed.
//
//   - Recursive deletes (rm -r / -rf) of RELATIVE targets are blocked unless every target's leaf name
//     is a disposable build-output dir (node_modules, dist, ...) -> otherwise Claude confirms with the user.
//   - find ... -delete is blocked unconditionally
//   - find ... -exec/-execdir/-ok rm ... {} is blocked unconditionally (as dangerous as -delete)
//   - ... | xargs rm ... is blocked when it carries a recursive/force flag (stdin-derived targets
//     can't be inspected against FORBIDDEN_TARGET/SAFE_LEAF, so the combination itself is the signal)
//   - dd ... of=<path> / truncate -s 0 <path> targeting an absolute or parent-relative path is blocked
//     (destructive overwrite, not a delete, but equally irreversible; §1.5 covers "data deletion" broadly)
//   - bash -c / sh -c / eval indirection is parsed recursively (checked by shared tokenizer)
//   - Leading env-var assignments (FOO=1 rm ...) and absolute paths (/bin/rm) are normalized
//
// Known limitation: shell-wrapper-mediated deletes via `find -exec`/`-execdir`/`-ok` or `xargs`
// invoking `sh`/`bash`/`dash`/`ash`/`zsh`/`env` are covered (see SHELL_WRAPPERS below) by
// re-tokenizing the wrapper's "-c <script>" argument with the shared tokenizer and checking whether
// any inner segment's command is rm/shred (so git rm / npm rm / a path containing "rm" are not
// false positives), and by peeling off env's own flags/assignments before recursing on the command
// it actually invokes. Forms without "-c" (e.g. `sh script.sh`) or further nested indirection beyond
// that (e.g. a wrapper script invoked by path that itself shells out) remain a structural limit. A
// script reached this way is resolved against the OUTER command's cwd (this hook does not track `cd`
// across segments or within a wrapper's script body), and symlinks are never resolved against the
// real filesystem (path.resolve is purely lexical, matching every other hook in this codebase) — a
// symlink whose lexical target looks inside the root but whose real target is outside it is not caught.
//
// Path comparison for the rm/shred containment check above: resolved absolute paths are compared with
// path.relative (a real separator-aware comparison, not a raw string startsWith, so a sibling dir like
// "<root>-other" is correctly seen as outside), case-folded on win32 only (case-insensitive filesystem
// there; POSIX stays case-sensitive).
//
// Input: Claude Code hook event JSON on stdin
// Output: matching command -> message on stderr + exit 2 (block); otherwise exit 0

const { segments, stripExeSuffix } = require('./lib/parse-cmd');
const path = require('node:path');
const { projectRoot } = require('./lib/journal-util');
const { normalizeRel } = require('./lib/scope-match');

// Directories that can be safely regenerated after deletion (matched by the trailing path element).
// rm/shred no longer consult this (workspace-root containment supersedes it — see header "Policy:
// rm/shred"); still used by the PowerShell recursive-delete and Clear-Content sections below.
const SAFE_LEAF =
  /^(node_modules|dist|build|out|coverage|target|tmp|temp|__pycache__|\.next|\.nuxt|\.turbo|\.cache|\.pytest_cache|\.venv|venv)\/?$/;

// Unconditional block targets (regardless of whether rm has -r)
// ~/... and $HOME/... cover any subpath under home (e.g. ~/.ssh/id_rsa), not just the bare prefix.
// (note: the leading `\/` alternative is already subsumed by `\/\S*`; left as-is on purpose —
//  this hook's regex is never touched by comment-only fixes.)
const FORBIDDEN_TARGET = /^(\/|~\/?\S*|\.\.(\/.*)?|\/\S*|[A-Za-z]:([\\/]\S*)?|\$HOME\/?\S*|\*)$/;

// Destructive commands that a `find -exec` / `xargs` may invoke
const DESTRUCTIVE_CMDS = new Set(['rm', 'shred']);

// PowerShell delete cmdlets/aliases (the PowerShell tool shares this hook via the
// Bash|PowerShell matcher; `rm` as a PS alias is already covered by the rm section)
const PS_DELETE_CMDS = new Set(['remove-item', 'ri', 'rd', 'rmdir', 'del', 'erase']);

// Shell wrappers that can mediate an indirect rm/shred (find -exec sh -c '...', xargs env rm, ...)
const SHELL_WRAPPERS = new Set(['sh', 'bash', 'dash', 'ash', 'zsh', 'env']);

// env options that take a value argument (must be skipped along with their value when peeling
// env off to find the actually-invoked command). e.g. `env -u PATH rm ...`, `env -C /tmp rm ...`.
const ENV_VALUE_FLAGS = new Set(['-u', '--unset', '-C', '--chdir', '-S', '--split-string']);

// Given args[] and the index of a command name, resolve it as a basename and, if it's a shell
// wrapper, peel off one layer (e.g. `env`) to find the actually-invoked command. Returns
// { invoked, rest } where `rest` is the remaining args after the invoked command name, or null
// if index is out of range.
function resolveWrapped(args, i) {
  if (i >= args.length) return null;
  const invoked = stripExeSuffix((args[i] || '').split('/').pop().toLowerCase());
  return { invoked, rest: args.slice(i + 1) };
}

// Skip past env's own options (-i, -u NAME, -C DIR, ...) and any NAME=value assignments to find
// the index of the actually-invoked command (env VAR=1 -i rm -rf x -> index of "rm").
function skipEnvPrefix(args) {
  let i = 0;
  while (i < args.length) {
    const t = args[i];
    if (/^\w+=/.test(t)) { i++; continue; }
    if (t.startsWith('-')) {
      i += ENV_VALUE_FLAGS.has(t) ? 2 : 1;
      continue;
    }
    break;
  }
  return i;
}

// True if `invoked` is a shell wrapper (sh/bash/.../env) that mediates an indirect rm/shred.
//   - sh/bash/dash/ash/zsh: only the "-c <script>" form is followed into the script text, which is
//     re-tokenized via segments() so only an actual rm/shred *command* (not a substring/argument/
//     path segment) trips the guard (git rm, npm rm, "echo rm", /var/rm/notes all pass through).
//   - env: env's own flags/assignments are peeled off first, then recurse on the real command,
//     so `env FOO=1 -i rm -rf x` and `env sh -c '...'` are both resolved correctly.
function isWrapperMediatedDelete(invoked, rest) {
  if (!SHELL_WRAPPERS.has(invoked)) return false;
  if (invoked === 'env') {
    const skip = skipEnvPrefix(rest);
    const next = resolveWrapped(rest, skip);
    if (!next) return false;
    if (DESTRUCTIVE_CMDS.has(next.invoked)) return true;
    return isWrapperMediatedDelete(next.invoked, next.rest);
  }
  // sh/bash/dash/ash/zsh: only "-c <script>" carries an inline command to inspect.
  const cIdx = rest.indexOf('-c');
  if (cIdx === -1) return false;
  const script = rest[cIdx + 1];
  if (!script) return false;
  return segments(script).some((seg) => DESTRUCTIVE_CMDS.has(seg.cmd));
}

// --- rm/shred containment (user ruling 2026-08-12; see header "Policy: rm/shred") --------------

// A leading ~ is a shell-expanded home-directory reference. path.resolve does NOT expand it (proven
// empirically, tmp/path-probe.js) -- it treats "~" as a literal path segment -- so without this
// check "~/foo" would resolve to "<root>/~/foo" and be wrongly seen as inside the root. Unresolved,
// blocked unconditionally.
const HOME_PREFIX = /^~/;

// Characters a real shell expands before rm/shred ever sees the literal argument: glob wildcards
// (* ? [ ]) and $ (variable/command-substitution expansion -- covers $HOME too, no separate case
// needed). This hook parses the command STRING, not a shell's post-expansion argv, so it cannot know
// what these expand to; path.resolve treats them as literal characters (same empirical proof as
// HOME_PREFIX above), so leaving them unhandled would let "rm -rf *" resolve to "<root>/*" and be
// wrongly allowed. Unresolved, blocked unconditionally.
const UNRESOLVABLE_TARGET = /[*?[\]$]/;

// Case-fold only on win32 (case-insensitive filesystem there); POSIX filesystems are case-sensitive.
// Applied to both operands before normalizeRel so its path.relative-based comparison -- already
// separator-aware, not a raw string prefix -- also becomes case-insensitive where the real
// filesystem is.
function foldCase(p) {
  return process.platform === 'win32' ? p.toLowerCase() : p;
}

// Resolve `target` against the command's cwd, then classify the result against the workspace root.
// `abs` keeps real casing (for messages); outside/isRootItself are decided on folded case.
function classifyRmTarget(root, cwd, target) {
  const abs = path.resolve(cwd, target);
  const { rel, outside } = normalizeRel(foldCase(root), foldCase(abs));
  return { abs, outside, isRootItself: !outside && rel === '' };
}

let data = '';
process.stdin.on('data', (c) => (data += c));
process.stdin.on('end', () => {
  let command = '';
  let payload = {};
  try {
    payload = JSON.parse(data);
    command = payload.tool_input?.command || '';
  } catch {
    process.exit(0);
  }

  // Mirrors cmd-write-guard.js's own root/cwd resolution exactly (CLAUDE_PROJECT_DIR -> payload.cwd
  // -> process.cwd(), walking up for a .claude dir; see lib/journal-util.js projectRoot).
  const root = projectRoot(payload);
  const cwd = payload.cwd || root;

  const verdict = checkCommand(command, cwd, root);
  if (verdict) {
    console.error(verdict);
    process.exit(2);
  }
  process.exit(0);
});

function checkCommand(command, cwd, root) {
  for (const { cmd, args, raw } of segments(command)) {
    // --- find ... -delete ---------------------------------------------------
    if (cmd === 'find') {
      if (args.includes('-delete')) {
        return `BLOCKED: "find ... -delete" is forbidden. File deletion requires user confirmation (CLAUDE.md §1.5).`;
      }
      // --- find ... -exec/-execdir/-ok rm|shred ... {} ; / + ---------------
      for (let i = 0; i < args.length; i++) {
        if (args[i] === '-exec' || args[i] === '-execdir' || args[i] === '-ok') {
          const invoked = stripExeSuffix((args[i + 1] || '').split('/').pop().toLowerCase());
          if (DESTRUCTIVE_CMDS.has(invoked)) {
            return `BLOCKED: "find ... ${args[i]} ${invoked} ..." is forbidden. File deletion requires user confirmation (CLAUDE.md §1.5).`;
          }
          // Shell-wrapper-mediated delete: find ... -exec sh -c 'rm -rf $1' _ {} ;
          // Scan only up to the -exec/-execdir/-ok terminator (';' or '+') so unrelated
          // trailing find predicates aren't swept into the check.
          let end = i + 2;
          while (end < args.length && args[end] !== ';' && args[end] !== '+') end++;
          if (isWrapperMediatedDelete(invoked, args.slice(i + 2, end))) {
            return `BLOCKED: "find ... ${args[i]} ${invoked} ..." (shell-wrapper-mediated delete) is forbidden. File deletion requires user confirmation (CLAUDE.md §1.5).`;
          }
        }
      }
    }

    // --- xargs rm/shred (stdin-derived targets can't be checked against
    // FORBIDDEN_TARGET/SAFE_LEAF, so a recursive/force flag on the invoked command is the signal) ---
    if (cmd === 'xargs') {
      // First non-flag token is the invoked command; skip xargs's own flags (-I, -n, -0, -P, ...),
      // including the value-consuming ones (-I repl, -n num).
      const XARGS_VALUE_FLAGS = new Set(['-I', '-n', '-P', '-L', '-s', '-d', '-E', '-e', '-a', '--arg-file']);
      let i = 0;
      while (i < args.length && args[i].startsWith('-')) {
        i += XARGS_VALUE_FLAGS.has(args[i]) ? 2 : 1;
      }
      const invoked = stripExeSuffix((args[i] || '').split('/').pop().toLowerCase());
      if (DESTRUCTIVE_CMDS.has(invoked)) {
        const invokedArgs = args.slice(i + 1);
        const invokedFlags = invokedArgs.filter((t) => t.startsWith('-'));
        const recursiveOrForce = invokedFlags.some((f) => /^-[a-zA-Z]*[rRf]/.test(f)) || invokedFlags.includes('--recursive') || invokedFlags.includes('--force');
        if (recursiveOrForce) {
          return `BLOCKED: "xargs ... ${invoked}" with a recursive/force flag is forbidden (${raw}). Targets come from stdin and can't be safety-checked. File deletion requires user confirmation (CLAUDE.md §1.5).`;
        }
      }
      // Shell-wrapper-mediated delete: xargs sh -c 'rm -rf x' / xargs env rm -rf x
      // Everything after the invoked wrapper is fair game (no find-style terminator for xargs).
      if (isWrapperMediatedDelete(invoked, args.slice(i + 1))) {
        return `BLOCKED: "xargs ... ${invoked}" (shell-wrapper-mediated delete) is forbidden (${raw}). Targets come from stdin and can't be safety-checked. File deletion requires user confirmation (CLAUDE.md §1.5).`;
      }
    }

    // --- dd of=<path> / truncate -s 0 <path> (destructive overwrite) --------
    if (cmd === 'dd') {
      const ofArg = args.find((a) => a.startsWith('of='));
      if (ofArg) {
        const target = ofArg.slice(3).replace(/^["']|["']$/g, '');
        if (FORBIDDEN_TARGET.test(target)) {
          return `BLOCKED: "dd" overwriting "${target}" is forbidden (root/home/parent/absolute path). Confirm with user before proceeding.`;
        }
      }
    }
    if (cmd === 'truncate') {
      const hasZero = args.includes('-s') && args[args.indexOf('-s') + 1] === '0' ||
        args.some((a) => a === '-s0' || a === '--size=0');
      if (hasZero) {
        const targets = args.filter((t) => !t.startsWith('-') && t !== '0');
        for (const t of targets) {
          const unquoted = t.replace(/^["']|["']$/g, '');
          if (FORBIDDEN_TARGET.test(unquoted)) {
            return `BLOCKED: "truncate -s 0" targeting "${unquoted}" is forbidden (root/home/parent/absolute path). Confirm with user before proceeding.`;
          }
        }
      }
    }

    // --- PowerShell delete cmdlets (Remove-Item -Recurse, rd /s, del /s, ...) ---
    const psCmd = cmd.toLowerCase();
    if (PS_DELETE_CMDS.has(psCmd)) {
      const psFlags = args.filter((t) => t.startsWith('-') || /^\/[a-zA-Z]$/.test(t));
      const psTargets = args.filter((t) => !t.startsWith('-') && !/^\/[a-zA-Z]$/.test(t));
      const psRecursive = psFlags.some((f) => /^-rec/i.test(f) || /^\/s$/i.test(f));
      for (const t of psTargets) {
        const unquoted = t.replace(/^["']|["']$/g, '').replace(/\\/g, '/');
        if (FORBIDDEN_TARGET.test(unquoted)) {
          return `BLOCKED: "${cmd}" targeting "${unquoted}" is forbidden (root/home/parent/absolute path). Confirm with user before proceeding.`;
        }
      }
      if (psRecursive) {
        const allSafe =
          psTargets.length > 0 &&
          psTargets.every((t) => {
            const leaf = t.replace(/^["']|["']$/g, '').replace(/\\/g, '/').replace(/\/+$/, '').split('/').pop();
            return SAFE_LEAF.test(leaf);
          });
        if (!allSafe) {
          return `BLOCKED: Recursive delete detected (${raw}). File deletion requires user confirmation (CLAUDE.md §1.5). Only disposable build dirs (node_modules, dist, ...) may be removed without asking.`;
        }
      }
    }
    if (psCmd === 'clear-content') {
      for (const t of args.filter((a) => !a.startsWith('-'))) {
        const unquoted = t.replace(/^["']|["']$/g, '').replace(/\\/g, '/');
        if (FORBIDDEN_TARGET.test(unquoted)) {
          return `BLOCKED: "Clear-Content" targeting "${unquoted}" is forbidden (root/home/parent/absolute path). Confirm with user before proceeding.`;
        }
      }
    }

    // --- rm/shred checks: workspace-root containment (user ruling 2026-08-12; see header) --------
    if (cmd !== 'rm' && cmd !== 'shred') continue;

    const targets = args.filter((t) => !t.startsWith('-'));

    for (const t of targets) {
      const unquoted = t.replace(/^["']|["']$/g, '');

      if (HOME_PREFIX.test(unquoted)) {
        return (
          `BLOCKED: "${cmd}" の削除対象「${unquoted}」はホームディレクトリ参照 (~) で、実際にどこを指すか` +
          `このフックでは確認できません。展開後の実際のパスを指定し直してください（CLAUDE.md §1.5）。`
        );
      }
      if (UNRESOLVABLE_TARGET.test(unquoted)) {
        return (
          `BLOCKED: "${cmd}" の削除対象「${unquoted}」はワイルドカード（* ? [ ]）または変数展開（$）を含み、` +
          `実際に何が消えるか事前に特定できません。展開後の実際のパスを1つずつ指定してください（CLAUDE.md §1.5）。`
        );
      }

      const { abs, outside, isRootItself } = classifyRmTarget(root, cwd, unquoted);
      if (outside) {
        return (
          `BLOCKED: "${cmd}" の削除対象「${unquoted}」（解決後のパス:「${abs}」）はワークスペース` +
          `「${root}」の外です。ワークスペース直下の削除は許可されていますが、外側は削除できません。` +
          `パスを確認し、ワークスペース内を指定し直してください。なお tasks/journal・tasks/history・` +
          `tasks/*.md・plans/・dev/ は git 管理外のため、削除すると git 履歴からは復元できません` +
          `（CLAUDE.md §1.5）。`
        );
      }
      if (isRootItself) {
        return (
          `BLOCKED: "${cmd}" の削除対象「${unquoted}」はワークスペース「${root}」そのものです。` +
          `ワークスペース直下（中身）は削除できますが、ワークスペースという入れ物自体は削除できません。` +
          `削除したい中身のパスを指定し直してください（CLAUDE.md §1.5）。`
        );
      }
      // Strictly inside the workspace root: allowed regardless of leaf name -- this supersedes
      // SAFE_LEAF for rm/shred (see header). Falls through to the next target / segment.
    }
  }
  return null;
}
