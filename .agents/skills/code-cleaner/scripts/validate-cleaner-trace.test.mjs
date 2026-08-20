import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import test from 'node:test';

import {
  analyzeUnifiedDiff,
  isProtectedComment,
  validateCleanerTrace,
} from './validate-cleaner-trace.mjs';

const SKILL_PATH = new URL('../SKILL.md', import.meta.url);
const VALIDATOR_PATH = fileURLToPath(new URL('./validate-cleaner-trace.mjs', import.meta.url));
const REMOVAL = [
  'diff --git a/src/app.js b/src/app.js',
  '--- a/src/app.js',
  '+++ b/src/app.js',
  '@@ -1,2 +1 @@',
  '-const unusedFlag = true;',
].join('\n');

function validTrace() {
  return {
    author: 'cleaner-author',
    baseline: { status: 'pass', command: 'node --test', evidence: 'baseline suite passed' },
    passes: [
      {
        id: 'dead-code-1',
        category: 'DEAD_CODE',
        diff: { unified: REMOVAL },
        outcome: 'passed',
        verification: { status: 'pass', command: 'node --test', evidence: 'focused suite passed' },
      },
    ],
    final: { status: 'pass', command: 'node --test', evidence: 'full suite passed', diff: { unified: REMOVAL } },
    independentVerification: {
      status: 'pass', command: 'node --test', evidence: 'independent verifier reran suite',
      role: 'verifier', actor: 'fresh-verifier',
    },
  };
}

test('skill uses the hub-reachable validator path', () => {
  const skill = readFileSync(SKILL_PATH, 'utf8');
  assert.equal(existsSync(new URL('./validate-cleaner-trace.mjs', import.meta.url)), true);
  assert.match(skill, /\.agents\/skills\/code-cleaner\/scripts\/validate-cleaner-trace\.mjs/);
});

test('accepts a baseline-protected, category-isolated deletion-only passing trace', () => {
  assert.deepEqual(validateCleanerTrace(validTrace()), []);
  assert.deepEqual(analyzeUnifiedDiff(REMOVAL).additions, []);
});

test('accepts a failed pass only when its own rollback is recorded', () => {
  const trace = validTrace();
  trace.passes.push({
    id: 'comment-noise-1', category: 'COMMENT_NOISE', diff: { unified: REMOVAL }, outcome: 'failed',
    verification: { status: 'fail', command: 'node --test', evidence: 'regression observed' },
    rollback: { passId: 'comment-noise-1', scope: 'own-pass', status: 'restored', evidence: 'recorded pass restored' },
  });
  assert.deepEqual(validateCleanerTrace(trace), []);
});

test('rejects every added line in a cleaner pass', () => {
  const trace = validTrace();
  trace.passes[0].diff.unified += '\n+const replacement = false;';
  assert.match(validateCleanerTrace(trace).join('\n'), /adds lines/);
});

test('rejects protected comment removal including directive forms', () => {
  assert.equal(isProtectedComment('// TODO: retained intentionally'), true);
  assert.equal(isProtectedComment('// @vitest-environment jsdom'), true);
  const trace = validTrace();
  trace.passes[0].diff.unified = REMOVAL.replace('-const unusedFlag = true;', '-// TODO: preserve this contract');
  assert.match(validateCleanerTrace(trace).join('\n'), /protected comment/);
});

test('rejects a failed pass without evidence that only its own pass was restored', () => {
  const trace = validTrace();
  trace.passes.push({
    id: 'comment-noise-1', category: 'COMMENT_NOISE', diff: { unified: REMOVAL }, outcome: 'failed',
    verification: { status: 'fail', command: 'node --test', evidence: 'regression observed' },
  });
  assert.match(validateCleanerTrace(trace).join('\n'), /failed without rollback evidence/);
});

test('mutation removes the validator additions guard and makes its detecting test RED before the real source is GREEN', () => {
  const trace = validTrace();
  trace.final.diff.unified += '\n+const accidentalAddition = true;';
  const source = readFileSync(VALIDATOR_PATH, 'utf8');
  const additionsGuard = /  if \(analysis\.additions\.length > 0\) errors\.push\(label \+ ' adds lines; cleaner passes must be deletion-only'\);\r?\n/;
  assert.match(source, additionsGuard);
  const directory = mkdtempSync(path.join(os.tmpdir(), 'cleaner-mutation-'));
  try {
    const mutantPath = path.join(directory, 'validate-cleaner-trace.mjs');
    writeFileSync(mutantPath, source.replace(additionsGuard, ''), 'utf8');
    const makeProbe = (modulePath) => [
      "import assert from 'node:assert/strict';",
      `import { validateCleanerTrace } from ${JSON.stringify(pathToFileURL(modulePath).href)};`,
      `const trace = ${JSON.stringify(trace)};`,
      "assert.match(validateCleanerTrace(trace).join('\\n'), /adds lines/);",
    ].join('\n');
    const mutantProbe = path.join(directory, 'mutant-probe.test.mjs');
    const realProbe = path.join(directory, 'real-probe.test.mjs');
    writeFileSync(mutantProbe, makeProbe(mutantPath), 'utf8');
    writeFileSync(realProbe, makeProbe(VALIDATOR_PATH), 'utf8');

    const red = spawnSync(process.execPath, [mutantProbe], { encoding: 'utf8' });
    assert.equal(red.status, 1, red.stdout + red.stderr);
    const green = spawnSync(process.execPath, [realProbe], { encoding: 'utf8' });
    assert.equal(green.status, 0, green.stdout + green.stderr);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
