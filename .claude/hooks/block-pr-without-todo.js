#!/usr/bin/env node
// PreToolUse hook (Bash|PowerShell): before `gh pr create`, require that this branch's
// tasks/todo.md was touched (mtime) at or after the moment the branch itself was created.
// Input:  Claude Code hook event JSON on stdin
// Output: for a `gh pr create` whose branch's todo.md predates the branch -> message on
//         stderr + exit 2 (block). Otherwise exit 0. No permissionDecision JSON on stdout —
//         unlike scope-guard.js/cmd-write-guard.js, this hook signals deny via exit code only
//         (2026-08-07 ruling): this harness has no other hook that emits an "allow" JSON, and
//         adding one here would short-circuit the permission check and make this hook's
//         composition with the rest of the PreToolUse chain unreadable.
//
// This is a "was todo.md TOUCHED" gate, not a "was todo.md written CORRECTLY" gate — it only
// compares two timestamps and never reads todo.md's content. tasks/todo.md is ONE file shared
// across every branch checked out in this working copy (git does not track it, CLAUDE.md §0);
// editing it while working on a DIFFERENT branch and then switching back to this one still
// satisfies the check, because only the mtime is compared, not which branch's work the edit
// actually described. This is a workflow-reminder device, not an adversarial control: both the
// judged signal (todo.md's mtime, see SEC-3 below) and the evidence used to detect evasion (the
// reflog file) are plain, unauthenticated files the same actor being gated can freely rewrite or
// delete — it exists to catch an honest miss, not to resist a determined bypass.
//
// Detection, no git subprocess (file reads only): reads .git/HEAD for the branch name and the
// FIRST line of .git/logs/refs/heads/<branch> (the "branch: Created from ..." reflog entry) for
// the branch's creation timestamp, then compares it against tasks/todo.md's mtime in the SAME
// repo root. `cd` inside the command is tracked (bash-only, bare `cd` with a literal, non-`$`,
// unsuffixed destination) so `cd dev/foo && gh pr create` is checked against dev/foo's own repo
// root (found by walking up from the effective cwd for a `.git` entry), not the workspace root —
// this is what makes a dev/{name} product-repo branch need no special-cased routing here.
// Directory-change constructs this cannot reliably follow — `pushd`/`popd`, PowerShell
// `Set-Location`/`sl`/`chdir`, a bare `cd` with no destination (-> $HOME), a `cd` whose
// destination contains `$` (variable expansion), a suffixed `cd.exe`/`cd.cmd`/`cd.com`/`cd.ps1`
// (or the `pushd`/`popd` equivalents), or any segment beginning with `(` (subshell/grouping
// entry) — make cwd tracking permanently uncertain from that point on: any `gh ... pr create`
// occurrence found AFTER one of these is skipped rather than answered against a stale/wrong cwd
// (see findPrCreateCwds() below for the exact rule). An occurrence found BEFORE the construct is
// unaffected — cwd tracking up to that point was exact, so it is still resolved and judged
// normally: e.g. `gh pr create -t x; cd` (a destination-less, therefore untrackable, `cd` AFTER
// the only occurrence) still denies against a stale todo.md — verified 2026-08-08. The command as
// a whole only resolves to fail-open (null) when EVERY occurrence ends up unresolved this way —
// no `gh ... pr create` is present at all, or the only occurrence(s) all come after an untrackable
// construct.
//
// EVERY `gh ... pr create` occurrence in the command is evaluated (not just the first) — if the
// command chains more than one (e.g. across `&&`/`;`), a deny on any one of them denies the whole
// command. The verdict is always computed against `.git/HEAD`'s CURRENT branch at the resolved
// cwd; a `gh pr create --head <other-branch>` targeting a different branch is judged using the
// checked-out branch, not `--head`'s value — this hook does not parse `--head`.
//
// Known non-coverage (deliberately not fixed here, same disclosure convention as
// block-direct-to-main.js's header — this is "a gate was added to the usual flow", NOT "todo
// update is now mandatory to open a PR"):
//   - `gh api --method POST repos/{o}/{r}/pulls` (a direct REST PR-create call), `hub
//     pull-request`, or a raw `curl` to the API — this hook only recognizes the `gh ... pr
//     create` shape, the same narrow scope block-direct-to-main.js's `gh pr merge` detection has.
//   - creating the PR from the GitHub website, or from another machine/clone entirely — neither
//     goes through this hook process at all (nothing here could close that; the website case is
//     not closeable in principle).
//   - every suffixed/wrapped/quoted-with-spaces spelling of `gh` that lib/parse-cmd.js's own
//     header still documents as unresolved: `gh.bat` (ruling G1, deliberately unstripped), an
//     unquoted "Program Files"-style spaced path, a backslash-separated path, and `eval.exe
//     "..."` (the inner command is never parsed because the extractor matches the raw text `eval
//     `, not `eval.exe `). (`sudo.exe`/`env.exe` wrapper peeling was previously listed here too,
//     but that was fixed 2026-08-06 in lib/parse-cmd.js — verified directly against this hook
//     2026-08-07: `sudo.exe gh pr create` and `env.exe gh pr create` both resolve and deny
//     correctly, so they are no longer a gap.)
//   - the shared tokenizer (lib/parse-cmd.js) splits only on `&&`/`||`/`;`/`|` — NOT on a literal
//     newline — so a `gh ... pr create` on any line but the first of a multi-line command is
//     never seen as its own segment and is not detected. `(gh pr create)` and `{ gh pr create; }`
//     also pass through undetected: the trailing `)` glues onto the preceding token (`create)`,
//     which no longer matches the literal `create`), and `{` becomes the opaque leading command
//     token itself, with `gh`/`pr`/`create` demoted to its args. Verified 2026-08-08 (all three
//     forms exit 0 against a fixture that a plain `gh pr create` correctly denies). Fixing the
//     tokenizer to also split on newlines is out of scope here — it is shared by every other
//     guard in this harness and needs its own impact review — disclosed, not fixed. (A
//     newline-splitting version of this tokenizer was tried and withdrawn 2026-08-08 after review
//     found several new bypasses it introduced elsewhere — not committed here.)
//   - the judged signal (tasks/todo.md's mtime) is plain filesystem state with no integrity
//     check: touching it to a future date once (via `touch`, an editor, or any other write)
//     satisfies this gate permanently for every later branch, regardless of what that later
//     branch's work actually was — verified 2026-08-07. Symmetrically, deleting the branch's own
//     `.git/logs/refs/heads/<branch>` reflog file makes branchCreatedMs() throw (see below) and
//     this hook fail OPEN — also verified 2026-08-07. Neither is fixed here; see the
//     workflow-reminder framing above.
//   - a branch name containing `/` or `..` is rejected by isSafeBranchName() (see below) as a
//     path-injection precaution, and currentBranch() then returns null the same as a detached
//     HEAD — so this gate is a permanent no-op (fail-open) for any nested branch name, including
//     an ordinary one like `feature/foo`, not just an adversarial one. Verified 2026-08-08: a
//     real repo checked out on `feature/foo` with tasks/todo.md pinned to predate the branch still
//     exits 0 (allowed). Deliberately left this way (a LOW-severity over-restriction, not fixed
//     here) rather than trusting a branch name read from an unauthenticated `.git/HEAD` file.
//   - H-2 (2026-08-12), the --base/-B check specifically: `gh pr create -dB develop` — a
//     CLUSTERED short flag, where `-d` (some boolean flag) and `-B` (value-taking) are combined
//     into one token, with `-B`'s value in a SEPARATE following token. findBadBaseValues() below
//     only recognizes `-B`/`--base` as a token's complete leading content (space-separated:
//     `-B develop`) or with a value attached to that same token (`-Bdevelop`, `-B=develop`) — it
//     never peels a leading or embedded `-B` off a multi-flag cluster, so `-dB develop` matches
//     neither branch and is not detected as a bad base. Deliberately not implemented: correctly
//     finding a cluster's boundary requires knowing gh's full boolean-vs-value-taking short-flag
//     surface (which short flags are booleans that can lead a cluster, and which take a value and
//     must end one) — the same class of hand-rolled CLI-grammar expansion the 2026-08-08 ruling on
//     lib/parse-cmd.js steered away from, even though this classification would live in this hook
//     file, not literally in parse-cmd.js. Disclosed, not fixed.
//
// Fail-open (exit 0) on ANY resolution failure — not a repo, detached HEAD, no reflog for the
// branch (e.g. a throwaway repo with no branch history yet), no tasks/todo.md, an unparsable
// reflog line, or a `.git` FILE (linked worktree / submodule checkout) whose `gitdir`/`commondir`
// pointer content doesn't match the shape resolveGitDir()/resolveCommonGitDir() expect — so this
// gate can never itself block the normal PR flow when it cannot determine an answer. A linked
// worktree with the NORMAL gitdir/commondir shape IS now resolved and correctly judged (verified
// 2026-08-07 against a real `git worktree add` checkout: before this fix it silently fell open
// because `.git/HEAD` was read as if `.git` were a directory when it is actually a file there;
// after the fix it reads the worktree's own HEAD and the main repo's shared reflog and denies
// correctly). Every other Bash|PowerShell-matched hook in this harness follows the same fail-open
// convention; this hook does not introduce a new fail-closed precedent.
//
// Batch A / A1 addition (2026-08-12): independently of the todo.md staleness check above, ANY
// `gh ... pr create` occurrence in the command carrying `--base <x>` / `-B <x>` / `--base=<x>`
// where `<x>` is neither `main` nor `master` is denied — CLAUDE.md §3 already states "one branch
// per work unit ... from up-to-date main ... one PR per branch"; this makes that already-documented
// policy mechanical (block-direct-to-main.js explicitly allowlists `gh pr create`, so nothing else
// sees this today). Detection (findBadBaseValues() below) is a SEPARATE pass over segments(command)
// that deliberately does NOT share findPrCreateCwds()'s cwd-tracking state: the base value is read
// straight from the command text, not from filesystem state, so it still fires on an occurrence
// found AFTER an untrackable cd/pushd/Set-Location construct — unlike the todo.md check, which
// fails open for such an occurrence because it cannot resolve which repo root to check. Same
// narrow shape as the todo.md detection above: only a literal `gh ... pr create` is recognized
// (`gh api`, `hub pull-request`, a raw curl, the GitHub web UI, and a later `gh pr edit --base` are
// all invisible to this hook, same as the Known non-coverage list above), and the same tokenizer
// limits apply (no newline-splitting, no `(...)`/`{...}` grouping — see lib/parse-cmd.js's header).
//
// Batch A / A5 addition (2026-08-12): the SAME mtime-vs-branch-creation comparison above, applied
// to tasks/CODEMAP.md in the same resolved repo root, opt-in — a repo root with no CODEMAP.md is
// unaffected (isCodemapStaleForBranch() fails open exactly like isTodoStaleForBranch() does for a
// repo with no reflog or no branch; see that function below). Same disclosure as the todo.md gate
// above: this compares ONLY the file's mtime, never its content, so touching CODEMAP.md once with
// no real update satisfies this gate the same way todo.md's own gate can be satisfied without a
// real update — a workflow-reminder device, not an adversarial control (see the second header
// paragraph above). The honest, cheap way to pass this gate on a branch that changed none of the
// structure the map describes is to update just the map's `最終確認: YYYY-MM-DD` line (contract:
// .claude/rules/session-persistence.md §6.5).

