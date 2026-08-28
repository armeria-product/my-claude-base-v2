// node --test ".claude/hooks/lib/*.test.js" ".claude/scripts/*.test.mjs"   (全テスト)
// node .claude/hooks/lib/hook-probes.test.js --set <SET_NAME> --out <FILE>   (単一セットのTSVダンプ; --set 省略で全件)
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const SANDBOX = path.join(ROOT, 'tmp', 'hook-probes', 'sandbox');
const SANDBOX_FREE = path.join(ROOT, 'tmp', 'hook-probes', 'sandbox-free');
const SANDBOX_GIT = path.join(ROOT, 'tmp', 'hook-probes', 'sandbox-git');
// ff5d0d7 (2026-08-06 ruling Q2) fast-forward catch-up exception probes for block-direct-to-main.js:
// a REAL git repo, checked out on `main` with `origin/main` set as its tracked upstream, targeted
// via `git -C <path>` in the sample commands. This sidesteps any dependency on the actual current
// branch of <REPO> (which varies by session/branch and would otherwise need a skipIf tag symmetric
// to -- but inverted from -- the existing 'protected-branch' one; not built, see hook-probes.samples.json).
const SANDBOX_GIT_MAIN = path.join(ROOT, 'tmp', 'hook-probes', 'sandbox-git-main');
// fable-gate (2026-08-06): four switch-file roots for block-fable-when-off.js probes. Each is
// rooted under tmp/ (gitignored), never <REPO> — the real .claude/.fable-status is machine-local
// and its content is arbitrary, so a <REPO>-rooted fable row would be flaky.
const SANDBOX_FABLE_ON = path.join(ROOT, 'tmp', 'hook-probes', 'sandbox-fable-on');
const SANDBOX_FABLE_ON_MESSY = path.join(ROOT, 'tmp', 'hook-probes', 'sandbox-fable-on-messy');
const SANDBOX_FABLE_OFF = path.join(ROOT, 'tmp', 'hook-probes', 'sandbox-fable-off');
const SANDBOX_FABLE_ONX = path.join(ROOT, 'tmp', 'hook-probes', 'sandbox-fable-onx');
// todo-gate-sweep Batch 3 (2026-08-07): three real git repos for block-pr-without-todo.js
// probes, rooted under tmp/ (gitignored), never <REPO> — the real workspace's tasks/todo.md and
// current branch vary by session (same flakiness reason SANDBOX_GIT_MAIN was built to avoid for
// block-direct-to-main.js). Deny/allow are made deterministic via fs.utimesSync pinning
// tasks/todo.md's mtime to a fixed far-past/far-future date, rather than relying on real
// wall-clock ordering against git's 1-second-granularity reflog timestamp (see
// buildSandboxTodoRepo() below).
const SANDBOX_TODO_DENY = path.join(ROOT, 'tmp', 'hook-probes', 'sandbox-todo-deny');
const SANDBOX_TODO_ALLOW = path.join(ROOT, 'tmp', 'hook-probes', 'sandbox-todo-allow');
const SANDBOX_TODO_NOREFLOG = path.join(ROOT, 'tmp', 'hook-probes', 'sandbox-todo-noreflog');
// todo-gate-sweep P2 item 1 (2026-08-07): a REAL linked worktree (`.git` there is a FILE, not a
// directory) for block-pr-without-todo.js's worktree-resolution fix (resolveGitDir()/
// resolveCommonGitDir()). SANDBOX_TODO_WORKTREE_BASE is the main checkout the worktree is linked
// from; SANDBOX_TODO_WORKTREE is the linked worktree itself.
const SANDBOX_TODO_WORKTREE_BASE = path.join(ROOT, 'tmp', 'hook-probes', 'sandbox-todo-wt-base');
const SANDBOX_TODO_WORKTREE = path.join(ROOT, 'tmp', 'hook-probes', 'sandbox-todo-wt');
// todo-gate-sweep P3 item 2 (2026-08-07): fixtures for block-pr-without-todo.js's gitdir/commondir/
// branch-name bound-check fix. SANDBOX_TODO_GITDIR_ESCAPE_TARGET is NOT named ".git" on purpose
// (see buildSandboxTodoGitdirEscape() below); SANDBOX_TODO_BRANCH_ESCAPE gets a hand-written HEAD.
const SANDBOX_TODO_GITDIR_ESCAPE = path.join(ROOT, 'tmp', 'hook-probes', 'sandbox-todo-gitdir-escape');
const SANDBOX_TODO_GITDIR_ESCAPE_TARGET = path.join(ROOT, 'tmp', 'hook-probes', 'evil-gitdir-store');
const SANDBOX_TODO_BRANCH_ESCAPE = path.join(ROOT, 'tmp', 'hook-probes', 'sandbox-todo-branch-escape');
// Batch A / A5 (2026-08-12): tasks/codemap.md mtime-vs-branch-creation fixtures for
// block-pr-without-todo.js's isCodemapStaleForBranch() check, same shape as the SANDBOX_TODO_*
// pair above but for codemap.md instead of todo.md. See buildSandboxCodemapSandboxes() below.
const SANDBOX_CODEMAP_DENY = path.join(ROOT, 'tmp', 'hook-probes', 'sandbox-codemap-deny');
const SANDBOX_CODEMAP_ALLOW_NEWER = path.join(ROOT, 'tmp', 'hook-probes', 'sandbox-codemap-allow-newer');
// Batch A / A3 (2026-08-12): relay ON, for relay-required-agent.js's new description/alias
// transparency check. Needs its own relay-ON root (not SANDBOX_FREE, which is relay OFF and
// already used by 3 existing relay-OFF rows) — see buildSandboxRelayOn() below for why.
const SANDBOX_RELAY_ON = path.join(ROOT, 'tmp', 'hook-probes', 'sandbox-relay-on');
// M1 (2026-08-13, cycle-2 authority review): a self-contained root (its own CLAUDE_PROJECT_DIR,
// like SANDBOX_FABLE_ON/SANDBOX_RELAY_ON above) for pinning block-destructive-git.js's
// realpathSync() junction-following. It must be self-contained rather than reusing <REPO>: every
// existing SANDBOX_* root here already lives under <REPO>/tmp/hook-probes/..., so relative to the
// REAL repo root every one of them already has a `tmp` path segment -- a junction planted inside
// one would be exempted by the naive raw-spelling check regardless of whether realpath-following
// works, giving zero detection power for that specific fix. Rooting this sandbox's OWN
// CLAUDE_PROJECT_DIR at itself (see buildSandboxJunction() below) makes `real-target/` -- the
// junction's actual destination -- NOT contain a `tmp` segment relative to that root, while the
// junction's own path (`tmp/jdir/...`) does, isolating the realpath fix as the only thing that can
// produce a deny here.
const SANDBOX_JUNCTION = path.join(ROOT, 'tmp', 'hook-probes', 'sandbox-junction');
const SAMPLES_FILE = path.join(__dirname, 'hook-probes.samples.json');
const PROTECTED_BRANCHES = new Set(['main', 'master']);

