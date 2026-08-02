import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { Readable } from 'node:stream';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

if (process.env.RELAY_SHIM_NO_LISTEN !== '1') {
  throw new Error('shim.test.mjs must be run with RELAY_SHIM_NO_LISTEN=1 (see test/README or CI invocation) to avoid binding a real port');
}

const authDir = fs.mkdtempSync(path.join(os.tmpdir(), 'clover-auth-'));
const authPath = path.join(authDir, 'auth.json');
process.env.CODEX_AUTH_PATH = authPath;

const {
  buildResponsesBody,
  streamResponsesToChatSSE,
  parseResponsesSSE,
  handle,
  accessTokenExpiryMs,
  refreshAccessToken,
  resolveReqId,
  __setAuthLoaderForTest,
  __setRequestResponsesForTest,
  __setOAuthFetchForTest,
} = await import('../src/codex-responses-shim.mjs');

function makeJwt(payload) {
  const b64url = (obj) => Buffer.from(JSON.stringify(obj)).toString('base64url');
  return b64url({ alg: 'none' }) + '.' + b64url(payload) + '.sig';
}

function writeAuthFile(obj) {
  fs.writeFileSync(authPath, JSON.stringify(obj, null, 2));
}

function sse(obj) {
  return 'data: ' + JSON.stringify(obj) + '\n\n';
}

function upstreamStream(lines) {
  return Readable.from((async function* () {
    for (const l of lines) yield Buffer.from(l);
  })());
}

function stallingUpstreamStream(gapMs) {
  return Readable.from((async function* () {
    await new Promise(r => setTimeout(r, gapMs));
  })());
}

class MockClientRes extends EventEmitter {
  constructor() {
    super();
    this.writes = [];
    this.writableEnded = false;
    this.destroyed = false;
    this.headers = null;
    this.statusCode = null;
  }
  writeHead(status, headers) {
    this.statusCode = status;
    this.headers = headers;
  }
  write(chunk) {
    this.writes.push(chunk);
    return true;
  }
  end(chunk) {
    if (chunk != null) this.writes.push(chunk);
    this.writableEnded = true;
    this.emit('finish');
  }
  raw() {
    return this.writes.join('');
  }
}

class MockReq extends EventEmitter {
  constructor(bodyObj, headers = {}) {
    super();
    this._buf = Buffer.from(JSON.stringify(bodyObj));
    this.headers = headers;
  }
  async *[Symbol.asyncIterator]() {
    yield this._buf;
  }
}

test('buildResponsesBody: tool_choice function form carries the function name through (M2)', () => {
  const body = buildResponsesBody({
    model: 'gpt-5.5',
    messages: [{ role: 'user', content: 'hi' }],
    tool_choice: { type: 'function', function: { name: 'get_weather' } },
  });
  assert.deepEqual(body.tool_choice, { type: 'function', name: 'get_weather' });
});

test('buildResponsesBody: string tool_choice passes through unchanged', () => {
  const body = buildResponsesBody({
    model: 'gpt-5.5',
    messages: [{ role: 'user', content: 'hi' }],
    tool_choice: 'required',
  });
  assert.equal(body.tool_choice, 'required');
});

test('streamResponsesToChatSSE: reasoning/progress events write no per-event keepalive (only the independent interval may)', async () => {
  const stream = upstreamStream([
    sse({ type: 'response.created', response: { id: 'resp_1' } }),
    sse({ type: 'response.reasoning_summary_text.delta', delta: 'thinking...' }),
    sse({ type: 'response.output_text.delta', delta: 'Hi' }),
    sse({ type: 'response.completed', response: { usage: { input_tokens: 1, output_tokens: 2 } } }),
    'data: [DONE]\n\n',
  ]);
  const res = new MockClientRes();

  await streamResponsesToChatSSE(stream, res, 'req1', { keepaliveMs: 60000 });

  const raw = res.raw();
  assert.ok(!raw.includes(': keepalive\n\n'), 'expected no per-event keepalive comment line for the reasoning event');
  assert.ok(raw.includes('"content":"Hi"'), 'expected the text delta to reach the client');
  assert.ok(raw.includes('data: [DONE]'));
  assert.ok(res.writableEnded);
});

