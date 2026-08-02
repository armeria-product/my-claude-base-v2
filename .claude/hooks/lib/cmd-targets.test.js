// node --test .claude/hooks/lib/cmd-targets.test.js
const { test } = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const { extractTargets, extractStateCandidates } = require('./cmd-targets');

const ROOT = 'D:\\proj';
const abs = (...parts) => path.resolve(ROOT, ...parts);

test('redirect forms: >, >>, 2>, attached', () => {
  assert.deepEqual(extractTargets('Bash', 'echo hi > a.txt', ROOT).targets, [abs('a.txt')]);
  assert.deepEqual(extractTargets('Bash', 'echo hi >> a.txt', ROOT).targets, [abs('a.txt')]);
  assert.deepEqual(extractTargets('Bash', 'sort file 2> err.log', ROOT).targets, [abs('err.log')]);
  assert.deepEqual(extractTargets('Bash', 'echo hi >a.txt', ROOT).targets, [abs('a.txt')]);
});

test('/dev/null, NUL, &1 redirect targets are excluded', () => {
  assert.deepEqual(extractTargets('Bash', 'cmd 2>/dev/null', ROOT).targets, []);
  assert.deepEqual(extractTargets('Bash', 'cmd > NUL', ROOT).targets, []);
  assert.deepEqual(extractTargets('Bash', 'cmd 2>&1', ROOT).targets, []);
});

test('tee', () => {
  assert.deepEqual(extractTargets('Bash', 'echo hi | tee out.txt', ROOT).targets, [abs('out.txt')]);
});

test('sed -i', () => {
  assert.deepEqual(extractTargets('Bash', "sed -i 's/a/b/' file.txt", ROOT).targets, [abs('file.txt')]);
});

test('mv / cp -t', () => {
  assert.deepEqual(extractTargets('Bash', 'mv a.txt b.txt', ROOT).targets, [abs('b.txt')]);
  assert.deepEqual(extractTargets('Bash', 'cp -t dest a.txt b.txt', ROOT).targets, [abs('dest')]);
});

test('rm', () => {
  assert.deepEqual(extractTargets('Bash', 'rm a.txt b.txt', ROOT).targets, [abs('a.txt'), abs('b.txt')]);
});

test('dd of=', () => {
  assert.deepEqual(extractTargets('Bash', 'dd if=/dev/zero of=out.bin', ROOT).targets, [abs('out.bin')]);
});

test('git checkout -- / git restore / bare checkout is not a write', () => {
  assert.deepEqual(extractTargets('Bash', 'git checkout -- a.txt b.txt', ROOT).targets, [abs('a.txt'), abs('b.txt')]);
  assert.deepEqual(extractTargets('Bash', 'git restore a.txt', ROOT).targets, [abs('a.txt')]);
  assert.deepEqual(extractTargets('Bash', 'git checkout main', ROOT).targets, []);
});

test('node -e path literal extraction', () => {
  const r = extractTargets('Bash', `node -e "require('fs').writeFileSync('out.txt','x')"`, ROOT);
  assert.deepEqual(r.targets, [abs('out.txt')]);
  assert.equal(r.unresolved, false);
});

test('node -e unresolved when no path literal is present', () => {
  const r = extractTargets('Bash', `node -e "require('fs').writeFileSync(process.env.OUT,'x')"`, ROOT);
  assert.deepEqual(r.targets, []);
  assert.equal(r.unresolved, true);
});

test('PowerShell named argument', () => {
  const r = extractTargets('PowerShell', 'Set-Content -Path out.txt -Value "hi"', ROOT);
  assert.deepEqual(r.targets, [abs('out.txt')]);
});

test('PowerShell positional argument', () => {
  const r = extractTargets('PowerShell', 'Out-File out.txt', ROOT);
  assert.deepEqual(r.targets, [abs('out.txt')]);
});

test('PowerShell $var target is unresolved', () => {
  const r = extractTargets('PowerShell', 'Set-Content -Path $dest -Value "hi"', ROOT);
  assert.deepEqual(r.targets, []);
  assert.equal(r.unresolved, true);
});

test('cd tracking resolves a later segment target against the new cwd', () => {
  const r = extractTargets('Bash', 'cd .claude && echo x > state/f', ROOT);
  assert.deepEqual(r.targets, [abs('.claude', 'state', 'f')]);
});

test('bare cd (-> home) and cd - leave cwd unchanged', () => {
  assert.deepEqual(extractTargets('Bash', 'cd && echo x > a.txt', ROOT).targets, [abs('a.txt')]);
  assert.deepEqual(extractTargets('Bash', 'cd - && echo x > a.txt', ROOT).targets, [abs('a.txt')]);
});

test('extractStateCandidates: subshell-entry (cd .claude tracks liberally into state/', () => {
  const r = extractStateCandidates('Bash', '(cd .claude && echo x > state/f)', ROOT);
  assert.ok(
    r.some((t) => t.toLowerCase().startsWith(abs('.claude', 'state').toLowerCase())),
    `expected a target under .claude/state, got ${JSON.stringify(r)}`
  );
});

test('extractStateCandidates: pushd .claude tracks liberally into state/', () => {
  const r = extractStateCandidates('Bash', 'pushd .claude && echo x > state/f', ROOT);
  assert.deepEqual(r, [abs('.claude', 'state', 'f')]);
});

test('extractStateCandidates: PowerShell Set-Location .claude; Set-Content state\\f', () => {
  const r = extractStateCandidates('PowerShell', 'Set-Location .claude; Set-Content state\\f x', ROOT);
  assert.ok(
    r.some((t) => t.toLowerCase().startsWith(abs('.claude', 'state').toLowerCase())),
    `expected a target under .claude/state, got ${JSON.stringify(r)}`
  );
});

test('extractStateCandidates: negative control — subshell cd into a non-.claude dir stays outside .claude/state', () => {
  const r = extractStateCandidates('Bash', '(cd sub && echo x > f)', ROOT);
  assert.ok(
    r.every((t) => !t.toLowerCase().startsWith(abs('.claude', 'state').toLowerCase())),
    `expected no target under .claude/state, got ${JSON.stringify(r)}`
  );
});

test('extractStateCandidates: subshell-entry with a space, "( cd .claude", tracks liberally into state/', () => {
  const r = extractStateCandidates('Bash', '( cd .claude && echo x > state/f )', ROOT);
  assert.deepEqual(r, [abs('.claude', 'state', 'f')]);
});

test('extractStateCandidates: subshell-entry with a space, "( pushd .claude", tracks liberally into state/', () => {
  const r = extractStateCandidates('Bash', '( pushd .claude && echo x > state/f )', ROOT);
  assert.deepEqual(r, [abs('.claude', 'state', 'f')]);
});

test('extractStateCandidates: negative control — "( cd sub" (space form, no .claude) stays outside .claude/state', () => {
  const r = extractStateCandidates('Bash', '( cd sub && echo x > f )', ROOT);
  assert.ok(
    r.every((t) => !t.toLowerCase().startsWith(abs('.claude', 'state').toLowerCase())),
    `expected no target under .claude/state, got ${JSON.stringify(r)}`
  );
});

test('extractStateCandidates: plain cd .claude (already caught by extractTargets) is also present', () => {
  const r = extractStateCandidates('Bash', 'cd .claude && echo x > state/f', ROOT);
  assert.deepEqual(r, [abs('.claude', 'state', 'f')]);
});
