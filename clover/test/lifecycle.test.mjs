import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn, spawnSync } from 'node:child_process';

if (process.env.RELAY_ROUTER_NO_LISTEN !== '1') {
  throw new Error('lifecycle.test.mjs must be run with RELAY_ROUTER_NO_LISTEN=1 to avoid binding a real port on import');
}

const { sessionsDir, sweepSessions, hasLiveSessions } = await import('../src/lifecycle.mjs');

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROUTER_PATH = path.join(__dirname, '..', 'src', 'router.mjs');

function mkTmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'clover-sessions-'));
}

// --- sweepSessions unit tests ---

test('sweepSessions: dead PID file is removed, returns 0', (t) => {
  const dir = mkTmpDir();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const prev = process.env.RELAY_SESSIONS_DIR;
  process.env.RELAY_SESSIONS_DIR = dir;
  t.after(() => { process.env.RELAY_SESSIONS_DIR = prev; });

  fs.writeFileSync(path.join(dir, 'dead'), '999999999');
  assert.equal(sweepSessions(), 0);
  assert.equal(fs.existsSync(path.join(dir, 'dead')), false, 'dead PID file should be deleted');
});

test('sweepSessions: own PID file is kept, returns 1', (t) => {
  const dir = mkTmpDir();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const prev = process.env.RELAY_SESSIONS_DIR;
  process.env.RELAY_SESSIONS_DIR = dir;
  t.after(() => { process.env.RELAY_SESSIONS_DIR = prev; });

  fs.writeFileSync(path.join(dir, 'self'), String(process.pid));
  assert.equal(sweepSessions(), 1);
  assert.equal(fs.existsSync(path.join(dir, 'self')), true, 'live PID file should remain');
  assert.equal(hasLiveSessions(), true);
});

test('sweepSessions: empty or non-existent directory returns 0', (t) => {
  const dir = mkTmpDir();
  fs.rmSync(dir, { recursive: true, force: true });
  const prev = process.env.RELAY_SESSIONS_DIR;
  process.env.RELAY_SESSIONS_DIR = dir;
  t.after(() => { process.env.RELAY_SESSIONS_DIR = prev; });

  assert.equal(sweepSessions(), 0, 'non-existent dir');
  assert.equal(hasLiveSessions(), false);

  fs.mkdirSync(dir, { recursive: true });
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  assert.equal(sweepSessions(), 0, 'empty dir');
});

test('sessionsDir: defaults to <clover>/run/sessions when env not set', (t) => {
  const prev = process.env.RELAY_SESSIONS_DIR;
  delete process.env.RELAY_SESSIONS_DIR;
  t.after(() => { if (prev !== undefined) process.env.RELAY_SESSIONS_DIR = prev; });
  const dir = sessionsDir();
  assert.ok(dir.endsWith(path.join('clover', 'run', 'sessions')), `got: ${dir}`);
});

// --- router integration: idle timer + registry sweep ---

function randPort() {
  return 18800 + Math.floor(Math.random() * 5000);
}

function waitForPort(port, tries = 20) {
  return new Promise((resolve, reject) => {
    let attempt = 0;
    const tryOnce = () => {
      const req = http.request({ host: '127.0.0.1', port, method: 'GET', path: '/', timeout: 300 }, (res) => {
        res.resume();
        resolve();
      });
      req.on('error', () => {
        attempt++;
        if (attempt >= tries) reject(new Error('router did not come up in time'));
        else setTimeout(tryOnce, 150);
      });
      req.on('timeout', () => { req.destroy(); });
      req.end();
    };
    tryOnce();
  });
}

function httpRequest(port, options, bodyStr) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, ...options }, (res) => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('error', reject);
    if (bodyStr != null) req.write(bodyStr);
    req.end();
  });
}

function isPortUp(port) {
  return new Promise((resolve) => {
    const req = http.request({ host: '127.0.0.1', port, method: 'GET', path: '/', timeout: 300 }, (res) => {
      res.resume();
      resolve(true);
    });
    req.on('error', () => resolve(false));
    req.on('timeout', () => { req.destroy(); resolve(false); });
    req.end();
  });
}

