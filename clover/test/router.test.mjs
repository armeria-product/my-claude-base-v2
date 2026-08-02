import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

if (process.env.RELAY_ROUTER_NO_LISTEN !== '1') {
  throw new Error('router.test.mjs must be run with RELAY_ROUTER_NO_LISTEN=1 to avoid binding a real port on import (the live-server test below spawns its own child process)');
}

const { resolveDirectModel, buildModelsListResponse, buildModelsMap, sanitizeMarkedBody } = await import('../src/router.mjs');

function fakeModelsMap() {
  const map = new Map();
  map.set('gpt-5-5', { model: 'gpt-5.5', base_url: 'http://127.0.0.1:1', api_key: 'k', format: 'openai', via: 'codex', effort: 'high', verbosity: 'medium' });
  map.set('gpt-5.4-mini', { model: 'gpt-5.4-mini', base_url: 'http://127.0.0.1:1', api_key: 'k', format: 'openai', via: 'codex', effort: 'medium', verbosity: 'medium' });
  return map;
}

test('resolveDirectModel: claude-<alias> prefix resolves case-insensitively', () => {
  const map = fakeModelsMap();
  assert.equal(resolveDirectModel('claude-gpt-5-5', map), 'gpt-5-5');
  assert.equal(resolveDirectModel('Claude-GPT-5-5', map), 'gpt-5-5');
});

test('resolveDirectModel: claude-<alias> prefix round-trips a dotted alias', () => {
  const map = fakeModelsMap();
  assert.equal(resolveDirectModel('claude-gpt-5.4-mini', map), 'gpt-5.4-mini');
});

test('resolveDirectModel: bare alias match', () => {
  const map = fakeModelsMap();
  assert.equal(resolveDirectModel('gpt-5.4-mini', map), 'gpt-5.4-mini');
  assert.equal(resolveDirectModel('GPT-5.4-MINI', map), 'gpt-5.4-mini');
});

test('resolveDirectModel: matches by entry.model name', () => {
  const map = fakeModelsMap();
  assert.equal(resolveDirectModel('gpt-5.5', map), 'gpt-5-5');
  assert.equal(resolveDirectModel('GPT-5.5', map), 'gpt-5-5');
});

test('resolveDirectModel: real Claude/Anthropic model names never mis-route (fall through to null = passthrough)', () => {
  const map = fakeModelsMap();
  // With DIRECT_MODEL_PREFIX = 'claude-', these also enter the prefix-strip branch, but the
  // stripped remainder ("opus-4-8" etc.) matches no models.json alias, so they still resolve to
  // null (passthrough) rather than being mis-routed to an external model.
  assert.equal(resolveDirectModel('claude-opus-4-8', map), null);
  assert.equal(resolveDirectModel('claude-sonnet-5', map), null);
  assert.equal(resolveDirectModel('claude-sonnet-4-5', map), null);
  assert.equal(resolveDirectModel('anthropic/claude-3-haiku', map), null);
});

test('resolveDirectModel: a claude-/anthropic-named alias or model in models.json is never bare-matched (only the claude- prefix path can reach it)', () => {
  const map = fakeModelsMap();
  map.set('claude-like-alias', { model: 'claude-shaped-model', base_url: 'http://127.0.0.1:1', api_key: 'k', format: 'openai' });
  map.set('anthropic-like-alias', { model: 'anthropic-shaped-model', base_url: 'http://127.0.0.1:1', api_key: 'k', format: 'openai' });

  assert.equal(resolveDirectModel('claude-like-alias', map), null, 'stripped remainder "like-alias" matches no real alias');
  assert.equal(resolveDirectModel('anthropic-like-alias', map), null, 'bare alias starting with anthropic must not resolve');
  assert.equal(resolveDirectModel('claude-shaped-model', map), null, 'stripped remainder "shaped-model" matches no real alias');
  assert.equal(resolveDirectModel('anthropic-shaped-model', map), null, 'model-name match starting with anthropic must not resolve');

  assert.equal(resolveDirectModel('claude-claude-like-alias', map), 'claude-like-alias', 'the claude-<alias> prefix path resolves when the stripped remainder matches a real alias');
});

