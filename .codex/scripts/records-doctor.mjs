import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HUMAN_REPORT = /^##\s+\d{2}:\d{2}\b/gm;
const CANONICAL_FILE = /^\d{4}-\d{2}\/\d{2}\.md$/;
const LEGACY_FILE = /^\d{4}\/\d{2}\/\d{2}\.md$/;

function humanReportHeadingCount(text) {
  return String(text || '').replace(/\r\n?/g, '\n').match(HUMAN_REPORT)?.length || 0;
}

function posix(relative) {
  return relative.split(path.sep).join('/');
}

function directoryExists(directory) {
  try {
    const stat = fs.lstatSync(directory);
    return stat.isDirectory() && !stat.isSymbolicLink();
  } catch {
    return false;
  }
}

function regularFiles(directory) {
  if (!directoryExists(directory)) return [];
  const files = [];
  const walk = (current, relative = '') => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      if (entry.isSymbolicLink()) continue;
      const next = path.join(current, entry.name);
      const nextRelative = relative ? path.join(relative, entry.name) : entry.name;
      if (entry.isDirectory()) walk(next, nextRelative);
      if (entry.isFile()) files.push(posix(nextRelative));
    }
  };
  walk(directory);
  return files.sort();
}

function symbolicLinks(directory) {
  let rootStat;
  try {
    rootStat = fs.lstatSync(directory);
  } catch {
    return [];
  }
  if (rootStat.isSymbolicLink()) return ['.'];
  if (!rootStat.isDirectory()) return [];
  const links = [];
  const walk = (current, relative = '') => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const next = path.join(current, entry.name);
      const nextRelative = relative ? path.join(relative, entry.name) : entry.name;
      if (entry.isSymbolicLink()) {
        links.push(posix(nextRelative));
        continue;
      }
      if (entry.isDirectory()) walk(next, nextRelative);
    }
  };
  walk(directory);
  return links.sort();
}

function readJournalFile(journalRoot, relative) {
  const target = path.join(journalRoot, ...relative.split('/'));
  try {
    const stat = fs.lstatSync(target);
    if (!stat.isFile() || stat.isSymbolicLink()) return null;
    return fs.readFileSync(target, 'utf8');
  } catch {
    return null;
  }
}

function inspectHumanLayout(journalRoot, matches) {
  const files = regularFiles(journalRoot).filter((file) => matches.test(file));
  const humanReportCount = files.reduce((count, file) => count + humanReportHeadingCount(readJournalFile(journalRoot, file)), 0);
  return { exists: directoryExists(journalRoot), files, humanReportCount, symlinks: symbolicLinks(journalRoot).filter((file) => matches.test(file)) };
}

function inspectMachineLayout(machineRoot) {
  return {
    exists: directoryExists(machineRoot),
    files: regularFiles(machineRoot).filter((file) => file.endsWith('.log')),
    symlinks: symbolicLinks(machineRoot),
  };
}

function pointerFromStateLine(line) {
  const match = String(line).match(/(?:→|->)\s*([^\s]+?\.md)(?=\s+(?:の|at)(?:\s|$)|\s*$)/u);
  return match ? match[1] : null;
}

function isUnder(root, target) {
  const relative = path.relative(root, target);
  return relative !== '' && !relative.startsWith('..' + path.sep) && relative !== '..' && !path.isAbsolute(relative);
}

function containsSymlink(journalRoot, target) {
  try {
    if (fs.lstatSync(journalRoot).isSymbolicLink()) return true;
    const relative = path.relative(journalRoot, target);
    let current = journalRoot;
    for (const part of relative.split(path.sep)) {
      current = path.join(current, part);
      if (!fs.existsSync(current)) return false;
      if (fs.lstatSync(current).isSymbolicLink()) return true;
    }
    return false;
  } catch {
    return false;
  }
}

export function resolveJournalPointer(root, pointer) {
  const workspaceRoot = path.resolve(root);
  const journalRoot = path.join(workspaceRoot, 'tasks', 'journal');
  const raw = String(pointer || '').trim();
  const normalized = raw.replace(/[\\/]+/g, path.sep);
  if (!raw) return { status: 'rejected', code: 'journal-pointer-missing', target: null };
  if (path.isAbsolute(normalized) || path.win32.isAbsolute(raw) || path.posix.isAbsolute(raw))
    return { status: 'rejected', code: 'journal-pointer-absolute', target: null };
  if (normalized.split(path.sep).includes('..'))
    return { status: 'rejected', code: 'journal-pointer-traversal', target: null };

  const target = path.resolve(workspaceRoot, normalized);
  if (!isUnder(journalRoot, target))
    return { status: 'rejected', code: 'journal-pointer-traversal', target: null };

  const relative = posix(path.relative(journalRoot, target));
  const layout = CANONICAL_FILE.test(relative) ? 'canonical' : LEGACY_FILE.test(relative) ? 'legacy' : null;
  if (!layout) return { status: 'rejected', code: 'journal-pointer-layout', target: null };
  if (containsSymlink(journalRoot, target))
    return { status: 'rejected', code: 'journal-pointer-symlink', target: null };

  let exists = false;
  let humanReport = false;
  try {
    const stat = fs.lstatSync(target);
    exists = stat.isFile() && !stat.isSymbolicLink();
    if (exists) humanReport = humanReportHeadingCount(fs.readFileSync(target, 'utf8')) > 0;
  } catch {
    // A missing pointer target is diagnosed by the caller; it is never created or followed.
  }
  return {
    status: 'valid',
    code: exists ? null : 'journal-pointer-target-missing',
    target: exists ? posix(path.relative(workspaceRoot, target)) : null,
    layout,
    exists,
    humanReport,
  };
}