test('streamResponsesToChatSSE: premature close of the upstream stream errors out instead of hanging', async () => {
  const stream = upstreamStream([
    sse({ type: 'response.created', response: { id: 'resp_2' } }),
    sse({ type: 'response.output_text.delta', delta: 'partial' }),
  ]);
  const res = new MockClientRes();

  await streamResponsesToChatSSE(stream, res, 'req2');

  assert.ok(res.writableEnded, 'client response must still be ended, not left hanging');
  const raw = res.raw();
  assert.ok(raw.includes('upstream stream ended prematurely'), 'expected an error payload for the client');
});

test('streamResponsesToChatSSE: an independent client keepalive fires during total silence, and its interval is cleared when the stream ends (no leaked timer)', async () => {
  const stream = stallingUpstreamStream(120);
  const res = new MockClientRes();

  const originalSetInterval = global.setInterval;
  const originalClearInterval = global.clearInterval;
  let createdHandle = null;
  const clearedHandles = [];
  global.setInterval = (fn, ms) => { createdHandle = originalSetInterval(fn, ms); return createdHandle; };
  global.clearInterval = (h) => { clearedHandles.push(h); return originalClearInterval(h); };

  try {
    await streamResponsesToChatSSE(stream, res, 'req-stall', { keepaliveMs: 20 });
  } finally {
    global.setInterval = originalSetInterval;
    global.clearInterval = originalClearInterval;
  }

  const raw = res.raw();
  const keepaliveCount = raw.split(': keepalive\n\n').length - 1;
  assert.ok(keepaliveCount >= 1, 'expected the independent client keepalive to write at least once during total silence (no events at all)');
  assert.ok(createdHandle, 'expected the keepalive interval to be created');
  assert.ok(clearedHandles.includes(createdHandle), 'expected the keepalive interval to be cleared when the stream finished (no leaked timer)');
  assert.ok(res.writableEnded);
});

test('handle: on 401, reloads auth and retries once when the token changed', async () => {
  let authCalls = 0;
  __setAuthLoaderForTest(() => {
    authCalls++;
    return authCalls === 1
      ? { accessToken: 'old-token', accountId: 'acct' }
      : { accessToken: 'new-token', accountId: 'acct' };
  });

  let requestCalls = 0;
  __setRequestResponsesForTest(async (bodyStr, auth) => {
    requestCalls++;
    if (auth.accessToken === 'old-token') {
      return { status: 401, headers: {}, stream: upstreamStream(['']) };
    }
    return {
      status: 200,
      headers: {},
      stream: upstreamStream([
        sse({ type: 'response.created', response: { id: 'resp_retry' } }),
        sse({ type: 'response.output_text.delta', delta: 'ok' }),
        sse({ type: 'response.completed', response: { usage: { input_tokens: 1, output_tokens: 1 } } }),
        'data: [DONE]\n\n',
      ]),
    };
  });

  try {
    const req = new MockReq({ model: 'gpt-5.5', messages: [{ role: 'user', content: 'hi' }], stream: false });
    const res = new MockClientRes();

    await handle(req, res, 'req3');

    assert.equal(authCalls, 2, 'expected auth to be reloaded exactly once after the first 401');
    assert.equal(requestCalls, 2, 'expected exactly one retry (no retry loop)');
    assert.equal(res.statusCode, 200);
    const body = JSON.parse(res.raw());
    assert.equal(body.choices[0].message.content, 'ok');
  } finally {
    __setAuthLoaderForTest(null);
    __setRequestResponsesForTest(null);
  }
});

test('handle: on 401 with an unchanged token, fails closed with 401 (no infinite retry)', async () => {
  __setAuthLoaderForTest(() => ({ accessToken: 'same-token', accountId: 'acct' }));

  let requestCalls = 0;
  __setRequestResponsesForTest(async () => {
    requestCalls++;
    return { status: 401, headers: {}, stream: upstreamStream(['']) };
  });

  try {
    const req = new MockReq({ model: 'gpt-5.5', messages: [{ role: 'user', content: 'hi' }], stream: false });
    const res = new MockClientRes();

    await handle(req, res, 'req4');

    assert.equal(requestCalls, 1, 'token never changed, so no retry should be attempted');
    assert.equal(res.statusCode, 401);
  } finally {
    __setAuthLoaderForTest(null);
    __setRequestResponsesForTest(null);
  }
});

test('accessTokenExpiryMs: reads exp from a well-formed JWT', () => {
  const expSec = Math.floor(Date.now() / 1000) + 3600;
  const jwt = makeJwt({ exp: expSec });
  assert.equal(accessTokenExpiryMs(jwt), expSec * 1000);
});