function slash(p) {
  return p.split(path.sep).join('/');
}

function ensureJournal(root) {
  const now = new Date();
  const two = (n) => String(n).padStart(2, '0');
  const yyyyMm = `${now.getFullYear()}-${two(now.getMonth() + 1)}`;
  const dd = two(now.getDate());
  const journalDir = path.join(root, 'tasks', 'journal', yyyyMm);
  fs.mkdirSync(journalDir, { recursive: true });
  const journalFile = path.join(journalDir, `${dd}.md`);
  if (!fs.existsSync(journalFile)) {
    fs.writeFileSync(journalFile, `# ${yyyyMm}-${dd} sandbox journal (hook-probes.test.js)\n\n`);
  }
}

function buildSandbox() {
  fs.mkdirSync(path.join(SANDBOX, 'dev', 'foo'), { recursive: true });

  ensureJournal(SANDBOX);

  // A real, existing regular file under this tmp-rooted sandbox — gp-redirect-scratch-exempt-
  // allowed (S-git-pure) redirects a `git show` into it to probe block-destructive-git.js's
  // scratch exemption.
  fs.writeFileSync(path.join(SANDBOX, 'scratch.txt'), 'scratch\n');
}

function buildSandboxFree() {
  fs.mkdirSync(path.join(SANDBOX_FREE, '.claude', 'state'), { recursive: true });
  fs.mkdirSync(path.join(SANDBOX_FREE, '.claude', 'agents'), { recursive: true });
  fs.mkdirSync(path.join(SANDBOX_FREE, 'clover'), { recursive: true });
  fs.writeFileSync(
    path.join(SANDBOX_FREE, '.claude', 'agents', 'reviewer.md'),
    '---\nname: reviewer\nmodel: fable\neffort: max\n---\n'
  );
  fs.writeFileSync(
    path.join(SANDBOX_FREE, '.claude', 'agents', 'reviewer-clover.md'),
    '---\nname: reviewer-clover\nmodel: claude-probe-ext\neffort: max\n---\n'
  );
  fs.writeFileSync(
    path.join(SANDBOX_FREE, 'clover', 'models.json'),
    JSON.stringify({ models: [{ alias: 'probe-ext', model: 'probe-ext-upstream', format: 'openai', via: 'codex' }] })
  );
  ensureJournal(SANDBOX_FREE);
}

// A real (throwaway) git repo, for check-commit-safety.js: that hook inspects `git diff --cached`
// against whatever repo the command is run in, so testing it — unlike every other hook here — needs
// an actual staged change, not just a payload.cwd path. leaky.js is staged (not committed; the hook
// never runs the commit itself, only the PreToolUse check before one) with a console.log so the
// DEBUG_PATTERN deny branch is exercised without touching this repo's own git state.
function buildSandboxGit() {
  fs.mkdirSync(SANDBOX_GIT, { recursive: true });
  execFileSync('git', ['init', '-q'], { cwd: SANDBOX_GIT });
  fs.writeFileSync(path.join(SANDBOX_GIT, 'leaky.js'), 'function f() {\n  console.log("debug");\n}\n');
  execFileSync('git', ['add', 'leaky.js'], { cwd: SANDBOX_GIT });
}