const fs = require('node:fs');
const path = require('node:path');
const { segments } = require('./lib/parse-cmd');
const { findSubcmdIndex } = require('./lib/git-parse');

// Mirrors block-direct-to-main.js's own local GH_GLOBAL_VALUE_FLAGS (gh's global value-consuming
// flags) — duplicated here rather than shared via a lib export, following that file's existing
// convention of a per-hook local copy.
const GH_GLOBAL_VALUE_FLAGS = new Set(['-R', '--repo']);

const DENY_MESSAGE =
  'BLOCKED: gh pr create の前に、tasks/todo.md を今回の作業内容に合わせて更新してから、もう一度実行してください。';

// A1 (2026-08-12): see the header paragraph above for why and what this cannot see (gh api, the
// GitHub web UI, a later `gh pr edit --base`).
function denyBaseMessage(base) {
  return (
    `BLOCKED: gh pr create の --base が "${base}" になっています。PR の宛先は main（または master）にしてください。\n` +
    `前の PR がマージされてから、あらためて main を最新化した上で次の枝を切ってください。\n` +
    `（このチェックは GitHub の Web 画面での作成、gh api 経由の作成、後から行う gh pr edit --base の変更まではカバーしていません。）`
  );
}

// A5 (2026-08-12): see the header paragraph above for why this is opt-in and what it does not
// check (mtime only, never content — a workflow reminder, not an adversarial control).
const DENY_CODEMAP_MESSAGE =
  'BLOCKED: gh pr create の前に、tasks/CODEMAP.md を確認してください。構造に変更があれば内容を更新し、無ければ「最終確認: YYYY-MM-DD」の行だけ今日の日付にしてから、もう一度実行してください。\n' +
  '（これはファイルの更新日時だけを比較する仕組みで、内容までは見ていません。更新し忘れを防ぐためのものです。）';