test('accessTokenExpiryMs: returns null for a malformed token', () => {
  assert.equal(accessTokenExpiryMs('not-a-jwt'), null);
  assert.equal(accessTokenExpiryMs('a.b'), null);
  assert.equal(accessTokenExpiryMs('a.' + Buffer.from('not json').toString('base64url') + '.c'), null);
});

test('refreshAccessToken: success replaces tokens and writes auth.json atomically', async () => {
  writeAuthFile({
    tokens: {
      access_token: 'old-access',
      refresh_token: 'old-refresh',
      account_id: 'acct-1',
      id_token: 'old-id',
    },
    last_refresh: '2020-01-01T00:00:00.000Z',
    other_field: 'keep-me',
  });

  let fetchCalls = 0;
  __setOAuthFetchForTest(async (refreshToken, signal) => {
    fetchCalls++;
    assert.equal(refreshToken, 'old-refresh');
    return {
      ok: true,
      json: async () => ({ access_token: 'new-access', refresh_token: 'new-refresh', id_token: 'new-id' }),
    };
  });

  try {
    const result = await refreshAccessToken();
    assert.equal(fetchCalls, 1);
    assert.equal(result.accessToken, 'new-access');
    assert.equal(result.accountId, 'acct-1');
    assert.equal(result.refreshToken, 'new-refresh');

    const onDisk = JSON.parse(fs.readFileSync(authPath, 'utf8'));
    assert.equal(onDisk.tokens.access_token, 'new-access');
    assert.equal(onDisk.tokens.refresh_token, 'new-refresh');
    assert.equal(onDisk.tokens.id_token, 'new-id');
    assert.equal(onDisk.tokens.account_id, 'acct-1');
    assert.equal(onDisk.other_field, 'keep-me');
    assert.notEqual(onDisk.last_refresh, '2020-01-01T00:00:00.000Z');
  } finally {
    __setOAuthFetchForTest(null);
  }
});

test('refreshAccessToken: single-flight shares one in-flight refresh across concurrent callers', async () => {
  writeAuthFile({ tokens: { access_token: 'a', refresh_token: 'r', account_id: 'acct-2' } });

  let fetchCalls = 0;
  __setOAuthFetchForTest(async () => {
    fetchCalls++;
    await new Promise(r => setTimeout(r, 20));
    return { ok: true, json: async () => ({ access_token: 'concurrent-access' }) };
  });

  try {
    const [r1, r2] = await Promise.all([refreshAccessToken(), refreshAccessToken()]);
    assert.equal(fetchCalls, 1, 'expected exactly one HTTP call for two concurrent refreshes');
    assert.equal(r1.accessToken, 'concurrent-access');
    assert.equal(r2.accessToken, 'concurrent-access');
  } finally {
    __setOAuthFetchForTest(null);
  }
});

test('refreshAccessToken: failure throws and leaves auth.json untouched', async () => {
  writeAuthFile({ tokens: { access_token: 'keep', refresh_token: 'r', account_id: 'acct-3' } });

  __setOAuthFetchForTest(async () => ({ ok: false, status: 400, text: async () => 'invalid_grant' }));

  try {
    await assert.rejects(() => refreshAccessToken(), /oauth refresh failed/);
    const onDisk = JSON.parse(fs.readFileSync(authPath, 'utf8'));
    assert.equal(onDisk.tokens.access_token, 'keep');
  } finally {
    __setOAuthFetchForTest(null);
  }
});

test('refreshAccessToken: missing refresh_token throws without calling fetch', async () => {
  writeAuthFile({ tokens: { access_token: 'keep', account_id: 'acct-4' } });

  let fetchCalls = 0;
  __setOAuthFetchForTest(async () => { fetchCalls++; return { ok: true, json: async () => ({}) }; });

  try {
    await assert.rejects(() => refreshAccessToken(), /missing tokens.refresh_token/);
    assert.equal(fetchCalls, 0);
  } finally {
    __setOAuthFetchForTest(null);
  }
});