// A second real (throwaway) git repo, checked out on `main` with `origin/main` configured as its
// tracked upstream (@{u}) — the fixture the isFastForwardCatchUp() exception in
// block-direct-to-main.js needs to be probed at all: it requires an actual resolvable @{u}, which
// `git rev-parse --abbrev-ref --symbolic-full-name @{u}` can only answer from real git state, not
// a payload field. Guarded by a check for its OWN .git dir (fs.existsSync, not `git rev-parse
// --verify HEAD` — that command walks up to the ENCLOSING repo's .git when SANDBOX_GIT_MAIN has
// none of its own yet, so it would falsely report "already has a commit" on a bare directory and
// skip init entirely) so re-running the test suite never re-inits/re-commits (git init/add are
// already idempotent elsewhere in this file, but `git commit` is not — a bare re-commit with no
// changes would fail with "nothing to commit" on the 2nd run).
function buildSandboxGitMain() {
  fs.mkdirSync(SANDBOX_GIT_MAIN, { recursive: true });
  if (fs.existsSync(path.join(SANDBOX_GIT_MAIN, '.git'))) return;
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: SANDBOX_GIT_MAIN });
  execFileSync('git', ['config', 'user.email', 'probe@example.com'], { cwd: SANDBOX_GIT_MAIN });
  execFileSync('git', ['config', 'user.name', 'probe'], { cwd: SANDBOX_GIT_MAIN });
  fs.writeFileSync(path.join(SANDBOX_GIT_MAIN, 'f.txt'), 'x\n');
  execFileSync('git', ['add', 'f.txt'], { cwd: SANDBOX_GIT_MAIN });
  execFileSync('git', ['commit', '-q', '-m', 'init'], { cwd: SANDBOX_GIT_MAIN });
  const sha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: SANDBOX_GIT_MAIN, encoding: 'utf8' }).trim();
  execFileSync('git', ['update-ref', 'refs/remotes/origin/main', sha], { cwd: SANDBOX_GIT_MAIN });
  execFileSync('git', ['remote', 'add', 'origin', 'https://example.invalid/probe.git'], { cwd: SANDBOX_GIT_MAIN });
  execFileSync('git', ['branch', '--set-upstream-to=origin/main', 'main'], { cwd: SANDBOX_GIT_MAIN });
}

// fable-gate (2026-08-06): each root gets the frontmatter-route fixture (reviewer.md with
// model: fable) plus a .claude/.fable-status with the given content. ensureJournal() is not
// needed here — block-fable-when-off.js writes nothing.
function buildFableSandbox(root, statusContent) {
  fs.mkdirSync(path.join(root, '.claude', 'agents'), { recursive: true });
  fs.writeFileSync(
    path.join(root, '.claude', 'agents', 'reviewer.md'),
    '---\nname: reviewer\nmodel: fable\neffort: max\n---\n'
  );
  fs.writeFileSync(path.join(root, '.claude', '.fable-status'), statusContent);
}

function buildFableSandboxes() {
  buildFableSandbox(SANDBOX_FABLE_ON, 'ON\n');
  buildFableSandbox(SANDBOX_FABLE_ON_MESSY, '  on \t\n');
  buildFableSandbox(SANDBOX_FABLE_OFF, 'OFF\n');
  buildFableSandbox(SANDBOX_FABLE_ONX, 'ONX\n');
}

// todo-gate-sweep Batch 3 (2026-08-07): a real git repo with one commit on `main` (so a `topic`
// branch can be created from it — an empty repo has no commit to branch from, and no reflog
// entry gets written until a ref actually moves) and a tasks/todo.md file, then `topic` is
// checked out (the reflog "branch: Created from HEAD" entry block-pr-without-todo.js reads is
// written at THIS checkout, before any further commits happen on topic — matching how a real
// `git switch -c <branch> main` records branch-creation time separately from later work).
function buildSandboxTodoRepo(root) {
  fs.mkdirSync(root, { recursive: true });
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: root });
  execFileSync('git', ['config', 'user.email', 'probe@example.com'], { cwd: root });
  execFileSync('git', ['config', 'user.name', 'probe'], { cwd: root });
  fs.mkdirSync(path.join(root, 'tasks'), { recursive: true });
  fs.writeFileSync(path.join(root, 'tasks', 'todo.md'), '# todo\n');
  execFileSync('git', ['add', '-A'], { cwd: root });
  execFileSync('git', ['commit', '-q', '-m', 'init'], { cwd: root });
  execFileSync('git', ['checkout', '-q', '-b', 'topic'], { cwd: root });
}

function setTodoMtime(root, when) {
  fs.utimesSync(path.join(root, 'tasks', 'todo.md'), when, when);
}

const TODO_PAST_MTIME = new Date('2000-01-01T00:00:00Z');
const TODO_FUTURE_MTIME = new Date('2099-01-01T00:00:00Z');

// todo-gate-sweep P2 item 1 (2026-08-07): a base repo with one commit on `main`, plus a linked
// worktree (`git worktree add -b <branch>`) checked out on its own new branch. `git worktree add`
// writes the same "branch: Created from ..." reflog entry a normal `git switch -c` does, but the
// worktree's `.git` is a FILE ("gitdir: <base>/.git/worktrees/<name>"), not a directory -- the
// exact shape block-pr-without-todo.js's resolveGitDir()/resolveCommonGitDir() exist to handle.
// tasks/todo.md is created directly INSIDE the worktree (a linked worktree is a separate directory
// on disk; it does not share untracked files with the base checkout) so its mtime can be pinned
// independently, mirroring buildSandboxTodoRepo()'s deterministic-mtime approach.
function buildSandboxTodoWorktree() {
  if (fs.existsSync(path.join(SANDBOX_TODO_WORKTREE, '.git'))) return;
  fs.mkdirSync(SANDBOX_TODO_WORKTREE_BASE, { recursive: true });
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: SANDBOX_TODO_WORKTREE_BASE });
  execFileSync('git', ['config', 'user.email', 'probe@example.com'], { cwd: SANDBOX_TODO_WORKTREE_BASE });
  execFileSync('git', ['config', 'user.name', 'probe'], { cwd: SANDBOX_TODO_WORKTREE_BASE });
  fs.writeFileSync(path.join(SANDBOX_TODO_WORKTREE_BASE, 'f.txt'), 'x\n');
  execFileSync('git', ['add', 'f.txt'], { cwd: SANDBOX_TODO_WORKTREE_BASE });
  execFileSync('git', ['commit', '-q', '-m', 'init'], { cwd: SANDBOX_TODO_WORKTREE_BASE });
  execFileSync(
    'git',
    ['worktree', 'add', '-q', '-b', 'topic-wt', SANDBOX_TODO_WORKTREE, 'main'],
    { cwd: SANDBOX_TODO_WORKTREE_BASE }
  );
  fs.mkdirSync(path.join(SANDBOX_TODO_WORKTREE, 'tasks'), { recursive: true });
  fs.writeFileSync(path.join(SANDBOX_TODO_WORKTREE, 'tasks', 'todo.md'), '# todo\n');
  setTodoMtime(SANDBOX_TODO_WORKTREE, TODO_PAST_MTIME); // predates topic-wt's creation -> deny
}

