// node --test .claude/hooks/lib/
//
// PR-B (2026-08-28, plans/parallel-dev-speedup/PLAN.md "作業ツリーの分離"): decide() must judge a
// path inside a linked worktree of this repo exactly as it would judge the identical relative
// path in the main tree, wherever that worktree sits on disk. These tests reproduce the plan's
// measured 4-row table against REAL git worktrees built under tmp/ (gitignored), following the
// same self-contained-fixture idiom as hook-probes.test.js's SANDBOX_TODO_WORKTREE.
'use strict';

const { test, before } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const { decide } = require('./scope-decision');
const { isLinkedWorktreeOf } = require('./git-worktree');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const FIXTURE_BASE = path.join(ROOT, 'tmp', 'scope-decision-fixture');
// MAIN_ROOT plays the role of the project root passed to decide() -- a self-contained fake repo,
// never the real D:\my-claude-base-v2 checkout, so nothing here touches the real repo's own
// `git worktree list`.
const MAIN_ROOT = path.join(FIXTURE_BASE, 'main');
// A worktree parked under the fake project's OWN tmp/ -- the real-world shape this plan targets
// (tmp/worktrees/<name>), physically nested inside MAIN_ROOT.
const WT_INSIDE = path.join(MAIN_ROOT, 'tmp', 'worktrees', 'probe');
// A worktree parked entirely outside MAIN_ROOT's tree -- row 4 of the plan's table.
const WT_OUTSIDE = path.join(FIXTURE_BASE, 'outside-wt');
// A hand-crafted ".git" FILE whose gitdir: line names a path-shape-plausible location under
// MAIN_ROOT/.git/worktrees/ that no real `git worktree add` ever registered -- isLinkedWorktreeOf
// must reject this (no real admin dir, no backpointer), not just check the path string.
const EVIL_FAKE_WT = path.join(FIXTURE_BASE, 'evil-fake-wt');
// A hand-crafted ".git" FILE whose gitdir: line escapes every repo tree entirely (no ".git"
// path segment anywhere in the resolved target) -- the exact shape isWithinRepoTree() exists to
// reject (S-pr-todo/pt-allow-gitdir-escape-outside-repo's threat model, reused here).
const EVIL_ESCAPE_WT = path.join(FIXTURE_BASE, 'evil-escape-wt');

const LOCK = { slug: 'test-plan', allow: ['allowed/**'], forbid: ['secret.txt'] };

function git(args, cwd) {
  execFileSync('git', args, { cwd });
}

function buildFixture() {
  // Unconditional and outside the idempotency guard below: journal-util.js's projectRoot() (used
  // by cmd-write-guard.js) resolves CLAUDE_PROJECT_DIR by walking UP looking for a `.claude`
  // entry to exist under it -- with none at MAIN_ROOT it would walk past FIXTURE_BASE/tmp/ and
  // land on the REAL repo's own .claude, silently testing against the wrong root entirely. This
  // must exist on every run (not just the first), since a `.claude` created for a single
  // hook-process test elsewhere in this suite's history may not persist.
  fs.mkdirSync(path.join(MAIN_ROOT, '.claude'), { recursive: true });
  if (fs.existsSync(path.join(MAIN_ROOT, '.git'))) return; // idempotent, mirrors hook-probes.test.js
  fs.mkdirSync(MAIN_ROOT, { recursive: true });
  git(['init', '-q', '-b', 'main'], MAIN_ROOT);
  git(['config', 'user.email', 'probe@example.com'], MAIN_ROOT);
  git(['config', 'user.name', 'probe'], MAIN_ROOT);
  fs.writeFileSync(path.join(MAIN_ROOT, 'f.txt'), 'x\n');
  git(['add', 'f.txt'], MAIN_ROOT);
  git(['commit', '-q', '-m', 'init'], MAIN_ROOT);

  fs.mkdirSync(path.dirname(WT_INSIDE), { recursive: true });
  git(['worktree', 'add', '-q', '-b', 'topic-inside', WT_INSIDE, 'main'], MAIN_ROOT);
  git(['worktree', 'add', '-q', '-b', 'topic-outside', WT_OUTSIDE, 'main'], MAIN_ROOT);

  fs.mkdirSync(EVIL_FAKE_WT, { recursive: true });
  const fakeAdminDir = path.join(MAIN_ROOT, '.git', 'worktrees', 'not-a-real-worktree');
  fs.writeFileSync(path.join(EVIL_FAKE_WT, '.git'), `gitdir: ${fakeAdminDir}\n`);

  fs.mkdirSync(EVIL_ESCAPE_WT, { recursive: true });
  fs.writeFileSync(path.join(EVIL_ESCAPE_WT, '.git'), 'gitdir: ../../../../../../../../../../../../etc\n');
}