test('resolveDirectModel: unknown claude-<alias> resolves to null', () => {
  const map = fakeModelsMap();
  assert.equal(resolveDirectModel('claude-does-not-exist', map), null);
});

test('buildModelsMap: aliases starting with a real Claude model family name are skipped (hijack guard)', () => {
  const cfg = {
    models: [
      { alias: 'gpt-5-5', model: 'gpt-5.5', format: 'openai', via: 'codex' },
      { alias: 'opus-4-8', model: 'some-model', format: 'openai', via: 'codex' },
      { alias: 'Sonnet-Foo', model: 'another-model', format: 'openai', via: 'codex' },
      { alias: 'haiku9000', model: 'x', format: 'openai', via: 'codex' },
      { alias: 'fable-x', model: 'y', format: 'openai', via: 'codex' },
    ],
  };
  const map = buildModelsMap(cfg);

  assert.equal(map.size, 1, 'only the safe alias should be loaded');
  assert.equal(map.has('gpt-5-5'), true);
  assert.equal(map.has('opus-4-8'), false, 'alias "opus-4-8" would produce id claude-opus-4-8, hijacking the real Claude Opus model');
  assert.equal(map.has('Sonnet-Foo'), false, 'case-insensitive: "Sonnet-Foo" also starts with the dangerous prefix "sonnet"');
  assert.equal(map.has('haiku9000'), false);
  assert.equal(map.has('fable-x'), false);

  assert.equal(resolveDirectModel('claude-opus-4-8', map), null, 'a skipped alias never entered the map, so it cannot resolve even via the claude-<alias> path');
});

test('resolveDirectModel: non-string / empty model field resolves to null', () => {
  const map = fakeModelsMap();
  assert.equal(resolveDirectModel(undefined, map), null);
  assert.equal(resolveDirectModel(null, map), null);
  assert.equal(resolveDirectModel('', map), null);
  assert.equal(resolveDirectModel('   ', map), null);
});

test('buildModelsListResponse: shape, id prefix, display_name, x_clover_relay marker', () => {
  const map = fakeModelsMap();
  const resp = buildModelsListResponse(map);
  assert.equal(resp.x_clover_relay, true, 'top-level identity marker for pingRouter must be present');
  assert.equal(resp.has_more, false);
  assert.equal(resp.data.length, 2);
  for (const entry of resp.data) {
    assert.equal(entry.type, 'model');
    assert.ok(entry.id.startsWith('claude-'), `id should start with claude-: ${entry.id}`);
    assert.ok(entry.display_name.endsWith('(clover)'), `display_name should end with (clover): ${entry.display_name}`);
  }
  assert.equal(resp.data[0].id, 'claude-gpt-5-5');
  assert.equal(resp.data[0].display_name, 'gpt-5.5 (clover)');
  assert.equal(resp.first_id, resp.data[0].id);
  assert.equal(resp.last_id, resp.data[resp.data.length - 1].id);
});

test('buildModelsListResponse: empty map yields empty data with null first/last id (marker still present)', () => {
  const resp = buildModelsListResponse(new Map());
  assert.equal(resp.x_clover_relay, true);
  assert.deepEqual(resp.data, []);
  assert.equal(resp.first_id, null);
  assert.equal(resp.last_id, null);
});

test('sanitizeMarkedBody: noise is stripped BEFORE the marker line is removed — a system-reminder block above the marker must not mask it', () => {
  const body = {
    messages: [{
      role: 'user',
      content: '<system-reminder>injected context</system-reminder>\n\nRELAY-MODEL: gpt-5-5\nactual worker prompt',
    }],
  };
  const removed = sanitizeMarkedBody(body, true);

  assert.ok(removed > 0, 'noise characters must be counted as removed');
  assert.ok(!body.messages[0].content.includes('<system-reminder>'), 'reminder block must be stripped');
  assert.ok(!body.messages[0].content.includes('RELAY-MODEL'), 'marker line must be removed even when noise preceded it (fails if removal runs before stripping)');
  assert.ok(body.messages[0].content.includes('actual worker prompt'), 'the real prompt must survive');
});

