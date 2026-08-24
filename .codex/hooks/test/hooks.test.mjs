import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { checkPolicy, denial, hasSecretPath, splitShellSegments } from '../lib/policy.mjs';
import { buildContext, extractFilePaths, readPayload } from '../lib/runtime.mjs';

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-hooks-'));
  fs.mkdirSync(path.join(root, '.codex'), { recursive: true });
  fs.writeFileSync(path.join(root, '.codex', 'hooks.json'), '{}\n');
  fs.writeFileSync(path.join(root, 'AGENTS.md'), '# Test workspace\n');
  execFileSync('git', ['init', '-q', root]);
  execFileSync('git', ['-C', root, 'checkout', '-q', '-b', 'main']);
  execFileSync('git', ['-C', root, '-c', 'user.name=Codex Test', '-c', 'user.email=codex@example.invalid', 'commit', '--allow-empty', '-q', '-m', 'initial']);
  fs.mkdirSync(path.join(root, 'tasks', 'journal', '2026', '08'), { recursive: true });
  fs.writeFileSync(path.join(root, 'tasks', 'session-state.md'), '## START HERE — pointer\n');
  fs.writeFileSync(path.join(root, 'tasks', 'todo.md'), '## Now\n- [ ] native hooks\n');
  fs.writeFileSync(path.join(root, 'tasks', 'lessons.md'), '### [2026-08-20] preserve provider boundary\n');
  return root;
}

