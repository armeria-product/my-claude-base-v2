// Shared git-worktree helpers (used by block-pr-without-todo.js and cmd-write-guard.js).
//
// isWithinRepoTree / resolveGitDir / resolveCommonGitDir were moved here verbatim from
// block-pr-without-todo.js (2026-08-07 origin; see that file's history) — same threat model,
// same fail-open convention (a caller's own try/catch turns a throw here into fail-open), unchanged.
//
// isLinkedWorktreeOf() is new (PR-B, 2026-08-28): given the PROJECT root and an absolute path,
// answer "does this path live inside a linked worktree of THIS repo?" using only git's own
// on-disk data — never the path's shape (a worktree parked under tmp/, elsewhere on the same
// drive, or on a different drive entirely must all resolve the same way). Fail-open: anything
// unresolvable (not a worktree, unreadable, malformed) returns null, which callers treat as
// "judge this path exactly as before."

const fs = require('node:fs');
const path = require('node:path');

// Bound check for a resolved absolute path read from an attacker-writable pointer file (a `.git`
// file's `gitdir:` line, or a linked worktree's `commondir` file): reject a resolved location that
// escapes both repoRoot's own tree AND every PATH containing a ".git" segment. A legitimate
// `gitdir:`/`commondir` value always resolves to somewhere under a directory literally named
// ".git" — either repoRoot's own (the normal, non-worktree case, which never reaches this check
// since resolveGitDir() returns early for it), or the MAIN checkout's `.git/worktrees/<name>` and
// `.git` themselves for the linked-worktree case. This is a NAME check on the resolved path's
// components (`.split(path.sep).includes('.git')`), not a check that real git structure actually
// exists there — it does not call fs.existsSync or read anything, so a path that merely contains a
// ".git" segment but points at nothing on disk still passes here (verified 2026-08-08: a made-up,
// nonexistent path under a `.git` directory returns true); an actually-missing target then fails
// later, in resolveGitDir()/resolveCommonGitDir()'s own readFileSync calls, not here. This does NOT
// prevent pointing at a different, unrelated repo's real `.git` directory either (also out of scope
// for this check — the value still names a real git internal directory, just the wrong one); it
// only rejects a resolved path with no ".git" path segment at all (e.g. `gitdir:
// ../../../../etc`), which is the escape 2026-08-07's review flagged (see hook-probes.samples.json
// S-pr-todo/pt-allow-gitdir-escape-outside-repo).
function isWithinRepoTree(resolvedPath, repoRoot) {
  const rel = path.relative(repoRoot, resolvedPath);
  if (rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel))) return true;
  return resolvedPath.split(path.sep).includes('.git');
}

// The actual git directory for `repoRoot`. For a normal checkout `.git` is a directory and this
// is just `<repoRoot>/.git`. For a linked worktree or a submodule checkout, `.git` is instead a
// FILE whose content is `gitdir: <path>` (the path is relative to the directory containing that
// file) — read and resolve it. Throws (does not return null) on anything that doesn't match this
// shape, INCLUDING a resolved path that fails isWithinRepoTree() above; the caller's own try/catch
// is what turns that into fail-open, same convention as every other resolution step in this file
// (see header).
function resolveGitDir(repoRoot) {
  const gitPath = path.join(repoRoot, '.git');
  if (fs.statSync(gitPath).isDirectory()) return gitPath;
  const content = fs.readFileSync(gitPath, 'utf8');
  const m = content.match(/^gitdir:\s*(.+?)\s*$/m);
  if (!m) throw new Error('unrecognized .git file content');
  const resolved = path.resolve(repoRoot, m[1]);
  if (!isWithinRepoTree(resolved, repoRoot)) throw new Error('gitdir escapes the repo tree');
  return resolved;
}

