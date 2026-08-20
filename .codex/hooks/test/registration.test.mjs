import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const workspace = path.resolve('.');
const configuration = JSON.parse(fs.readFileSync(path.join(workspace, '.codex', 'hooks.json'), 'utf8'));

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-registration-'));
  fs.mkdirSync(path.join(root, '.codex'), { recursive: true });
  fs.cpSync(path.join(workspace, '.codex', 'hooks'), path.join(root, '.codex', 'hooks'), { recursive: true });
  fs.copyFileSync(path.join(workspace, '.codex', 'hooks.json'), path.join(root, '.codex', 'hooks.json'));
  fs.writeFileSync(path.join(root, 'AGENTS.md'), '# fixture\n', 'utf8');
  fs.mkdirSync(path.join(root, 'tasks'), { recursive: true });
  execFileSync('git', ['init', '-q', root]);
  execFileSync('git', ['-C', root, 'checkout', '-q', '-b', 'main']);
  execFileSync('git', ['-C', root, '-c', 'user.name=Codex Test', '-c', 'user.email=codex@example.invalid', 'commit', '--allow-empty', '-q', '-m', 'initial']);
  return root;
}

function entries() {
  return Object.entries(configuration.hooks).flatMap(([event, groups]) =>
    groups.flatMap((group) => group.hooks.map((hook) => ({ event, matcher: group.matcher, hook }))));
}

function payload(root, event, denied = false) {
  const base = {
    cwd: root,
    session_id: 'registration-12345678',
    turn_id: 'turn-12345678',
    hook_event_name: event,
  };
  if (event === 'SessionStart') return { ...base, source: 'startup' };
  if (event === 'SessionEnd') return { ...base, reason: 'other' };
  if (event === 'PostToolUse') return {
    ...base,
    tool_name: 'Write',
    tool_input: { file_path: 'notes.md', content: 'ordinary edit content' },
    tool_response: { isError: false },
  };
  return {
    ...base,
    tool_name: 'exec_command',
    tool_input: { cmd: denied ? 'git commit -m blocked' : 'git status' },
  };
}

function invoke(root, hook, event, denied = false) {
  return spawnSync(hook.command, {
    cwd: root,
    encoding: 'utf8',
    input: JSON.stringify(payload(root, event, denied)),
    shell: true,
    timeout: 10_000,
  });
}

test('hook registrations target the configured native handlers with bounded matching', () => {
  const expected = {
    SessionStart: { script: 'session-start.mjs', matcher: 'startup|resume|clear|compact' },
    SessionEnd: { script: 'session-end.mjs', matcher: undefined },
    PreToolUse: { script: 'pre-tool-use.mjs', matcher: '^(exec_command|Bash|PowerShell|apply_patch|Edit|Write|Move)$' },
    PostToolUse: { script: 'post-tool-use.mjs', matcher: '^(apply_patch|Edit|Write|Move)$' },
  };

  for (const { event, matcher, hook } of entries()) {
    assert.equal(hook.type, 'command', event);
    assert.match(hook.command, new RegExp(expected[event].script.replace('.', '\\.')), event);
    assert.equal(matcher, expected[event].matcher, event);
  }

  const sessionStart = entries().find(({ event }) => event === 'SessionStart').hook;
  const sessionEnd = entries().find(({ event }) => event === 'SessionEnd').hook;
  assert.equal(sessionStart.additionalContextLimit, 2500);
  assert.equal(sessionEnd.timeout, 3);
});

test('every configured native hook command runs in a disposable fixture', () => {
  const root = fixture();
  for (const { event, hook } of entries()) {
    if (event === 'PreToolUse') {
      const allowed = invoke(root, hook, event);
      assert.equal(allowed.status, 0, allowed.stderr);
      assert.equal(allowed.stdout.trim(), '');
      const denied = invoke(root, hook, event, true);
      assert.equal(denied.status, 0, denied.stderr);
      assert.equal(JSON.parse(denied.stdout).decision, 'block');
      continue;
    }

    const result = invoke(root, hook, event);
    assert.equal(result.status, 0, event + ': ' + result.stderr);
    if (event === 'SessionStart')
      assert.equal(JSON.parse(result.stdout).hookSpecificOutput.hookEventName, 'SessionStart');
  }
});

test('launcher ignores a nested malicious configuration and uses the outer hub handler', () => {
  const root = fixture();
  const nested = path.join(root, 'nested', 'untrusted');
  const hook = entries().find(({ event }) => event === 'SessionStart').hook;

  fs.mkdirSync(path.join(nested, '.codex', 'hooks'), { recursive: true });
  fs.writeFileSync(path.join(nested, '.codex', 'hooks.json'), '{}\n', 'utf8');
  fs.writeFileSync(path.join(nested, 'AGENTS.md'), '# untrusted\n', 'utf8');
  const marker = path.join(root, 'nested-malicious-handler-ran');
  fs.writeFileSync(path.join(nested, '.codex', 'hooks', 'session-start.mjs'), "import fs from 'node:fs'; fs.writeFileSync(" + JSON.stringify(marker) + ", 'ran'); process.exit(97);\n", 'utf8');

  const result = invoke(nested, hook, 'SessionStart');
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).hookSpecificOutput.hookEventName, 'SessionStart');
  assert.equal(fs.existsSync(marker), false);
});