function spawnRouter(env) {
  return spawn(process.execPath, [ROUTER_PATH], { env, stdio: ['ignore', 'ignore', 'ignore'] });
}

test('router idle timer: re-arms while a live session is registered, then exits once the registry is empty', async (t) => {
  const port = randPort();
  const dir = mkTmpDir();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

  fs.writeFileSync(path.join(dir, 'live'), String(process.pid));

  const childEnv = { ...process.env, PORT: String(port), RELAY_IDLE_MS: '100', RELAY_SESSIONS_DIR: dir };
  delete childEnv.RELAY_ROUTER_NO_LISTEN;
  const child = spawnRouter(childEnv);
  t.after(() => { child.kill(); });

  await waitForPort(port);

  await new Promise((r) => setTimeout(r, 400));
  assert.equal(await isPortUp(port), true, 'router must stay up while a live session is registered');

  fs.rmSync(path.join(dir, 'live'), { force: true });

  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('router did not exit after registry emptied')), 4000);
    child.on('exit', () => { clearTimeout(timer); resolve(); });
  });
});

// --- /__clover/shutdown endpoint ---

test('POST /__clover/shutdown: 403 when RELAY_IDLE_MS is unset (idle reaper disabled)', async (t) => {
  const port = randPort();
  const childEnv = { ...process.env, PORT: String(port) };
  delete childEnv.RELAY_ROUTER_NO_LISTEN;
  delete childEnv.RELAY_IDLE_MS;
  const child = spawnRouter(childEnv);
  t.after(() => { child.kill(); });
  await waitForPort(port);

  const resp = await httpRequest(port, { method: 'POST', path: '/__clover/shutdown' });
  assert.equal(resp.status, 403);
});

test('POST /__clover/shutdown: 409 when a live session is still registered', async (t) => {
  const port = randPort();
  const dir = mkTmpDir();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.writeFileSync(path.join(dir, 'live'), String(process.pid));

  const childEnv = { ...process.env, PORT: String(port), RELAY_IDLE_MS: '600000', RELAY_SESSIONS_DIR: dir };
  delete childEnv.RELAY_ROUTER_NO_LISTEN;
  const child = spawnRouter(childEnv);
  t.after(() => { child.kill(); });
  await waitForPort(port);

  const resp = await httpRequest(port, { method: 'POST', path: '/__clover/shutdown' });
  assert.equal(resp.status, 409);
  assert.equal(await isPortUp(port), true, 'router must remain up after a 409');
});

test('POST /__clover/shutdown: 200 and process exits when the registry is empty', async (t) => {
  const port = randPort();
  const dir = mkTmpDir();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

  const childEnv = { ...process.env, PORT: String(port), RELAY_IDLE_MS: '600000', RELAY_SESSIONS_DIR: dir };
  delete childEnv.RELAY_ROUTER_NO_LISTEN;
  const child = spawnRouter(childEnv);
  t.after(() => { child.kill(); });
  await waitForPort(port);

  const resp = await httpRequest(port, { method: 'POST', path: '/__clover/shutdown' });
  assert.equal(resp.status, 200);
  const json = JSON.parse(resp.body);
  assert.equal(json.ok, true);

  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('router did not exit after shutdown request')), 4000);
    child.on('exit', () => { clearTimeout(timer); resolve(); });
  });
});

// --- clover-launch.mjs: registry registration + CLOVER_SESSION_FILE output ---

const LAUNCH_PATH = path.join(__dirname, '..', 'bin', 'clover-launch.mjs');