// The git dir that actually holds refs/heads and their reflogs. For a normal checkout, or for a
// submodule's own module dir (`.git/modules/<name>`, fully self-contained), this is `gitDir`
// itself. For a LINKED WORKTREE, `gitDir` is instead the per-worktree admin directory
// (`<main-repo>/.git/worktrees/<name>`) — refs/heads and their reflogs are NOT duplicated there;
// they live in the main repo's git dir, which the admin directory's own `commondir` file points at
// (its content is a path, typically relative, e.g. "../.."). Absence of a `commondir` file means
// `gitDir` is already the common dir (the normal-checkout and submodule cases). `repoRoot` is only
// used for the isWithinRepoTree() bound check (same anchor resolveGitDir() uses above), not for
// resolving `rel` itself, which stays relative to `gitDir` per git's own convention.
function resolveCommonGitDir(gitDir, repoRoot) {
  const commondirPath = path.join(gitDir, 'commondir');
  if (!fs.existsSync(commondirPath)) return gitDir;
  const rel = fs.readFileSync(commondirPath, 'utf8').trim();
  const resolved = path.resolve(gitDir, rel);
  if (!isWithinRepoTree(resolved, repoRoot)) throw new Error('commondir escapes the repo tree');
  return resolved;
}

// Per-process memoization of resolveGitDir(root): cmd-write-guard.js's isStateDir()/
// isFableStatusFile() can run this lookup once per extracted Bash write-target — several times
// in one hook invocation for a single multi-target command. Each hook invocation is its own
// short-lived Node process, so a
// module-level Map is both the cheapest cache available AND cannot go stale across invocations
// (the process exits and the cache with it) — nothing needs to invalidate it. Within one process
// `root` never changes mid-run and the on-disk git structure cannot change under a hook that is
// itself the only thing running, so caching by `root` for the process lifetime is safe.
const rootGitDirCache = new Map();
function getRootGitDir(root) {
  if (!rootGitDirCache.has(root)) rootGitDirCache.set(root, resolveGitDir(root));
  return rootGitDirCache.get(root);
}

// Walk up from `startDir` to the nearest ancestor that has a `.git` entry, stopping the moment
// one is found (whether it is a file or a directory) or the filesystem root is reached. Distinct
// from block-pr-without-todo.js's findRepoRoot(): that function answers "what's the repo root for
// this cwd" and treats a `.git` FILE and a `.git` DIRECTORY identically (both stop the walk with
// a hit). This one needs the raw fs.Stats to tell them apart in the caller, so it returns the
// containing directory only when the entry is a FILE (a `.git` DIRECTORY means we hit a normal
// repo/worktree root that is not itself a linked-worktree pointer, so there is nothing to rebase
// and the walk stops there too, returning null).
//
// Memoized per directory for the process lifetime (gitFileAncestorCache below): every directory
// walked through on the way to an answer gets that SAME answer cached, not just the starting
// directory — correct because two directories on the same upward path with no `.git` entry of
// their own share the identical nearest-ancestor result by construction (nothing between them
// changes what's found further up). This is what keeps a cmd-write-guard.js command with several
// write targets under the same subtree (or this module's own repeated per-target calls) from
// re-walking the same directories once the first lookup has populated the cache. Safe for the
// same reason getRootGitDir()'s cache is: one hook invocation is one short-lived process, so nothing
// on disk can change between a cache write and a later read within it.
const gitFileAncestorCache = new Map();
function findGitFileAncestor(startDir) {
  const visited = [];
  let dir = path.resolve(startDir);
  let result;
  for (;;) {
    if (gitFileAncestorCache.has(dir)) {
      result = gitFileAncestorCache.get(dir);
      break;
    }
    visited.push(dir);
    const gitPath = path.join(dir, '.git');
    let st;
    try {
      st = fs.statSync(gitPath);
    } catch {
      st = null;
    }
    if (st) {
      result = st.isFile() ? dir : null;
      break;
    }
    const up = path.dirname(dir);
    if (up === dir) {
      result = null;
      break;
    }
    dir = up;
  }
  for (const d of visited) gitFileAncestorCache.set(d, result);
  return result;
}