test('launcher rejects a symlinked configuration or handler', (t) => {
  const cases = [
    ['config', '.codex', 'hooks.json'],
    ['handler', '.codex', 'hooks', 'session-start.mjs'],
  ];
  for (const [label, ...parts] of cases) {
    const root = fixture();
    const hook = entries().find(({ event }) => event === 'SessionStart').hook;
    const target = path.join(root, ...parts);
    const externalRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-launcher-symlink-'));
    const external = path.join(externalRoot, label === 'config' ? 'hooks.json' : 'session-start.mjs');
    const marker = path.join(root, 'symlink-handler-ran');
    fs.writeFileSync(external, label === 'config' ? '{}\n' : "import fs from 'node:fs'; fs.writeFileSync(" + JSON.stringify(marker) + ", 'ran');\n", 'utf8');
    fs.rmSync(target);
    try {
      fs.symlinkSync(external, target, 'file');
    } catch (error) {
      t.skip('symbolic links are unavailable in this test host: ' + error.code);
      return;
    }
    const result = invoke(root, hook, 'SessionStart');
    assert.notEqual(result.status, 0, label + ': ' + result.stderr);
    assert.equal(fs.existsSync(marker), false, label);
  }
});


test('hook registration config has the exact four event, group, and handler contract', () => {
  const expected = {
    SessionStart: {
      script: 'session-start.mjs',
      matcher: 'startup|resume|clear|compact',
      timeout: 10,
      statusMessage: 'Loading workspace context',
      additionalContextLimit: 2500,
    },
    SessionEnd: {
      script: 'session-end.mjs',
      matcher: undefined,
      timeout: 3,
      statusMessage: 'Saving session marker',
    },
    PreToolUse: {
      script: 'pre-tool-use.mjs',
      matcher: '^(exec_command|Bash|PowerShell|apply_patch|Edit|Write|Move)$',
      timeout: 10,
      statusMessage: 'Checking workspace policy',
    },
    PostToolUse: {
      script: 'post-tool-use.mjs',
      matcher: '^(apply_patch|Edit|Write|Move)$',
      timeout: 20,
      statusMessage: 'Recording workspace activity',
    },
  };

  assert.deepEqual(Object.keys(configuration.hooks).sort(), Object.keys(expected).sort());
  assert.equal(entries().length, Object.keys(expected).length);

  for (const [event, shape] of Object.entries(expected)) {
    const groups = configuration.hooks[event];
    assert.equal(groups.length, 1, event + ' group count');
    const [group] = groups;
    assert.deepEqual(
      Object.keys(group).sort(),
      shape.matcher === undefined ? ['hooks'] : ['hooks', 'matcher'],
      event + ' group keys',
    );
    assert.equal(group.matcher, shape.matcher, event + ' matcher');
    assert.equal(group.hooks.length, 1, event + ' handler count');

    const [hook] = group.hooks;
    const handlerKeys = ['command', 'statusMessage', 'timeout', 'type'];
    if (shape.additionalContextLimit !== undefined) handlerKeys.push('additionalContextLimit');
    assert.deepEqual(Object.keys(hook).sort(), handlerKeys.sort(), event + ' handler keys');
    assert.equal(hook.type, 'command', event);
    assert.equal(hook.timeout, shape.timeout, event);
    assert.equal(hook.statusMessage, shape.statusMessage, event);
    assert.equal(hook.additionalContextLimit, shape.additionalContextLimit, event);
    assert.ok(hook.command.includes(shape.script), event + ' handler command');

    const handler = path.join(workspace, '.codex', 'hooks', shape.script);
    assert.equal(fs.existsSync(handler), true, event + ' handler exists');
    assert.equal(fs.statSync(handler).isFile(), true, event + ' handler is a file');
  }
});

function machineEvents(root) {
  const machineRoot = path.join(root, 'tasks', 'journal', '.machine');
  const logs = [];
  const collect = (directory) => {
    if (!fs.existsSync(directory)) return;
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const target = path.join(directory, entry.name);
      if (entry.isDirectory()) collect(target);
      if (entry.isFile() && entry.name.endsWith('.log')) logs.push(target);
    }
  };
  collect(machineRoot);
  return logs.sort().map((file) => fs.readFileSync(file, 'utf8')).join('\n');
}

test('registered commands emit only lifecycle and edit machine effects and enforce PreToolUse', () => {
  const root = fixture();
  const hooks = Object.fromEntries(entries().map(({ event, hook }) => [event, hook]));

  const start = invoke(root, hooks.SessionStart, 'SessionStart');
  assert.equal(start.status, 0, start.stderr);
  assert.equal(JSON.parse(start.stdout).hookSpecificOutput.hookEventName, 'SessionStart');

  const allowed = invoke(root, hooks.PreToolUse, 'PreToolUse');
  assert.equal(allowed.status, 0, allowed.stderr);
  assert.equal(allowed.stdout.trim(), '');

  const denied = invoke(root, hooks.PreToolUse, 'PreToolUse', true);
  assert.equal(denied.status, 0, denied.stderr);
  const denial = JSON.parse(denied.stdout);
  assert.equal(denial.decision, 'block');
  assert.equal(denial.hookSpecificOutput.permissionDecision, 'deny');

  const end = invoke(root, hooks.SessionEnd, 'SessionEnd');
  assert.equal(end.status, 0, end.stderr);
  assert.equal(end.stdout.trim(), '');

  const post = invoke(root, hooks.PostToolUse, 'PostToolUse');
  assert.equal(post.status, 0, post.stderr);
  assert.equal(post.stdout.trim(), '');

  const machine = machineEvents(root);
  assert.match(machine, /SESSION START \(startup\)/);
  assert.match(machine, /SESSION END \(other\)/);
  assert.match(machine, /EDIT Write notes\.md \(ok\)/);
  assert.doesNotMatch(machine, /git (?:status|commit)/);
});
