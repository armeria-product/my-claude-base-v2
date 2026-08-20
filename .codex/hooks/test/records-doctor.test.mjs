import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { diagnoseRecords, formatDiagnosis } from '../../scripts/records-doctor.mjs';

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-records-doctor-'));
  const journal = path.join(root, 'tasks', 'journal');
  fs.mkdirSync(path.join(journal, '2026-08'), { recursive: true });
  fs.mkdirSync(path.join(journal, '2026', '08'), { recursive: true });
  fs.mkdirSync(path.join(journal, '.machine', '2026-08'), { recursive: true });
  fs.writeFileSync(
    path.join(root, 'tasks', 'session-state.md'),
    '# Session State — fixture\n## START HERE — [2026-08-20 10:00] → tasks/journal/2026-08/20.md の 10:00 レポート\n',
  );
  fs.writeFileSync(path.join(journal, '2026-08', '20.md'), '# Canonical\n\n## 10:00 report\nhuman report\n');
  fs.writeFileSync(path.join(journal, '2026', '08', '19.md'), '# Legacy\n\n## 09:00 report\nlegacy report\n');
  fs.writeFileSync(path.join(journal, '.machine', '2026-08', '20.log'), '- 10:00:00 machine event\n');
  return root;
}

test('records doctor reports canonical and legacy human journals plus machine evidence', () => {
  const root = fixture();
  const report = diagnoseRecords(root);

  assert.deepEqual(report.journal.canonical.files, ['2026-08/20.md']);
  assert.equal(report.journal.canonical.humanReportCount, 1);
  assert.deepEqual(report.journal.legacy.files, ['2026/08/19.md']);
  assert.equal(report.journal.legacy.humanReportCount, 1);
  assert.deepEqual(report.journal.machine.files, ['2026-08/20.log']);
  assert.equal(report.sessionState.lineCount, 2);
  assert.equal(report.sessionState.pointer.status, 'valid');
  assert.equal(report.sessionState.pointer.layout, 'canonical');
  assert.equal(report.sessionState.pointer.exists, true);
  assert.equal(report.sessionState.pointer.humanReport, true);
  assert.equal(report.findings.filter((finding) => finding.level === 'error').length, 0);
});

test('records doctor rejects a journal-pointer traversal without reading its target', () => {
  const root = fixture();
  const outside = path.join(root, 'outside.md');
  fs.writeFileSync(outside, 'outside journal contents must stay unread\n');
  fs.writeFileSync(
    path.join(root, 'tasks', 'session-state.md'),
    '# Session State — fixture\n## START HERE — [2026-08-20 10:00] → tasks/journal/../../outside.md の 10:00 レポート\n',
  );

  const report = diagnoseRecords(root);

  assert.equal(report.sessionState.pointer.status, 'rejected');
  assert.equal(report.sessionState.pointer.code, 'journal-pointer-traversal');
  assert.equal(report.sessionState.pointer.target, null);
  assert.equal(JSON.stringify(report).includes('outside journal contents'), false);
  assert.ok(report.findings.some((finding) => finding.code === 'journal-pointer-traversal'));
});

test('records doctor reports a session-state file that is not an exact two-line pointer', () => {
  const root = fixture();
  fs.writeFileSync(
    path.join(root, 'tasks', 'session-state.md'),
    '# Session State — fixture\n## START HERE — pointer\nextra\n',
  );

  const report = diagnoseRecords(root);

  assert.equal(report.sessionState.status, 'invalid');
  assert.equal(report.sessionState.code, 'session-state-line-count');
  assert.ok(report.findings.some((finding) => finding.code === 'session-state-line-count'));
});


test('records doctor counts each human-report heading and invalidates a missing pointer target', () => {
  const root = fixture();
  const canonical = path.join(root, 'tasks', 'journal', '2026-08', '20.md');
  fs.writeFileSync(
    canonical,
    '# Canonical\n\n## 09:00 earlier report\nearlier\n\n## 10:00 current report\ncurrent\n',
  );

  const multiReport = diagnoseRecords(root);
  assert.equal(multiReport.journal.canonical.humanReportCount, 2);
  assert.match(formatDiagnosis(multiReport), /2 human report heading\(s\)/);

  fs.writeFileSync(
    path.join(root, 'tasks', 'session-state.md'),
    '# Session State — fixture\n## START HERE — [2026-08-21 10:00] → tasks/journal/2026-08/21.md の 10:00 レポート\n',
  );

  const missingTarget = diagnoseRecords(root);
  assert.equal(missingTarget.sessionState.status, 'invalid');
  assert.equal(missingTarget.sessionState.pointer.code, 'journal-pointer-target-missing');
  assert.ok(missingTarget.findings.some((finding) => finding.code === 'journal-pointer-target-missing'));
});
test('records doctor reports canonical and machine journal symlink invalidity', (t) => {
  const root = fixture();
  const journal = path.join(root, 'tasks', 'journal');
  const canonical = path.join(journal, '2026-08', '20.md');
  const externalHuman = path.join(root, 'outside-human.md');
  const machine = path.join(journal, '.machine');
  const externalMachine = path.join(root, 'outside-machine');
  fs.writeFileSync(externalHuman, '## 10:00 external\n');
  fs.mkdirSync(externalMachine, { recursive: true });
  fs.unlinkSync(canonical);
  fs.rmSync(machine, { recursive: true, force: true });
  try {
    fs.symlinkSync(externalHuman, canonical, 'file');
    fs.symlinkSync(externalMachine, machine, 'dir');
  } catch (error) {
    t.skip('symbolic links are unavailable in this test host: ' + error.code);
    return;
  }

  const report = diagnoseRecords(root);
  assert.ok(report.journal.canonical.symlinks.includes('2026-08/20.md'));
  assert.ok(report.journal.machine.symlinks.includes('.'));
  for (const code of ['canonical-journal-symlink', 'machine-journal-symlink', 'journal-pointer-symlink']) {
    assert.ok(report.findings.some((finding) => finding.code === code), code);
  }
});
