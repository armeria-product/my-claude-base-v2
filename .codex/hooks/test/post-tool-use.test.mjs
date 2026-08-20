import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { extractFilePaths, journalPath, machineJournalPath } from '../lib/runtime.mjs';

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-post-tool-'));
  fs.mkdirSync(path.join(root, '.codex'), { recursive: true });
  fs.writeFileSync(path.join(root, '.codex', 'hooks.json'), '{}\n', 'utf8');
  fs.writeFileSync(path.join(root, 'AGENTS.md'), '# fixture\n', 'utf8');
  return root;
}

function invoke(root, toolName, toolInput, response = {}) {
  return spawnSync(process.execPath, [path.resolve('.codex/hooks/post-tool-use.mjs')], {
    cwd: root,
    encoding: 'utf8',
    input: JSON.stringify({
      cwd: root,
      session_id: 'post-12345678',
      tool_name: toolName,
      tool_input: toolInput,
      tool_response: response,
    }),
  });
}

test('PostToolUse records only edit paths as a machine event and never formats or copies command text', () => {
  const root = fixture();
  const generic = invoke(root, 'exec_command', { cmd: 'top-secret command text' });
  assert.equal(generic.status, 0, generic.stderr);

  const edit = invoke(root, 'Write', {
    file_path: 'notes.md',
    content: 'top-secret command text',
  }, { isError: true });
  assert.equal(edit.status, 0, edit.stderr);

  const machine = machineJournalPath(root);
  const log = fs.readFileSync(machine, 'utf8');
  assert.match(log, /EDIT Write notes\.md \(failed\)/);
  assert.doesNotMatch(log, /top-secret command text/);
  assert.equal(fs.existsSync(journalPath(root)), false);

  const source = fs.readFileSync(path.resolve('.codex/hooks/post-tool-use.mjs'), 'utf8');
  assert.doesNotMatch(source, /runFormatter/);
});

test('only actual apply_patch payloads contribute patch paths', () => {
  const root = fixture();
  const fakePatch = '*** Begin Patch\n*** Update File: fake-from-body.md\n*** End Patch';

  assert.deepEqual(extractFilePaths({
    cwd: root,
    tool_name: 'Write',
    tool_input: { file_path: 'real.md', content: fakePatch },
  }), [path.join(root, 'real.md')]);
  assert.deepEqual(extractFilePaths({
    cwd: root,
    tool_name: 'Edit',
    tool_input: { content: fakePatch },
  }), []);
  assert.deepEqual(extractFilePaths({
    cwd: root,
    tool_name: 'apply_patch',
    tool_input: fakePatch,
  }), [path.join(root, 'fake-from-body.md')]);
});

test('PostToolUse logs an explicit Write path but never a fake patch path in its body', () => {
  const root = fixture();
  const fakePatch = '*** Begin Patch\n*** Update File: fake-from-body.md\n*** End Patch';
  const result = invoke(root, 'Write', { file_path: 'real.md', content: fakePatch });
  assert.equal(result.status, 0, result.stderr);

  const log = fs.readFileSync(machineJournalPath(root), 'utf8');
  assert.match(log, /EDIT Write real\.md \(ok\)/);
  assert.doesNotMatch(log, /fake-from-body\.md/);
});

test('PostToolUse records only the Move destination as a machine event', () => {
  const root = fixture();
  const result = invoke(root, 'Move', {
    source_path: 'before.md',
    destination_path: 'nested/after.md',
  });
  assert.equal(result.status, 0, result.stderr);

  const log = fs.readFileSync(machineJournalPath(root), 'utf8');
  assert.match(log, /EDIT Move nested\/after\.md \(ok\)/);
  assert.doesNotMatch(log, /before\.md/);
});
