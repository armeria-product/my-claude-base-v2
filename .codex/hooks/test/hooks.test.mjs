import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { checkPolicy, denial, hasSecretPath } from '../lib/policy.mjs';
import { buildContext, extractFilePaths, journalPath, readPayload } from '../lib/runtime.mjs';

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-hooks-'));
  execFileSync('git', ['init', '-q', root]);
  execFileSync('git', ['-C', root, 'checkout', '-q', '-b', 'main']);
  execFileSync('git', ['-C', root, '-c', 'user.name=Codex Test', '-c', 'user.email=codex@example.invalid', 'commit', '--allow-empty', '-q', '-m', 'initial']);
  fs.mkdirSync(path.join(root, 'tasks', 'journal', '2026', '08'), { recursive: true });
  fs.writeFileSync(path.join(root, 'tasks', 'session-state.md'), '## START HERE — pointer\n');
  fs.writeFileSync(path.join(root, 'tasks', 'todo.md'), '## Now\n- [ ] native hooks\n');
  fs.writeFileSync(path.join(root, 'tasks', 'lessons.md'), '### [2026-08-20] preserve provider boundary\n');
  return root;
}

function payload(root, extra = {}) {
  return {
    cwd: root,
    session_id: 'session-12345678',
    turn_id: 'turn-12345678',
    hook_event_name: 'PreToolUse',
    tool_name: 'exec_command',
    tool_input: { cmd: 'git status' },
    ...extra,
  };
}

test('payload parser accepts objects and rejects malformed data', () => {
  assert.deepEqual(readPayload('{"cwd":"x"}'), { cwd: 'x' });
  assert.throws(() => readPayload('[]'), /object/);
  assert.throws(() => readPayload('{'), SyntaxError);
});

test('session context follows dev task routing and chooses the latest report', () => {
  const root = fixture();
  const dev = path.join(root, 'dev', 'alpha');
  fs.mkdirSync(path.join(dev, 'tasks'), { recursive: true });
  fs.writeFileSync(path.join(dev, 'tasks', 'todo.md'), 'product todo');
  fs.writeFileSync(path.join(root, 'tasks', 'journal', '2026', '08', '20.md'), '- machine\n## 10:00 report\nlatest report');
  const context = buildContext(payload(dev), new Date('2026-08-20T12:00:00'));
  assert.match(context, /product todo/);
  assert.match(context, /latest report/);
  assert.match(context, /session-/);
});

test('native patch paths are extracted without interpreting shell input', () => {
  const root = fixture();
  const paths = extractFilePaths(payload(root, {
    tool_name: 'apply_patch',
    tool_input: '*** Begin Patch\n*** Update File: dev/alpha/a.ts\n*** End Patch',
  }));
  assert.deepEqual(paths, [path.join(root, 'dev', 'alpha', 'a.ts')]);
  const secretPatch = extractFilePaths(payload(root, {
    tool_name: 'apply_patch',
    tool_input: { command: '*** Begin Patch\n*** Update File: .env\n*** End Patch' },
  }));
  assert.deepEqual(secretPatch, [path.join(root, '.env')]);
  assert.notEqual(checkPolicy(payload(root, {
    tool_name: 'apply_patch',
    tool_input: { command: '*** Begin Patch\n*** Update File: .env\n*** End Patch' },
  })), null);
});

test('safety policy blocks destructive, secret, direct-main, no-verify, and stale-PR cases', () => {
  const root = fixture();
  const todo = path.join(root, 'tasks', 'todo.md');
  fs.utimesSync(todo, new Date(0), new Date(0));
  const cases = [
    'git reset --hard',
    'Remove-Item -Recurse -Force build',
    'Get-Content .env',
    'git commit --no-verify -m test',
    'git commit -m test',
    'gh pr create --fill',
  ];
  for (const command of cases) {
    assert.notEqual(checkPolicy(payload(root, { tool_input: { cmd: command } })), null, command);
  }
  assert.equal(checkPolicy(payload(root, { tool_input: { cmd: 'git status' } })), null);
  assert.equal(hasSecretPath('docs/secretary.md'), false);
  assert.equal(hasSecretPath('.env.production'), true);
});

test('fresh todo allows PR creation on a work branch', () => {
  const root = fixture();
  execFileSync('git', ['-C', root, 'checkout', '-q', '-b', 'feature/hooks']);
  const todo = path.join(root, 'tasks', 'todo.md');
  fs.utimesSync(todo, new Date(Date.now() + 2_000), new Date(Date.now() + 2_000));
  assert.equal(checkPolicy(payload(root, { tool_input: { cmd: 'gh pr create --fill' } })), null);
});

test('direct-main protection resolves an explicit git -C target', () => {
  const root = fixture();
  const nested = path.join(root, 'scratch');
  fs.mkdirSync(nested);
  assert.notEqual(checkPolicy(payload(nested, { tool_input: { cmd: `git -C "${root}" commit -m test` } })), null);
});

test('direct-main protection rejects switching then writing in one command chain', () => {
  const root = fixture();
  execFileSync('git', ['-C', root, 'checkout', '-q', '-b', 'feature/hooks']);
  assert.notEqual(checkPolicy(payload(root, { tool_input: { cmd: 'git switch main; git commit -m test' } })), null);
  assert.notEqual(checkPolicy(payload(root, { tool_input: { cmd: 'git switch "main"; git commit -m test' } })), null);
});

test('pre-tool deny uses the native denial envelope without continue', () => {
  const output = JSON.parse(denial('blocked'));
  assert.equal(output.decision, 'block');
  assert.equal(output.hookSpecificOutput.permissionDecision, 'deny');
  assert.equal(Object.hasOwn(output, 'continue'), false);
});

test('session hook appends a marker and returns official context envelope', () => {
  const root = fixture();
  const script = path.resolve('.codex/hooks/session-start.mjs');
  const result = spawnSync(process.execPath, [script], {
    cwd: root,
    input: JSON.stringify(payload(root, { hook_event_name: 'SessionStart', source: 'startup' })),
    encoding: 'utf8',
  });
  assert.equal(result.status, 0, result.stderr);
  const output = JSON.parse(result.stdout);
  assert.equal(output.hookSpecificOutput.hookEventName, 'SessionStart');
  const journal = fs.readFileSync(journalPath(root), 'utf8');
  assert.match(journal, /SESSION START/);
});

test('Codex hook sources remain provider-independent', () => {
  const root = path.resolve('.codex', 'hooks');
  const prohibited = ['.claude', 'hooks'].join('/');
  const sources = fs.readdirSync(root, { recursive: true })
    .filter((name) => String(name).endsWith('.mjs') && !String(name).startsWith('test'));
  for (const source of sources) {
    const text = fs.readFileSync(path.join(root, source), 'utf8');
    assert.equal(text.includes(prohibited), false, source);
  }
});
