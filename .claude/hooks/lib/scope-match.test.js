// node --test .claude/hooks/lib/
const { test } = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const { normalizeRel } = require('./scope-match');

test('normalizeRel detects outside-root paths', () => {
  // Platform-agnostic root: path.resolve(path.sep, 'proj') resolves to an absolute
  // path under the current drive/root on win32 (e.g. "D:\proj") and to "/proj" on
  // posix, so the in-root/outside-root assertions below exercise real path.resolve +
  // path.relative behavior on whichever platform the suite runs on.
  const root = path.resolve(path.sep, 'proj');
  const inRoot = path.join(root, 'src', 'a.ts');
  const outsideSibling = path.join(path.dirname(root), 'other', 'a.ts');

  assert.equal(normalizeRel(root, inRoot).rel, 'src/a.ts');
  assert.ok(!normalizeRel(root, inRoot).outside);
  assert.ok(normalizeRel(root, outsideSibling).outside);
  assert.equal(normalizeRel(root, 'src/a.ts').rel, 'src/a.ts');
});

test('normalizeRel detects cross-drive paths as outside-root (Windows-only)', {
  skip: process.platform !== 'win32' && 'cross-drive paths only exist on win32',
}, () => {
  assert.ok(normalizeRel('D:\\proj', 'C:\\proj\\a.ts').outside);
});