function nestedRepository(root, name, branch = 'feature/hooks') {
  const target = path.join(root, 'dev', name);
  fs.mkdirSync(target, { recursive: true });
  execFileSync('git', ['init', '-q', target]);
  execFileSync('git', ['-C', target, 'checkout', '-q', '-b', 'main']);
  execFileSync('git', ['-C', target, '-c', 'user.name=Codex Test', '-c', 'user.email=codex@example.invalid', 'commit', '--allow-empty', '-q', '-m', 'initial']);
  if (branch !== 'main') execFileSync('git', ['-C', target, 'checkout', '-q', '-b', branch]);
  return target;
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

function commandPayload(root, command) {
  return payload(root, { tool_input: { cmd: command } });
}

test('payload parser accepts objects and rejects malformed data', () => {
  assert.deepEqual(readPayload('{"cwd":"x"}'), { cwd: 'x' });
  assert.throws(() => readPayload('[]'), /object/);
  assert.throws(() => readPayload('{'), SyntaxError);
});

test('session context follows dev task routing and chooses a legacy human report', () => {
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
});

test('apply_patch accepts the string-argument bridge envelope and fails closed otherwise', () => {
  const root = fixture();
  const patch = '*** Begin Patch\n*** Update File: src/wrapped.mjs\n*** End Patch';
  const wrapped = payload(root, {
    tool_name: 'apply_patch',
    tool_input: { input: patch },
  });
  assert.deepEqual(extractFilePaths(wrapped), [path.join(root, 'src', 'wrapped.mjs')]);
  assert.equal(checkPolicy(wrapped), null);

  const secret = payload(root, {
    tool_name: 'apply_patch',
    tool_input: { input: '*** Begin Patch\n*** Update File: .env\n*** End Patch' },
  });
  assert.deepEqual(extractFilePaths(secret), [path.join(root, '.env')]);
  assert.notEqual(checkPolicy(secret), null);

  const contentOnly = payload(root, {
    tool_name: 'apply_patch',
    tool_input: { content: patch },
  });
  assert.deepEqual(extractFilePaths(contentOnly), []);
  assert.notEqual(checkPolicy(contentOnly), null);
});

test('apply_patch accepts canonical command input and rejects conflicting patch sources', () => {
  const root = fixture();
  const patch = '*** Begin Patch\n*** Update File: src/canonical.mjs\n*** End Patch';
  for (const tool_input of [
    { command: patch },
    { command: patch, patch },
    { command: patch, input: patch },
    { command: patch, patch, input: patch },
  ]) assert.equal(checkPolicy(payload(root, { tool_name: 'apply_patch', tool_input })), null);

  for (const tool_input of [
    { command: patch, patch: patch + '\n# conflicting' },
    { command: patch, input: patch + '\n# conflicting' },
    { patch, input: patch + '\n# conflicting' },
    { command: patch, patch: 42 },
    { command: patch, input: { input: patch } },
  ]) assert.notEqual(checkPolicy(payload(root, { tool_name: 'apply_patch', tool_input })), null);

  assert.match(checkPolicy(payload(root, {
    tool_name: 'apply_patch',
    tool_input: { command: '*** Begin Patch\n*** Update File: ../outside.mjs\n*** End Patch' },
  })), /ワークスペース外またはシンボリックリンク/);
  assert.match(checkPolicy(payload(root, {
    tool_name: 'apply_patch',
    tool_input: { command: '*** Begin Patch\n*** Update File: .env\n*** End Patch' },
  })), /秘密情報/);
});

test('canonical apply_patch command rejects symlink paths', (t) => {
  const root = fixture();
  const link = path.join(root, 'linked');
  try {
    fs.symlinkSync(os.tmpdir(), link, process.platform === 'win32' ? 'junction' : 'dir');
  } catch (error) {
    if (['EACCES', 'EPERM'].includes(error?.code)) {
      t.skip('host does not permit test symlink creation');
      return;
    }
    throw error;
  }
  assert.match(checkPolicy(payload(root, {
    tool_name: 'apply_patch',
    tool_input: { command: '*** Begin Patch\n*** Update File: linked/escaped.mjs\n*** End Patch' },
  })), /ワークスペース外またはシンボリックリンク/);
});

test('apply_patch Move to validates both source and destination paths', (t) => {
  const root = fixture();
  const movePatch = (source, destination) => [
    '*** Begin Patch',
    `*** Update File: ${source}`,
    `*** Move to: ${destination}`,
    '*** End Patch',
  ].join('\n');
  assert.equal(checkPolicy(payload(root, {
    tool_name: 'apply_patch',
    tool_input: { command: movePatch('src/before.mjs', 'src/after.mjs') },
  })), null);
  for (const patch of [
    movePatch('.env', 'src/after.mjs'),
    movePatch('src/before.mjs', '.env'),
    movePatch('src/before.mjs', '../outside.mjs'),
  ]) assert.notEqual(checkPolicy(payload(root, {
    tool_name: 'apply_patch',
    tool_input: { command: patch },
  })), null);

  const link = path.join(root, 'linked');
  try {
    fs.symlinkSync(os.tmpdir(), link, process.platform === 'win32' ? 'junction' : 'dir');
  } catch (error) {
    if (['EACCES', 'EPERM'].includes(error?.code)) {
      t.skip('host does not permit test symlink creation');
      return;
    }
    throw error;
  }
  assert.match(checkPolicy(payload(root, {
    tool_name: 'apply_patch',
    tool_input: { command: movePatch('src/before.mjs', 'linked/escaped.mjs') },
  })), /ワークスペース外またはシンボリックリンク/);
});

test('edit tools require a path, deny secrets, and never classify body text as shell', () => {
  const root = fixture();
  const body = 'Format-Table\ngit reset --hard\nRemove-Item -Recurse build';
  assert.equal(checkPolicy(payload(root, {
    tool_name: 'Edit',
    tool_input: { file_path: 'src/a.mjs', old_string: 'old', new_string: body },
  })), null);
  assert.equal(checkPolicy(payload(root, {
    tool_name: 'apply_patch',
    tool_input: '*** Begin Patch\n*** Update File: src/a.mjs\n*** End Patch',
  })), null);
  assert.notEqual(checkPolicy(payload(root, {
    tool_name: 'Edit',
    tool_input: { content: body },
  })), null);
  assert.notEqual(checkPolicy(payload(root, {
    tool_name: 'apply_patch',
    tool_input: { patch: '' },
  })), null);
  assert.notEqual(checkPolicy(payload(root, {
    tool_name: 'apply_patch',
    tool_input: '*** Begin Patch\n*** Update File: .env\n*** End Patch',
  })), null);
});

test('edit path extraction ignores patch-like body text outside explicit path fields', () => {
  const root = fixture();
  const fakePatch = '*** Begin Patch\n*** Update File: fake/secret.key\n*** End Patch';
  const contentOnly = payload(root, {
    tool_name: 'Edit',
    tool_input: { content: fakePatch },
  });
  assert.deepEqual(extractFilePaths(contentOnly), []);
  assert.notEqual(checkPolicy(contentOnly), null);
  for (const tool_name of ['Edit', 'Write']) {
    const explicitPath = payload(root, {
      tool_name,
      tool_input: { file_path: 'src/real.mjs', content: fakePatch },
    });
    assert.deepEqual(extractFilePaths(explicitPath), [path.join(root, 'src', 'real.mjs')]);
    assert.equal(checkPolicy(explicitPath), null);
  }
  assert.equal(checkPolicy(payload(root, {
    tool_name: 'exec_command',
    tool_input: { cmd: 'Get-Content AGENTS.md', content: 'Get-Content .env' },
  })), null);
});

test('safety policy blocks dangerous commands and direct protected-branch writes', () => {
  const root = fixture();
  const cases = [
    'git reset --hard',
    'git restore src/a.mjs',
    'git switch -C codex/probe',
    'git pull',
    'Remove-Item -Recurse -Force build',
    'format C:',
    'Get-Content .env',
    'git commit --no-verify -m test',
    'git commit -m test',
  ];
  for (const command of cases) {
    assert.notEqual(checkPolicy(commandPayload(root, command)), null, command);
  }
  assert.equal(hasSecretPath('docs/secretary.md'), false);
  assert.equal(hasSecretPath('.env.production'), true);
});

test('safe display, search, branch navigation, fast-forward sync, and PR commands allow', () => {
  const root = fixture();
  const cases = [
    'git status',
    'Format-Table',
    'git show --format=fuller',
    'rg "git switch -C main" .',
    'node -e "console' + '.log(\'git reset --hard\')"',
    'git switch feature/probe',
    'git switch -c codex/probe',
    'git pull --ff-only',
    'gh pr create --fill',
  ];
  for (const command of cases) {
    assert.equal(checkPolicy(commandPayload(root, command)), null, command);
  }
});

test('wrapper scanner normalizes continuations and inspects executed forms only', () => {
  const root = fixture();
  const slash = String.fromCharCode(92);
  const powerShellEscape = String.fromCharCode(96);
  const pairs = [
    ['git reset ' + slash + '\n--hard', 'git status ' + slash + '\n--short'],
    ['git reset ' + powerShellEscape + '\n--hard', 'git status ' + powerShellEscape + '\n--short'],
    ['git reset ^\r\n--hard', 'git status ^\r\n--short'],
    ['POLICY_TEST=1 git reset --hard', 'POLICY_TEST=1 git status'],
    ['env POLICY_TEST=1 git reset --hard', 'env POLICY_TEST=1 git status'],
    ['command git reset --hard', 'command git status'],
    ['cmd /c "git reset --hard"', 'cmd /c "git status"'],
    ['powershell -Command "git reset --hard"', 'powershell -Command "git status"'],
    ['pwsh -Command { git reset --hard }', 'pwsh -Command { git status }'],
    ['sh -c "git reset --hard"', 'sh -c "git status"'],
    ['echo "$(git reset --hard)"', 'echo "$(git status)"'],
    ['& { git reset --hard }', '& { git status }'],
  ];
  for (const [deny, allow] of pairs) {
    assert.notEqual(checkPolicy(commandPayload(root, deny)), null, deny);
    assert.equal(checkPolicy(commandPayload(root, allow)), null, allow);
  }
  for (const command of [
    'node -e "console' + '.log(\'git reset --hard\')"',
    'node -e "console' + '.log(\'Get-Content .env\')"',
    'echo "git reset --hard"',
    'echo "Get-Content .env"',
  ]) assert.equal(checkPolicy(commandPayload(root, command)), null, command);
});

test('shell segmentation ignores separators inside quoted arguments', () => {
  assert.deepEqual(splitShellSegments('node -e "console' + '.log(\'a;b\')" && git status'), [
    'node -e "console' + '.log(\'a;b\')"',
    'git status',
  ]);
});

test('compound Git state changes fail closed while a work-branch commit allows', () => {
  const root = fixture();
  execFileSync('git', ['-C', root, 'checkout', '-q', '-b', 'feature/hooks']);
  assert.equal(checkPolicy(commandPayload(root, 'git commit -m test')), null);
  assert.notEqual(checkPolicy(commandPayload(root, 'git pull --ff-only; git commit -m test')), null);
  assert.notEqual(checkPolicy(commandPayload(root, 'git switch main; git commit -m test')), null);
  assert.notEqual(checkPolicy(commandPayload(root, `git -C "${root}" pull --ff-only; git -C "${root}" commit -m test`)), null);
});

test('alternate repository forms fail closed while compact git -C resolves the work branch', () => {
  const protectedRoot = fixture();
  const work = fixture();
  execFileSync('git', ['-C', work, 'checkout', '-q', '-b', 'feature/hooks']);
  assert.notEqual(checkPolicy(commandPayload(work, 'git -C"' + protectedRoot + '" commit -m test')), null);
  assert.equal(checkPolicy(commandPayload(work, 'git -C' + work + ' commit -m test')), null);
  for (const command of [
    'git --git-dir .git commit -m test',
    'git --work-tree . commit -m test',
    'GIT_DIR=.git git commit -m test',
    'env GIT_WORK_TREE=. git commit -m test',
    'git -C$REPOSITORY commit -m test',
    'cmd /c "set GIT_DIR=.git && git commit -m test"',
    'pwsh -Command "$env:GIT_DIR = \'.git\'; git commit -m test"',
  ]) assert.notEqual(checkPolicy(commandPayload(work, command)), null, command);
});

test('literal exec workdir permits a nested feature repository and keeps write safeguards active', () => {
  const root = fixture();
  const work = nestedRepository(root, 'reprodocs');
  const workdir = path.relative(root, work);
  assert.equal(checkPolicy(payload(root, {
    tool_input: { cmd: 'git commit -m test', workdir },
  })), null);
  assert.equal(checkPolicy(payload(root, {
    tool_input: { cmd: 'git commit -m test', workdir: work },
  })), null);
  assert.notEqual(checkPolicy(commandPayload(root, 'git commit -m test')), null);

  for (const command of [
    'git commit --no-verify -m test',
    'git reset --hard',
    'git push origin feature/hooks:main',
    'git show HEAD:.env',
  ]) assert.notEqual(checkPolicy(payload(root, {
    tool_input: { cmd: command, workdir },
  })), null, command);
});

test('exec workdir accepts only an existing non-symlink workspace directory on a feature branch', () => {
  const root = fixture();
  const work = nestedRepository(root, 'reprodocs');
  const protectedWorkdirs = ['main', 'master', 'trunk']
    .map((branch) => nestedRepository(root, `protected-${branch}`, branch));
  const nonRepository = path.join(root, 'dev', 'not-a-repository');
  const file = path.join(root, 'not-a-directory');
  fs.mkdirSync(nonRepository, { recursive: true });
  fs.writeFileSync(file, 'file\n');
  const denied = [
    path.relative(root, file),
    'dev/missing',
    '$REPOSITORY',
    'dev/*',
    fixture(),
    null,
    42,
    {},
    [],
  ];
  for (const workdir of denied) assert.match(checkPolicy(payload(root, {
    tool_input: { cmd: 'git commit -m test', workdir },
  })), /実行作業ディレクトリ/, String(workdir));
  for (const workdir of [path.relative(root, nonRepository), ...protectedWorkdirs.map((target) => path.relative(root, target))]) {
    assert.match(checkPolicy(payload(root, {
      tool_input: { cmd: 'git commit -m test', workdir },
    })), /保護ブランチ/);
  }
  assert.equal(checkPolicy(payload(root, {
    tool_input: { cmd: 'git commit -m test', workdir: path.relative(root, work) },
  })), null);
});

test('explicit exec workdir is validated before Git read and sync early returns', () => {
  const root = fixture();
  const work = nestedRepository(root, 'reprodocs');
  const commands = ['git status', 'git checkout feature/hooks', 'git pull --ff-only'];
  for (const workdir of [path.relative(root, work), work]) {
    for (const cmd of commands) assert.equal(checkPolicy(payload(root, {
      tool_input: { cmd, workdir },
    })), null, cmd + ' ' + workdir);
  }

  const file = path.join(root, 'not-a-directory');
  fs.writeFileSync(file, 'file\n');
  for (const workdir of [path.relative(root, file), 'dev/missing', fixture(), null, 42, {}, []]) {
    assert.match(checkPolicy(payload(root, {
      tool_input: { cmd: 'git status', workdir },
    })), /実行作業ディレクトリ/, String(workdir));
  }
  for (const cmd of commands) assert.match(checkPolicy(payload(root, {
    tool_input: { cmd, workdir: 'dev/missing' },
  })), /実行作業ディレクトリ/, cmd);
});

test('symlink exec workdir is rejected', (t) => {
  const root = fixture();
  const work = nestedRepository(root, 'reprodocs');
  const link = path.join(root, 'dev', 'linked-reprodocs');
  try {
    fs.symlinkSync(work, link, process.platform === 'win32' ? 'junction' : 'dir');
  } catch (error) {
    if (['EACCES', 'EPERM'].includes(error?.code)) {
      t.skip('host does not permit test symlink creation');
      return;
    }
    throw error;
  }
  for (const cmd of ['git status', 'git checkout feature/hooks', 'git pull --ff-only', 'git commit -m test']) {
    assert.match(checkPolicy(payload(root, {
      tool_input: { cmd, workdir: path.relative(root, link) },
    })), /実行作業ディレクトリ/, cmd);
  }
});

test('git -C writes cannot leave the literal exec workdir repository', () => {
  const root = fixture();
  const work = nestedRepository(root, 'reprodocs');
  const sibling = nestedRepository(root, 'other-product');
  const workdir = path.relative(root, work);
  assert.equal(checkPolicy(payload(root, {
    tool_input: { cmd: 'git -C . commit -m test', workdir },
  })), null);
  assert.equal(checkPolicy(payload(root, {
    tool_input: { cmd: 'git -C . -C . commit -m test', workdir },
  })), null);
  assert.equal(checkPolicy(payload(root, {
    tool_input: { cmd: `git -C "${work}" commit -m test`, workdir },
  })), null);
  assert.match(checkPolicy(payload(root, {
    tool_input: { cmd: `git -C "${sibling}" commit -m test`, workdir },
  })), /別リポジトリ/);
  assert.match(checkPolicy(payload(root, {
    tool_input: { cmd: 'git -C . -C .. commit -m test', workdir },
  })), /別リポジトリ/);
  assert.equal(checkPolicy(payload(root, {
    tool_input: { cmd: 'git -C . pull --ff-only', workdir },
  })), null);
  for (const command of ['git -C .. pull --ff-only', 'git -C "' + sibling + '" pull --ff-only']) {
    assert.match(checkPolicy(payload(root, {
      tool_input: { cmd: command, workdir },
    })), /別リポジトリ/, command);
  }
  assert.equal(checkPolicy(commandPayload(root, 'git pull --ff-only')), null);
});

test('git -C targets are checked for every Git operation', () => {
  const root = fixture();
  const work = nestedRepository(root, 'reprodocs');
  const sibling = nestedRepository(root, 'other-product');
  const workdir = path.relative(root, work);
  for (const operation of [
    'add tracked.txt',
    'update-index --add tracked.txt',
    'stash',
    'config user.name Codex',
    'fetch origin',
    'checkout feature/hooks',
    'status',
  ]) {
    assert.match(checkPolicy(payload(root, {
      tool_input: { cmd: 'git -C "' + sibling + '" ' + operation, workdir },
    })), /別リポジトリ/, operation);
  }
  assert.equal(checkPolicy(payload(root, {
    tool_input: { cmd: 'git -C . status', workdir },
  })), null);
});

test('cwd changes block Git writes even when git -C is explicit', () => {
  const root = fixture();
  const work = nestedRepository(root, 'reprodocs');
  const workdir = path.relative(root, work);
  for (const change of ['cd ..', 'chdir ..', 'Set-Location ..', 'Push-Location ..', 'pushd ..', 'sl ..']) {
    assert.match(checkPolicy(payload(root, {
      tool_input: { cmd: `${change}; git -C . commit -m test`, workdir },
    })), /作業ディレクトリを途中で切り替える Git 書き込み/);
  }
});

test('CWD dispatch variants and dynamic definitions fail closed without classifying inert prose', () => {
  const root = fixture();
  const work = nestedRepository(root, 'reprodocs');
  const workdir = path.relative(root, work);
  for (const command of [
    'popd; git -C . commit -m test',
    'Pop-Location; git -C . commit -m test',
    'cmd /c "cd.. & git -C . commit -m test"',
    'cmd /c "cd\\ & git -C . commit -m test"',
    'bash -lc "builtin cd ..; git -C . commit -m test"',
  ]) assert.match(checkPolicy(payload(root, {
    tool_input: { cmd: command, workdir },
  })), /作業ディレクトリを途中で切り替える Git 書き込み/, command);
  for (const command of [
    'Set-Alias c Set-Location; c ..; git -C . commit -m test',
    'New-Alias c Set-Location; c ..; git -C . commit -m test',
    'Set-Item Alias:c Set-Location; c ..; git -C . commit -m test',
    "alias c='cd ..'; c; git -C . commit -m test",
    'function c() { cd ..; }; c; git -C . commit -m test',
  ]) assert.match(checkPolicy(payload(root, {
    tool_input: { cmd: command, workdir },
  })), /(?:安全に検査できない|Git 書き込みと Git 以外|作業ディレクトリを途中で切り替える)/, command);
  assert.equal(checkPolicy(payload(root, {
    tool_input: { cmd: 'git -C . commit -m test', workdir },
  })), null);
  for (const command of [
    'echo "popd; git -C . commit -m test"',
    'echo "Set-Alias c Set-Location; c ..; git -C . commit -m test"',
    "echo \"alias c='cd ..'; c; git -C . commit -m test\"",
  ]) assert.equal(checkPolicy(payload(root, {
    tool_input: { cmd: command, workdir },
  })), null, command);
});

test('Git writes reject mixed non-Git execution and hidden control flow while Git-only chains allow', () => {
  const root = fixture();
  const work = nestedRepository(root, 'reprodocs');
  const workdir = path.relative(root, work);
  for (const command of [
    'Write-Output pre; git -C . commit -m test',
    'sal c Set-Location; git -C . commit -m test',
    'si Alias:c Set-Location; git -C . commit -m test',
    'ni Alias:c Set-Location; git -C . commit -m test',
    'Set-Item Function:c { Write-Output pre }; git -C . commit -m test',
    'Rename-Item before after; git -C . commit -m test',
    'cmd /c "call git -C . commit -m test"',
    'cmd /c "call %GIT% commit -m test"',
    'cmd /c "if 1==1 git -C . commit -m test"',
    'cmd /c "for %I in (1) do git -C . commit -m test"',
    'cmd /c "%GIT% commit -m test"',
    'cmd /c "!GIT! commit -m test"',
    'bash -lc "echo pre; git -C . commit -m test"',
    'bash -lc "if true; then git -C . commit -m test; fi"',
    'bash -lc "function c() { git -C . commit -m test; }; c"',
  ]) assert.notEqual(checkPolicy(payload(root, {
    tool_input: { cmd: command, workdir },
  })), null, command);
  for (const command of [
    'git status; git -C . commit -m test',
    'cmd /c "git status"',
    'cmd /c "call git status"',
    'cmd /c "git status & git -C . commit -m test"',
    'bash -lc "git status"',
    'bash -lc "git status; git -C . commit -m test"',
    'powershell -Command "git status"',
  ]) assert.equal(checkPolicy(payload(root, {
    tool_input: { cmd: command, workdir },
  })), null, command);
});

test('Git state-changing commands require literal runtime values', () => {
  const root = fixture();
  const work = nestedRepository(root, 'reprodocs');
  const workdir = path.relative(root, work);
  for (const command of [
    'git checkout $BRANCH',
    'git -C !REPOSITORY! commit -m test',
    'git update-ref refs/heads/feature/hooks $TARGET',
    'git commit -m %MESSAGE%',
    'git push origin %SOURCE%:refs/heads/feature/hooks',
    'git push origin HEAD:!DESTINATION!',
  ]) assert.notEqual(checkPolicy(payload(root, {
    tool_input: { cmd: command, workdir },
  })), null, command);
  for (const command of [
    'git status $PATH',
    'echo "git checkout $BRANCH"',
  ]) assert.equal(checkPolicy(payload(root, {
    tool_input: { cmd: command, workdir },
  })), null, command);
});

test('cmd caret escapes normalize executable names, policy options, refs, and wrappers', () => {
  const root = fixture();
  const work = nestedRepository(root, 'reprodocs');
  const workdir = path.relative(root, work);
  for (const command of [
    'git checkout ma^in; git commit -m test',
    'git update-ref refs/heads/ma^in HEAD',
    'git commit --no-ver^ify -m test',
    'git reset --ha^rd',
    'git show HEAD:.e^nv',
    'c^md /c "git commit --no-verify -m test"',
    'cmd /c "ca^ll git commit -m test"',
    'cmd /c "st^art /b git status"',
  ]) assert.notEqual(checkPolicy(payload(root, {
    tool_input: { cmd: command, workdir },
  })), null, command);
  for (const command of [
    'g^it commit -m test',
    'g^it push origin HEAD:main',
  ]) assert.notEqual(checkPolicy(commandPayload(root, command)), null, command);
  assert.equal(checkPolicy(payload(root, {
    tool_input: { cmd: 'g^it commit -m test', workdir },
  })), null);
});

test('PowerShell expressions and execution backticks cannot disguise Git policy values', () => {
  const root = fixture();
  const work = nestedRepository(root, 'reprodocs');
  const workdir = path.relative(root, work);
  const tick = String.fromCharCode(96);
  for (const command of [
    "pwsh -Command { git checkout ('m'+'ain'); git commit -m test }",
    'pwsh -Command { git -C (Get-Location) commit -m test }',
    "pwsh -Command { git update-ref refs/heads/feature/hooks ('HEAD') }",
    "pwsh -Command { git push origin ('HEAD:refs/heads/feature/hooks') }",
    "pwsh -Command 'git commit --no-ver" + tick + "ify -m test'",
    "pwsh -Command 'git update-ref refs/heads/ma" + tick + "in HEAD'",
    "pwsh -Command 'git show HEAD:.e" + tick + "nv'",
  ]) assert.notEqual(checkPolicy(payload(root, {
    tool_input: { cmd: command, workdir },
  })), null, command);
  assert.equal(checkPolicy(payload(root, {
    tool_input: { cmd: 'pwsh -Command { git status }', workdir },
  })), null);
});

test('direct expression values fail closed for Git mutations even under mixed parsing', () => {
  const root = fixture();
  const work = nestedRepository(root, 'reprodocs');
  const workdir = path.relative(root, work);
  fs.mkdirSync(path.join(work, '(.)'));
  for (const command of [
    "git checkout ('m'+'ain'); git commit -m test",
    "git update-ref refs/heads/feature/hooks ('HEAD')",
    "git push origin ('HEAD:refs/heads/feature/hooks')",
    'git -C "(.)" commit -m test',
  ]) assert.notEqual(checkPolicy(payload(root, {
    tool_input: { cmd: command, workdir },
  })), null, command);
});

test('cmd runtime-expanded wrapper sources fail closed without a literal Git keyword', () => {
  const root = fixture();
  const work = nestedRepository(root, 'reprodocs');
  const workdir = path.relative(root, work);
  for (const command of [
    'cmd /c "%GIT% %WRITE% -m test"',
    'cmd /c "!GIT! !WRITE! -m test"',
    'cmd /c "%GIT% %WRITE% origin HEAD:main"',
  ]) assert.notEqual(checkPolicy(payload(root, {
    tool_input: { cmd: command, workdir },
  })), null, command);
  assert.equal(checkPolicy(payload(root, {
    tool_input: { cmd: 'cmd /c "git status"', workdir },
  })), null);
});

test('cmd compact and grouped execution switches recurse into their command source', () => {
  const root = fixture();
  const work = nestedRepository(root, 'reprodocs');
  const workdir = path.relative(root, work);
  for (const command of [
    'cmd /cgit commit -m test',
    'cmd "/cgit commit -m test"',
    'cmd /c=git update-ref refs/heads/main HEAD',
    'cmd /kgit commit -m test',
    'cmd /s/c git commit -m test',
    'cmd /d/c git update-ref refs/heads/main HEAD',
    'cmd /q/c git commit -m test',
    'cmd /e:on/c git push origin HEAD:main',
  ]) assert.notEqual(checkPolicy(commandPayload(root, command)), null, command);
  assert.notEqual(checkPolicy(payload(root, {
    tool_input: { cmd: 'cmd /cgit -C .. commit -m test', workdir },
  })), null);
  for (const command of [
    'cmd /cgit status',
    'cmd /c=git status',
    'cmd /s/c git status',
    'cmd /d/c git status',
    'cmd /q/c git status',
    'cmd /e:on/c git status',
  ]) assert.equal(checkPolicy(commandPayload(root, command)), null, command);
});

test('POSIX shell backslash escapes normalize executed Git policy tokens', () => {
  const root = fixture();
  const work = nestedRepository(root, 'reprodocs');
  const workdir = path.relative(root, work);
  for (const command of [
    'sh -c "g\\it checkout ma\\in; git commit -m test"',
    'sh -c "git commit --no-ver\\ify -m test"',
    'sh -c "git reset --ha\\rd"',
    'sh -c "git show HEAD:.e\\nv"',
  ]) assert.notEqual(checkPolicy(payload(root, {
    tool_input: { cmd: command, workdir },
  })), null, command);
  assert.equal(checkPolicy(payload(root, {
    tool_input: { cmd: 'sh -c "g\\it commit -m test"', workdir },
  })), null);
});

test('POSIX pathname-glob executable tokens fail closed before they can resolve Git', () => {
  const root = fixture();
  const work = nestedRepository(root, 'reprodocs');
  const workdir = path.relative(root, work);
  for (const command of [
    'sh -c "g?t update-ref refs/heads/main HEAD"',
    'sh -c "[g]it update-ref refs/heads/main HEAD"',
  ]) assert.notEqual(checkPolicy(payload(root, {
    tool_input: { cmd: command, workdir },
  })), null, command);
  assert.equal(checkPolicy(payload(root, {
    tool_input: { cmd: 'sh -c "git commit -m test"', workdir },
  })), null);
  assert.equal(checkPolicy(commandPayload(root, 'sh -c "git status"')), null);
});

test('Invoke-Command accepts only a literal balanced ScriptBlock', () => {
  const root = fixture();
  for (const command of [
    'Invoke-Command -ScriptBlock $script',
    "Invoke-Command -ScriptBlock ('git commit -m test')",
    'Invoke-Command -ScriptBlock (Get-Command git)',
  ]) assert.notEqual(checkPolicy(commandPayload(root, command)), null, command);
  assert.equal(checkPolicy(commandPayload(root, 'Invoke-Command -ScriptBlock { git status }')), null);
});

test('constructed PowerShell ScriptBlocks fail closed inside literal outer blocks', () => {
  const root = fixture();
  for (const command of [
    "pwsh -Command { $script = [ScriptBlock]::Create('git commit -m test'); $script.Invoke() }",
    "pwsh -Command { $script = [System.Management.Automation.ScriptBlock]::Create('git update-ref refs/heads/main HEAD'); & $script }",
    'pwsh -Command { $script.Invoke() }',
  ]) assert.notEqual(checkPolicy(commandPayload(root, command)), null, command);
  assert.equal(checkPolicy(commandPayload(root, 'pwsh -Command { git status }')), null);
});

test('all Git mutation classes require literal values and honor mix and CWD boundaries', () => {
  const root = fixture();
  const work = nestedRepository(root, 'reprodocs');
  const workdir = path.relative(root, work);
  for (const command of [
    'git branch $BRANCH',
    'git tag $TAG',
    'git notes add $NOTE',
    'git symbolic-ref HEAD $REF',
    'git remote add origin $URL',
    'git worktree add $DIR',
    'git submodule update $NAME',
    'git am $PATCH',
    'git annotate $TAG',
    'git apply $PATCH',
    'git bisect start $BAD',
    'git checkout-index $PATH',
    'git clean $FLAGS',
    'git clone $URL',
    'git gc $FLAGS',
    'git hash-object -w $PATH',
    'git init $DIR',
    'git mv $FROM $TO',
    'git read-tree $TREE',
    'git reflog $ARGS',
    'git rm $PATH',
    'git sparse-checkout set $DIR',
  ]) assert.notEqual(checkPolicy(payload(root, {
    tool_input: { cmd: command, workdir },
  })), null, command);
  for (const command of [
    'Write-Output pre; git branch feature/next',
    'Write-Output pre; git annotate v1',
    'cd ..; git tag v1',
    'cmd /c "if 1==1 git branch feature/next"',
  ]) assert.notEqual(checkPolicy(payload(root, {
    tool_input: { cmd: command, workdir },
  })), null, command);
  assert.equal(checkPolicy(payload(root, {
    tool_input: { cmd: 'git status $PATH', workdir },
  })), null);
  assert.equal(checkPolicy(payload(root, {
    tool_input: { cmd: 'Write-Output pre; git hash-object --stdin', workdir },
  })), null);
});

test('alias and function definitions fail closed before a visible Git invocation', () => {
  const root = fixture();
  for (const command of [
    'Set-Alias g git',
    'New-Alias push git',
    'sal g git',
    'nal push git',
    'Set-Item Alias:update-ref git',
    'si Alias:update-ref git',
    'New-Item Function:g',
    'Copy-Item Alias:g Alias:h',
    'Move-Item Function:g Function:h',
    'Rename-Item Alias:g update-ref',
    'Set-Content Function:g "git commit -m test"',
    'Set-Item Function:g { git -C ../.. commit -m test }',
    'bash -lc "alias g=git"',
    'bash -lc "alias g=git; g -C ../.. commit -m test"',
    'sh -c "g() { :; }"',
    'cmd /c "doskey g=git $*"',
  ]) assert.notEqual(checkPolicy(commandPayload(root, command)), null, command);
  assert.equal(checkPolicy(commandPayload(root, 'bash -lc "alias"')), null);
});

test('dynamic PowerShell provider targets fail closed before they can define aliases', () => {
  const root = fixture();
  for (const command of [
    "Set-Item ('Alias:' + 'g') git",
    "Set-Item ('Function:' + 'g') { git commit -m test }",
  ]) assert.notEqual(checkPolicy(commandPayload(root, command)), null, command);
  assert.equal(checkPolicy(commandPayload(root, 'Set-Item env:CODEX_HOOK_TEST static')), null);
});

test('external process launches deny unknown and shell-wrapper targets while helpers remain allowed', () => {
  const root = fixture();
  for (const command of [
    "Start-Process -ArgumentList 'status'",
    'Start-Process -FilePath zsh',
    'Start-Process -FilePath dash',
    'Start-Process -FilePath ksh',
    'cmd /c "start /b"',
  ]) assert.notEqual(checkPolicy(commandPayload(root, command)), null, command);
  assert.equal(checkPolicy(commandPayload(root, 'Start-Process node helper.mjs -WindowStyle Hidden')), null);
});

test('standard POSIX dispatch prefixes expose literal Git mutations to policy checks', () => {
  const root = fixture();
  const work = nestedRepository(root, 'reprodocs');
  const workdir = path.relative(root, work);
  for (const command of [
    'sh -c "command git commit -m test"',
    'sh -c "env git commit -m test"',
  ]) assert.notEqual(checkPolicy(commandPayload(root, command)), null, command);
  for (const command of [
    'sh -c "exec git update-ref refs/heads/main HEAD"',
    'sh -c "time git reset --hard"',
    'sh -c "nohup git push origin HEAD:main"',
  ]) assert.notEqual(checkPolicy(payload(root, {
    tool_input: { cmd: command, workdir },
  })), null, command);
  for (const command of [
    'sh -c "command git commit -m test"',
    'sh -c "env git commit -m test"',
    'sh -c "exec git update-ref refs/heads/feature/hooks HEAD"',
    'sh -c "time git status"',
    'sh -c "nohup git push origin HEAD:refs/heads/feature/hooks"',
  ]) assert.equal(checkPolicy(payload(root, {
    tool_input: { cmd: command, workdir },
  })), null, command);
});

test('unknown POSIX utility prefixes cannot hide literal Git mutations', () => {
  const root = fixture();
  for (const command of [
    'sh -c "nice git commit -m test"',
    'sh -c "timeout 1 git update-ref refs/heads/main HEAD"',
    'sh -c "stdbuf -oL git reset --hard"',
    'nice git commit -m test',
    'timeout 1 git update-ref refs/heads/main HEAD',
    'stdbuf -oL git reset --hard',
  ]) assert.notEqual(checkPolicy(commandPayload(root, command)), null, command);
  for (const command of [
    'sh -c "nice git status"',
    'nice git status',
    'echo git commit',
  ]) assert.equal(checkPolicy(commandPayload(root, command)), null, command);
});

test('unknown prefixes cannot nest a known shell dispatcher', () => {
  const root = fixture();
  for (const command of [
    'nice sh -c "git commit -m test"',
    'nice env -S "git commit -m test"',
    'nice (Get-Command sh) -c "git commit -m test"',
  ]) assert.notEqual(checkPolicy(commandPayload(root, command)), null, command);
  assert.equal(checkPolicy(commandPayload(root, 'nice node helper.mjs')), null);
});

test('brace-expanded Git mutation values fail closed before they can fan out', () => {
  const root = fixture();
  const work = nestedRepository(root, 'reprodocs');
  const workdir = path.relative(root, work);
  for (const command of [
    'sh -c "git push origin HEAD:refs/heads/{feature/hooks,main}"',
    'git push origin HEAD:refs/heads/{feature/hooks,main}',
  ]) assert.notEqual(checkPolicy(payload(root, {
    tool_input: { cmd: command, workdir },
  })), null, command);
  assert.equal(checkPolicy(payload(root, {
    tool_input: { cmd: 'sh -c "git push origin HEAD:refs/heads/feature/hooks"', workdir },
  })), null);
});

test('env split-string forms fail closed without changing literal env dispatch', () => {
  const root = fixture();
  const work = nestedRepository(root, 'reprodocs');
  const workdir = path.relative(root, work);
  for (const command of [
    'env -S "git commit -m test"',
    'env -S"git update-ref refs/heads/main HEAD"',
    'env --split-string "git reset --hard"',
    'env --split-string="git push origin HEAD:main"',
  ]) assert.notEqual(checkPolicy(commandPayload(root, command)), null, command);
  assert.equal(checkPolicy(commandPayload(root, 'env git status')), null);
  assert.equal(checkPolicy(payload(root, {
    tool_input: { cmd: 'env git commit -m test', workdir },
  })), null);
});

test('external process dispatch denies Git, shells, scripts, and dynamic targets without blocking helpers', () => {
  const root = fixture();
  const work = nestedRepository(root, 'reprodocs');
  const workdir = path.relative(root, work);
  for (const command of [
    "Start-Process -FilePath git -ArgumentList 'commit -m test' -WorkingDirectory .",
    "Start-Process git -WorkingDirectory . -ArgumentList 'commit -m test'",
    "start git -ArgumentList 'commit -m test' -WorkingDirectory .",
    "saps -WorkingDirectory . -FilePath git -ArgumentList 'commit -m test'",
    "Start-Process -WindowStyle Hidden -FilePath git.exe -ArgumentList 'status'",
    "Start-Process -FilePath git.cmd -ArgumentList 'status'",
    "Start-Process -FilePath git.bat -ArgumentList 'status'",
    "Start-Process -FilePath cmd.exe -ArgumentList '/c git status'",
    "Start-Process -FilePath powershell.exe -ArgumentList '-Command git status'",
    "Start-Process -FilePath pwsh -ArgumentList '-Command git status'",
    "Start-Process -FilePath bash -ArgumentList '-lc git status'",
    "Start-Process -FilePath sh -ArgumentList '-c git status'",
    'Start-Process -FilePath tools/runner.cmd',
    'Start-Process -FilePath tools/runner.bat',
    'Start-Process -FilePath tools/runner.ps1',
    'Start-Process -FilePath tools/runner.sh',
    "Start-Process -FilePath '(Get-Command git)'",
    'Start-Process -FilePath %GIT%',
    'Start-Process -FilePath !GIT!',
    'cmd /c "start "" /b git.exe status"',
    'cmd /c "start /b git.cmd status"',
    'cmd /c "start /b powershell.exe -Command git status"',
  ]) assert.notEqual(checkPolicy(payload(root, {
    tool_input: { cmd: command, workdir },
  })), null, command);
  for (const command of [
    'Start-Process node helper.mjs -WindowStyle Hidden',
    'cmd /c "start /b node helper.mjs"',
  ]) assert.equal(checkPolicy(payload(root, {
    tool_input: { cmd: command, workdir },
  })), null, command);
});

test('destructive aliases and protected refspecs block with safe counterparts', () => {
  const root = fixture();
  execFileSync('git', ['-C', root, 'checkout', '-q', '-b', 'feature/hooks']);
  const pairs = [
    ['git clean --force', 'git clean -n'],
    ['git reset --hard=HEAD', 'git reset --soft HEAD'],
    ['git checkout -B codex/replaced', 'git checkout feature/hooks'],
    ['git branch -f codex/replaced', 'git branch --list'],
    ['git branch -D codex/replaced', 'git branch --list'],
    ['git worktree remove scratch', 'git worktree list'],
    ['git stash clear', 'git stash list'],
    ['git reflog delete HEAD@{0}', 'git reflog show'],
    ['rd build', 'Remove-Item -WhatIf build'],
    ['erase stale.txt', 'rm --version'],
    ['Remove-Item -r build', 'Remove-Item -WhatIf build'],
    ['rm --recursive build', 'rm --version'],
    ['git update-ref refs/heads/main HEAD', 'git update-ref refs/heads/feature/hooks HEAD'],
    ['git push origin HEAD:main', 'git push origin HEAD:feature/hooks'],
    ['git push origin feature:refs/heads/master', 'git push origin HEAD:feature/hooks'],
    ['git push origin :trunk', 'git push origin HEAD:feature/hooks'],
  ];
  for (const [deny, allow] of pairs) {
    assert.notEqual(checkPolicy(commandPayload(root, deny)), null, deny);
    assert.equal(checkPolicy(commandPayload(root, allow)), null, allow);
  }
});

test('git push requires exactly one explicit non-wildcard source-to-destination refspec', () => {
  const root = fixture();
  execFileSync('git', ['-C', root, 'checkout', '-q', '-b', 'feature/hooks']);
  for (const command of [
    'git push',
    'git push origin',
    'git push -u origin',
    'git push -u origin feature/hooks',
    'git push origin feature/hooks',
    'git push origin :',
    'git push origin +:',
    'git push origin HEAD:',
    'git push origin feature/*:feature/*',
    'git push --delete origin feature/hooks',
    'git push --all origin',
    'git push --mirror origin',
    'git push --receive-pack receive-pack origin feature/hooks:feature/hooks',
    'git push origin %SOURCE%:refs/heads/feature/hooks',
    'git push origin HEAD:!DESTINATION!',
    'git push origin HEAD:HEAD',
    'git push origin feature/hooks:feature/hooks feature/other:feature/other',
    'git push origin HEAD:refs/heads/feature/hooks HEAD:refs/heads/feature/other',
  ]) {
    assert.notEqual(checkPolicy(commandPayload(root, command)), null, command);
  }
  for (const command of [
    'git push -u origin feature/hooks:feature/hooks',
    'git push origin HEAD:refs/heads/feature/hooks',
  ]) {
    assert.equal(checkPolicy(commandPayload(root, command)), null, command);
  }
  for (const command of ['git push origin HEAD:main', 'git push origin feature/hooks:refs/heads/master']) {
    assert.notEqual(checkPolicy(commandPayload(root, command)), null, command);
  }
});

test('secret path terminators block reads without matching mon.keynote', () => {
  const root = fixture();
  assert.equal(hasSecretPath('docs/mon.keynote'), false);
  assert.equal(hasSecretPath('.env?'), true);
  assert.equal(hasSecretPath('keys/private.key,'), true);
  for (const command of [
    'Get-Content .env?',
    'Get-Content keys/private.key,',
    'cat certs/service.pem;',
  ]) assert.notEqual(checkPolicy(commandPayload(root, command)), null, command);
  for (const command of [
    'Get-Content docs/mon.keynote',
    'node -e "console' + '.log(\'Get-Content .env\')"',
    'echo "cat .env"',
  ]) assert.equal(checkPolicy(commandPayload(root, command)), null, command);
});

test('direct-main protection resolves an explicit git -C target', () => {
  const root = fixture();
  const nested = path.join(root, 'scratch');
  fs.mkdirSync(nested);
  assert.notEqual(checkPolicy(payload(nested, { tool_input: { cmd: `git -C "${root}" commit -m test` } })), null);
});

test('cwd-changing Git writes fail closed', () => {
  const root = fixture();
  assert.notEqual(checkPolicy(commandPayload(root, 'Set-Location scratch; git commit -m test')), null);
});

test('Git policy rejects config, ref, secret, no-verify, and external -C bypasses', () => {
  const root = fixture();
  const external = fixture();
  execFileSync('git', ['-C', root, 'checkout', '-q', '-b', 'feature/hooks']);
  execFileSync('git', ['-C', external, 'checkout', '-q', '-b', 'feature/external']);

  const denied = [
    'git -c alias.status=status status',
    'git -calias.status=status status',
    'git -c core.hooksPath=.hooks status',
    'git -ccore.hooksPath=.hooks status',
    'git --config-env=core.hooksPath=HOOK_PATH status',
    'git symbolic-ref HEAD refs/heads/main; git commit -m test',
    'git symbolic-ref -m move HEAD refs/heads/main; git status',
    'git show HEAD:.env',
    'git diff HEAD -- .env',
    'git grep token -- .env',
    'git cat-file -p HEAD:.env',
    'git commit -n -m test',
    'git commit -nm test',
    `git -C "${external}" commit -m test`,
  ];
  for (const command of denied) assert.notEqual(checkPolicy(commandPayload(root, command)), null, command);

  const allowed = [
    `git -C${root} commit -m test`,
    'git show HEAD:.env.example',
    'git diff HEAD -- .env.example',
    'git grep token -- .env.example',
    'git cat-file -p HEAD:.env.example',
    'git symbolic-ref --short HEAD',
    'git commit -m test',
  ];
  for (const command of allowed) assert.equal(checkPolicy(commandPayload(root, command)), null, command);
});

test('dynamic shell and PowerShell execution forms fail closed while static safe forms allow', () => {
  const root = fixture();
  const denied = [
    'bash -lc "git reset --hard"',
    'sh -lc "git reset --hard"',
    'powershell -e Z2l0IHJlc2V0IC0taGFyZA==',
    'powershell -ec Z2l0IHJlc2V0IC0taGFyZA==',
    'pwsh -encodedcommand:Z2l0IHJlc2V0IC0taGFyZA==',
    'if ($true) { git reset --hard }',
    'powershell -Command "if ($true) { git reset --hard }"',
    'Invoke-Expression "git reset --hard"',
    'sh -c "$(echo git reset --hard)"',
    'ri -Recurse build',
    'ri -r build',
  ];
  for (const command of denied) assert.notEqual(checkPolicy(commandPayload(root, command)), null, command);

  const allowed = [
    'bash -lc "git status"',
    'powershell -Command "if ($true) { git status }"',
    'Invoke-Expression "git status"',
    'sh -c "git status"',
    'ri -WhatIf build',
  ];
  for (const command of allowed) assert.equal(checkPolicy(commandPayload(root, command)), null, command);
});

test('indirect secret-path data flows fail closed without classifying inert prose', () => {
  const root = fixture();
  const denied = [
    'Get-ChildItem .env | Get-Content',
    'Get-ChildItem .env | ForEach-Object { Get-Content $_.FullName }',
    '$f = .env; Get-Content $f',
  ];
  for (const command of denied) assert.notEqual(checkPolicy(commandPayload(root, command)), null, command);

  const allowed = [
    'Get-ChildItem .env.example | Get-Content',
    'Get-ChildItem README.md | Get-Content',
    '$f = README.md; Get-Content $f',
    'node -e "console' + '.log(\'Get-Content .env\')"',
    'echo "Get-ChildItem .env | Get-Content"',
  ];
  for (const command of allowed) assert.equal(checkPolicy(commandPayload(root, command)), null, command);
});

test('pre-tool deny uses the native denial envelope without continue', () => {
  const output = JSON.parse(denial('blocked'));
  assert.equal(output.decision, 'block');
  assert.equal(output.hookSpecificOutput.permissionDecision, 'deny');
  assert.equal(Object.hasOwn(output, 'continue'), false);
});

test('session hook returns the official context envelope', () => {
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
test('dynamic interpreters and opaque scripts fail closed while inert inline code remains allowed', () => {
  const root = fixture();
  const denied = [
    '$c = "git reset --hard"; & $c',
    'powershell -File destructive.ps1',
    'pwsh -f destructive.ps1',
    'bash destructive.sh',
    'eval "git reset --hard"',
    '. ./destructive.sh',
    'source ./destructive.sh',
    'echo `git reset --hard`',
    'cat <(git reset --hard)',
    'node -e "require(\'node:child_process\').execFileSync(\'git\',[\'reset\',\'--hard\'])"',
    'python -c "import os; os.system(\'git reset --hard\')"',
  ];
  for (const command of denied) assert.notEqual(checkPolicy(commandPayload(root, command)), null, command);

  const allowed = [
    'bash -c "git status"',
    'node -e "console' + '.log(\'git reset --hard\')"',
    'python -c "print(\'git reset --hard\')"',
  ];
  for (const command of allowed) assert.equal(checkPolicy(commandPayload(root, command)), null, command);
});

test('Git config, external dispatch, destructive plumbing, and compact force fail closed', () => {
  const root = fixture();
  execFileSync('git', ['-C', root, 'checkout', '-q', '-b', 'feature/policy']);
  const denied = [
    'git config --local alias.wipe "!git reset --hard"',
    'git config --local core.hooksPath .hooks',
    'git -c color.ui=false status',
    'git --config-env=color.ui=COLOR status',
    'git --exec-path=./tools arbitrary-external-subcommand',
    'git arbitrary-external-subcommand',
    'git symbolic-ref --delete HEAD',
    'git symbolic-ref -d HEAD',
    'git update-ref -d refs/heads/feature/old',
    'git update-ref --stdin',
    'git rm tracked.txt',
    'git rm -r src',
    'git checkout-index -f --all',
    'git read-tree --reset -u HEAD',
    'git push -fu origin HEAD:feature/policy',
  ];
  for (const command of denied) assert.notEqual(checkPolicy(commandPayload(root, command)), null, command);

  const allowed = [
    'git config --get user.name',
    'git config user.name',
    'git symbolic-ref --short HEAD',
    'git status',
    'git ls-files',
  ];
  for (const command of allowed) assert.equal(checkPolicy(commandPayload(root, command)), null, command);
});

test('secret globs, tainted shell variables, and direct deletion fail closed', () => {
  const root = fixture();
  const denied = [
    'Get-Content *',
    'Get-Content .env*',
    'cat .env*',
    'git show HEAD:.env*',
    'git grep needle -- .env*',
    'Get-ChildItem -Filter *.env | Get-Content',
    'f=.env; cat $f',
    'f=.env.production; Get-Content $f',
    'for f in .env; do cat $f; done',
    'env f=.env cat $f',
    'rm important.txt',
    'Remove-Item important.txt',
    'unlink important.txt',
    'Get-ChildItem build | Remove-Item',
  ];
  for (const command of denied) assert.notEqual(checkPolicy(commandPayload(root, command)), null, command);

  assert.equal(checkPolicy(payload(root, {
    tool_name: 'Edit',
    tool_input: { file_path: '.env.example', content: 'MODE=example' },
  })), null);
});

test('conflicting command fields fail closed', () => {
  const root = fixture();
  assert.notEqual(checkPolicy(payload(root, {
    tool_input: { command: 'git status', cmd: 'git reset --hard' },
  })), null);
});

test('literal PowerShell here-string data may contain Markdown backticks', () => {
  const root = fixture();
  const literalPatch = [
    "$patch = @'",
    '*** Begin Patch',
    '*** Update File: README.md',
    '+Read `tasks/codemap.md` before editing.',
    '*** End Patch',
    "'@",
    '$patch | apply_patch',
  ].join('\n');
  assert.equal(checkPolicy(commandPayload(root, literalPatch)), null);
  assert.notEqual(checkPolicy(commandPayload(root, literalPatch + '\ngit reset --hard')), null);
});
