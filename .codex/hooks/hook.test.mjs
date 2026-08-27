import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  MAX_CONTEXT_BYTES,
  WORKSPACE_ROOT,
  appendMachine,
  buildContext,
  checkPreToolUse,
  gitCalls,
  handleHook,
  safeWorkspacePath,
} from './hook.mjs';

const HOOK = path.join(import.meta.dirname, 'hook.mjs');

function fixture(branch = 'feature/minimal-harness') {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-minimal-hook-'));
  fs.mkdirSync(path.join(root, 'tasks', 'journal', '2026-08'), { recursive: true });
  fs.writeFileSync(path.join(root, 'tasks', 'session-state.md'),
    '# Session State — fixture\n## START HERE — [2026-08-27 10:00] — feature・abc123 → tasks/journal/2026-08/27.md の 10:00 レポート\n');
  fs.writeFileSync(path.join(root, 'tasks', 'journal', '2026-08', '27.md'),
    '## 10:00 セッションレポート — ready\n**次にやること**: test\n');
  fs.writeFileSync(path.join(root, 'tasks', 'todo.md'), '# TODO\n## Now\n- [ ] hook\n## Backlog\n- [ ] later\n');
  fs.writeFileSync(path.join(root, 'tasks', 'codemap.md'), '# Map\n## Entry points\n## Records\n');
  execFileSync('git', ['init', '-q', root]);
  execFileSync('git', ['-C', root, 'checkout', '-q', '-b', branch]);
  execFileSync('git', ['-C', root, '-c', 'user.name=Codex Test', '-c', 'user.email=codex@example.invalid',
    'commit', '--allow-empty', '-q', '-m', 'initial']);
  return root;
}

function pre(root, toolName, toolInput) {
  return {
    cwd: root,
    session_id: 'session-12345678',
    hook_event_name: 'PreToolUse',
    tool_name: toolName,
    tool_input: toolInput,
  };
}

test('direct edits stay inside the workspace and avoid secret paths', () => {
  const root = fixture();
  const allowed = pre(root, 'apply_patch', { command: '*** Begin Patch\n*** Add File: src/app.mjs\n+x\n*** End Patch' });
  assert.equal(checkPreToolUse(allowed, root), null);
  const outside = pre(root, 'apply_patch', { command: '*** Begin Patch\n*** Add File: ../outside.txt\n+x\n*** End Patch' });
  assert.match(checkPreToolUse(outside, root), /ワークスペース外/);
  const secret = pre(root, 'apply_patch', { command: '*** Begin Patch\n*** Update File: .env\n*** End Patch' });
  assert.match(checkPreToolUse(secret, root), /秘密情報/);
  const example = pre(root, 'apply_patch', { command: '*** Begin Patch\n*** Update File: .env.example\n*** End Patch' });
  assert.equal(checkPreToolUse(example, root), null);
});

test('symlink-mediated direct edits are denied', (context) => {
  const root = fixture();
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-hook-outside-'));
  const link = path.join(root, 'linked');
  try {
    fs.symlinkSync(outside, link, process.platform === 'win32' ? 'junction' : 'dir');
  } catch (error) {
    context.skip(`symlink unavailable: ${error.code || error.message}`);
    return;
  }
  assert.equal(safeWorkspacePath(root, path.join(link, 'file.txt')), false);
  const payload = pre(root, 'apply_patch', { command: '*** Begin Patch\n*** Add File: linked/file.txt\n+x\n*** End Patch' });
  assert.match(checkPreToolUse(payload, root), /symlink/);
});

test('shell guard blocks high-confidence destructive and secret operations', () => {
  const root = fixture();
  for (const command of [
    'Remove-Item -Recurse -Force .\\build',
    'git reset --hard HEAD~1',
    'git commit --no-verify -m skip',
    'Get-Content .env',
    'git config --global core.hooksPath nowhere',
  ]) assert.notEqual(checkPreToolUse(pre(root, 'Bash', { command }), root), null, command);
  assert.equal(checkPreToolUse(pre(root, 'Bash', { command: 'git status --short' }), root), null);
  assert.equal(checkPreToolUse(pre(root, 'Bash', { command: 'Get-Content .env.example' }), root), null);
  assert.equal(checkPreToolUse(pre(root, 'Bash', { command: 'rg token src' }), root), null);
  assert.equal(checkPreToolUse(pre(root, 'Bash', { command: 'Remove-Item -Force .\\one.tmp' }), root), null);
  assert.match(checkPreToolUse(pre(root, 'Bash', { command: 'Get-Content credentials.json' }), root), /秘密情報/);
});