function runLaunch(env) {
  return new Promise((resolve, reject) => {
    const childEnv = { ...process.env, ...env };
    delete childEnv.RELAY_ROUTER_NO_LISTEN;
    delete childEnv.RELAY_SHIM_NO_LISTEN;
    const child = spawn(process.execPath, [LAUNCH_PATH], {
      env: childEnv,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    let err = '';
    child.stdout.on('data', (c) => { out += c; });
    child.stderr.on('data', (c) => { err += c; });
    child.on('error', reject);
    child.on('exit', (code) => resolve({ code, out, err: err.trim() }));
  });
}

function isNodePid(pid) {
  return new Promise((resolve) => {
    if (process.platform === 'win32') {
      const tasklist = spawn('tasklist', ['/FI', `PID eq ${pid}`, '/FO', 'CSV', '/NH'], { stdio: ['ignore', 'pipe', 'ignore'] });
      let out = '';
      tasklist.stdout.on('data', (c) => { out += c; });
      tasklist.on('exit', () => resolve(/^"node\.exe"/i.test(out.trim())));
      tasklist.on('error', () => resolve(false));
    } else {
      const ps = spawn('ps', ['-o', 'comm=', '-p', String(pid)], { stdio: ['ignore', 'pipe', 'ignore'] });
      let out = '';
      ps.stdout.on('data', (c) => { out += c; });
      ps.on('exit', () => resolve(/node$/.test(out.trim())));
      ps.on('error', () => resolve(false));
    }
  });
}

async function killPortHolder(port) {
  if (process.platform === 'win32') {
    const pids = await new Promise((resolve) => {
      const netstat = spawn('cmd', ['/c', `netstat -ano | findstr :${port}`], { stdio: ['ignore', 'pipe', 'ignore'] });
      let out = '';
      netstat.stdout.on('data', (c) => { out += c; });
      netstat.on('exit', () => {
        const found = new Set();
        for (const line of out.split('\n')) {
          const m = line.match(/LISTENING\s+(\d+)/);
          if (m) found.add(m[1]);
        }
        resolve([...found]);
      });
    });
    for (const pid of pids) {
      if (await isNodePid(pid)) {
        await new Promise((resolve) => {
          const tk = spawn('taskkill', ['/PID', pid, '/F'], { stdio: 'ignore' });
          tk.on('exit', resolve);
        });
      }
    }
  } else {
    const pids = await new Promise((resolve) => {
      const lsof = spawn('lsof', ['-ti', `:${port}`], { stdio: ['ignore', 'pipe', 'ignore'] });
      let out = '';
      lsof.stdout.on('data', (c) => { out += c; });
      lsof.on('exit', () => resolve(out.split('\n').map(s => s.trim()).filter(Boolean)));
    });
    for (const pid of pids) {
      if (await isNodePid(pid)) { try { process.kill(Number(pid), 'SIGKILL'); } catch {} }
    }
  }
}

function randPortLaunch() {
  return 18800 + Math.floor(Math.random() * 5000);
}

test('clover-launch: registers a session file and prints CLOVER_SESSION_FILE, dead registrations are swept', async () => {
  const shimPort = randPortLaunch();
  const routerPort = randPortLaunch();
  const dir = mkTmpDir();

  fs.writeFileSync(path.join(dir, 'dead-leftover'), '999999999');

  try {
    const result = await runLaunch({ SHIM_PORT: String(shimPort), ROUTER_PORT: String(routerPort), RELAY_SESSIONS_DIR: dir });

    assert.equal(result.code, 0, `should exit 0, stderr: ${result.err}`);
    const lines = result.out.split('\n').filter(Boolean);
    const env = Object.fromEntries(lines.map(l => { const i = l.indexOf('='); return [l.slice(0, i), l.slice(i + 1)]; }));

    assert.ok(env.CLOVER_SESSION_FILE, `expected CLOVER_SESSION_FILE line, got: ${JSON.stringify(result.out)}`);
    assert.equal(fs.existsSync(env.CLOVER_SESSION_FILE), true, 'session file should exist on disk');
    assert.equal(fs.readFileSync(env.CLOVER_SESSION_FILE, 'utf8'), String(process.pid), 'session file should hold this test process ppid (launcher\'s parent)');

    assert.equal(fs.existsSync(path.join(dir, 'dead-leftover')), false, 'dead leftover registration should have been swept by the launcher');
  } finally {
    await killPortHolder(routerPort);
    await killPortHolder(shimPort);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
