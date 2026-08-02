// node --test ".claude/hooks/lib/*.test.js" ".claude/scripts/*.test.mjs"   (全テスト)
// node .claude/hooks/lib/hook-probes.test.js --set <SET_NAME> --out <FILE>   (単一セットのTSVダンプ; --set 省略で全件)
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const SANDBOX = path.join(ROOT, 'tmp', 'hook-probes', 'sandbox');
const SANDBOX_FREE = path.join(ROOT, 'tmp', 'hook-probes', 'sandbox-free');
const SAMPLES_FILE = path.join(__dirname, 'hook-probes.samples.json');
const PROTECTED_BRANCHES = new Set(['main', 'master']);

function slash(p) {
  return p.split(path.sep).join('/');
}

function ensureJournal(root) {
  const now = new Date();
  const two = (n) => String(n).padStart(2, '0');
  const yyyyMm = `${now.getFullYear()}-${two(now.getMonth() + 1)}`;
  const dd = two(now.getDate());
  const journalDir = path.join(root, 'tasks', 'journal', yyyyMm);
  fs.mkdirSync(journalDir, { recursive: true });
  const journalFile = path.join(journalDir, `${dd}.md`);
  if (!fs.existsSync(journalFile)) {
    fs.writeFileSync(journalFile, `# ${yyyyMm}-${dd} sandbox journal (hook-probes.test.js)\n\n`);
  }
}

function buildSandbox() {
  fs.mkdirSync(path.join(SANDBOX, '.claude', 'state'), { recursive: true });
  fs.mkdirSync(path.join(SANDBOX, 'sub'), { recursive: true });
  fs.mkdirSync(path.join(SANDBOX, 'other'), { recursive: true });
  fs.mkdirSync(path.join(SANDBOX, 'dev', 'foo'), { recursive: true });

  ensureJournal(SANDBOX);

  fs.writeFileSync(
    path.join(SANDBOX, '.claude', 'state', 'scope-lock.json'),
    JSON.stringify({
      status: 'locked',
      slug: 'probe',
      plan: 'plans/probe/PLAN.md',
      allow: ['sub/**'],
      forbid: [],
    })
  );
}

function buildSandboxFree() {
  fs.mkdirSync(path.join(SANDBOX_FREE, '.claude', 'state'), { recursive: true });
  ensureJournal(SANDBOX_FREE);
}

function loadRows() {
  const raw = fs.readFileSync(SAMPLES_FILE, 'utf8');
  const substituted = raw
    .split('<SANDBOX_FREE>').join(slash(SANDBOX_FREE))
    .split('<SANDBOX>').join(slash(SANDBOX))
    .split('<REPO>').join(slash(ROOT));
  return JSON.parse(substituted);
}

function buildEnv(overrides) {
  const env = { ...process.env };
  env.CLAUDE_PROJECT_DIR = slash(ROOT);
  for (const [k, v] of Object.entries(overrides || {})) {
    if (v === null) delete env[k];
    else env[k] = v;
  }
  return env;
}

function runRow(row) {
  const hookPath = path.join(ROOT, row.hook);
  const input = JSON.stringify(row.payload);
  const env = buildEnv(row.env);
  const cwdOpt = row.payload.cwd || ROOT;
  try {
    const stdout = execFileSync(process.execPath, [hookPath], {
      input,
      env,
      cwd: cwdOpt,
      encoding: 'utf8',
    });
    return { exit: 0, stdout: stdout || '', stderr: '' };
  } catch (e) {
    return {
      exit: typeof e.status === 'number' ? e.status : -1,
      stdout: e.stdout != null ? String(e.stdout) : '',
      stderr: e.stderr != null ? String(e.stderr) : '',
    };
  }
}

function verdictOf(row, result) {
  if (row.hook.endsWith('cmd-write-guard.js')) {
    if (result.exit !== 0) {
      throw new Error(
        `${row.set}/${row.name}: cmd-write-guard.js exited ${result.exit} (expected 0; ` +
        `this hook signals deny via stdout JSON, not exit code) — stderr: ${result.stderr}`
      );
    }
    return result.stdout.includes('"permissionDecision":"deny"') ? 'deny' : 'allow';
  }
  if (result.exit === 2) return 'deny';
  if (result.exit === 0) return 'allow';
  throw new Error(
    `${row.set}/${row.name}: ${row.hook} exited ${result.exit} (expected 0 or 2) — stderr: ${result.stderr}`
  );
}

function checkCanaries(results) {
  const byName = Object.fromEntries(results.map((r) => [r.row.name, r]));
  const failures = [];

  const a = byName.__canary_deny_exit;
  if (!a || a.result.exit !== 2 || !/force push/i.test(a.result.stderr)) {
    failures.push('__canary_deny_exit');
  }

  const b = byName.__canary_allow;
  if (!b || b.result.exit !== 0 || b.result.stderr.trim() !== '') {
    failures.push('__canary_allow');
  }

  const c = byName.__canary_deny_stdout;
  if (!c || !c.result.stdout.includes('"permissionDecision":"deny"')) {
    failures.push('__canary_deny_stdout');
  }

  return failures;
}

function currentBranch() {
  try {
    return execFileSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], {
      cwd: ROOT,
      encoding: 'utf8',
    }).trim();
  } catch {
    return '';
  }
}

