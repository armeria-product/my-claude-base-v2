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

test('cwd-changing Git writes fail closed unless the target uses git -C', () => {
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