// Directory-change command names this hook cannot reliably follow (see header) — PowerShell's
// Set-Location/its aliases, and bash's pushd/popd (which, unlike `cd`, this hook never tracks at
// all, matching lib/cmd-targets.js's own precise-mode scope note for pushd/popd).
const UNTRACKABLE_CWD_CMDS = new Set(['pushd', 'popd', 'set-location', 'sl', 'chdir']);

// A suffixed cd/pushd/popd spelling (cd.exe, pushd.cmd, ...). lib/parse-cmd.js's CWD_BUILTINS
// exception deliberately leaves these suffixed rather than normalizing them to the bare name,
// since as a child process none of them could ever move the parent shell's cwd — but this hook
// cannot tell a real suffixed invocation (a no-op) apart from a shell that actually changed
// directory via a same-named token it failed to normalize, so it treats the suffixed form as
// untrackable rather than silently keeping the previous (possibly stale) cwd.
const SUFFIXED_CWD_BUILTIN_RE = /^(?:cd|pushd|popd)\.(?:exe|cmd|com|ps1)$/;

function isUntrackableCwdCmd(cmd) {
  return UNTRACKABLE_CWD_CMDS.has(cmd) || SUFFIXED_CWD_BUILTIN_RE.test(cmd);
}

// Independent of findPrCreateCwds() below (see the A1 header paragraph for why): scans every
// `gh ... pr create` occurrence in `command` for a --base/-B/--base=<x> value that is neither
// `main` nor `master`, and returns every such value found (in order, possibly with duplicates —
// the caller only looks at [0] and .length). Returns an empty array when no occurrence carries a
// bad base, including when there is no `gh ... pr create` occurrence at all — never null, since
// the caller only checks .length, not identity.
// H-2 (2026-08-12): a quoted value survives as ONE token with its quote characters still
// attached when it reaches here (e.g. --base="main" -> value === '"main"') --
// lib/parse-cmd.js's tokenizer only strips a quote pair spanning a token's FULL width from the
// start, not one that begins mid-token after '='; fixing the tokenizer itself is out of bounds
// here (2026-08-08 ruling). Stripping one matching leading/trailing quote pair locally is enough
// to stop --base="main" from being misread as a bad base value and denied with a confusing
// `""main""` message (M-1, 2026-08-12).
function stripMatchingQuotes(v) {
  if (v == null || v.length < 2) return v;
  const first = v[0];
  const last = v[v.length - 1];
  if ((first === '"' && last === '"') || (first === "'" && last === "'")) return v.slice(1, -1);
  return v;
}

