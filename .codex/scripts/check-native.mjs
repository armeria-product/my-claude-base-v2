import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(import.meta.dirname, '..', '..');
const TEST_ROOTS = [
  '.codex/hooks/test',
  '.codex/agents/test',
  '.agents/skills',
];
const SYNTAX_ROOTS = ['.codex/hooks', '.codex/scripts', '.agents/skills'];

function listMjs(directory, predicate = () => true) {
  const absolute = path.join(ROOT, directory);
  if (!fs.existsSync(absolute)) throw new Error('required native directory is missing: ' + directory);
  const files = [];
  const walk = (current) => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      if (entry.isSymbolicLink()) continue;
      const target = path.join(current, entry.name);
      if (entry.isDirectory()) walk(target);
      if (entry.isFile() && entry.name.endsWith('.mjs') && predicate(entry.name)) files.push(path.relative(ROOT, target));
    }
  };
  walk(absolute);
  return files.sort();
}

function runNode(label, args) {
  process.stdout.write('\n== ' + label + ' ==\n');
  const result = spawnSync(process.execPath, args, { cwd: ROOT, stdio: 'inherit' });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exitCode = result.status || 1;
  return result.status === 0;
}

export function nativeTestFiles() {
  return TEST_ROOTS.flatMap((directory) => listMjs(directory, (name) => name.endsWith('.test.mjs')));
}

export function nativeSyntaxFiles() {
  return SYNTAX_ROOTS.flatMap((directory) => listMjs(directory));
}

export function runNativeChecks() {
  const syntaxFiles = nativeSyntaxFiles();
  let passed = true;
  for (const file of syntaxFiles) passed = runNode('syntax ' + file, ['--check', file]) && passed;
  passed = runNode('records doctor', ['.codex/scripts/records-doctor.mjs']) && passed;
  passed = runNode('native tests', ['--test', ...nativeTestFiles()]) && passed;
  return passed;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = runNativeChecks() ? 0 : 1;
}