// todo-gate-sweep P3 item 2 (2026-08-07): a REAL repo built with `git init --separate-git-dir=
// <dir>` where <dir> ("evil-gitdir-store") is deliberately NOT named ".git" and lives OUTSIDE
// SANDBOX_TODO_GITDIR_ESCAPE's own tree -- git itself writes the resulting ".git" FILE's
// "gitdir: <dir>" content, so this is a genuinely valid git internal structure at an unexpected
// location, not hand-fabricated file content. This is the fixture resolveGitDir()'s
// isWithinRepoTree() bound check exists to reject: before the fix, this hook followed the pointer
// unconditionally and produced a real (non-fail-open) verdict from outside the repo root; after
// the fix, the resolved path is neither under repoRoot nor under any ".git" directory, so it is
// rejected and the occurrence fails open. tasks/todo.md is pinned to predate the topic branch
// (deny-producing IF the pointer were followed, same convention as buildSandboxTodoRepo()).
function buildSandboxTodoGitdirEscape() {
  if (fs.existsSync(path.join(SANDBOX_TODO_GITDIR_ESCAPE, '.git'))) return;
  fs.mkdirSync(SANDBOX_TODO_GITDIR_ESCAPE, { recursive: true });
  execFileSync(
    'git',
    ['init', '-q', '-b', 'main', `--separate-git-dir=${SANDBOX_TODO_GITDIR_ESCAPE_TARGET}`],
    { cwd: SANDBOX_TODO_GITDIR_ESCAPE }
  );
  execFileSync('git', ['config', 'user.email', 'probe@example.com'], { cwd: SANDBOX_TODO_GITDIR_ESCAPE });
  execFileSync('git', ['config', 'user.name', 'probe'], { cwd: SANDBOX_TODO_GITDIR_ESCAPE });
  fs.mkdirSync(path.join(SANDBOX_TODO_GITDIR_ESCAPE, 'tasks'), { recursive: true });
  fs.writeFileSync(path.join(SANDBOX_TODO_GITDIR_ESCAPE, 'tasks', 'todo.md'), '# todo\n');
  execFileSync('git', ['add', '-A'], { cwd: SANDBOX_TODO_GITDIR_ESCAPE });
  execFileSync('git', ['commit', '-q', '-m', 'init'], { cwd: SANDBOX_TODO_GITDIR_ESCAPE });
  execFileSync('git', ['checkout', '-q', '-b', 'topic'], { cwd: SANDBOX_TODO_GITDIR_ESCAPE });
  setTodoMtime(SANDBOX_TODO_GITDIR_ESCAPE, TODO_PAST_MTIME);
}

// todo-gate-sweep P3 item 2 (2026-08-07): a real repo (normal ".git" directory) whose
// ".git/HEAD" is overwritten with a hand-written "ref: refs/heads/../heads/main" -- a ref shape
// git's own `checkout -b` refuses to create (check-ref-format rejects ".."), simulating a HEAD
// file an attacker wrote directly rather than via git. This is the fixture isSafeBranchName()
// exists to reject: branchCreatedMs() builds the reflog path with path.join(), which silently
// COLLAPSES the ".." instead of rejecting it, so before the fix this redirected the lookup to
// refs/heads/main's own real reflog instead of failing to resolve.
function buildSandboxTodoBranchEscape() {
  if (fs.existsSync(path.join(SANDBOX_TODO_BRANCH_ESCAPE, '.git'))) return;
  buildSandboxTodoRepo(SANDBOX_TODO_BRANCH_ESCAPE);
  setTodoMtime(SANDBOX_TODO_BRANCH_ESCAPE, TODO_PAST_MTIME);
  fs.writeFileSync(path.join(SANDBOX_TODO_BRANCH_ESCAPE, '.git', 'HEAD'), 'ref: refs/heads/../heads/main\n');
}