function runDump() {
  const args = process.argv.slice(2);
  const setIdx = args.indexOf('--set');
  const outIdx = args.indexOf('--out');
  if (outIdx === -1) {
    console.error('Usage: node hook-probes.test.js [--set <SET_NAME>] --out <FILE>');
    process.exit(1);
  }
  const setName = setIdx !== -1 ? args[setIdx + 1] : null;
  const outFile = args[outIdx + 1];

  buildSandbox();
  buildSandboxFree();

  const allRows = loadRows();
  const rows = setName ? allRows.filter((r) => r.set === setName) : allRows;
  if (rows.length === 0) {
    console.error(`No samples found for set "${setName}"`);
    process.exit(1);
  }

  const lines = rows.map((row) => {
    const result = runRow(row);
    const verdict = verdictOf(row, result);
    return [row.set, row.name, verdict, row.expect].join('\t');
  });

  fs.mkdirSync(path.dirname(outFile), { recursive: true });
  fs.writeFileSync(outFile, lines.join('\n') + '\n');

  console.log(`OK: ${setName || 'ALL'} — ${lines.length} rows captured -> ${outFile}`);
  process.exit(0);
}

function registerTests() {
  const { test } = require('node:test');
  const assert = require('node:assert');

  buildSandbox();
  buildSandboxFree();

  const raw = fs.readFileSync(SAMPLES_FILE, 'utf8');
  const allRows = JSON.parse(raw
    .split('<SANDBOX_FREE>').join(slash(SANDBOX_FREE))
    .split('<SANDBOX>').join(slash(SANDBOX))
    .split('<REPO>').join(slash(ROOT)));

  const EXPECTED_SAMPLE_COUNT = 148;
  // Independently-hardcoded expectation (not re-derived from allRows) so this assertion can't
  // silently pass no matter what skipIf tags actually exist in the samples file — mirrors the
  // EXPECTED_SAMPLE_COUNT literal above. Update both the count and this table together when a
  // row's skipIf tag changes or a new skipIf-tagged row is added/removed.
  const EXPECTED_SKIP_TAG_COUNTS = { 'protected-branch': 4, 'non-win32': 1 };

  test('samples file integrity: JSON.parse succeeds, row count matches, set+name pairs unique', () => {
    const parsed = JSON.parse(raw
      .split('<SANDBOX_FREE>').join(slash(SANDBOX_FREE))
      .split('<SANDBOX>').join(slash(SANDBOX))
      .split('<REPO>').join(slash(ROOT)));
    assert.strictEqual(parsed.length, EXPECTED_SAMPLE_COUNT);
    const seen = new Set();
    for (const r of parsed) {
      const key = `${r.set}/${r.name}`;
      assert.ok(!seen.has(key), `duplicate set+name pair: ${key}`);
      seen.add(key);
    }
  });

  test('samples file integrity: skipIf tag counts match the expected table', () => {
    const parsed = JSON.parse(raw
      .split('<SANDBOX_FREE>').join(slash(SANDBOX_FREE))
      .split('<SANDBOX>').join(slash(SANDBOX))
      .split('<REPO>').join(slash(ROOT)));
    const actual = {};
    for (const r of parsed) {
      if (r.skipIf) actual[r.skipIf] = (actual[r.skipIf] || 0) + 1;
    }
    assert.deepStrictEqual(actual, EXPECTED_SKIP_TAG_COUNTS);
  });

  const branch = currentBranch();
  const branchProtected = PROTECTED_BRANCHES.has(branch);

  for (const row of allRows) {
    const skip = (row.skipIf === 'protected-branch' && branchProtected)
      || (row.skipIf === 'non-win32' && process.platform !== 'win32')
      ? row.skipReason
      : false;
    test(`${row.set}/${row.name}`, { skip }, () => {
      const result = runRow(row);
      const verdict = verdictOf(row, result);
      assert.strictEqual(verdict, row.expect);
    });
  }

  // Independently-hardcoded per-set expectation (not re-derived from allRows — a self-filter
  // compared to itself is always equal and detects nothing). Update this table whenever a row
  // is added to/removed from/moved between sets. Verified this equals EXPECTED_SAMPLE_COUNT and
  // covers exactly the sets present in the samples file below.
  const EXPECTED_SET_COUNTS = {
    'S-git-pure': 26,
    'S-git-env': 13,
    'S-gh': 15,
    'S-state': 17,
    'S-lock': 18,
    'S-fs': 18,
    'S-prompt': 8,
    'S-session': 5,
    'S-agent': 23,
    'S-secret': 5,
  };

  const setsInOrder = [...new Set(allRows.map((r) => r.set))];

  test('EXPECTED_SET_COUNTS covers exactly the sets present, and sums to EXPECTED_SAMPLE_COUNT', () => {
    assert.deepStrictEqual(
      [...Object.keys(EXPECTED_SET_COUNTS)].sort(),
      [...setsInOrder].sort()
    );
    const sum = Object.values(EXPECTED_SET_COUNTS).reduce((a, b) => a + b, 0);
    assert.strictEqual(sum, EXPECTED_SAMPLE_COUNT);
  });

  for (const setName of setsInOrder) {
    const setRows = allRows.filter((r) => r.set === setName);

    test(`${setName}: row count matches the expected table (${setRows.length})`, () => {
      assert.strictEqual(setRows.length, EXPECTED_SET_COUNTS[setName]);
      assert.ok(setRows.length >= 3, `${setName} must include at least the 3 canary rows`);
    });

    test(`${setName}: canaries pass (scoped to this set)`, () => {
      const results = setRows.map((row) => ({ row, result: runRow(row) }));
      const failures = checkCanaries(results);
      assert.deepStrictEqual(failures, []);
    });
  }
}

if (process.argv.includes('--out')) {
  runDump();
} else {
  registerTests();
}