test('sanitizeMarkedBody: aliasFromPrompt=false strips noise but leaves user content lines alone', () => {
  const body = {
    system: '<system-reminder>sys noise</system-reminder>\nworker instructions',
    messages: [{ role: 'user', content: 'RELAY-MODEL: gpt-5-5 mentioned mid-text stays\nhello' }],
  };
  sanitizeMarkedBody(body, false);

  assert.ok(!body.system.includes('<system-reminder>'));
  assert.ok(body.messages[0].content.includes('RELAY-MODEL'), 'without aliasFromPrompt no marker-line removal happens');
});

// --- live server tests: GET /v1/models and the count_tokens guard ---
// These start the real router process as a child so upstream fetch is never exercised
// for the passthrough (marker/model-less) case, and never reached for the guarded paths.

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROUTER_PATH = path.join(__dirname, '..', 'src', 'router.mjs');

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

const { spawn } = await import('node:child_process');
const { readFileSync } = await import('node:fs');

// The live tests exercise routing with REAL aliases from models.json (hardcoding an alias
// silently falls through to passthrough when the model generation rotates — that drift
// actually happened with the retired gpt-5-5 era). Requires >= 2 codex-via entries.
const LIVE_MODELS = JSON.parse(
  readFileSync(new URL('../models.json', import.meta.url), 'utf8')
).models.filter((m) => (m.via || 'codex') === 'codex');
const LIVE_ALIAS = LIVE_MODELS[0]?.alias;
const LIVE_ALIAS_2 = LIVE_MODELS[1]?.alias || LIVE_ALIAS;
const LIVE_MODEL_2 = LIVE_MODELS[1]?.model || LIVE_MODELS[0]?.model;

function spawnRouter(env) {
  return spawn(process.execPath, [ROUTER_PATH], { env, stdio: ['ignore', 'ignore', 'ignore'] });
}

test('GET /v1/models and the /v1/messages/count_tokens guard against a live router', async (t) => {
  const port = 18800 + Math.floor(Math.random() * 500);
  const childEnv = { ...process.env, PORT: String(port) };
  delete childEnv.RELAY_ROUTER_NO_LISTEN;
  const child = spawnRouter(childEnv);

  t.after(() => { child.kill(); });

  await waitForPort(port);

  const modelsResp = await httpRequest(port, { method: 'GET', path: '/v1/models' });
  assert.equal(modelsResp.status, 200);
  const modelsJson = JSON.parse(modelsResp.body);
  assert.equal(modelsJson.x_clover_relay, true, 'live router response must carry the identity marker pingRouter checks');
  assert.ok(Array.isArray(modelsJson.data));
  assert.ok(modelsJson.data.every(e => e.id.startsWith('claude-')));

  assert.ok(
    modelsJson.data.some(e => e.id === `claude-${LIVE_ALIAS}`),
    `expected the live router to expose claude-${LIVE_ALIAS} (first codex alias in models.json — the count_tokens guard below depends on a real alias so it never falls through to passthrough and hits real network)`,
  );

  const otherGet = await httpRequest(port, { method: 'GET', path: '/some/other/path' });
  assert.equal(otherGet.status, 200);
  assert.equal(otherGet.body, '');

  const bodyStr = JSON.stringify({ model: `claude-${LIVE_ALIAS}`, messages: [{ role: 'user', content: 'hi' }] });
  const countResp = await httpRequest(port, {
    method: 'POST',
    path: '/v1/messages/count_tokens',
    headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(bodyStr) },
  }, bodyStr);
  assert.equal(countResp.status, 404);
  const countJson = JSON.parse(countResp.body);
  assert.equal(countJson.type, 'error');
  assert.equal(countJson.error.type, 'not_found_error');
});

// --- live server + mock upstream: marker-vs-model-field priority, and strip scoping ---
// The two LIVE aliases both route via the codex shim base_url (fixed in router.mjs's VIA_URL
// map), so a mock listener observes what router.mjs actually forwards without touching
// models.json.