function buildSandboxTodoSandboxes() {
  if (!fs.existsSync(path.join(SANDBOX_TODO_DENY, '.git'))) {
    buildSandboxTodoRepo(SANDBOX_TODO_DENY);
    setTodoMtime(SANDBOX_TODO_DENY, TODO_PAST_MTIME);
    // Nested product repo with the OPPOSITE (allow-producing) timestamp, so
    // pt-allow-cd-into-product-repo can pin that repo-root resolution finds THIS .git, not the
    // outer deny-producing one, once `cd dev/prod` moves the effective cwd.
    const prodRoot = path.join(SANDBOX_TODO_DENY, 'dev', 'prod');
    buildSandboxTodoRepo(prodRoot);
    setTodoMtime(prodRoot, TODO_FUTURE_MTIME);
  }
  if (!fs.existsSync(path.join(SANDBOX_TODO_ALLOW, '.git'))) {
    buildSandboxTodoRepo(SANDBOX_TODO_ALLOW);
    setTodoMtime(SANDBOX_TODO_ALLOW, TODO_FUTURE_MTIME);
  }
  if (!fs.existsSync(path.join(SANDBOX_TODO_NOREFLOG, '.git'))) {
    // git init only, zero commits: refs/heads/topic and its reflog never get created.
    fs.mkdirSync(SANDBOX_TODO_NOREFLOG, { recursive: true });
    execFileSync('git', ['init', '-q', '-b', 'topic'], { cwd: SANDBOX_TODO_NOREFLOG });
  }
  buildSandboxTodoWorktree();
  buildSandboxTodoGitdirEscape();
  buildSandboxTodoBranchEscape();
}

// Batch A / A5 (2026-08-12): mirrors setTodoMtime() above but for tasks/codemap.md. Kept as a
// separate small function rather than adding a filename parameter to setTodoMtime() -- that
// function already has several call sites above and this keeps them untouched.
function setCodemapMtime(root, when) {
  fs.utimesSync(path.join(root, 'tasks', 'codemap.md'), when, when);
}

// Batch A / A5 (2026-08-12): reuses buildSandboxTodoRepo() (git repo + tasks/todo.md + `topic`
// branch checkout) as-is, then adds tasks/codemap.md on top with its own pinned mtime. todo.md's
// own mtime is pinned to the future (allow-producing) in BOTH roots below so that a deny verdict
// on SANDBOX_CODEMAP_DENY can only come from the new isCodemapStaleForBranch() check, never from
// the pre-existing todo-staleness check -- otherwise the deny sample would still "pass" even if
// the new CODEMAP check were deleted, i.e. it would have no detection power.
function buildSandboxCodemapSandboxes() {
  if (!fs.existsSync(path.join(SANDBOX_CODEMAP_DENY, '.git'))) {
    buildSandboxTodoRepo(SANDBOX_CODEMAP_DENY);
    setTodoMtime(SANDBOX_CODEMAP_DENY, TODO_FUTURE_MTIME);
    fs.writeFileSync(path.join(SANDBOX_CODEMAP_DENY, 'tasks', 'codemap.md'), '# CODEMAP\n');
    setCodemapMtime(SANDBOX_CODEMAP_DENY, TODO_PAST_MTIME);
  }
  if (!fs.existsSync(path.join(SANDBOX_CODEMAP_ALLOW_NEWER, '.git'))) {
    buildSandboxTodoRepo(SANDBOX_CODEMAP_ALLOW_NEWER);
    setTodoMtime(SANDBOX_CODEMAP_ALLOW_NEWER, TODO_FUTURE_MTIME);
    fs.writeFileSync(path.join(SANDBOX_CODEMAP_ALLOW_NEWER, 'tasks', 'codemap.md'), '# CODEMAP\n');
    setCodemapMtime(SANDBOX_CODEMAP_ALLOW_NEWER, TODO_FUTURE_MTIME);
  }
}

// Batch A / A3 (2026-08-12): relay ON (unlike SANDBOX_FREE, which is relay OFF and already
// backs 3 existing relay-required-agent.js rows) plus the clover alias 'probe-ext' seeded, so
// Route 2 (RELAY-MODEL:<alias> marker) resolves. No .claude/agents/*.md frontmatter is needed
// here since these samples only exercise Route 2, not Route 1. Detection-power rationale: if this
// reused SANDBOX_FREE (relay OFF) instead, the pre-existing relay-off deny path would produce the
// same "deny" verdict even with the new description/alias check deleted -- a relay-ON-only root
// is what makes the new check the sole cause of the deny.
function buildSandboxRelayOn() {
  fs.mkdirSync(path.join(SANDBOX_RELAY_ON, '.claude'), { recursive: true });
  fs.mkdirSync(path.join(SANDBOX_RELAY_ON, 'clover'), { recursive: true });
  fs.writeFileSync(path.join(SANDBOX_RELAY_ON, '.claude', '.relay-status'), 'ON\n');
  fs.writeFileSync(
    path.join(SANDBOX_RELAY_ON, 'clover', 'models.json'),
    JSON.stringify({ models: [{ alias: 'probe-ext', model: 'probe-ext-upstream', format: 'openai', via: 'codex' }] })
  );
}

// M1 (2026-08-13, cycle-2 authority review): builds a real NTFS directory junction
// (SANDBOX_JUNCTION/tmp/jdir -> SANDBOX_JUNCTION/real-target) via `mklink /J`, which needs no
// admin rights on NTFS. Windows-only by construction (mklink is a cmd.exe builtin); the
// corresponding sample row is tagged skipIf:'non-win32', and this builder itself is gated on
// process.platform so it is a safe no-op on a non-win32 CI box rather than throwing and breaking
// every OTHER row in the suite (mklink would not exist there to exec in the first place). The
// existsSync guard makes re-running the suite idempotent (`mklink` errors if the link already
// exists).
function buildSandboxJunction() {
  fs.mkdirSync(path.join(SANDBOX_JUNCTION, 'real-target'), { recursive: true });
  fs.mkdirSync(path.join(SANDBOX_JUNCTION, 'tmp'), { recursive: true });
  fs.writeFileSync(path.join(SANDBOX_JUNCTION, 'real-target', 'precious.txt'), 'secret\n');
  const linkPath = path.join(SANDBOX_JUNCTION, 'tmp', 'jdir');
  if (process.platform === 'win32' && !fs.existsSync(linkPath)) {
    try {
      execFileSync('cmd', ['/c', 'mklink', '/J', linkPath, path.join(SANDBOX_JUNCTION, 'real-target')]);
    } catch {
      // mklink unavailable/failed on this win32 box -- the corresponding row is not skipIf-tagged
      // for this case, so it will fail loudly (not silently pass) rather than mask the problem.
    }
  }
}

