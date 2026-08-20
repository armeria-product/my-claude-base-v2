import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  discoverPreviewCommand,
  probeHttp,
  runPreviewLifecycle,
  validatePreviewEvidence,
} from './preview-lifecycle.mjs';

function temporaryDirectory(prefix = 'preview-skill-') {
  return mkdtempSync(path.join(os.tmpdir(), prefix));
}

function write(directory, relative, content) {
  const filename = path.join(directory, relative);
  mkdirSync(path.dirname(filename), { recursive: true });
  writeFileSync(filename, content);
  return filename;
}

function listen(server, port) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => resolve(server.address().port));
  });
}

function close(server) {
  return new Promise((resolve) => server.close(resolve));
}

async function unusedPort() {
  const server = createServer();
  const port = await listen(server, 0);
  await close(server);
  return port;
}

function wait(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function isAlive(pid) {
  for (let attempt = 0; attempt < 30; attempt += 1) {
    try {
      process.kill(pid, 0);
      await wait(25);
    } catch (error) {
      if (error.code === 'ESRCH') return false;
      throw error;
    }
  }
  return true;
}

function browserObservation() {
  return {
    screenshot: { status: 'captured', path: 'artifacts/preview.png' },
    console: { status: 'clean', errors: [] },
    interaction: { status: 'passed', summary: 'primary control responded' },
    mockComparison: { status: 'not-applicable', differences: [] },
    verdict: 'looks-ok',
  };
}

function writeScreenshot(directory) {
  return write(directory, 'artifacts/preview.png', Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScL5eQAAAABJRU5ErkJggg==',
    'base64',
  ));
}

function writeInvalidScreenshot(directory) {
  return write(directory, 'artifacts/not-an-image.png', 'not-a-real-png-but-an-observed-artifact');
}

function serverFixture(directory) {
  return write(directory, 'server.mjs', `
    import { createServer } from 'node:http';
    const server = createServer((_request, response) => response.end('ready'));
    server.listen(Number(process.env.PORT), '127.0.0.1');
    process.on('SIGTERM', () => server.close(() => process.exit(0)));
  `);
}

