import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

const skill = fs.readFileSync(path.join(import.meta.dirname, 'SKILL.md'), 'utf8');
const legacyCommands = ['.', 'claude', '/commands'].join('');

test('resume-session is a standalone Codex skill rather than a slash-command bridge', () => {
  assert.match(skill, /^---\nname: resume-session\n/m);
  assert.match(skill, /\$resume-session/);
  assert.match(skill, /Do not present this as a slash command/);
  assert.equal(skill.includes(legacyCommands), false);
});

test('resume-session requires record-to-reality reconciliation before work', () => {
  for (const required of [
    'git branch --show-current',
    'git status --porcelain',
    'git log -1 --oneline',
    'allow/forbid',
    '**現在地**',
    '**前回の到達点**',
    '**記録と現実**',
    '**推奨する次の一手**',
    'do not edit files',
  ]) assert.ok(skill.includes(required), required);
});

test('resume-session preserves real marker and trusted-hook limitations', () => {
  assert.match(skill, /SESSION START/);
  assert.match(skill, /SESSION END/);
  assert.match(skill, /\$save-session 補完/);
  assert.match(skill, /Never manufacture/);
  assert.match(skill, /external terminals\/editors/);
});