// fable-gate (2026-08-06, plan Phase 3 O-4 ruling): single substitution point for all 4 call
// sites (loadRows, registerTests, and its two inline integrity-test re-parses). This does not
// weaken the deliberate independence of the hardcoded *counts* below — each site still re-parses
// `raw` on its own; only the placeholder text substitution is shared. Placeholder collision is
// safe because every placeholder is `>`-terminated (e.g. <SANDBOX_FABLE_ON_MESSY> has `_` where
// <SANDBOX_FABLE_ON> has `>`), so no substitution order hazard exists.
function substitute(raw) {
  return raw
    .split('<SANDBOX_FREE>').join(slash(SANDBOX_FREE))
    .split('<SANDBOX_FABLE_ON_MESSY>').join(slash(SANDBOX_FABLE_ON_MESSY))
    .split('<SANDBOX_FABLE_ON>').join(slash(SANDBOX_FABLE_ON))
    .split('<SANDBOX_FABLE_OFF>').join(slash(SANDBOX_FABLE_OFF))
    .split('<SANDBOX_FABLE_ONX>').join(slash(SANDBOX_FABLE_ONX))
    .split('<SANDBOX_TODO_DENY>').join(slash(SANDBOX_TODO_DENY))
    .split('<SANDBOX_TODO_ALLOW>').join(slash(SANDBOX_TODO_ALLOW))
    .split('<SANDBOX_TODO_NOREFLOG>').join(slash(SANDBOX_TODO_NOREFLOG))
    .split('<SANDBOX_TODO_WORKTREE>').join(slash(SANDBOX_TODO_WORKTREE))
    .split('<SANDBOX_TODO_GITDIR_ESCAPE>').join(slash(SANDBOX_TODO_GITDIR_ESCAPE))
    .split('<SANDBOX_TODO_BRANCH_ESCAPE>').join(slash(SANDBOX_TODO_BRANCH_ESCAPE))
    .split('<SANDBOX_CODEMAP_DENY>').join(slash(SANDBOX_CODEMAP_DENY))
    .split('<SANDBOX_CODEMAP_ALLOW_NEWER>').join(slash(SANDBOX_CODEMAP_ALLOW_NEWER))
    .split('<SANDBOX_RELAY_ON>').join(slash(SANDBOX_RELAY_ON))
    .split('<SANDBOX_JUNCTION>').join(slash(SANDBOX_JUNCTION))
    .split('<SANDBOX>').join(slash(SANDBOX))
    .split('<REPO>').join(slash(ROOT))
    .split('<SANDBOX_GIT_MAIN>').join(slash(SANDBOX_GIT_MAIN))
    .split('<SANDBOX_GIT>').join(slash(SANDBOX_GIT));
}

function loadRows() {
  const raw = fs.readFileSync(SAMPLES_FILE, 'utf8');
  return JSON.parse(substitute(raw));
}

// P4 (2026-08-07): count-only checks (EXPECTED_SAMPLE_COUNT, EXPECTED_SET_COUNTS) can't tell
// "the right rows are present" from "the same number of rows are present but one row's content
// got swapped for another's" -- e.g. deleting gp-status-allowed's row and duplicating
// gp-branch-D's row in its place leaves every count identical. This hash covers full row
// content, so that kind of swap changes the digest.
//
// Input: the RAW (pre-substitution) parsed rows, i.e. JSON.parse(raw) -- NOT
// JSON.parse(substitute(raw)). substitute() inlines this machine's absolute checkout path (and
// OS-specific slashes) into placeholders like <REPO>/<SANDBOX>, so a substituted hash would
// differ by clone location/OS and fail on every machine but the one it was computed on. Hashing
// the placeholder text keeps the digest portable.
//
// Order: rows are sorted by "set/name" (the same identity EXPECTED_SKIP_TAGS above is keyed by,
// not physical position) before hashing, so reordering rows within the file does NOT change the
// hash -- only a change to some row's actual content under an existing or new set/name does.
// Reordering carries no signal here (nothing in this file or the hooks it drives depends on row
// order), so treating it as a false positive would just train people to blindly re-paste the
// literal; keying by content-under-identity instead keeps the hash meaningful. The comparator
// below uses plain `<`/`>` on the "set/name" strings (UTF-16 code-unit order), NOT
// String#localeCompare() -- localeCompare() without a fixed locale collates using whatever
// locale the running environment defaults to, which reorders these ASCII keys differently under
// different OS/language settings and would make the hash non-reproducible across machines even
// with byte-identical row content. NOTE: this hash is still sensitive to each row OBJECT's own
// key order (JSON.stringify serializes keys in insertion order, unaffected by the row sort
// above), so reordering keys within a row's JSON without changing any value still flips the
// digest.
//
// Algorithm: sha256 hex digest of JSON.stringify(sorted rows). Update EXPECTED_SAMPLES_HASH (the
// one literal below) whenever a row is intentionally added/changed/removed -- same one-literal
// update as EXPECTED_SAMPLE_COUNT.
function samplesHash(rows) {
  const sorted = [...rows].sort((a, b) => {
    const ka = `${a.set}/${a.name}`;
    const kb = `${b.set}/${b.name}`;
    return ka < kb ? -1 : ka > kb ? 1 : 0;
  });
  return crypto.createHash('sha256').update(JSON.stringify(sorted)).digest('hex');
}