test('command discovery observes AGENTS, package, Cargo, static, then none precedence without writing', () => {
  const root = temporaryDirectory();
  try {
    const target = path.join(root, 'product', 'nested');
    mkdirSync(target, { recursive: true });
    const agentsPath = write(root, 'product/AGENTS.md', '## Commands\n\n```sh\nnode server.mjs\n```\n');
    write(root, 'product/package.json', JSON.stringify({ scripts: { dev: 'vite', start: 'node app.mjs' } }));
    write(root, 'product/Cargo.toml', '[package]\nname = "fixture"\n');
    write(root, 'product/index.html', '<!doctype html>');

    const before = readFileSync(agentsPath, 'utf8');
    let result = discoverPreviewCommand(target, { workspaceRoot: root });
    assert.equal(result.kind, 'agents-commands');
    assert.equal(result.commandText, 'node server.mjs');
    assert.equal(result.persistence, 'suggest-only');
    assert.match(result.suggestedCommands, /node server\.mjs/);
    assert.equal(readFileSync(agentsPath, 'utf8'), before);

    write(root, 'product/AGENTS.md', '## Commands\n\n```sh\nnpm run dev && curl https://example.test\n```\n');
    result = discoverPreviewCommand(target, { workspaceRoot: root });
    assert.equal(result.kind, 'package-dev');

    rmSync(agentsPath);
    result = discoverPreviewCommand(target, { workspaceRoot: root });
    assert.equal(result.kind, 'package-dev');
    write(root, 'product/package.json', JSON.stringify({ scripts: { start: 'node app.mjs' } }));
    result = discoverPreviewCommand(target, { workspaceRoot: root });
    assert.equal(result.kind, 'package-start');
    rmSync(path.join(root, 'product', 'package.json'));
    result = discoverPreviewCommand(target, { workspaceRoot: root });
    assert.equal(result.kind, 'cargo');
    rmSync(path.join(root, 'product', 'Cargo.toml'));
    result = discoverPreviewCommand(target, { workspaceRoot: root });
    assert.equal(result.kind, 'static-index');
    rmSync(path.join(root, 'product', 'index.html'));
    result = discoverPreviewCommand(target, { workspaceRoot: root });
    assert.equal(result.kind, 'none');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('lifecycle gets HTTP and exits the real disposable process in finally', async () => {
  const directory = temporaryDirectory();
  try {
    const fixture = serverFixture(directory);
    writeScreenshot(directory);
    const result = await runPreviewLifecycle({
      launch: { kind: 'command', supported: true, command: process.execPath, args: [fixture] },
      cwd: directory,
      basePort: await unusedPort(),
      buildPath: 'disposable server',
      isReady: (response) => response.body === 'ready',
      observe: browserObservation,
    });
    assert.equal(result.response.statusCode, 200);
    assert.equal(result.attempts.length, 1);
    assert.equal(result.cleanup.stopped, true);
    assert.deepEqual(validatePreviewEvidence(result.evidence, { workspaceRoot: directory }), []);
    assert.equal(await isAlive(result.processPid), false);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('lifecycle retries once after an occupied port and keeps the attempt bound', async () => {

test('static previews require a loopback host and do not serve symlink escapes', async (t) => {
  const directory = temporaryDirectory();
  try {
    const staticRoot = path.join(directory, 'static');
    const outside = path.join(directory, 'outside');
    mkdirSync(staticRoot, { recursive: true });
    mkdirSync(outside, { recursive: true });
    writeFileSync(path.join(staticRoot, 'index.html'), '<!doctype html><p>safe</p>', 'utf8');
    writeFileSync(path.join(outside, 'secret.txt'), 'not-for-preview', 'utf8');
    try {
      symlinkSync(outside, path.join(staticRoot, 'linked'), process.platform === 'win32' ? 'junction' : 'dir');
    } catch (error) {
      t.skip('the current host cannot create a disposable directory link: ' + error.code);
      return;
    }

    await assert.rejects(
      runPreviewLifecycle({
        launch: { kind: 'static', supported: true, rootDirectory: staticRoot },
        cwd: directory,
        host: '0.0.0.0',
        basePort: await unusedPort(),
      }),
      /loopback host/i,
    );

    const result = await runPreviewLifecycle({
      launch: { kind: 'static', supported: true, rootDirectory: staticRoot },
      cwd: directory,
      basePort: await unusedPort(),
      observe: async ({ url }) => {
        await assert.rejects(probeHttp(new URL('/linked/secret.txt', url)), /HTTP probe returned 404/);
        return null;
      },
    });
    assert.equal(result.response.statusCode, 200);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('evidence requires loopback URLs and real in-scope screenshots, but accepts explicit unverified reports', () => {
  const directory = temporaryDirectory();
  try {
    const unverified = {
      url: 'http://127.0.0.1:4173/',
      buildPath: 'fixture',
      screenshot: { status: 'not-captured', reason: 'browser unavailable' },
      console: { status: 'not-checked', errors: [] },
      interaction: { status: 'not-run', summary: 'browser unavailable' },
      mockComparison: { status: 'not-compared', differences: [] },
      verdict: 'unverified',
    };
    assert.deepEqual(validatePreviewEvidence(unverified, { workspaceRoot: directory }), []);
    assert.match(validatePreviewEvidence({ ...unverified, url: 'https://example.test/' }, { workspaceRoot: directory }).join('\n'), /loopback/i);
    assert.match(validatePreviewEvidence({ ...unverified, verdict: 'looks-ok' }, { workspaceRoot: directory }).join('\n'), /unverified/i);

    const captured = {
      ...unverified,
      screenshot: { status: 'captured', path: 'artifacts/preview.png' },
      console: { status: 'clean', errors: [] },
      interaction: { status: 'passed', summary: 'primary control responded' },
      mockComparison: { status: 'not-applicable', differences: [] },
      verdict: 'looks-ok',
    };
    assert.match(validatePreviewEvidence(captured, { workspaceRoot: directory }).join('\n'), /existing in-scope screenshot/i);
    writeScreenshot(directory);
    assert.deepEqual(validatePreviewEvidence(captured, { workspaceRoot: directory }), []);
    assert.match(validatePreviewEvidence({ ...captured, screenshot: { status: 'captured', path: '../outside.png' } }, { workspaceRoot: directory }).join('\n'), /existing in-scope screenshot/i);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
  const directory = temporaryDirectory();
  const blocker = createServer((_request, response) => response.end('blocked'));
  try {
    const occupiedPort = await listen(blocker, 0);
    const fixture = serverFixture(directory);
    writeScreenshot(directory);
    const result = await runPreviewLifecycle({
      launch: { kind: 'command', supported: true, command: process.execPath, args: [fixture] },
      cwd: directory,
      basePort: occupiedPort,
      maxAttempts: 99,
      buildPath: 'disposable server',
      isReady: (response) => response.body === 'ready',
      observe: browserObservation,
    });
    assert.equal(result.attempts.length, 2);
    assert.equal(result.attempts[0].status, 'failed');
    assert.equal(result.attempts[1].status, 'ready');
    assert.equal(result.port, occupiedPort + 1);
    assert.equal(result.cleanup.stopped, true);
  } finally {
    await close(blocker);
    rmSync(directory, { recursive: true, force: true });
  }
});

test('lifecycle cleanup still runs when browser observation throws', async () => {
  const directory = temporaryDirectory();
  let spawnedPid = null;
  try {
    const fixture = serverFixture(directory);
    await assert.rejects(
      runPreviewLifecycle({
        launch: { kind: 'command', supported: true, command: process.execPath, args: [fixture] },
        cwd: directory,
        basePort: await unusedPort(),
        maxAttempts: 1,
        onSpawn: (handle) => { spawnedPid = handle.child?.pid ?? null; },
        observe: async () => { throw new Error('browser observation failed'); },
      }),
      /preview did not become ready/,
    );
    assert.ok(spawnedPid);
    assert.equal(await isAlive(spawnedPid), false);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('skill uses a hub-reachable lifecycle helper path', () => {
  const skill = readFileSync(new URL('../SKILL.md', import.meta.url), 'utf8');
  const helper = readFileSync(new URL('./preview-lifecycle.mjs', import.meta.url), 'utf8');
  assert.match(skill, /\.agents\/skills\/preview\/scripts\/preview-lifecycle\.mjs/);
  assert.match(helper, /export async function runPreviewLifecycle/);
});

test('evidence binds captured image bytes and a report URL to lifecycle or explicit contract', () => {
  const directory = temporaryDirectory();
  try {
    writeInvalidScreenshot(directory);
    const evidence = {
      url: 'http://127.0.0.1:4173/',
      buildPath: 'fixture',
      screenshot: { status: 'captured', path: 'artifacts/not-an-image.png' },
      console: { status: 'clean', errors: [] },
      interaction: { status: 'passed', summary: 'primary control responded' },
      mockComparison: { status: 'not-applicable', differences: [] },
      verdict: 'looks-ok',
    };
    assert.match(validatePreviewEvidence(evidence, { workspaceRoot: directory }).join('\n'), /image artifact/i);

    writeScreenshot(directory);
    const captured = { ...evidence, screenshot: { status: 'captured', path: 'artifacts/preview.png' } };
    assert.match(
      validatePreviewEvidence(captured, {
        workspaceRoot: directory,
        observedUrl: 'http://127.0.0.1:4180/',
      }).join('\n'),
      /observed lifecycle URL/i,
    );
    assert.deepEqual(validatePreviewEvidence(captured, {
      workspaceRoot: directory,
      observedUrl: 'http://127.0.0.1:4180/',
      expectedUrl: captured.url,
    }), []);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('static previews reject a root whose real path escapes the declared workspace', async () => {
  const directory = temporaryDirectory();
  try {
    const workspace = path.join(directory, 'workspace');
    const outside = path.join(directory, 'outside');
    mkdirSync(workspace, { recursive: true });
    mkdirSync(outside, { recursive: true });
    writeFileSync(path.join(outside, 'index.html'), '<!doctype html><p>outside</p>', 'utf8');
    await assert.rejects(
      runPreviewLifecycle({
        launch: { kind: 'static', supported: true, rootDirectory: outside },
        cwd: workspace,
        workspaceRoot: workspace,
        basePort: await unusedPort(),
        maxAttempts: 1,
      }),
      /static preview root must stay inside workspace/i,
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
