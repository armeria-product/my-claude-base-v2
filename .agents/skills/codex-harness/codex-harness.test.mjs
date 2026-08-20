import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

const skill = fs.readFileSync(path.join(import.meta.dirname, 'SKILL.md'), 'utf8').replace(/\r\n/g, '\n');
const legacySurface = ['.', 'claude'].join('');

test('codex-harness is discoverable and routes to every native workflow', () => {
  assert.match(skill, /^---\nname: codex-harness\n/m);
  assert.match(skill, /\$codex-harness/);
  for (const workflow of ['plan', 'harness', 'quality-loop', 'check', 'commit', 'pr']) {
    assert.ok(skill.includes(`.codex/workflows/${workflow}.md`), workflow);
  }
});

test('codex-harness sends session work to standalone Codex skills', () => {
  assert.match(skill, /\$save-session/);
  assert.match(skill, /\$resume-session/);
  assert.match(skill, /standalone skills directly/);
});

test('codex-harness remains independent of the legacy provider surface', () => {
  assert.equal(skill.includes(legacySurface), false);
  assert.match(skill, /not a write lock/);
  assert.match(skill, /complete security boundary/);
  assert.match(skill, /writer, reviewer, and verifier independent/);
});
