import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';

const HUB_DECK_ASSET = '.agents/skills/doc/assets/doc.pptx.template.html';

test('doc deck command names a hub-reachable bundled template asset', () => {
  assert.equal(existsSync(path.resolve(process.cwd(), HUB_DECK_ASSET)), true);
  const skill = readFileSync(path.resolve(process.cwd(), '.agents/skills/doc/SKILL.md'), 'utf8');
  assert.match(skill, new RegExp('--extract ' + HUB_DECK_ASSET.replace(/[.]/g, '\\.')));
});