// Is `absPath` inside a linked worktree of the repo rooted at `root`? Returns the worktree's own
// root directory (an absolute path) when yes, or null when no (not inside any worktree, or the
// worktree found belongs to a different repo entirely). Established from git's own on-disk data,
// never from where the candidate directory happens to sit relative to `root`:
//   1. Walk up from absPath to the nearest ancestor whose OWN `.git` is a FILE (findGitFileAncestor
//      above) — a `.git` FILE is the one shape a linked worktree's root always has.
//   2. Read that file's `gitdir:` line and resolve it. A linked worktree's `.git` file always
//      points at `<main-repo>/.git/worktrees/<name>` — reject anything that doesn't land inside
//      root's OWN `.git/worktrees/` (getRootGitDir(root) + 'worktrees'), so a worktree of some
//      unrelated repo is correctly treated as "not a worktree of THIS repo" (null), not rebased.
//   3. Confirm the resolved admin directory is real, registered git data — not merely a plausible
//      path string: it must exist AND its own `gitdir` file must point straight back at the `.git`
//      file found in step 1 (the bidirectional link `git worktree add` itself creates and
//      maintains). This is what stops a hand-written `.git` file whose `gitdir:` line merely
//      NAMES a `.git/worktrees/<anything>` path — without that path actually being a real,
//      registered worktree — from being treated as a legitimate worktree of this repo.
// Any failure at any step (unreadable file, malformed content, escape past isWithinRepoTree,
// missing admin dir) is caught and returns null — fail-open, matching every other resolution step
// in this module.
function isLinkedWorktreeOf(root, absPath) {
  try {
    const rootGitDir = getRootGitDir(root);
    const worktreesDir = path.join(rootGitDir, 'worktrees');

    const gitFileDir = findGitFileAncestor(path.dirname(absPath));
    if (!gitFileDir) return null;
    const gitPath = path.join(gitFileDir, '.git');

    const content = fs.readFileSync(gitPath, 'utf8');
    const m = content.match(/^gitdir:\s*(.+?)\s*$/m);
    if (!m) return null;
    const resolvedAdminDir = path.resolve(gitFileDir, m[1]);
    if (!isWithinRepoTree(resolvedAdminDir, root)) return null;

    const relToWorktrees = path.relative(worktreesDir, resolvedAdminDir);
    if (relToWorktrees === '' || relToWorktrees.startsWith('..') || path.isAbsolute(relToWorktrees)) {
      return null;
    }

    if (!fs.statSync(resolvedAdminDir).isDirectory()) return null;
    const backPointer = fs.readFileSync(path.join(resolvedAdminDir, 'gitdir'), 'utf8').trim();
    const backResolved = path.resolve(resolvedAdminDir, backPointer);
    if (path.resolve(backResolved) !== path.resolve(gitPath)) return null;

    return gitFileDir;
  } catch {
    return null;
  }
}

// PR-B (2026-08-28, plans/parallel-dev-speedup/PLAN.md): rebase a path that lives inside a linked
// worktree of this repo onto the equivalent path in the main tree, so a prefix-based judgment
// treats it exactly as it would the identical file in the main tree — regardless of where that
// worktree sits on disk. Used by cmd-write-guard.js's isFableStatusFile() (2026-08-28 follow-up:
// it compared the RAW path against <root>/.claude/.fable-status, so a worktree-internal write to
// it was invisible to that comparison regardless of the raw spelling used). Any resolution
// failure returns `p` unchanged — fail-open, the path is then judged exactly as it was before
// this function existed.
function rebaseIntoMainTree(root, p) {
  try {
    const abs = path.resolve(root, String(p));
    const worktreeRoot = isLinkedWorktreeOf(root, abs);
    if (!worktreeRoot) return p;
    const relInWorktree = path.relative(worktreeRoot, abs);
    if (relInWorktree.startsWith('..') || path.isAbsolute(relInWorktree)) return p;
    return path.join(root, relInWorktree);
  } catch {
    return p;
  }
}

module.exports = { isWithinRepoTree, resolveGitDir, resolveCommonGitDir, isLinkedWorktreeOf, rebaseIntoMainTree };
