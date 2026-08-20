const { test } = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const { normalizeRel } = require('./path-util');

test('normalizeRel distinguishes in-root and outside paths', () => {
  const root = path.resolve(path.sep, 'proj');
  const inRoot = path.join(root, 'src', 'a.ts');
  const outsideSibling = path.join(path.dirname(root), 'other', 'a.ts');

  assert.equal(normalizeRel(root, inRoot).rel, 'src/a.ts');
  assert.equal(normalizeRel(root, inRoot).outside, false);
  assert.equal(normalizeRel(root, outsideSibling).outside, true);
  assert.equal(normalizeRel(root, 'src/a.ts').rel, 'src/a.ts');
});

test('normalizeRel treats cross-drive paths as outside on Windows', {
  skip: process.platform !== 'win32' && 'cross-drive paths only exist on win32',
}, () => {
  assert.equal(normalizeRel('D:\\proj', 'C:\\proj\\a.ts').outside, true);
});