// Bind on an ephemeral port (0) and report the actual port, so the mock never collides
// with a real relay shim that may be running on the fixed 8791. The router is pointed at
// this port via RELAY_CODEX_BASE_URL (overrides VIA_URL.codex).
function startMockUpstream() {
  return new Promise((resolve) => {
    const received = [];
    const srv = http.createServer((req, res) => {
      const chunks = [];
      req.on('data', c => chunks.push(c));
      req.on('end', () => {
        received.push(JSON.parse(Buffer.concat(chunks).toString('utf8')));
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ id: 'chatcmpl-mock', choices: [{ index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }], usage: {} }));
      });
    });
    srv.listen(0, '127.0.0.1', () => resolve({ srv, received, port: srv.address().port }));
  });
}

test('router: marker wins over a claude-* model field when both are present', async (t) => {
  const routerPort = 18800 + Math.floor(Math.random() * 500);

  const { srv: mockSrv, received, port: mockPort } = await startMockUpstream();
  t.after(() => mockSrv.close());

  const childEnv = { ...process.env, PORT: String(routerPort), RELAY_CODEX_BASE_URL: `http://127.0.0.1:${mockPort}/v1` };
  delete childEnv.RELAY_ROUTER_NO_LISTEN;
  const child = spawnRouter(childEnv);
  t.after(() => { child.kill(); });
  await waitForPort(routerPort);

  const bodyStr = JSON.stringify({
    model: `claude-${LIVE_ALIAS}`,
    system: `RELAY-MODEL: ${LIVE_ALIAS_2}\nyou are a worker`,
    messages: [{ role: 'user', content: 'hi' }],
  });
  await httpRequest(routerPort, {
    method: 'POST',
    path: '/v1/messages',
    headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(bodyStr) },
  }, bodyStr);

  assert.equal(received.length, 1);
  assert.equal(received[0].model, LIVE_MODEL_2, `marker (${LIVE_ALIAS_2}) must win over the model field (claude-${LIVE_ALIAS})`);
});

test('router: model-field routing does not strip system-reminder noise (marker routing does)', async (t) => {
  const routerPort = 18800 + Math.floor(Math.random() * 500);

  const { srv: mockSrv, received, port: mockPort } = await startMockUpstream();
  t.after(() => mockSrv.close());

  const childEnv = { ...process.env, PORT: String(routerPort), RELAY_CODEX_BASE_URL: `http://127.0.0.1:${mockPort}/v1` };
  delete childEnv.RELAY_ROUTER_NO_LISTEN;
  const child = spawnRouter(childEnv);
  t.after(() => { child.kill(); });
  await waitForPort(routerPort);

  const reminder = '<system-reminder>do not leak this</system-reminder>';

  const viaModelField = JSON.stringify({
    model: `claude-${LIVE_ALIAS}`,
    system: reminder + '\nmain session instructions',
    messages: [{ role: 'user', content: 'hi' }],
  });
  await httpRequest(routerPort, {
    method: 'POST',
    path: '/v1/messages',
    headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(viaModelField) },
  }, viaModelField);

  assert.equal(received.length, 1);
  const sysMsgModelField = received[0].messages.find(m => m.role === 'system');
  assert.ok(sysMsgModelField.content.includes('<system-reminder>'), 'model-field routing must NOT strip system-reminder blocks');

  const viaMarker = JSON.stringify({
    system: `RELAY-MODEL: ${LIVE_ALIAS}\n` + reminder + '\nworker instructions',
    messages: [{ role: 'user', content: 'hi' }],
  });
  await httpRequest(routerPort, {
    method: 'POST',
    path: '/v1/messages',
    headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(viaMarker) },
  }, viaMarker);

  assert.equal(received.length, 2);
  const sysMsgMarker = received[1].messages.find(m => m.role === 'system');
  assert.ok(!sysMsgMarker.content.includes('<system-reminder>'), 'marker routing must strip system-reminder blocks as before');
});

