import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

const skill = fs.readFileSync(path.join(import.meta.dirname, 'SKILL.md'), 'utf8');
const legacyCommands = ['.', 'claude', '/commands'].join('');

test('save-session has a discoverable standalone Codex frontmatter contract', () => {
  assert.match(skill, /^---\nname: save-session\n/m);
  assert.match(skill, /\$save-session/);
  assert.match(skill, /\$save-session 補完/);
  assert.equal(skill.includes(legacyCommands), false);
});

test('save-session preserves the fixed record contracts', () => {
  for (const required of [
    'tasks/journal/YYYY-MM/DD.md',
    'append-only',
    'exactly two lines',
    '未検証',
    '**やったこと**',
    '**できなかったこと・保留**',
    '**確認してほしいこと**',
    '**次にやること**',
    '[xxxxxxxx] SAVE',
    'Never create a plausible-looking ID',
  ]) assert.ok(skill.includes(required), required);
});

test('save-session retains root and product routing plus scope-review behavior', () => {
  assert.match(skill, /dev\/\{name\}\/tasks/);
  assert.match(skill, /workspace-root/);
  assert.match(skill, /allow\/forbid/);
  assert.match(skill, /Do not broaden scope/);
});
