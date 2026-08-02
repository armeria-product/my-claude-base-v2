import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';

// clover-launch.mjs starts the relay (router/shim) and prints KEY=VALUE env lines to stdout if
// reachable (ANTHROPIC_BASE_URL + discovery + the custom /model picker entry), or nothing if not
// — it never spawns claude itself (claude is started natively by the calling shell's `claude`
// function). These tests use alternate ports so real 8788/8791 relays (if running) are never touched.

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const LAUNCH_PATH = path.join(__dirname, '..', 'bin', 'clover-launch.mjs');

function randPort() {
  return 18800 + Math.floor(Math.random() * 5000);
}

function runLaunch(env) {
  return new Promise((resolve, reject) => {
    // clover-launch.mjs forwards process.env to the router/shim children it spawns, so this
    // suite's own RELAY_ROUTER_NO_LISTEN/RELAY_SHIM_NO_LISTEN (set by the standard test
    // invocation to keep *this* process from binding a port on import) must not leak into
    // those children, or the relay it starts would never actually listen.
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
    // Guard against killing an unrelated service that happened to be given the same random
    // port: only kill PIDs whose image/command name is actually node(.exe), which is all
    // clover-launch.mjs ever spawns (router.mjs / codex-responses-shim.mjs children).
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
  // Best-effort: find and kill whatever is LISTENing on `port` (relay child spawned detached
  // by clover-launch.mjs, which this test does not otherwise have a handle to).
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

test('clover-launch: brings up the relay and prints the env KEY=VALUE lines the shell applies', async () => {
  const shimPort = randPort();
  const routerPort = randPort();

  const result = await runLaunch({ SHIM_PORT: String(shimPort), ROUTER_PORT: String(routerPort) });

  try {
    assert.equal(result.code, 0, `should exit 0, stderr: ${result.err}`);
    const lines = result.out.split('\n').filter(Boolean);
    const env = Object.fromEntries(lines.map(l => { const i = l.indexOf('='); return [l.slice(0, i), l.slice(i + 1)]; }));
    assert.equal(env.ANTHROPIC_BASE_URL, `http://127.0.0.1:${routerPort}`, `base url line, got: ${JSON.stringify(result.out)} / stderr: ${result.err}`);
    // gateway discovery never fires under subscription auth (verified), so the launcher must not
    // claim it does: no CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY / CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC lines.
    assert.equal(env.CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY, undefined, `must not claim discovery works, got: ${JSON.stringify(result.out)}`);
    assert.equal(env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC, undefined, `must not emit the now-pointless traffic override, got: ${JSON.stringify(result.out)}`);
    // the custom /model picker entry is derived from models.json's first model
    assert.ok(env.ANTHROPIC_CUSTOM_MODEL_OPTION?.startsWith('claude-'), `custom model id, got: ${JSON.stringify(env.ANTHROPIC_CUSTOM_MODEL_OPTION)}`);
    assert.ok(env.ANTHROPIC_CUSTOM_MODEL_OPTION_NAME?.endsWith('(clover)'), `custom model name, got: ${JSON.stringify(env.ANTHROPIC_CUSTOM_MODEL_OPTION_NAME)}`);
  } finally {
    await killPortHolder(routerPort);
    await killPortHolder(shimPort);
  }
});

test('clover-launch: falls back cleanly when the router port cannot be bound (stdout empty)', async () => {
  const shimPort = randPort();
  const routerPort = randPort();

  // Occupy routerPort with a dummy server that never answers 200 on GET / (so ping() sees it as
  // down) yet holds the port (so the real router.mjs spawn fails with EADDRINUSE) — this
  // reproduces "router unreachable/cannot start" without needing to kill a real relay.
  const blocker = http.createServer((_req, res) => { res.writeHead(500); res.end(); });
  await new Promise((resolve, reject) => {
    blocker.listen(routerPort, '127.0.0.1', resolve);
    blocker.on('error', reject);
  });

  try {
    const result = await runLaunch({ SHIM_PORT: String(shimPort), ROUTER_PORT: String(routerPort) });

    assert.equal(result.code, 0, `should still exit 0 (fallback, not crash), stderr: ${result.err}`);
    assert.equal(result.out, '', `stdout must be empty on fallback, got: ${JSON.stringify(result.out)} / stderr: ${result.err}`);
    assert.match(result.err, /中継を起動できませんでした/);
  } finally {
    await new Promise((resolve) => blocker.close(resolve));
    await killPortHolder(shimPort);
  }
});

test('clover-launch: a look-alike server on the router port that is not the real clover router is treated as down (identity check)', async () => {
  const shimPort = randPort();
  const routerPort = randPort();

  // Answers 200 on GET / (would pass a naive health check) but is not the real router: /v1/models
  // returns a shape with no x_clover_relay marker. pingRouter() must reject it, so ensureUp() falls
  // back instead of routing the whole session into this decoy.
  const decoy = http.createServer((req, res) => {
    if (req.url === '/v1/models') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ data: [{ type: 'model', id: 'not-a-clover-model' }] }));
      return;
    }
    res.writeHead(200);
    res.end();
  });
  await new Promise((resolve, reject) => {
    decoy.listen(routerPort, '127.0.0.1', resolve);
    decoy.on('error', reject);
  });

  try {
    const result = await runLaunch({ SHIM_PORT: String(shimPort), ROUTER_PORT: String(routerPort) });

    assert.equal(result.code, 0, `should still exit 0 (fallback, not crash), stderr: ${result.err}`);
    assert.equal(result.out, '', `decoy server must not be treated as the real router, got stdout: ${JSON.stringify(result.out)} / stderr: ${result.err}`);
  } finally {
    await new Promise((resolve) => decoy.close(resolve));
    await killPortHolder(shimPort);
  }
});

test('clover-launch: real Anthropic-shaped /v1/models (id starts with claude-, no x_clover_relay marker) is treated as down, not routed', async () => {
  const shimPort = randPort();
  const routerPort = randPort();

  // Since DIRECT_MODEL_PREFIX is now 'claude-', the real Anthropic API's own /v1/models response
  // (ids like "claude-opus-4-1-20250805") is id-shape-indistinguishable from a clover router
  // response. Only the x_clover_relay marker (absent here, as on the real API) tells them apart.
  // If pingRouter regressed to an id-prefix check, this decoy would be mistaken for the real
  // router and ANTHROPIC_BASE_URL would be pointed at it, taking down the whole main session.
  const decoy = http.createServer((req, res) => {
    if (req.url === '/v1/models') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({
        data: [
          { type: 'model', id: 'claude-opus-4-1-20250805', display_name: 'Claude Opus 4.1' },
          { type: 'model', id: 'claude-sonnet-5-20250929', display_name: 'Claude Sonnet 5' },
        ],
        has_more: false,
        first_id: 'claude-opus-4-1-20250805',
        last_id: 'claude-sonnet-5-20250929',
      }));
      return;
    }
    res.writeHead(200);
    res.end();
  });
  await new Promise((resolve, reject) => {
    decoy.listen(routerPort, '127.0.0.1', resolve);
    decoy.on('error', reject);
  });

  try {
    const result = await runLaunch({ SHIM_PORT: String(shimPort), ROUTER_PORT: String(routerPort) });

    assert.equal(result.code, 0, `should still exit 0 (fallback, not crash), stderr: ${result.err}`);
    assert.equal(result.out, '', `real-Anthropic-shaped decoy must not be treated as the clover router, got stdout: ${JSON.stringify(result.out)} / stderr: ${result.err}`);
  } finally {
    await new Promise((resolve) => decoy.close(resolve));
    await killPortHolder(shimPort);
  }
});