// --- live server + mock native (Anthropic) upstream: 429 gate + limited retry (Fix 2) ---
// A body with no marker and a real Claude model name resolves alias=null (native passthrough),
// which forwards to ANTHROPIC_UPSTREAM. RELAY_ANTHROPIC_BASE_URL redirects that to this mock so
// the concurrency gate and the Retry-After-limited retry can be exercised without a live API key.

function startMockNativeUpstream({ statuses, retryAfter, delayMs = 0, holdBodyMs = 0 } = {}) {
  return new Promise((resolve) => {
    const received = [];
    let concurrent = 0;
    let maxConcurrent = 0;
    const srv = http.createServer((req, res) => {
      concurrent++;
      maxConcurrent = Math.max(maxConcurrent, concurrent);
      const chunks = [];
      req.on('data', c => chunks.push(c));
      req.on('end', () => {
        const callIndex = received.length;
        received.push(Buffer.concat(chunks).toString('utf8'));
        const respond = () => {
          const status = statuses ? (statuses[callIndex] ?? statuses[statuses.length - 1]) : 200;
          const headers = { 'content-type': 'application/json' };
          if (status === 429 && retryAfter != null) headers['retry-after'] = String(retryAfter);
          res.writeHead(status, headers);
          if (holdBodyMs > 0) {
            res.flushHeaders();
            setTimeout(() => { concurrent--; res.end(JSON.stringify({ type: 'message', id: 'mock', content: [] })); }, holdBodyMs);
          } else {
            concurrent--;
            res.end(JSON.stringify({ type: 'message', id: 'mock', content: [] }));
          }
        };
        if (delayMs > 0) setTimeout(respond, delayMs); else respond();
      });
    });
    srv.listen(0, '127.0.0.1', () => resolve({ srv, received, port: srv.address().port, getMaxConcurrent: () => maxConcurrent }));
  });
}

function nativeBodyStr() {
  return JSON.stringify({ model: 'claude-opus-4-8', messages: [{ role: 'user', content: 'hi' }] });
}

test('router: native 429 with Retry-After retries exactly once and returns the retried response', async (t) => {
  const routerPort = 18800 + Math.floor(Math.random() * 500);
  const { srv: mockSrv, received, port: mockPort } = await startMockNativeUpstream({ statuses: [429, 200], retryAfter: 1 });
  t.after(() => mockSrv.close());

  const childEnv = { ...process.env, PORT: String(routerPort), RELAY_ANTHROPIC_BASE_URL: `http://127.0.0.1:${mockPort}` };
  delete childEnv.RELAY_ROUTER_NO_LISTEN;
  const child = spawnRouter(childEnv);
  t.after(() => { child.kill(); });
  await waitForPort(routerPort);

  const bodyStr = nativeBodyStr();
  const resp = await httpRequest(routerPort, {
    method: 'POST',
    path: '/v1/messages',
    headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(bodyStr) },
  }, bodyStr);

  assert.equal(received.length, 2, 'expected exactly one retry (2 upstream calls total)');
  assert.equal(resp.status, 200, 'client should see the retried (successful) response');
});

test('router: native 429 without Retry-After is not retried', async (t) => {
  const routerPort = 18800 + Math.floor(Math.random() * 500);
  const { srv: mockSrv, received, port: mockPort } = await startMockNativeUpstream({ statuses: [429] });
  t.after(() => mockSrv.close());

  const childEnv = { ...process.env, PORT: String(routerPort), RELAY_ANTHROPIC_BASE_URL: `http://127.0.0.1:${mockPort}` };
  delete childEnv.RELAY_ROUTER_NO_LISTEN;
  const child = spawnRouter(childEnv);
  t.after(() => { child.kill(); });
  await waitForPort(routerPort);

  const bodyStr = nativeBodyStr();
  const resp = await httpRequest(routerPort, {
    method: 'POST',
    path: '/v1/messages',
    headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(bodyStr) },
  }, bodyStr);

  assert.equal(received.length, 1, 'no Retry-After header -> must not retry');
  assert.equal(resp.status, 429);
});