function buildEnv(overrides) {
  const env = { ...process.env };
  env.CLAUDE_PROJECT_DIR = slash(ROOT);
  for (const [k, v] of Object.entries(overrides || {})) {
    if (v === null) delete env[k];
    else env[k] = v;
  }
  return env;
}

function runRow(row) {
  const hookPath = path.join(ROOT, row.hook);
  const input = JSON.stringify(row.payload);
  const env = buildEnv(row.env);
  const cwdOpt = row.payload.cwd || ROOT;
  try {
    const stdout = execFileSync(process.execPath, [hookPath], {
      input,
      env,
      cwd: cwdOpt,
      encoding: 'utf8',
    });
    return { exit: 0, stdout: stdout || '', stderr: '' };
  } catch (e) {
    return {
      exit: typeof e.status === 'number' ? e.status : -1,
      stdout: e.stdout != null ? String(e.stdout) : '',
      stderr: e.stderr != null ? String(e.stderr) : '',
    };
  }
}

// Hooks that always exit 0 and signal deny via a "permissionDecision":"deny" JSON blob on
// stdout instead of exit code 2.
const STDOUT_DENY_HOOKS = ['cmd-write-guard.js'];

function verdictOf(row, result) {
  if (STDOUT_DENY_HOOKS.some((h) => row.hook.endsWith(h))) {
    if (result.exit !== 0) {
      throw new Error(
        `${row.set}/${row.name}: ${row.hook} exited ${result.exit} (expected 0; ` +
        `this hook signals deny via stdout JSON, not exit code) — stderr: ${result.stderr}`
      );
    }
    return result.stdout.includes('"permissionDecision":"deny"') ? 'deny' : 'allow';
  }
  if (result.exit === 2) return 'deny';
  if (result.exit === 0) return 'allow';
  throw new Error(
    `${row.set}/${row.name}: ${row.hook} exited ${result.exit} (expected 0 or 2) — stderr: ${result.stderr}`
  );
}

function checkCanaries(results) {
  const byName = Object.fromEntries(results.map((r) => [r.row.name, r]));
  const failures = [];

  const a = byName.__canary_deny_exit;
  if (!a || a.result.exit !== 2 || !/force push/i.test(a.result.stderr)) {
    failures.push('__canary_deny_exit');
  }

  const b = byName.__canary_allow;
  if (!b || b.result.exit !== 0 || b.result.stderr.trim() !== '') {
    failures.push('__canary_allow');
  }

  const c = byName.__canary_deny_stdout;
  if (!c || !c.result.stdout.includes('"permissionDecision":"deny"')) {
    failures.push('__canary_deny_stdout');
  }

  return failures;
}

function currentBranch() {
  try {
    return execFileSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], {
      cwd: ROOT,
      encoding: 'utf8',
    }).trim();
  } catch {
    return '';
  }
}

function runDump() {
  const args = process.argv.slice(2);
  const setIdx = args.indexOf('--set');
  const outIdx = args.indexOf('--out');
  if (outIdx === -1) {
    console.error('Usage: node hook-probes.test.js [--set <SET_NAME>] --out <FILE>');
    process.exit(1);
  }
  const setName = setIdx !== -1 ? args[setIdx + 1] : null;
  const outFile = args[outIdx + 1];

  buildSandbox();
  buildSandboxFree();
  buildSandboxGit();
  buildSandboxGitMain();
  buildFableSandboxes();
  buildSandboxTodoSandboxes();
  buildSandboxCodemapSandboxes();
  buildSandboxRelayOn();
  buildSandboxJunction();

  const allRows = loadRows();
  const rows = setName ? allRows.filter((r) => r.set === setName) : allRows;
  if (rows.length === 0) {
    console.error(`No samples found for set "${setName}"`);
    process.exit(1);
  }

  const lines = rows.map((row) => {
    const result = runRow(row);
    const verdict = verdictOf(row, result);
    return [row.set, row.name, verdict, row.expect].join('\t');
  });

  fs.mkdirSync(path.dirname(outFile), { recursive: true });
  fs.writeFileSync(outFile, lines.join('\n') + '\n');

  console.log(`OK: ${setName || 'ALL'} — ${lines.length} rows captured -> ${outFile}`);
  process.exit(0);
}