function findBadBaseValues(command) {
  const badBases = [];
  for (const { cmd, args } of segments(command)) {
    if (cmd !== 'gh') continue;
    const i = findSubcmdIndex(args, GH_GLOBAL_VALUE_FLAGS);
    if (i < 0 || args[i] !== 'pr') continue;
    const rest = args.slice(i + 1);
    const j = findSubcmdIndex(rest, GH_GLOBAL_VALUE_FLAGS);
    if (j < 0 || rest[j] !== 'create') continue;
    const createArgs = rest.slice(j + 1);
    for (let k = 0; k < createArgs.length; k++) {
      const a = createArgs[k];
      let value = null;
      if (a === '--base' || a === '-B') value = createArgs[k + 1];
      else if (a.startsWith('--base=')) value = a.slice('--base='.length);
      // H-2 (2026-08-12): -B's value can also be attached directly to the flag, getopt/pflag
      // short-option style (-Bdevelop), or joined with a literal '=' (-B=develop) -- both were
      // previously invisible here, unlike --base's own space- and '='-separated forms just above.
      // Deliberately NOT handled: a CLUSTERED short flag (e.g. -dB develop, with -d and -B combined
      // into one token) -- see the header's Known non-coverage list for the decision and why.
      else if (a.startsWith('-B') && a !== '-B') value = a.slice(2).replace(/^=/, '');
      value = stripMatchingQuotes(value);
      if (value != null && value !== 'main' && value !== 'master') {
        badBases.push(value);
        break;
      }
    }
  }
  return badBases;
}

