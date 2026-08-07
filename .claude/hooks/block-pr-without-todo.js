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
// Every directory-change construct this cannot reliably follow — `pushd`/`popd`, PowerShell
// `Set-Location`/`sl`/`chdir`, a bare `cd` with no destination (-> $HOME), a `cd` whose
// destination contains `$` (variable expansion), a suffixed `cd.exe`/`cd.cmd`/`cd.com`/`cd.ps1`
// (or the `pushd`/`popd` equivalents), or any segment beginning with `(` (subshell/grouping
// entry) — makes the WHOLE command resolve to fail-open (null), not just that one segment: once
// cwd tracking is uncertain, evaluating a later `gh ... pr create` against a stale/wrong cwd would
// answer using the WRONG repo's todo.md/branch (a false deny OR a false allow), which is worse
// than not answering at all.
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
//     token itself, with `gh`/`pr`/`create` demoted to its args. Verified 2026-08-07 (all three
//     forms exit 0 against a fixture that a plain `gh pr create` correctly denies). Fixing the
//     tokenizer to also split on newlines is out of scope here — it is shared by every other
//     guard in this harness and needs its own impact review — disclosed, not fixed.
//   - the judged signal (tasks/todo.md's mtime) is plain filesystem state with no integrity
//     check: touching it to a future date once (via `touch`, an editor, or any other write)
//     satisfies this gate permanently for every later branch, regardless of what that later
//     branch's work actually was — verified 2026-08-07. Symmetrically, deleting the branch's own
//     `.git/logs/refs/heads/<branch>` reflog file makes branchCreatedMs() throw (see below) and
//     this hook fail OPEN — also verified 2026-08-07. Neither is fixed here; see the
//     workflow-reminder framing above.
//   - a linked worktree or a submodule checkout has `.git` as a FILE, not a directory. findRepoRoot()
//     only checks `fs.existsSync(path.join(dir, '.git'))`, which is true for a file too, so it
//     stops there and treats the worktree/submodule directory itself as the repo root; the
//     subsequent `.git/HEAD` read then tries to treat that file as a directory, throws, and the
//     outer try/catch turns that into a silent fail-open (exit 0) — verified 2026-08-07 against a
//     real `git worktree add` checkout. Not fixed here, only disclosed; this is a realistic path
//     in this harness since review seats are documented to run from a throwaway worktree.
//
// Fail-open (exit 0) on ANY resolution failure — not a repo, detached HEAD, no reflog for the
// branch (e.g. a throwaway repo with no branch history yet), no tasks/todo.md, an unparsable
// reflog line — so this gate can never itself block the normal PR flow when it cannot determine
// an answer. Every other Bash|PowerShell-matched hook in this harness follows the same
// fail-open convention; this hook does not introduce a new fail-closed precedent.

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

// Find the effective cwd of EVERY `gh ... pr create` occurrence within `command`, tracking `cd`
// across segments in order (see header for the precise/non-liberal cd-tracking scope and the full
// list of untrackable move constructs). Returns an array of cwds — one per occurrence, in the
// order found, possibly with duplicates if the cwd didn't change between two occurrences — or
// null if no occurrence was found, OR an untrackable move construct was seen ANYWHERE in the
// command (before, between, or after any occurrence): once cwd tracking is uncertain for any part
// of the command, this bails on the whole command rather than return a partial/possibly-wrong
// result for occurrences it did resolve.
function findPrCreateCwds(command, startCwd) {
  let cur = startCwd;
  const cwds = [];
  for (const { cmd, args } of segments(command)) {
    // A subshell/grouping entry: lib/parse-cmd.js glues a leading '(' onto the command token
    // (`(cd` -> cmd "(cd", `(gh` -> cmd "(gh") and this hook does not scope cwd changes to the
    // subshell, so it cannot tell whether a real shell actually changed directory inside one.
    if (cmd.startsWith('(')) return null;
    if (isUntrackableCwdCmd(cmd)) return null;

    if (cmd === 'gh') {
      const i = findSubcmdIndex(args, GH_GLOBAL_VALUE_FLAGS);
      if (i >= 0 && args[i] === 'pr') {
        const rest = args.slice(i + 1);
        const j = findSubcmdIndex(rest, GH_GLOBAL_VALUE_FLAGS);
        if (j >= 0 && rest[j] === 'create') cwds.push(cur);
      }
    }
    if (cmd === 'cd') {
      const dest = args.filter((a) => !a.startsWith('-'))[0];
      // No destination (-> $HOME) or a variable-expanded destination ($VAR): this hook has no
      // shell to resolve either against, so bail rather than keep the previous (now-stale) cwd.
      if (!dest || dest.includes('$')) return null;
      cur = path.resolve(cur, dest);
    }
  }
  return cwds.length > 0 ? cwds : null;
}

// Walk up from `startDir` looking for a `.git` entry (dir or file). Returns the containing dir
// (the repo root: the workspace root if startDir is under it directly, or a dev/{name} product
// repo's own root if it has its own .git), or null if none is found (filesystem root reached).
function findRepoRoot(startDir) {
  let dir = path.resolve(startDir);
  for (;;) {
    if (fs.existsSync(path.join(dir, '.git'))) return dir;
    const up = path.dirname(dir);
    if (up === dir) return null;
    dir = up;
  }
}

// The branch HEAD currently points to, or null for a detached HEAD.
function currentBranch(repoRoot) {
  const head = fs.readFileSync(path.join(repoRoot, '.git', 'HEAD'), 'utf8').trim();
  const m = head.match(/^ref:\s*refs\/heads\/(.+)$/);
  return m ? m[1] : null;
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
// first line's timestamp field doesn't parse as a number.
function branchCreatedMs(repoRoot, branch) {
  const reflogPath = path.join(repoRoot, '.git', 'logs', 'refs', 'heads', branch);
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

let data = '';
process.stdin.on('data', (c) => (data += c));
process.stdin.on('end', () => {
  try {
    const payload = JSON.parse(data);
    if (!['Bash', 'PowerShell'].includes(payload.tool_name)) process.exit(0);
    const command = String(payload.tool_input?.command || '');
    if (!command) process.exit(0);

    const prCreateCwds = findPrCreateCwds(command, payload.cwd || process.cwd());
    if (!prCreateCwds) process.exit(0);

    if (prCreateCwds.some((cwd) => isTodoStaleForBranch(cwd))) {
      console.error(DENY_MESSAGE);
      process.exit(2);
    }
    process.exit(0);
  } catch {
    process.exit(0);
  }
});