function registerTests() {
  const { test } = require('node:test');
  const assert = require('node:assert');

  buildSandbox();
  buildSandboxFree();
  buildSandboxGit();
  buildSandboxGitMain();
  buildFableSandboxes();
  buildSandboxTodoSandboxes();
  buildSandboxCodemapSandboxes();
  buildSandboxRelayOn();
  buildSandboxJunction();

  const raw = fs.readFileSync(SAMPLES_FILE, 'utf8');
  const allRows = JSON.parse(substitute(raw));

  const EXPECTED_SAMPLE_COUNT = 252;
  // Independently-hardcoded expectation (not re-derived from allRows) so this assertion can't
  // silently pass no matter what skipIf tags actually exist in the samples file — mirrors the
  // EXPECTED_SAMPLE_COUNT literal above. Keyed by exact set/name (not just a per-tag count) so a
  // mutation that moves a skipIf tag from one row to another same-tagged-count row is also
  // caught — a plain count table can't distinguish "the right rows are tagged" from "some rows
  // are tagged". Update this table together with EXPECTED_SAMPLE_COUNT when a row's skipIf tag
  // changes or a new skipIf-tagged row is added/removed.
  const EXPECTED_SKIP_TAGS = {
    'S-git-env/ge-commit-plain': 'protected-branch',
    'S-git-env/ge-push-bare': 'protected-branch',
    'S-git-env/ge-reset-hard-bare': 'protected-branch',
    'S-git-env/ge-commit-amend': 'protected-branch',
    'S-git-pure/gp-redirect-junction-realpath-deny': 'non-win32',
  };

  test('samples file integrity: JSON.parse succeeds, row count matches, set+name pairs unique', () => {
    const parsed = JSON.parse(substitute(raw));
    assert.strictEqual(parsed.length, EXPECTED_SAMPLE_COUNT);
    const seen = new Set();
    for (const r of parsed) {
      const key = `${r.set}/${r.name}`;
      assert.ok(!seen.has(key), `duplicate set+name pair: ${key}`);
      seen.add(key);
    }
  });

  // P4 (2026-08-07): full-content hash, orthogonal to the count check above -- a swap that
  // preserves both the total count and every set's count (e.g. one row's payload/expect copied
  // over another row's, or a row deleted and a different one duplicated in its place) passes the
  // count test above but changes this hash. See samplesHash() for the algorithm (sha256 over
  // pre-substitution rows sorted by set/name) and why it's built that way.
  const EXPECTED_SAMPLES_HASH = '1a758806bc40e747c4bdcff12aa8ac1eb35b259cb084869e1378f1b0ccbb14f4';

  test('samples file integrity: full-content hash matches (catches same-count content swaps the row/set count checks miss)', () => {
    const rawRows = JSON.parse(raw); // pre-substitution rows -- see samplesHash() comment for why
    const actualHash = samplesHash(rawRows);
    assert.strictEqual(
      actualHash,
      EXPECTED_SAMPLES_HASH,
      'row CONTENT changed (hash mismatch), not row count -- if intentional, recompute samplesHash() ' +
      'over the current samples file and paste the new value into EXPECTED_SAMPLES_HASH'
    );
  });

  test('samples file integrity: skipIf tags match the expected set/name table', () => {
    const parsed = JSON.parse(substitute(raw));
    const actual = {};
    for (const r of parsed) {
      if (r.skipIf) actual[`${r.set}/${r.name}`] = r.skipIf;
    }
    assert.deepStrictEqual(actual, EXPECTED_SKIP_TAGS);
  });

  const branch = currentBranch();
  const branchProtected = PROTECTED_BRANCHES.has(branch);

  for (const row of allRows) {
    const skip = (row.skipIf === 'protected-branch' && branchProtected)
      || (row.skipIf === 'non-win32' && process.platform !== 'win32')
      ? row.skipReason
      : false;
    test(`${row.set}/${row.name}`, { skip }, () => {
      const result = runRow(row);
      const verdict = verdictOf(row, result);
      assert.strictEqual(verdict, row.expect);
    });
  }

  // Independently-hardcoded per-set expectation (not re-derived from allRows — a self-filter
  // compared to itself is always equal and detects nothing). Update this table whenever a row
  // is added to/removed from/moved between sets. Verified this equals EXPECTED_SAMPLE_COUNT and
  // covers exactly the sets present in the samples file below.
  const EXPECTED_SET_COUNTS = {
    'S-git-pure': 69,
    'S-git-env': 19,
    'S-gh': 15,
    'S-state': 8,
    'S-fs': 32,
    'S-prompt': 8,
    'S-session': 5,
    'S-agent': 57,
    'S-secret': 5,
    'S-pr-todo': 34,
  };

  const setsInOrder = [...new Set(allRows.map((r) => r.set))];

  test('EXPECTED_SET_COUNTS covers exactly the sets present, and sums to EXPECTED_SAMPLE_COUNT', () => {
    assert.deepStrictEqual(
      [...Object.keys(EXPECTED_SET_COUNTS)].sort(),
      [...setsInOrder].sort()
    );
    const sum = Object.values(EXPECTED_SET_COUNTS).reduce((a, b) => a + b, 0);
    assert.strictEqual(sum, EXPECTED_SAMPLE_COUNT);
  });

  for (const setName of setsInOrder) {
    const setRows = allRows.filter((r) => r.set === setName);

    test(`${setName}: row count matches the expected table (${setRows.length})`, () => {
      assert.strictEqual(setRows.length, EXPECTED_SET_COUNTS[setName]);
      assert.ok(setRows.length >= 3, `${setName} must include at least the 3 canary rows`);
    });

    test(`${setName}: canaries pass (scoped to this set)`, () => {
      // checkCanaries() only ever looks up __canary_deny_exit / __canary_allow /
      // __canary_deny_stdout by name, so running every non-canary row here just burns child
      // processes for nothing -- both this filter and checkCanaries() depend on the
      // "__canary_" name prefix, so don't rename a canary row without updating both.
      const canaryRows = setRows.filter((r) => r.name.startsWith('__canary_'));
      const results = canaryRows.map((row) => ({ row, result: runRow(row) }));
      const failures = checkCanaries(results);
      assert.deepStrictEqual(failures, []);
    });
  }
}

if (process.argv.includes('--out')) {
  runDump();
} else {
  registerTests();
}