// Find the effective cwd of EVERY `gh ... pr create` occurrence within `command`, tracking `cd`
// across segments in order (see header for the precise/non-liberal cd-tracking scope and the full
// list of untrackable move constructs). Returns an array of cwds — one per occurrence whose cwd
// was actually resolvable, in the order found, possibly with duplicates if the cwd didn't change
// between two occurrences — or null if no occurrence was found, OR every occurrence found had an
// unresolvable cwd.
//
// Once an untrackable move construct (subshell/grouping entry, pushd/popd, Set-Location and its
// aliases, a suffixed cd/pushd/popd, a destination-less `cd`, or a `cd` whose destination contains
// `$`) is seen, cwd tracking becomes permanently uncertain from that point onward — `cur` is no
// longer trusted, later `cd`s are not applied, and any LATER `gh ... pr create` occurrence is
// skipped (not resolved, not added to the returned array) rather than evaluated against a stale or
// guessed cwd. An occurrence found BEFORE the untrackable construct is unaffected and still
// resolves normally: cwd tracking up to that point was exact, so there is no reason to also
// discard those already-correct results (2026-08-07 fix — previously ANY untrackable construct
// ANYWHERE in the command, including after the last relevant occurrence, discarded every
// occurrence found so far and made the whole command fail open; see hook-probes.samples.json
// S-pr-todo/pt-deny-pushd-after-create for the regression pin).
function findPrCreateCwds(command, startCwd) {
  let cur = startCwd;
  let cwdUnknown = false;
  const cwds = [];
  for (const { cmd, args } of segments(command)) {
    // A subshell/grouping entry: lib/parse-cmd.js glues a leading '(' onto the command token
    // (`(cd` -> cmd "(cd", `(gh` -> cmd "(gh") and this hook does not scope cwd changes to the
    // subshell, so it cannot tell whether a real shell actually changed directory inside one.
    if (cmd.startsWith('(') || isUntrackableCwdCmd(cmd)) {
      cwdUnknown = true;
      continue;
    }

    if (cmd === 'gh') {
      const i = findSubcmdIndex(args, GH_GLOBAL_VALUE_FLAGS);
      if (i >= 0 && args[i] === 'pr') {
        const rest = args.slice(i + 1);
        const j = findSubcmdIndex(rest, GH_GLOBAL_VALUE_FLAGS);
        if (j >= 0 && rest[j] === 'create' && !cwdUnknown) cwds.push(cur);
      }
    }
    if (cmd === 'cd' && !cwdUnknown) {
      const dest = args.filter((a) => !a.startsWith('-'))[0];
      // No destination (-> $HOME) or a variable-expanded destination ($VAR): this hook has no
      // shell to resolve either against, so cwd tracking becomes uncertain from here on rather
      // than keeping the previous (now-stale) cwd.
      if (!dest || dest.includes('$')) {
        cwdUnknown = true;
        continue;
      }
      cur = path.resolve(cur, dest);
    }
  }
  return cwds.length > 0 ? cwds : null;
}

