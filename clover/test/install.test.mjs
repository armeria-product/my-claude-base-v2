import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

// install.mjs writes the clover claude wrapper into a PowerShell profile. These tests never touch
// the real $PROFILE: CLOVER_PROFILE_PATH always points at a throwaway file under os.tmpdir(), and
// CLOVER_SKIP_PARSE=1 skips the powershell.exe syntax check (may be unavailable in CI).

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const INSTALL_PATH = path.join(__dirname, '..', 'bin', 'install.mjs');

function tmpProfilePath() {
  return path.join(os.tmpdir(), `clover-install-test-${crypto.randomBytes(6).toString('hex')}`, 'profile.ps1');
}

function tmpRunDir() {
  return path.join(os.tmpdir(), `clover-install-test-rundir-${crypto.randomBytes(6).toString('hex')}`);
}

// CLOVER_RUN_DIR は常にテスト専用の使い捨てディレクトリへ差し替える（実運用の
// clover/run/ を汚さないため）。呼び出し側が extraEnv.CLOVER_RUN_DIR を渡した場合はそちらを優先する。
function runInstall(profilePath, extraArgs = [], { skipParse = true, extraEnv = {} } = {}) {
  const env = {
    ...process.env,
    CLOVER_PROFILE_PATH: profilePath,
    CLOVER_RUN_DIR: extraEnv.CLOVER_RUN_DIR || tmpRunDir(),
    ...extraEnv,
  };
  if (skipParse) env.CLOVER_SKIP_PARSE = '1';
  else delete env.CLOVER_SKIP_PARSE;
  const result = spawnSync(process.execPath, [INSTALL_PATH, ...extraArgs], { env, encoding: 'utf8' });
  if (!extraEnv.CLOVER_RUN_DIR) fs.rmSync(env.CLOVER_RUN_DIR, { recursive: true, force: true });
  return { code: result.status, out: result.stdout, err: result.stderr };
}

test('install: fresh profile gets the managed block with <REPO> replaced by an absolute path', () => {
  const profilePath = tmpProfilePath();
  try {
    const result = runInstall(profilePath);
    assert.equal(result.code, 0, `stderr: ${result.err}`);
    assert.ok(fs.existsSync(profilePath));
    const content = fs.readFileSync(profilePath, 'utf8');
    assert.ok(content.includes('# >>> clover claude wrapper (managed; remove this block to uninstall) >>>'));
    assert.ok(content.includes('# <<< clover claude wrapper <<<'));
    assert.ok(!content.includes('<REPO>'), 'placeholder must be replaced');
    assert.match(content, /[A-Za-z]:\\.*clover/, 'must contain a drive-rooted absolute path, not a drive-relative one');
  } finally {
    fs.rmSync(path.dirname(profilePath), { recursive: true, force: true });
  }
});