test('protected branches allow creating a work branch but deny direct writes', () => {
  const root = fixture('main');
  assert.match(checkPreToolUse(pre(root, 'Bash', { command: 'git add AGENTS.md' }), root), /保護ブランチ/);
  assert.equal(checkPreToolUse(pre(root, 'Bash', { command: 'git switch -c feature/safe' }), root), null);
  assert.match(checkPreToolUse(pre(root, 'Bash', { command: 'git push origin HEAD:main' }), root), /直接 push/);
});

test('git call extraction handles global options and multiple statements', () => {
  assert.deepEqual(gitCalls('git -C repo status; git -c color.ui=false commit -m ok'), [
    { subcommand: 'status', args: [] },
    { subcommand: 'commit', args: ['-m', 'ok'] },
  ]);
});

test('Git mutations honor -C workspace and protected-branch boundaries', () => {
  const feature = fixture();
  assert.equal(checkPreToolUse(pre(feature, 'Bash', { command: 'git -C . commit -m ok' }), feature), null);
  assert.match(checkPreToolUse(pre(feature, 'Bash', { command: 'git -C .. commit -m no' }), feature), /ワークスペース外/);
  assert.match(checkPreToolUse(pre(feature, 'Bash', { command: 'git -C $TARGET commit -m no' }), feature), /作業場所/);
  assert.match(checkPreToolUse(pre(feature, 'Bash', { command: 'git --git-dir ..\\outside commit -m no' }), feature), /作業場所/);

  const main = fixture('main');
  assert.match(checkPreToolUse(pre(main, 'Bash', { command: 'git -C . add AGENTS.md' }), main), /保護ブランチ/);

  const nested = path.join(main, 'nested');
  fs.mkdirSync(nested);
  execFileSync('git', ['init', '-q', nested]);
  execFileSync('git', ['-C', nested, 'checkout', '-q', '-b', 'feature/nested']);
  assert.equal(checkPreToolUse(pre(main, 'Bash', { command: 'git -C nested add app.mjs' }), main), null);
});

test('SessionStart context is bounded and compact', () => {
  const root = fixture();
  const payload = { cwd: root, session_id: 'session-12345678', hook_event_name: 'SessionStart', source: 'startup' };
  const context = buildContext(payload, root, new Date(2026, 7, 27, 12, 0, 0));
  assert.ok(Buffer.byteLength(context, 'utf8') <= MAX_CONTEXT_BYTES);
  for (const label of ['SESSION STATE', 'LATEST HUMAN REPORT', 'TODO NOW', 'CODEMAP', 'Entry points'])
    assert.match(context, new RegExp(label));
  assert.doesNotMatch(context, /Backlog|LESSONS/);
});

test('machine journal stores lifecycle and direct edit paths, not shell or patch text', () => {
  const root = fixture();
  const now = new Date(2026, 7, 27, 12, 34, 56);
  assert.equal(appendMachine(root, '[session] SESSION START (startup)', now), true);
  handleHook({
    cwd: root,
    session_id: 'session-12345678',
    hook_event_name: 'PostToolUse',
    tool_name: 'apply_patch',
    tool_input: { command: '*** Begin Patch\n*** Update File: AGENTS.md\n*** End Patch' },
    tool_response: { success: true },
  }, root, now);
  const log = fs.readFileSync(path.join(root, 'tasks', 'journal', '.machine', '2026-08', '27.log'), 'utf8');
  assert.match(log, /SESSION START/);
  assert.match(log, /EDIT AGENTS\.md \(ok\)/);
  assert.doesNotMatch(log, /Begin Patch/);
});

test('hook process emits the current PreToolUse deny schema', () => {
  const result = spawnSync(process.execPath, [HOOK], {
    cwd: WORKSPACE_ROOT,
    encoding: 'utf8',
    input: JSON.stringify(pre(WORKSPACE_ROOT, 'Bash', { command: 'git reset --hard HEAD' })),
  });
  assert.equal(result.status, 0, result.stderr);
  const output = JSON.parse(result.stdout);
  assert.equal(output.hookSpecificOutput.hookEventName, 'PreToolUse');
  assert.equal(output.hookSpecificOutput.permissionDecision, 'deny');
});

test('registered command finds and runs the handler from a nested directory', () => {
  const config = JSON.parse(fs.readFileSync(path.join(WORKSPACE_ROOT, '.codex', 'hooks.json'), 'utf8'));
  const command = config.hooks.PreToolUse[0].hooks[0].command;
  const result = spawnSync(command, {
    cwd: path.join(WORKSPACE_ROOT, '.codex', 'hooks'),
    encoding: 'utf8',
    input: JSON.stringify(pre(WORKSPACE_ROOT, 'Bash', { command: 'git reset --hard HEAD' })),
    shell: true,
  });
  assert.equal(result.status, 0, result.stderr);
  const output = JSON.parse(result.stdout);
  assert.equal(output.hookSpecificOutput.permissionDecision, 'deny');
});