// Walk up from `startDir` looking for a `.git` entry (dir or file). Returns the containing dir
// (the repo root: the workspace root if startDir is under it directly, or a dev/{name} product
// repo's own root if it has its own .git), or null if none is found (filesystem root reached).
// `.git` being a FILE (a linked worktree or submodule checkout) is deliberately still accepted
// here — resolveGitDir()/resolveCommonGitDir() below are what actually read that file's content;
// this function only locates it.
function findRepoRoot(startDir) {
  let dir = path.resolve(startDir);
  for (;;) {
    if (fs.existsSync(path.join(dir, '.git'))) return dir;
    const up = path.dirname(dir);
    if (up === dir) return null;
    dir = up;
  }
}

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

// A branch name is only trusted when it is a single path segment: it is used verbatim as the last
// path.join() argument building the reflog path in branchCreatedMs() below, and path.join()
// SILENTLY COLLAPSES ".." components rather than rejecting them — a HEAD file containing
// `ref: refs/heads/../heads/main` (something git's own `checkout -b` refuses to create, but this
// hook reads HEAD as a plain file with no such validation) would redirect branchCreatedMs() to a
// DIFFERENT branch's real reflog instead of failing to resolve. Rejecting any "/" also means a
// legitimate nested branch name (e.g. "feature/foo") is treated as unresolvable (fails open) —
// a deliberate over-restriction for this LOW-severity fix rather than a real, common case.
function isSafeBranchName(branch) {
  return !/[\\/]/.test(branch) && !branch.includes('..');
}

// The branch HEAD currently points to, or null for a detached HEAD OR an unsafe branch name (see
// isSafeBranchName() above — the caller treats null the same as a detached HEAD: fail open). HEAD
// is read from `gitDir` itself (not the common dir): a linked worktree's checked-out branch is
// recorded in its OWN per-worktree HEAD file, distinct from the main checkout's HEAD.
function currentBranch(repoRoot) {
  const gitDir = resolveGitDir(repoRoot);
  const head = fs.readFileSync(path.join(gitDir, 'HEAD'), 'utf8').trim();
  const m = head.match(/^ref:\s*refs\/heads\/(.+)$/);
  if (!m) return null;
  return isSafeBranchName(m[1]) ? m[1] : null;
}

// The branch's creation time (ms since epoch), read from the FIRST line of its reflog file — the
// "branch: Created from ..." entry git writes when the branch is created. Reflog line shape:
// "<old-sha> <new-sha> <name-with-spaces> <email> <timestamp> <tz>\t<message>" — the committer
// name can contain spaces, so this takes the LAST two whitespace-separated tokens before the tab
// (timestamp, tz) rather than a fixed field index. THROWS (does not return null) if the reflog
// file doesn't exist (e.g. a throwaway repo with no branch history yet, or a branch that predates
// any reflog) — fs.readFileSync's ENOENT propagates to the caller, whose own try/catch is what
// actually produces the fail-open result for that case, not a null return from this function.
// Only returns null (a value the caller also treats as fail-open) when the file DOES exist but its
// first line's timestamp field doesn't parse as a number. The reflog always lives under the
// COMMON git dir (resolveCommonGitDir()), not necessarily `repoRoot`'s own gitdir — for a linked
// worktree these differ (see resolveCommonGitDir() above); for a normal checkout or a submodule
// they are the same directory, so this is a no-op there.
function branchCreatedMs(repoRoot, branch) {
  const commonDir = resolveCommonGitDir(resolveGitDir(repoRoot), repoRoot);
  const reflogPath = path.join(commonDir, 'logs', 'refs', 'heads', branch);
  const firstLine = fs.readFileSync(reflogPath, 'utf8').split('\n')[0] || '';
  const fields = firstLine.split('\t')[0].trim().split(/\s+/);
  const ts = Number(fields[fields.length - 2]);
  return Number.isFinite(ts) ? ts * 1000 : null;
}

