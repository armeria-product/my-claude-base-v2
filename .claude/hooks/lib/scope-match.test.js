// node --test .claude/hooks/lib/
const { test } = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const { matches, normalizeRel } = require('./scope-match');

test('exact match, case-insensitive (Windows)', () => {
  assert.ok(matches('CLAUDE.md', ['claude.md']));
  assert.ok(!matches('CLAUDE.md', ['readme.md']));
});

test('* stays within one segment', () => {
  assert.ok(matches('src/auth/token.ts', ['src/auth/*.ts']));
  assert.ok(!matches('src/auth/deep/token.ts', ['src/auth/*.ts']));
  assert.ok(matches('notes.md', ['*.md']));
  assert.ok(!matches('docs/notes.md', ['*.md']));
});

test('** crosses segments', () => {
  assert.ok(matches('src/auth/deep/token.ts', ['src/auth/**']));
  assert.ok(matches('src/auth/deep/token.ts', ['src/**/*.ts']));
  assert.ok(!matches('lib/auth/token.ts', ['src/**']));
});

test('**/ matches zero directories too', () => {
  assert.ok(matches('a.txt', ['**/a.txt']));
  assert.ok(matches('x/y/a.txt', ['**/a.txt']));
});

test('trailing slash means directory prefix', () => {
  assert.ok(matches('journal/2026-08/02.md', ['journal/']));
  assert.ok(!matches('journal.md', ['journal/']));
});

test('backslash input is normalized', () => {
  assert.ok(matches('src\\auth\\token.ts', ['src/auth/**']));
  assert.ok(matches('src/auth/token.ts', ['src\\auth\\**']));
});

test('literal dots are not regex wildcards', () => {
  assert.ok(!matches('claudeXmd', ['claude.md']));
  assert.ok(matches('a.b.c', ['a.b.c']));
});

test('dev/*/tasks/** shape (single-star directory)', () => {
  assert.ok(matches('dev/app/tasks/todo.md', ['dev/*/tasks/**']));
  assert.ok(!matches('dev/app/src/x.ts', ['dev/*/tasks/**']));
});

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