test('install: re-running is idempotent (single block, content refreshed, other profile content preserved)', () => {
  const profilePath = tmpProfilePath();
  try {
    fs.mkdirSync(path.dirname(profilePath), { recursive: true });
    fs.writeFileSync(profilePath, '# my own stuff\nWrite-Host "hello"\n', 'utf8');

    const first = runInstall(profilePath);
    assert.equal(first.code, 0, `stderr: ${first.err}`);
    const second = runInstall(profilePath);
    assert.equal(second.code, 0, `stderr: ${second.err}`);

    const content = fs.readFileSync(profilePath, 'utf8');
    const opens = content.match(/# >>> clover claude wrapper/g) || [];
    assert.equal(opens.length, 1, `expected exactly one block, got ${opens.length}. content:\n${content}`);
    assert.ok(content.includes('# my own stuff'), 'pre-existing profile content must be preserved');
    assert.ok(content.includes('Write-Host "hello"'));
  } finally {
    fs.rmSync(path.dirname(profilePath), { recursive: true, force: true });
  }
});

test('install: an old-generation block (marker without "(managed") is replaced by the new-format block', () => {
  const profilePath = tmpProfilePath();
  try {
    fs.mkdirSync(path.dirname(profilePath), { recursive: true });
    const oldBlock = [
      '# >>> clover claude wrapper >>>',
      'function claude { Write-Host "old version" }',
      '# <<< clover claude wrapper <<<',
      '',
    ].join('\n');
    fs.writeFileSync(profilePath, `# keep me\n${oldBlock}`, 'utf8');

    const result = runInstall(profilePath);
    assert.equal(result.code, 0, `stderr: ${result.err}`);

    const content = fs.readFileSync(profilePath, 'utf8');
    assert.ok(!content.includes('old version'), 'old block body must be replaced');
    assert.ok(content.includes('# >>> clover claude wrapper (managed; remove this block to uninstall) >>>'));
    const opens = content.match(/# >>> clover claude wrapper/g) || [];
    assert.equal(opens.length, 1, `expected exactly one block after replacing old-gen marker, got ${opens.length}`);
    assert.ok(content.includes('# keep me'), 'unrelated existing content must be preserved');
  } finally {
    fs.rmSync(path.dirname(profilePath), { recursive: true, force: true });
  }
});

test('install --uninstall: removes the managed block but preserves other existing content', () => {
  const profilePath = tmpProfilePath();
  try {
    const install = runInstall(profilePath);
    assert.equal(install.code, 0, `stderr: ${install.err}`);
    fs.appendFileSync(profilePath, '\n# unrelated line\n', 'utf8');

    const result = runInstall(profilePath, ['--uninstall']);
    assert.equal(result.code, 0, `stderr: ${result.err}`);

    const content = fs.readFileSync(profilePath, 'utf8');
    assert.ok(!content.includes('clover claude wrapper'), 'managed block must be gone');
    assert.ok(content.includes('# unrelated line'), 'unrelated content must survive uninstall');
  } finally {
    fs.rmSync(path.dirname(profilePath), { recursive: true, force: true });
  }
});

test('install --uninstall: no-op (exit 0) when there is no managed block to remove', () => {
  const profilePath = tmpProfilePath();
  try {
    fs.mkdirSync(path.dirname(profilePath), { recursive: true });
    fs.writeFileSync(profilePath, '# nothing to see here\n', 'utf8');

    const result = runInstall(profilePath, ['--uninstall']);
    assert.equal(result.code, 0, `stderr: ${result.err}`);
    assert.equal(fs.readFileSync(profilePath, 'utf8'), '# nothing to see here\n');
  } finally {
    fs.rmSync(path.dirname(profilePath), { recursive: true, force: true });
  }
});

test('verifyProfileContent: rejects an unreplaced <REPO> placeholder, non-ASCII in the block, and a drive-relative path', async () => {
  const { verifyProfileContent, blockRegex } = await import(pathToFileURL(INSTALL_PATH));

  assert.throws(() => verifyProfileContent(
    '# >>> clover claude wrapper (managed; remove this block to uninstall) >>>\nD:\\my-claude-base\\clover and <REPO>\n# <<< clover claude wrapper <<<\n',
    'D:\\my-claude-base',
  ), /<REPO>/);

  assert.throws(() => verifyProfileContent(
    '# >>> clover claude wrapper (managed; remove this block to uninstall) >>>\n# 日本語コメント D:\\my-claude-base\\clover\n# <<< clover claude wrapper <<<\n',
    'D:\\my-claude-base',
  ), /非ASCII/);

  assert.throws(() => verifyProfileContent(
    '# >>> clover claude wrapper (managed; remove this block to uninstall) >>>\nmy-claude-base\\clover\n# <<< clover claude wrapper <<<\n',
    'D:\\my-claude-base',
  ), /絶対パス/);

  void blockRegex;
});

test('install: rolls back to the pre-write content when post-write verification (PowerShell syntax check) fails', () => {
  // This is the one test that does NOT pass CLOVER_SKIP_PARSE, so it exercises the real
  // powershell.exe syntax-check path. It corrupts the *pre-existing, unrelated* profile content
  // (outside the managed block) with a syntax error, which the parser check must catch, and
  // asserts the whole file -- including that broken pre-existing content -- is rolled back exactly.
  const profilePath = tmpProfilePath();
  try {
    fs.mkdirSync(path.dirname(profilePath), { recursive: true });
    const brokenPreexisting = '# my own stuff\nfunction unbalanced { Write-Host "oops"\n';
    fs.writeFileSync(profilePath, brokenPreexisting, 'utf8');

    const result = runInstall(profilePath, [], { skipParse: false });
    assert.equal(result.code, 1, `expected a syntax-error rollback, stdout: ${result.out} stderr: ${result.err}`);

    const content = fs.readFileSync(profilePath, 'utf8');
    assert.equal(content, brokenPreexisting, 'rollback should restore the exact pre-write content');
  } finally {
    fs.rmSync(path.dirname(profilePath), { recursive: true, force: true });
  }
});

test('install (bash, CLOVER_FORCE_PLATFORM=linux): fresh profile gets the managed block with <REPO> replaced by a POSIX path', () => {
  const profilePath = tmpProfilePath();
  try {
    const result = runInstall(profilePath, [], { extraEnv: { CLOVER_FORCE_PLATFORM: 'linux' } });
    assert.equal(result.code, 0, `stderr: ${result.err}`);
    assert.ok(fs.existsSync(profilePath));
    const content = fs.readFileSync(profilePath, 'utf8');
    assert.ok(content.includes('# >>> clover claude wrapper (managed; remove this block to uninstall) >>>'));
    assert.ok(content.includes('# <<< clover claude wrapper <<<'));
    assert.ok(!content.includes('<REPO>'), 'placeholder must be replaced');
    assert.match(content, /\/[^\s'"]*clover/, 'must contain a POSIX-style absolute path containing clover');
    assert.ok(!content.includes('\\clover'), 'must not contain a backslash-separated path');
  } finally {
    fs.rmSync(path.dirname(profilePath), { recursive: true, force: true });
  }
});

test('install (bash, CLOVER_FORCE_PLATFORM=linux): re-running is idempotent (single block)', () => {
  const profilePath = tmpProfilePath();
  try {
    const extraEnv = { CLOVER_FORCE_PLATFORM: 'linux' };
    const first = runInstall(profilePath, [], { extraEnv });
    assert.equal(first.code, 0, `stderr: ${first.err}`);
    const second = runInstall(profilePath, [], { extraEnv });
    assert.equal(second.code, 0, `stderr: ${second.err}`);

    const content = fs.readFileSync(profilePath, 'utf8');
    const opens = content.match(/# >>> clover claude wrapper/g) || [];
    assert.equal(opens.length, 1, `expected exactly one block, got ${opens.length}. content:\n${content}`);
  } finally {
    fs.rmSync(path.dirname(profilePath), { recursive: true, force: true });
  }
});

test('install (bash, CLOVER_FORCE_PLATFORM=linux) --uninstall: removes the managed block but preserves other existing content', () => {
  const profilePath = tmpProfilePath();
  try {
    const extraEnv = { CLOVER_FORCE_PLATFORM: 'linux' };
    const install = runInstall(profilePath, [], { extraEnv });
    assert.equal(install.code, 0, `stderr: ${install.err}`);
    fs.appendFileSync(profilePath, '\n# unrelated line\n', 'utf8');

    const result = runInstall(profilePath, ['--uninstall'], { extraEnv });
    assert.equal(result.code, 0, `stderr: ${result.err}`);

    const content = fs.readFileSync(profilePath, 'utf8');
    assert.ok(!content.includes('clover claude wrapper'), 'managed block must be gone');
    assert.ok(content.includes('# unrelated line'), 'unrelated content must survive uninstall');
  } finally {
    fs.rmSync(path.dirname(profilePath), { recursive: true, force: true });
  }
});

test('verifyProfileContent (non-win32): rejects an unreplaced <REPO> placeholder, a missing POSIX path, and reports a bash syntax error', async () => {
  const { verifyProfileContent } = await import(pathToFileURL(INSTALL_PATH));

  assert.throws(() => verifyProfileContent(
    '# >>> clover claude wrapper (managed; remove this block to uninstall) >>>\n/home/user/my-claude-base/clover and <REPO>\n# <<< clover claude wrapper <<<\n',
    '/home/user/my-claude-base',
    undefined,
    'linux',
  ), /<REPO>/);

  assert.throws(() => verifyProfileContent(
    '# >>> clover claude wrapper (managed; remove this block to uninstall) >>>\nmy-claude-base/clover\n# <<< clover claude wrapper <<<\n',
    '/home/user/my-claude-base',
    undefined,
    'linux',
  ), /絶対パス/);

  const brokenProfilePath = path.join(os.tmpdir(), `clover-install-test-bash-syntax-${crypto.randomBytes(6).toString('hex')}.sh`);
  fs.writeFileSync(brokenProfilePath, 'function unbalanced { echo "oops"\n', 'utf8');
  try {
    const envBackup = process.env.CLOVER_SKIP_PARSE;
    delete process.env.CLOVER_SKIP_PARSE;
    try {
      assert.throws(() => verifyProfileContent(
        `# >>> clover claude wrapper (managed; remove this block to uninstall) >>>\n/home/user/my-claude-base/clover\n# <<< clover claude wrapper <<<\nfunction unbalanced { echo "oops"\n`,
        '/home/user/my-claude-base',
        brokenProfilePath,
        'linux',
      ), /bash 構文チェック/);
    } finally {
      if (envBackup === undefined) delete process.env.CLOVER_SKIP_PARSE;
      else process.env.CLOVER_SKIP_PARSE = envBackup;
    }
  } finally {
    fs.rmSync(brokenProfilePath, { force: true });
  }
});

test('install (bash, CLOVER_FORCE_PLATFORM=linux): rolls back to the pre-write content when post-write verification (bash syntax check) fails', () => {
  const profilePath = tmpProfilePath();
  try {
    fs.mkdirSync(path.dirname(profilePath), { recursive: true });
    const brokenPreexisting = '# my own stuff\nfunction unbalanced { echo "oops"\n';
    fs.writeFileSync(profilePath, brokenPreexisting, 'utf8');

    const result = runInstall(profilePath, [], { skipParse: false, extraEnv: { CLOVER_FORCE_PLATFORM: 'linux' } });
    assert.equal(result.code, 1, `expected a syntax-error rollback, stdout: ${result.out} stderr: ${result.err}`);

    const content = fs.readFileSync(profilePath, 'utf8');
    assert.equal(content, brokenPreexisting, 'rollback should restore the exact pre-write content');
  } finally {
    fs.rmSync(path.dirname(profilePath), { recursive: true, force: true });
  }
});

function pathToFileURL(p) {
  return `file:///${path.resolve(p).replace(/\\/g, '/')}`;
}

// --- --auto / .no-auto-install / profile-path キャッシュ ---
// これらのテストは run/ の実ファイルを一切触らない。CLOVER_RUN_DIR で毎回使い捨てディレクトリに
// 差し替える（フラグ・キャッシュの置き場所を env で切り替えられる設計そのものの検証も兼ねる）。

function runAutoInstall(profilePath, runDir, extraEnv = {}) {
  const env = {
    ...process.env,
    CLOVER_PROFILE_PATH: profilePath,
    CLOVER_SKIP_PARSE: '1',
    CLOVER_RUN_DIR: runDir,
    ...extraEnv,
  };
  const result = spawnSync(process.execPath, [INSTALL_PATH, '--auto'], { env, encoding: 'utf8' });
  return { code: result.status, out: result.stdout, err: result.stderr };
}

test('install --auto: block already present -> does nothing (no extra write, no output)', () => {
  const profilePath = tmpProfilePath();
  const runDir = tmpRunDir();
  try {
    const first = runInstall(profilePath, [], { extraEnv: { CLOVER_RUN_DIR: runDir } });
    assert.equal(first.code, 0, `stderr: ${first.err}`);
    const before = fs.readFileSync(profilePath, 'utf8');

    const result = runAutoInstall(profilePath, runDir);
    assert.equal(result.code, 0, `stderr: ${result.err}`);
    assert.equal(result.out.trim(), '', 'no output expected when already installed');
    assert.equal(fs.readFileSync(profilePath, 'utf8'), before, 'profile must be untouched');
  } finally {
    fs.rmSync(path.dirname(profilePath), { recursive: true, force: true });
    fs.rmSync(runDir, { recursive: true, force: true });
  }
});

test('install --auto: no managed block yet -> installs it and prints exactly one line', () => {
  const profilePath = tmpProfilePath();
  const runDir = tmpRunDir();
  try {
    const result = runAutoInstall(profilePath, runDir);
    assert.equal(result.code, 0, `stderr: ${result.err}`);
    assert.match(result.out.trim(), /clover/, 'expected a one-line notice');
    assert.equal(result.out.trim().split('\n').length, 1, 'must print exactly one line');

    const content = fs.readFileSync(profilePath, 'utf8');
    assert.ok(content.includes('# >>> clover claude wrapper (managed; remove this block to uninstall) >>>'));
  } finally {
    fs.rmSync(path.dirname(profilePath), { recursive: true, force: true });
    fs.rmSync(runDir, { recursive: true, force: true });
  }
});

test('install --auto: .no-auto-install present -> does nothing, no output, no profile write', () => {
  const profilePath = tmpProfilePath();
  const runDir = tmpRunDir();
  try {
    fs.mkdirSync(runDir, { recursive: true });
    fs.writeFileSync(path.join(runDir, '.no-auto-install'), '', 'utf8');

    const result = runAutoInstall(profilePath, runDir);
    assert.equal(result.code, 0, `stderr: ${result.err}`);
    assert.equal(result.out.trim(), '', 'no output expected when opted out');
    assert.ok(!fs.existsSync(profilePath), 'profile must not be created');
  } finally {
    fs.rmSync(path.dirname(profilePath), { recursive: true, force: true });
    fs.rmSync(runDir, { recursive: true, force: true });
  }
});

test('install --uninstall: creates .no-auto-install; a plain (non --auto) install removes it again', () => {
  const profilePath = tmpProfilePath();
  const runDir = tmpRunDir();
  try {
    const install = runInstall(profilePath, [], { extraEnv: { CLOVER_RUN_DIR: runDir } });
    assert.equal(install.code, 0, `stderr: ${install.err}`);

    const uninstall = runInstall(profilePath, ['--uninstall'], { extraEnv: { CLOVER_RUN_DIR: runDir } });
    assert.equal(uninstall.code, 0, `stderr: ${uninstall.err}`);
    assert.ok(fs.existsSync(path.join(runDir, '.no-auto-install')), '.no-auto-install must be created on uninstall');

    const reinstall = runInstall(profilePath, [], { extraEnv: { CLOVER_RUN_DIR: runDir } });
    assert.equal(reinstall.code, 0, `stderr: ${reinstall.err}`);
    assert.ok(!fs.existsSync(path.join(runDir, '.no-auto-install')), 'explicit install must remove .no-auto-install');
  } finally {
    fs.rmSync(path.dirname(profilePath), { recursive: true, force: true });
    fs.rmSync(runDir, { recursive: true, force: true });
  }
});

test('install --auto: valid cached profile-path (containing the managed block) short-circuits before resolveProfilePath runs', () => {
  const profilePath = tmpProfilePath();
  const runDir = tmpRunDir();
  try {
    const install = runInstall(profilePath, [], { extraEnv: { CLOVER_RUN_DIR: runDir } });
    assert.equal(install.code, 0, `stderr: ${install.err}`);
    fs.writeFileSync(path.join(runDir, '.profile-path'), profilePath, 'utf8');
    const before = fs.readFileSync(profilePath, 'utf8');

    // Point CLOVER_PROFILE_PATH somewhere nonexistent -- if the cache branch is NOT taken first,
    // resolveProfilePath would return this bogus path and the test would fail differently.
    const bogusProfilePath = path.join(os.tmpdir(), `clover-install-test-bogus-${crypto.randomBytes(6).toString('hex')}`);
    const result = runAutoInstall(bogusProfilePath, runDir);
    assert.equal(result.code, 0, `stderr: ${result.err}`);
    assert.equal(result.out.trim(), '', 'no output expected -- cache hit must skip installing');
    assert.equal(fs.readFileSync(profilePath, 'utf8'), before, 'cached profile must be untouched');
    assert.ok(!fs.existsSync(bogusProfilePath), 'the bogus CLOVER_PROFILE_PATH target must never be written');
  } finally {
    fs.rmSync(path.dirname(profilePath), { recursive: true, force: true });
    fs.rmSync(runDir, { recursive: true, force: true });
  }
});

test('install (non --auto): writes a profile-path cache file that matches CLOVER_PROFILE_PATH', () => {
  const profilePath = tmpProfilePath();
  const runDir = tmpRunDir();
  try {
    const result = runInstall(profilePath, [], { extraEnv: { CLOVER_RUN_DIR: runDir } });
    assert.equal(result.code, 0, `stderr: ${result.err}`);
    const cachePath = path.join(runDir, '.profile-path');
    assert.ok(fs.existsSync(cachePath), 'cache file must be written');
    assert.equal(fs.readFileSync(cachePath, 'utf8').trim(), profilePath);
  } finally {
    fs.rmSync(path.dirname(profilePath), { recursive: true, force: true });
    fs.rmSync(runDir, { recursive: true, force: true });
  }
});