function diagnoseSessionState(root, findings) {
  const statePath = path.join(root, 'tasks', 'session-state.md');
  if (!fs.existsSync(statePath)) {
    findings.push({ level: 'warning', code: 'session-state-missing', message: 'tasks/session-state.md is missing' });
    return { status: 'missing', path: 'tasks/session-state.md', lineCount: 0, pointer: null };
  }

  if (fs.lstatSync(statePath).isSymbolicLink()) {
    findings.push({ level: 'error', code: 'session-state-symlink', message: 'tasks/session-state.md must not be a symbolic link' });
    return { status: 'invalid', code: 'session-state-symlink', path: 'tasks/session-state.md', lineCount: 0, pointer: null };
  }

  const text = fs.readFileSync(statePath, 'utf8').replace(/\r\n/g, '\n');
  const lines = text.split('\n');
  if (lines.at(-1) === '') lines.pop();
  if (lines.length !== 2) {
    findings.push({ level: 'error', code: 'session-state-line-count', message: 'session-state.md must contain exactly two lines' });
    return { status: 'invalid', code: 'session-state-line-count', path: 'tasks/session-state.md', lineCount: lines.length, pointer: null };
  }
  if (!lines[0].startsWith('# Session State') || !lines[1].startsWith('## START HERE')) {
    findings.push({ level: 'error', code: 'session-state-shape', message: 'session-state.md does not have the required two-line pointer shape' });
    return { status: 'invalid', code: 'session-state-shape', path: 'tasks/session-state.md', lineCount: lines.length, pointer: null };
  }

  const rawPointer = pointerFromStateLine(lines[1]);
  const pointer = resolveJournalPointer(root, rawPointer);
  if (pointer.status === 'rejected') {
    findings.push({ level: 'error', code: pointer.code, message: 'session-state journal pointer was rejected' });
  } else if (!pointer.exists) {
    findings.push({ level: 'error', code: pointer.code, message: 'session-state journal pointer target is missing' });
  } else if (!pointer.humanReport) {
    findings.push({ level: 'warning', code: 'journal-pointer-no-human-report', message: 'session-state journal pointer has no human report heading' });
  }
  const status = pointer.status === 'valid' && pointer.exists ? 'valid' : 'invalid';
  return {
    status,
    ...(status === 'invalid' ? { code: pointer.code } : {}),
    path: 'tasks/session-state.md',
    lineCount: lines.length,
    pointer,
  };
}

export function diagnoseRecords(root = process.cwd()) {
  const workspaceRoot = path.resolve(root);
  const journalRoot = path.join(workspaceRoot, 'tasks', 'journal');
  const findings = [];
  const journal = {
    canonical: inspectHumanLayout(journalRoot, CANONICAL_FILE),
    legacy: inspectHumanLayout(journalRoot, LEGACY_FILE),
    machine: inspectMachineLayout(path.join(journalRoot, '.machine')),
  };

  for (const [layout, code] of [['canonical', 'canonical-journal-symlink'], ['legacy', 'legacy-journal-symlink'], ['machine', 'machine-journal-symlink']]) {
    if (journal[layout].symlinks.length)
      findings.push({ level: 'error', code, message: layout + ' journal layout contains symbolic links' });
  }

  if (!journal.canonical.humanReportCount && !journal.legacy.humanReportCount)
    findings.push({ level: 'warning', code: 'human-report-missing', message: 'no human journal report heading was found' });
  if (!journal.machine.exists)
    findings.push({ level: 'info', code: 'machine-journal-missing', message: 'no machine journal directory exists yet' });

  const sessionState = diagnoseSessionState(workspaceRoot, findings);
  return { root: workspaceRoot, journal, sessionState, findings };
}

export function formatDiagnosis(report) {
  const lines = [
    'Codex native records doctor',
    'canonical: ' + report.journal.canonical.files.length + ' file(s), ' + report.journal.canonical.humanReportCount + ' human report heading(s)',
    'legacy: ' + report.journal.legacy.files.length + ' file(s), ' + report.journal.legacy.humanReportCount + ' human report heading(s)',
    'machine: ' + report.journal.machine.files.length + ' log(s)',
    'session-state: ' + report.sessionState.status,
  ];
  for (const finding of report.findings) lines.push(finding.level.toUpperCase() + ' ' + finding.code + ': ' + finding.message);
  return lines.join('\n') + '\n';
}

export function runRecordsDoctor(root = process.cwd()) {
  const report = diagnoseRecords(root);
  process.stdout.write(formatDiagnosis(report));
  return report.findings.some((finding) => finding.level === 'error') ? 1 : 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = runRecordsDoctor(process.argv[2] || process.cwd());
}