test('router: native concurrency gate caps simultaneous upstream requests at RELAY_NATIVE_MAX_CONCURRENCY', async (t) => {
  const routerPort = 18800 + Math.floor(Math.random() * 500);
  const K = 2;
  const N = 6;
  const { srv: mockSrv, received, port: mockPort, getMaxConcurrent } = await startMockNativeUpstream({ delayMs: 200 });
  t.after(() => mockSrv.close());

  const childEnv = {
    ...process.env,
    PORT: String(routerPort),
    RELAY_ANTHROPIC_BASE_URL: `http://127.0.0.1:${mockPort}`,
    RELAY_NATIVE_MAX_CONCURRENCY: String(K),
  };
  delete childEnv.RELAY_ROUTER_NO_LISTEN;
  const child = spawnRouter(childEnv);
  t.after(() => { child.kill(); });
  await waitForPort(routerPort);

  const bodyStr = nativeBodyStr();
  await Promise.all(Array.from({ length: N }, () => httpRequest(routerPort, {
    method: 'POST',
    path: '/v1/messages',
    headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(bodyStr) },
  }, bodyStr)));

  assert.equal(received.length, N, 'all requests should eventually reach the mock upstream (gate delays, does not drop)');
  assert.ok(getMaxConcurrent() <= K, `observed concurrency ${getMaxConcurrent()} must not exceed K=${K}`);
});

test('router: RELAY_NATIVE_MAX_CONCURRENCY=0 disables the 429 retry (rollback switch)', async (t) => {
  const routerPort = 18800 + Math.floor(Math.random() * 500);
  const { srv: mockSrv, received, port: mockPort } = await startMockNativeUpstream({ statuses: [429], retryAfter: 1 });
  t.after(() => mockSrv.close());

  const childEnv = {
    ...process.env,
    PORT: String(routerPort),
    RELAY_ANTHROPIC_BASE_URL: `http://127.0.0.1:${mockPort}`,
    RELAY_NATIVE_MAX_CONCURRENCY: '0',
  };
  delete childEnv.RELAY_ROUTER_NO_LISTEN;
  const child = spawnRouter(childEnv);
  t.after(() => { child.kill(); });
  await waitForPort(routerPort);

  const bodyStr = nativeBodyStr();
  const resp = await httpRequest(routerPort, {
    method: 'POST',
    path: '/v1/messages',
    headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(bodyStr) },
  }, bodyStr);

  assert.equal(received.length, 1, 'RELAY_NATIVE_MAX_CONCURRENCY=0 must fully disable the retry rollback path -> no retry even with Retry-After present');
  assert.equal(resp.status, 429, 'client should see the 429 passed through unmodified');
});

test('router: native gate releases its slot once upstream response headers arrive, not after the body finishes', async (t) => {
  const routerPort = 18800 + Math.floor(Math.random() * 500);
  const K = 2;
  const N = 3;
  const { srv: mockSrv, received, port: mockPort } = await startMockNativeUpstream({ holdBodyMs: 300 });
  t.after(() => mockSrv.close());

  const childEnv = {
    ...process.env,
    PORT: String(routerPort),
    RELAY_ANTHROPIC_BASE_URL: `http://127.0.0.1:${mockPort}`,
    RELAY_NATIVE_MAX_CONCURRENCY: String(K),
  };
  delete childEnv.RELAY_ROUTER_NO_LISTEN;
  const child = spawnRouter(childEnv);
  t.after(() => { child.kill(); });
  await waitForPort(routerPort);

  const bodyStr = nativeBodyStr();
  const requests = Promise.all(Array.from({ length: N }, () => httpRequest(routerPort, {
    method: 'POST',
    path: '/v1/messages',
    headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(bodyStr) },
  }, bodyStr)));

  await new Promise((r) => setTimeout(r, 150));
  assert.equal(received.length, N, 'all N requests should reach the mock well before the 300ms held body completes -- the gate must release once upstream headers arrive, not after the full body completes');

  await requests;
});