before(() => buildFixture());

// --- The plan's measured 4-row table -------------------------------------------------------

test('row 1: a forbidden file in the main tree -> DENY forbid', () => {
  const v = decide(MAIN_ROOT, LOCK, path.join(MAIN_ROOT, 'secret.txt'));
  assert.deepStrictEqual(v, { rel: 'secret.txt', why: 'forbid' });
});

test('row 2: the same forbidden file inside a worktree under tmp/ -> DENY forbid (was ALLOW)', () => {
  const v = decide(MAIN_ROOT, LOCK, path.join(WT_INSIDE, 'secret.txt'));
  assert.deepStrictEqual(v, { rel: 'secret.txt', why: 'forbid' });
});

test('row 3: the enforcement chain itself inside a worktree -> DENY enforcement-chain (was ALLOW)', () => {
  const v = decide(MAIN_ROOT, LOCK, path.join(WT_INSIDE, '.claude', 'hooks', 'scope-guard.js'));
  assert.deepStrictEqual(v, { rel: '.claude/hooks/scope-guard.js', why: 'enforcement-chain' });
});

test('row 4: a worktree placed outside the repo gets the correct per-file verdict, not a blanket deny', () => {
  const denied = decide(MAIN_ROOT, LOCK, path.join(WT_OUTSIDE, 'secret.txt'));
  assert.deepStrictEqual(denied, { rel: 'secret.txt', why: 'forbid' });

  const allowed = decide(MAIN_ROOT, LOCK, path.join(WT_OUTSIDE, 'allowed', 'x.txt'));
  assert.strictEqual(allowed, null);
});

// --- Additional required coverage -----------------------------------------------------------

test('an ordinary tmp/ file that is NOT inside a worktree stays allowed', () => {
  const v = decide(MAIN_ROOT, LOCK, path.join(MAIN_ROOT, 'tmp', 'scratch.txt'));
  assert.strictEqual(v, null);
});

test('an allowed file matches in both the main tree and the worktree (no half-fixed deny-everything)', () => {
  const inMain = decide(MAIN_ROOT, LOCK, path.join(MAIN_ROOT, 'allowed', 'x.txt'));
  const inWorktree = decide(MAIN_ROOT, LOCK, path.join(WT_INSIDE, 'allowed', 'x.txt'));
  assert.strictEqual(inMain, null);
  assert.strictEqual(inWorktree, null);
});

// The test above alone has NO detection power for "allow still works through the rebase": under
// the pre-fix code, EVERY path under WT_INSIDE (nested in tmp/worktrees/) already matched the
// pre-existing tmp/** always-allow rule directly, on its raw un-rebased path -- so it returned
// ALLOW for the wrong reason even before this fix existed, and would keep passing even if the
// rebase were silently deleted. This test uses forbid:['tmp/**'] specifically so the raw
// (un-rebased) path -- 'tmp/worktrees/probe/allowed/x.txt' -- hits lock.forbid BEFORE the
// always-allow rule ever runs, while the correctly REBASED path -- 'allowed/x.txt' -- does not
// start with "tmp" and instead matches lock.allow. Pre-fix: DENY forbid. Post-fix: ALLOW.
const FORBID_TMP_LOCK = { slug: 'test-plan-2', allow: ['allowed/**'], forbid: ['tmp/**'] };
test('an allowed file inside a worktree is judged by its REBASED relative path, not the raw tmp/-prefixed one', () => {
  const v = decide(MAIN_ROOT, FORBID_TMP_LOCK, path.join(WT_INSIDE, 'allowed', 'x.txt'));
  assert.strictEqual(v, null);
});

test('a nested/".."-containing path inside a worktree resolves to the same verdict, no escape', () => {
  const direct = decide(MAIN_ROOT, LOCK, path.join(WT_INSIDE, 'secret.txt'));
  const viaDotDot = decide(MAIN_ROOT, LOCK, path.join(WT_INSIDE, 'sub', '..', 'secret.txt'));
  assert.deepStrictEqual(direct, { rel: 'secret.txt', why: 'forbid' });
  assert.deepStrictEqual(viaDotDot, direct);
});

test('isLinkedWorktreeOf resolves the real worktrees to their own root', () => {
  assert.strictEqual(isLinkedWorktreeOf(MAIN_ROOT, path.join(WT_INSIDE, 'secret.txt')), WT_INSIDE);
  assert.strictEqual(isLinkedWorktreeOf(MAIN_ROOT, path.join(WT_OUTSIDE, 'secret.txt')), WT_OUTSIDE);
});