test('handle: 401 with unchanged token but refresh_token present -> refreshes and retries once', async () => {
  writeAuthFile({ tokens: { access_token: 'stale-access', refresh_token: 'good-refresh', account_id: 'acct-5' } });

  __setAuthLoaderForTest(() => ({ accessToken: 'stale-access', accountId: 'acct-5', refreshToken: 'good-refresh' }));

  __setOAuthFetchForTest(async () => ({
    ok: true,
    json: async () => ({ access_token: 'refreshed-access' }),
  }));

  let requestCalls = 0;
  __setRequestResponsesForTest(async (bodyStr, auth) => {
    requestCalls++;
    if (auth.accessToken === 'stale-access') {
      return { status: 401, headers: {}, stream: upstreamStream(['']) };
    }
    assert.equal(auth.accessToken, 'refreshed-access');
    return {
      status: 200,
      headers: {},
      stream: upstreamStream([
        sse({ type: 'response.created', response: { id: 'resp_refresh' } }),
        sse({ type: 'response.output_text.delta', delta: 'ok-refreshed' }),
        sse({ type: 'response.completed', response: { usage: { input_tokens: 1, output_tokens: 1 } } }),
        'data: [DONE]\n\n',
      ]),
    };
  });

  try {
    const req = new MockReq({ model: 'gpt-5.5', messages: [{ role: 'user', content: 'hi' }], stream: false });
    const res = new MockClientRes();

    await handle(req, res, 'req6');

    assert.equal(requestCalls, 2, 'expected exactly one retry after refresh');
    assert.equal(res.statusCode, 200);
    const body = JSON.parse(res.raw());
    assert.equal(body.choices[0].message.content, 'ok-refreshed');
  } finally {
    __setAuthLoaderForTest(null);
    __setRequestResponsesForTest(null);
    __setOAuthFetchForTest(null);
  }
});

test('handle: 401 with no refresh_token available -> fails closed with 401 as before', async () => {
  __setAuthLoaderForTest(() => ({ accessToken: 'same-token', accountId: 'acct' }));

  let requestCalls = 0;
  __setRequestResponsesForTest(async () => {
    requestCalls++;
    return { status: 401, headers: {}, stream: upstreamStream(['']) };
  });

  try {
    const req = new MockReq({ model: 'gpt-5.5', messages: [{ role: 'user', content: 'hi' }], stream: false });
    const res = new MockClientRes();

    await handle(req, res, 'req7');

    assert.equal(requestCalls, 1);
    assert.equal(res.statusCode, 401);
  } finally {
    __setAuthLoaderForTest(null);
    __setRequestResponsesForTest(null);
  }
});

test('handle: pre-emptively refreshes when the JWT exp is under the 5-minute margin', async () => {
  writeAuthFile({ tokens: { access_token: 'will-not-be-used-directly', refresh_token: 'good-refresh', account_id: 'acct-preemptive' } });

  const almostExpiredJwt = makeJwt({ exp: Math.floor(Date.now() / 1000) + 60 });
  __setAuthLoaderForTest(() => ({ accessToken: almostExpiredJwt, accountId: 'acct-preemptive', refreshToken: 'good-refresh' }));

  let fetchCalls = 0;
  __setOAuthFetchForTest(async () => {
    fetchCalls++;
    return { ok: true, json: async () => ({ access_token: 'pre-emptively-refreshed' }) };
  });

  let requestCalls = 0;
  __setRequestResponsesForTest(async (bodyStr, auth) => {
    requestCalls++;
    assert.equal(auth.accessToken, 'pre-emptively-refreshed', 'the request must use the pre-emptively refreshed access token, not the near-expiry one');
    return {
      status: 200,
      headers: {},
      stream: upstreamStream([
        sse({ type: 'response.created', response: { id: 'resp_preemptive' } }),
        sse({ type: 'response.output_text.delta', delta: 'ok' }),
        sse({ type: 'response.completed', response: { usage: { input_tokens: 1, output_tokens: 1 } } }),
        'data: [DONE]\n\n',
      ]),
    };
  });

  try {
    const req = new MockReq({ model: 'gpt-5.5', messages: [{ role: 'user', content: 'hi' }], stream: false });
    const res = new MockClientRes();

    await handle(req, res, 'req8');

    assert.equal(fetchCalls, 1, 'expected exactly one pre-emptive refresh call');
    assert.equal(requestCalls, 1, 'expected exactly one upstream request (no 401 retry needed)');
    assert.equal(res.statusCode, 200);
  } finally {
    __setAuthLoaderForTest(null);
    __setRequestResponsesForTest(null);
    __setOAuthFetchForTest(null);
  }
});