// Per-occurrence verdict for one `gh ... pr create`'s resolved cwd: true only if the repo root,
// branch, and reflog all resolve AND todo.md's mtime predates the branch's creation. Any
// resolution failure at any step (not a repo, detached HEAD, no reflog, no tasks/todo.md, an
// unparsable reflog line) returns false (fail-open for THIS occurrence) — this is the same
// single-occurrence fail-open behavior this hook always had, now applied per-occurrence since
// every occurrence in the command is evaluated (see findPrCreateCwds above).
function isTodoStaleForBranch(cwd) {
  try {
    const repoRoot = findRepoRoot(cwd);
    if (!repoRoot) return false;
    const branch = currentBranch(repoRoot);
    if (!branch) return false;
    const createdMs = branchCreatedMs(repoRoot, branch);
    if (createdMs === null) return false;
    const todoMtimeMs = fs.statSync(path.join(repoRoot, 'tasks', 'todo.md')).mtimeMs;
    return todoMtimeMs < createdMs;
  } catch {
    return false;
  }
}

// A5 (2026-08-12): same comparison as isTodoStaleForBranch() above, applied to tasks/CODEMAP.md —
// opt-in: a repo root with no CODEMAP.md fails open here (fs.statSync throws ENOENT, caught below,
// same as every other resolution failure this file treats as fail-open), so a project that has not
// adopted the CODEMAP mechanism is unaffected. Mirrors isTodoStaleForBranch()'s structure rather
// than sharing code with it, so each function's fail-open shape stays independently readable
// (CLAUDE.md §1.7) — the two differ only in which file's mtime is compared.
function isCodemapStaleForBranch(cwd) {
  try {
    const repoRoot = findRepoRoot(cwd);
    if (!repoRoot) return false;
    const branch = currentBranch(repoRoot);
    if (!branch) return false;
    const createdMs = branchCreatedMs(repoRoot, branch);
    if (createdMs === null) return false;
    const codemapMtimeMs = fs.statSync(path.join(repoRoot, 'tasks', 'CODEMAP.md')).mtimeMs;
    return codemapMtimeMs < createdMs;
  } catch {
    return false;
  }
}

let data = '';
process.stdin.on('data', (c) => (data += c));
process.stdin.on('end', () => {
  try {
    const payload = JSON.parse(data);
    if (!['Bash', 'PowerShell'].includes(payload.tool_name)) process.exit(0);
    const command = String(payload.tool_input?.command || '');
    if (!command) process.exit(0);

    const badBases = findBadBaseValues(command);
    if (badBases.length > 0) {
      console.error(denyBaseMessage(badBases[0]));
      process.exit(2);
    }

    const prCreateCwds = findPrCreateCwds(command, payload.cwd || process.cwd());
    if (!prCreateCwds) process.exit(0);

    // L-2 (2026-08-12): todo.md and CODEMAP.md staleness are two independent, opt-in checks (see
    // the A5 header paragraph) over the SAME cwd list — both are evaluated and reported together
    // in one message when both fire, rather than exiting on the first and leaving the second
    // failure for a follow-up run to discover.
    const todoStale = prCreateCwds.some((cwd) => isTodoStaleForBranch(cwd));
    const codemapStale = prCreateCwds.some((cwd) => isCodemapStaleForBranch(cwd));
    if (todoStale || codemapStale) {
      const messages = [];
      if (todoStale) messages.push(DENY_MESSAGE);
      if (codemapStale) messages.push(DENY_CODEMAP_MESSAGE);
      console.error(messages.join('\n\n'));
      process.exit(2);
    }
    process.exit(0);
  } catch {
    process.exit(0);
  }
});
