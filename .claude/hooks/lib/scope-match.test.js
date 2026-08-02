// node --test .claude/hooks/lib/
const { test } = require('node:test');
const assert = require('node:assert');
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
  const root = 'D:\\proj';
  assert.equal(normalizeRel(root, 'D:\\proj\\src\\a.ts').rel, 'src/a.ts');
  assert.ok(!normalizeRel(root, 'D:\\proj\\src\\a.ts').outside);
  assert.ok(normalizeRel(root, 'D:\\other\\a.ts').outside);
  assert.ok(normalizeRel(root, 'C:\\proj\\a.ts').outside);
  assert.equal(normalizeRel(root, 'src/a.ts').rel, 'src/a.ts');
});
