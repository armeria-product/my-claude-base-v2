import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  CONTEXT_BLOCK_BUDGETS,
  MAX_CONTEXT_BYTES,
  appendMachineEvent,
  buildContext,
  humanJournalPaths,
  journalPath,
  latestReport,
  legacyJournalPath,
  machineJournalPath,
} from '../lib/runtime.mjs';

const NOW = new Date('2026-08-20T12:00:00');

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-runtime-'));
  fs.mkdirSync(path.join(root, 'tasks'), { recursive: true });
  return root;
}

function write(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text, 'utf8');
}

function payload(root) {
  return {
    cwd: root,
    session_id: 'runtime-12345678',
    turn_id: 'turn-12345678',
  };
}

function block(context, label) {
  const start = context.indexOf(`=== ${label} ===`);
  assert.notEqual(start, -1, label);
  const end = context.indexOf('\n\n=== ', start + label.length);
  return context.slice(start, end < 0 ? context.length : end);
}

test('human journals use the canonical path, read legacy reports, and keep machine events separate', () => {
  const root = fixture();
  const canonical = journalPath(root, NOW);
  const legacy = legacyJournalPath(root, NOW);
  const machine = machineJournalPath(root, NOW);

  assert.deepEqual(humanJournalPaths(root, NOW), [canonical, legacy]);
  assert.match(canonical, /tasks[\\/]journal[\\/]2026-08[\\/]20\.md$/);
  assert.match(legacy, /tasks[\\/]journal[\\/]2026[\\/]08[\\/]20\.md$/);
  assert.match(machine, /tasks[\\/]journal[\\/]\.machine[\\/]2026-08[\\/]20\.log$/);

  write(canonical, '- machine-shaped text without a human heading\n');
  write(legacy, '## 09:00 セッションレポート — legacy fallback\nlegacy body\n');
  assert.match(latestReport(root, NOW), /legacy fallback/);

  write(canonical, '## 10:00 セッションレポート — canonical wins\ncanonical body\n');
  const report = latestReport(root, NOW);
  assert.match(report, /canonical wins/);
  assert.doesNotMatch(report, /legacy fallback/);

  appendMachineEvent(root, '- 12:00:00 [runtime] SESSION START', NOW);
  assert.equal(fs.existsSync(machine), true);
  assert.match(fs.readFileSync(machine, 'utf8'), /SESSION START/);
  assert.equal(fs.readFileSync(canonical, 'utf8').includes('SESSION START'), false);
});

test('runtime refuses journal symlinks for human reads and machine writes', (t) => {
  const root = fixture();
  const externalHuman = path.join(root, 'outside-human.md');
  const canonical = journalPath(root, NOW);
  write(externalHuman, '## 10:00 external report\nthis must stay unread\n');
  fs.mkdirSync(path.dirname(canonical), { recursive: true });
  try {
    fs.symlinkSync(externalHuman, canonical, 'file');
  } catch (error) {
    t.skip('symbolic links are unavailable in this test host: ' + error.code);
    return;
  }
  assert.equal(latestReport(root, NOW), null);

  const machineRoot = path.join(root, 'tasks', 'journal', '.machine');
  const externalMachine = path.join(root, 'outside-machine');
  fs.mkdirSync(externalMachine, { recursive: true });
  fs.symlinkSync(externalMachine, machineRoot, 'dir');
  assert.equal(appendMachineEvent(root, '- 12:00 safe event', NOW), false);
  assert.equal(fs.existsSync(path.join(externalMachine, '2026-08', '20.log')), false);
});

test('machine-event logging strips C0, C1, and ESC controls from input fields', () => {
  const root = fixture();
  appendMachineEvent(root, '- field\u0000\u0008\u001b\u007f\u0085\u009f value', NOW);
  const logged = fs.readFileSync(machineJournalPath(root, NOW), 'utf8').replace(/\n/g, '');
  assert.doesNotMatch(logged, /[\u0000-\u001f\u007f-\u009f]/);
  assert.match(logged, /field value/);
});

test('session context reserves every required block within the 10 KiB cap', () => {
  const root = fixture();
  write(path.join(root, 'tasks', 'session-state.md'), `# Session State\n${'state '.repeat(2_000)}`);
  write(path.join(root, 'tasks', 'todo.md'), `# TODO\n\n## Now\n- [ ] keep the next action\n${'todo '.repeat(2_000)}\n\n## Backlog\n- [ ] later`);
  write(journalPath(root, NOW), `## 10:00 セッションレポート — latest human report\n${'report '.repeat(2_000)}`);
  write(path.join(root, 'tasks', 'codemap.md'), `# Map\n${Array.from({ length: 600 }, (_, index) => `## Area ${index}`).join('\n')}`);
  write(path.join(root, 'tasks', 'lessons.md'), 'LESSON_MARKER must not be injected');

  const context = buildContext(payload(root), NOW);

  assert.ok(Buffer.byteLength(context, 'utf8') <= MAX_CONTEXT_BYTES);
  assert.match(context, /=== SESSION STATE ===/);
  assert.match(context, /=== LATEST HUMAN REPORT ===/);
  assert.match(context, /=== TODO ===/);
  assert.match(context, /=== CODEMAP ===/);
  assert.match(context, /keep the next action/);
  assert.match(context, /latest human report/);
  assert.doesNotMatch(context, /LESSON_MARKER/);
  assert.ok(Buffer.byteLength(block(context, 'SESSION STATE'), 'utf8') <= CONTEXT_BLOCK_BUDGETS.sessionState);
  assert.ok(Buffer.byteLength(block(context, 'LATEST HUMAN REPORT'), 'utf8') <= CONTEXT_BLOCK_BUDGETS.latestHumanReport);
  assert.ok(Buffer.byteLength(block(context, 'TODO'), 'utf8') <= CONTEXT_BLOCK_BUDGETS.todo);
  assert.ok(Buffer.byteLength(block(context, 'CODEMAP'), 'utf8') <= CONTEXT_BLOCK_BUDGETS.codemap);
});