test('handle: does not pre-emptively refresh when the JWT exp is comfortably outside the margin', async () => {
  writeAuthFile({ tokens: { access_token: 'will-not-be-used-directly', refresh_token: 'good-refresh', account_id: 'acct-fresh' } });

  const freshJwt = makeJwt({ exp: Math.floor(Date.now() / 1000) + 3600 });
  __setAuthLoaderForTest(() => ({ accessToken: freshJwt, accountId: 'acct-fresh', refreshToken: 'good-refresh' }));

  let fetchCalls = 0;
  __setOAuthFetchForTest(async () => {
    fetchCalls++;
    return { ok: true, json: async () => ({ access_token: 'should-not-be-used' }) };
  });

  __setRequestResponsesForTest(async (bodyStr, auth) => {
    assert.equal(auth.accessToken, freshJwt, 'the request must use the still-fresh access token');
    return {
      status: 200,
      headers: {},
      stream: upstreamStream([
        sse({ type: 'response.created', response: { id: 'resp_fresh' } }),
        sse({ type: 'response.output_text.delta', delta: 'ok' }),
        sse({ type: 'response.completed', response: { usage: { input_tokens: 1, output_tokens: 1 } } }),
        'data: [DONE]\n\n',
      ]),
    };
  });

  try {
    const req = new MockReq({ model: 'gpt-5.5', messages: [{ role: 'user', content: 'hi' }], stream: false });
    const res = new MockClientRes();

    await handle(req, res, 'req9');

    assert.equal(fetchCalls, 0, 'a fresh token must not trigger a pre-emptive refresh');
    assert.equal(res.statusCode, 200);
  } finally {
    __setAuthLoaderForTest(null);
    __setRequestResponsesForTest(null);
  }
});

test('resolveReqId: a valid incoming x-clover-trace-id header is used as-is', () => {
  const traceId = 'abc123-def456';
  assert.equal(resolveReqId({ 'x-clover-trace-id': traceId }), traceId);
});

test('resolveReqId: no header falls back to a freshly generated id', () => {
  const a = resolveReqId({});
  const b = resolveReqId(undefined);
  assert.equal(typeof a, 'string');
  assert.equal(a.length, 8, 'fallback must be the existing randomUUID().slice(0,8) shape');
  assert.notEqual(a, b, 'each fallback call must generate a fresh id');
});

test('resolveReqId: a header value with disallowed characters is rejected (fails closed to a fresh id)', () => {
  const fallback = resolveReqId({ 'x-clover-trace-id': 'not valid! <script>' });
  assert.equal(fallback.length, 8);
});

test('handle: log lines carry an ISO timestamp and the trace ID propagated via x-clover-trace-id', async () => {
  __setAuthLoaderForTest(() => ({ accessToken: 'same-token', accountId: 'acct' }));
  __setRequestResponsesForTest(async () => ({ status: 401, headers: {}, stream: upstreamStream(['']) }));

  const originalError = console.error;
  const logs = [];
  console.error = (...args) => { logs.push(args.join(' ')); };

  try {
    const req = new MockReq({ model: 'gpt-5.5', messages: [{ role: 'user', content: 'hi' }], stream: false }, { 'x-clover-trace-id': 'deadbeef-cafe-789' });
    const res = new MockClientRes();
    const reqID = resolveReqId(req.headers);
    assert.equal(reqID, 'deadbeef-cafe-789', 'a valid incoming trace id must be used as-is, not re-generated');

    await handle(req, res, reqID);

    const line = logs.find(l => l.includes('[deadbeef-cafe-789]'));
    assert.ok(line, 'expected a log line tagged with the propagated trace id');
    assert.match(line, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z /, 'expected an ISO timestamp prefix on the log line (logts)');
  } finally {
    console.error = originalError;
    __setAuthLoaderForTest(null);
    __setRequestResponsesForTest(null);
  }
});

test('handle: without an incoming trace id, falls back to a freshly generated id (still logged with a timestamp)', async () => {
  __setAuthLoaderForTest(() => ({ accessToken: 'same-token', accountId: 'acct' }));
  __setRequestResponsesForTest(async () => ({ status: 401, headers: {}, stream: upstreamStream(['']) }));

  const originalError = console.error;
  const logs = [];
  console.error = (...args) => { logs.push(args.join(' ')); };

  try {
    const req = new MockReq({ model: 'gpt-5.5', messages: [{ role: 'user', content: 'hi' }], stream: false });
    const res = new MockClientRes();
    const reqID = resolveReqId(req.headers);
    assert.equal(reqID.length, 8);

    await handle(req, res, reqID);

    const line = logs.find(l => l.includes('[' + reqID + ']'));
    assert.ok(line, 'expected a log line tagged with the fallback-generated id');
    assert.match(line, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z /, 'expected an ISO timestamp prefix on the log line (logts)');
  } finally {
    console.error = originalError;
    __setAuthLoaderForTest(null);
    __setRequestResponsesForTest(null);
  }
});
