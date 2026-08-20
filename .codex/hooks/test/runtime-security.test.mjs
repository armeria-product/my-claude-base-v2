import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { extractFilePaths, isSafeWorkspacePath } from '../lib/runtime.mjs';

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-runtime-security-'));
  fs.mkdirSync(path.join(root, 'src'), { recursive: true });
  return root;
}

function payload(root, tool_name, tool_input) {
  return { cwd: root, tool_name, tool_input };
}

test('apply_patch path extraction fails closed when patch and input conflict', () => {
  const root = fixture();
  const alpha = '*** Begin Patch\n*** Update File: src/alpha.mjs\n*** End Patch';
  const beta = '*** Begin Patch\n*** Update File: src/beta.mjs\n*** End Patch';

  assert.deepEqual(extractFilePaths(payload(root, 'apply_patch', { patch: alpha, input: alpha })), [
    path.join(root, 'src', 'alpha.mjs'),
  ]);
  assert.deepEqual(extractFilePaths(payload(root, 'apply_patch', { patch: alpha, input: beta })), []);
  assert.deepEqual(extractFilePaths(payload(root, 'apply_patch', { input: { input: alpha } })), [
    path.join(root, 'src', 'alpha.mjs'),
  ]);
  assert.deepEqual(extractFilePaths(payload(root, 'apply_patch', { input: { patch: alpha } })), [
    path.join(root, 'src', 'alpha.mjs'),
  ]);
  assert.deepEqual(extractFilePaths(payload(root, 'apply_patch', {
    input: { patch: alpha, input: beta },
  })), []);
  assert.deepEqual(extractFilePaths(payload(root, 'apply_patch', { input: { content: alpha } })), []);
});

test('Move extracts every declared write destination but not its source', () => {
  const root = fixture();
  const destinations = [
    'out/to.mjs',
    'out/destination.mjs',
    'out/destination-path.mjs',
    'out/destination-path-camel.mjs',
    'out/target.mjs',
    'out/target-path.mjs',
    'out/target-path-camel.mjs',
    'out/new-path.mjs',
    'out/new-path-camel.mjs',
    'out/output-path.mjs',
    'out/output-path-camel.mjs',
    'out/write-path.mjs',
    'out/write-path-camel.mjs',
    'out/to-many-a.mjs',
    'out/to-many-b.mjs',
    'out/destinations-a.mjs',
    'out/destinations-b.mjs',
  ];
  const files = extractFilePaths(payload(root, 'Move', {
    from: 'src/source.mjs',
    to: destinations[0],
    destination: destinations[1],
    destination_path: destinations[2],
    destinationPath: destinations[3],
    target: destinations[4],
    target_path: destinations[5],
    targetPath: destinations[6],
    new_path: destinations[7],
    newPath: destinations[8],
    output_path: destinations[9],
    outputPath: destinations[10],
    write_path: destinations[11],
    writePath: destinations[12],
    to_paths: destinations.slice(13, 15),
    destinations: destinations.slice(15),
  }));

  assert.deepEqual(files, destinations.map((file) => path.join(root, file)));
  assert.equal(files.includes(path.join(root, 'src', 'source.mjs')), false);
});

test('workspace path safety permits a missing in-root leaf and rejects outside or symlinked paths', (t) => {
  const root = fixture();
  assert.equal(isSafeWorkspacePath(root, path.join(root, 'src', 'new-file.mjs')), true);
  assert.equal(isSafeWorkspacePath(root, path.join(root, '..', 'outside.mjs')), false);

  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-runtime-outside-'));
  const link = path.join(root, 'linked');
  try {
    fs.symlinkSync(outside, link, 'dir');
  } catch (error) {
    t.skip('symbolic links are unavailable in this test host: ' + error.code);
    return;
  }
  assert.equal(isSafeWorkspacePath(root, path.join(link, 'new-file.mjs')), false);
});