test('isLinkedWorktreeOf rejects a plausible-but-unregistered gitdir (no real admin dir/backpointer)', () => {
  assert.strictEqual(isLinkedWorktreeOf(MAIN_ROOT, path.join(EVIL_FAKE_WT, 'secret.txt')), null);
});

test('isLinkedWorktreeOf rejects a gitdir that escapes every repo tree (isWithinRepoTree)', () => {
  assert.strictEqual(isLinkedWorktreeOf(MAIN_ROOT, path.join(EVIL_ESCAPE_WT, 'secret.txt')), null);
});

test('isLinkedWorktreeOf returns null for an ordinary in-tree path (not a worktree at all)', () => {
  assert.strictEqual(isLinkedWorktreeOf(MAIN_ROOT, path.join(MAIN_ROOT, 'src', 'a.ts')), null);
});

// --- cmd-write-guard.js Arm B (isStateDir / isFableStatusFile) worktree follow-up (2026-08-28) --
//
// Arm B is UNCONDITIONAL (runs regardless of scope-lock state) — it compares the extracted write
// target's resolved path against <root>/.claude/state and <root>/.claude/.fable-status. Before
// rebaseIntoMainTree() was applied here too, a write into a linked worktree's OWN .claude/state or
// .claude/.fable-status was invisible to it: the raw path (e.g. tmp/worktrees/probe/.claude/state/x)
// never matched the literal prefix check. These tests drive the REAL cmd-write-guard.js hook
// process end to end (not just isStateDir/isFableStatusFile directly), with NO scope lock armed
// (MAIN_ROOT/.claude/state/scope-lock.json does not exist) -- Arm B's whole point is that it does
// not need one. Each test's command is deliberately built so its RAW TEXT never contains
// ".claude/state" or ".claude/.fable-status" (that would trip Arm A's lexical tripwire instead,
// which every command in this harness already does regardless of worktree awareness -- see the
// header of cmd-write-guard.js -- and would prove nothing about THIS fix): the target path is
// built via `cwd` + a short relative filename, so only path RESOLUTION (extraction + Arm B's
// isStateDir/isFableStatusFile) can catch it.
// CLAUDE_PROJECT_DIR is what projectRoot() (lib/journal-util.js) prefers above all else, and is
// always set by the real harness even when cwd is inside a linked worktree (plans/parallel-dev-
// speedup/PLAN.md's own "撤回済み" note verified this) -- so pinning it to MAIN_ROOT here, while
// `cwd` points inside WT_INSIDE, reproduces the realistic parallel-worker shape: root resolves
// correctly, and the write TARGET is what may or may not be recognized as worktree-internal.
function runCmdWriteGuard(payload) {
  const hookPath = path.join(ROOT, '.claude', 'hooks', 'cmd-write-guard.js');
  try {
    const out = execFileSync(process.execPath, [hookPath], {
      input: JSON.stringify(payload),
      env: { ...process.env, CLAUDE_PROJECT_DIR: MAIN_ROOT },
      encoding: 'utf8',
    });
    return { code: 0, stdout: out };
  } catch (e) {
    return { code: e.status, stdout: e.stdout, stderr: e.stderr };
  }
}

function isDenyStdout(stdout) {
  if (!stdout) return false;
  try {
    return JSON.parse(stdout).hookSpecificOutput?.permissionDecision === 'deny';
  } catch {
    return false;
  }
}

test('cmd-write-guard denies a write into .claude/state inside a worktree, no lock armed', () => {
  const cwd = path.join(WT_INSIDE, '.claude', 'state');
  const r = runCmdWriteGuard({
    tool_name: 'Bash',
    cwd,
    tool_input: { command: 'echo hi > scope-lock.json' },
  });
  assert.ok(isDenyStdout(r.stdout), `expected a deny JSON on stdout, got: ${JSON.stringify(r)}`);
});

test('cmd-write-guard denies a write into .claude/.fable-status inside a worktree, no lock armed', () => {
  const cwd = path.join(WT_INSIDE, '.claude');
  const r = runCmdWriteGuard({
    tool_name: 'Bash',
    cwd,
    tool_input: { command: 'echo ON > .fable-status' },
  });
  assert.ok(isDenyStdout(r.stdout), `expected a deny JSON on stdout, got: ${JSON.stringify(r)}`);
});

test('cmd-write-guard still allows an ordinary write inside a worktree, no lock armed', () => {
  const cwd = path.join(WT_INSIDE, 'allowed');
  const r = runCmdWriteGuard({
    tool_name: 'Bash',
    cwd,
    tool_input: { command: 'echo hi > x.txt' },
  });
  assert.strictEqual(r.code, 0);
  assert.strictEqual(r.stdout, '');
});
