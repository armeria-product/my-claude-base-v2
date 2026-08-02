import http from 'node:http';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { toOpenAIRequest, streamOpenAIToAnthropic, aggregateOpenAIStreamToAnthropic } from './openai-adapter.mjs';
import { hasLiveSessions, sweepSessions } from './lifecycle.mjs';

const DIRECT_MODEL_PREFIX = 'claude-';

export function resolveDirectModel(modelField, modelsMap) {
  if (typeof modelField !== 'string') return null;
  const clean = modelField.trim().toLowerCase();
  if (!clean) return null;

  if (clean.startsWith(DIRECT_MODEL_PREFIX)) {
    const alias = clean.slice(DIRECT_MODEL_PREFIX.length);
    for (const key of modelsMap.keys()) {
      if (key.toLowerCase() === alias) return key;
    }
    return null;
  }

  if (clean.startsWith('anthropic')) return null;

  for (const key of modelsMap.keys()) {
    if (key.toLowerCase() === clean) return key;
  }

  for (const [key, cfg] of modelsMap.entries()) {
    if (String(cfg.model || '').toLowerCase() === clean) return key;
  }

  return null;
}

export function buildModelsListResponse(modelsMap) {
  const data = [...modelsMap.entries()].map(([alias, cfg]) => ({
    type: 'model',
    id: DIRECT_MODEL_PREFIX + alias,
    display_name: `${cfg.model} (clover)`,
  }));
  return {
    // identity marker for pingRouter (bin/clover-launch.mjs); id alone can't tell us apart from real Anthropic
    x_clover_relay: true,
    data,
    has_more: false,
    first_id: data.length > 0 ? data[0].id : null,
    last_id: data.length > 0 ? data[data.length - 1].id : null,
  };
}

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const JSON_PATH = path.join(__dirname, '..', 'models.json');
const PORT = Number(process.env.PORT || 8788);
const ANTHROPIC_UPSTREAM = process.env.RELAY_ANTHROPIC_BASE_URL || 'https://api.anthropic.com';
const MARKER_RE = /(?:^|\s)RELAY-MODEL:\s*(\S+)/m;
const PROMPT_MARKER_RE = /^RELAY-MODEL:[ \t]*([^\s,]+)/;
const VIA_URL = { codex: process.env.RELAY_CODEX_BASE_URL || 'http://127.0.0.1:8791/v1' };
const IDLE_MS = num(process.env.RELAY_IDLE_MS) ?? 0;
function num(v) {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : undefined;
}
const RELAY_CONNECT_TIMEOUT_MS = num(process.env.RELAY_CONNECT_TIMEOUT_MS) ?? num(process.env.RELAY_UPSTREAM_TIMEOUT_MS) ?? 300000;
const RELAY_LOG = process.env.RELAY_LOG === '1';
const RELAY_LOG_FULL = process.env.RELAY_LOG_FULL === '1';
const logts = (...a) => console.error(new Date().toISOString(), ...a);

const RELAY_NATIVE_MAX_CONCURRENCY = (() => {
  const raw = process.env.RELAY_NATIVE_MAX_CONCURRENCY;
  if (raw === undefined || raw === '') return 4;
  const n = Number(raw);
  return Number.isInteger(n) && n >= 0 ? n : 4;
})();
const RELAY_NATIVE_GATE_WAIT_MS = 60000;
const RELAY_NATIVE_RETRY_AFTER_CAP_S = 60;

let inflight = 0;
let idleTimer = null;

function armIdle() {
  if (IDLE_MS <= 0) return;
  if (idleTimer) {
    clearTimeout(idleTimer);
    idleTimer = null;
  }
  if (inflight > 0) return;
  idleTimer = setTimeout(() => {
    if (hasLiveSessions()) {
      armIdle();
      return;
    }
    server.close(() => process.exit(0));
  }, IDLE_MS);
}

let nativeInflight = 0;
const nativeWaitQueue = [];

function acquireNativeSlot() {
  if (RELAY_NATIVE_MAX_CONCURRENCY <= 0) return Promise.resolve(false);
  if (nativeInflight < RELAY_NATIVE_MAX_CONCURRENCY) {
    nativeInflight++;
    return Promise.resolve(true);
  }
  return new Promise((resolve) => {
    let settled = false;
    const wake = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      nativeInflight++;
      resolve(true);
    };
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      const idx = nativeWaitQueue.indexOf(wake);
      if (idx !== -1) nativeWaitQueue.splice(idx, 1);
      resolve(false); // fail-open: proceed without a slot rather than queue forever
    }, RELAY_NATIVE_GATE_WAIT_MS);
    nativeWaitQueue.push(wake);
  });
}

function releaseNativeSlot(counted) {
  if (!counted) return;
  nativeInflight--;
  const wake = nativeWaitQueue.shift();
  if (wake) wake();
}

// alias becomes claude-<alias>; an alias starting with a real Claude model family name would make
// that id collide with (hijack) the real model, e.g. alias "opus-4-8" -> id "claude-opus-4-8".
const DANGEROUS_ALIAS_PREFIXES = ['opus', 'sonnet', 'haiku', 'fable'];

export function buildModelsMap(cfg) {
  const map = new Map();
  for (const entry of cfg.models) {
    const aliasLower = String(entry.alias || '').toLowerCase();
    if (DANGEROUS_ALIAS_PREFIXES.some(p => aliasLower.startsWith(p))) {
      logts(`models.json: alias "${entry.alias}" starts with a real Claude model name (${DANGEROUS_ALIAS_PREFIXES.join('/')}) -- skipping (would hijack claude-${entry.alias})`);
      continue;
    }
    const format = String(entry.format || 'anthropic').toLowerCase();
    const via = entry.via ? String(entry.via) : null;
    const base_url = String(entry.base_url || VIA_URL[via] || '').replace(/\/+$/, '');
    map.set(entry.alias, {
      model: entry.model,
      base_url,
      api_key: entry.api_key,
      format,
      via,
      effort: entry.effort != null ? entry.effort : null,
      verbosity: entry.verbosity != null ? entry.verbosity : null,
    });
  }
  return map;
}

function loadModels() {
  const cfg = JSON.parse(readFileSync(JSON_PATH, 'utf8'));
  return buildModelsMap(cfg);
}

let modelsMapCache = loadModels();

function getModelsMap() {
  try {
    modelsMapCache = loadModels();
  } catch (e) {
    logts(`models.json reload failed, keeping previous config: ${e.message}`);
  }
  return modelsMapCache;
}

function extractSystemText(system) {
  if (typeof system === 'string') return system;
  if (Array.isArray(system)) return system.map(b => b.text || '').join(' ');
  return '';
}

function lastUserText(body) {
  const msgs = (body && body.messages) || [];
  for (let i = msgs.length - 1; i >= 0; i--) {
    if (msgs[i].role !== 'user') continue;
    const c = msgs[i].content;
    if (typeof c === 'string') return c;
    if (Array.isArray(c)) {
      const t = c.filter(b => b.type === 'text').map(b => b.text).join(' ');
      const tr = c.filter(b => b.type === 'tool_result').length;
      return t || (tr ? '[' + tr + ' tool_result]' : '');
    }
  }
  return '';
}

function firstUserText(body) {
  const msgs = (body && body.messages) || [];
  for (let i = 0; i < msgs.length; i++) {
    if (msgs[i].role !== 'user') continue;
    const c = msgs[i].content;
    if (typeof c === 'string') return c;
    if (Array.isArray(c)) {
      return c.filter(b => b.type === 'text').map(b => b.text).join('\n');
    }
  }
  return '';
}

function respSummary(aj) {
  const c = aj.content || [];
  const text = c.filter(b => b.type === 'text').map(b => b.text).join(' ');
  const tools = c.filter(b => b.type === 'tool_use').map(b => b.name + '(' + JSON.stringify(b.input).slice(0, 200) + ')');
  return 'id=' + aj.id + ' text=' + JSON.stringify(text.slice(0, 200)) + ' tools=[' + tools.join(', ') + '] stop=' + aj.stop_reason;
}

function renderContent(c) {
  if (typeof c === 'string') return c;
  if (!Array.isArray(c)) return JSON.stringify(c);
  return c.map(b => {
    if (b.type === 'text') return b.text;
    if (b.type === 'tool_use') return '[tool_use ' + b.name + '] ' + JSON.stringify(b.input);
    if (b.type === 'tool_result') return '[tool_result ' + b.tool_use_id + '] ' + renderContent(b.content);
    return '[' + b.type + ']';
  }).join('\n');
}

function fullRequestDump(reqID, alias, model, body) {
  const out = [];
  out.push('[' + reqID + '] ===== REQUEST alias=' + alias + ' model=' + model + ' stream=' + (body.stream === true) + ' tools=' + ((body.tools || []).length) + ' =====');
  out.push('[' + reqID + '] --- system ---');
  out.push(extractSystemText(body.system));
  out.push('[' + reqID + '] --- messages (' + ((body.messages || []).length) + ') ---');
  for (const m of (body.messages || [])) {
    out.push('[' + reqID + '] [' + m.role + '] ' + renderContent(m.content));
  }
  out.push('[' + reqID + '] ===== END REQUEST =====');
  return out.join('\n');
}

function fullResponseDump(reqID, aj) {
  const out = [];
  out.push('[' + reqID + '] ===== RESPONSE id=' + aj.id + ' stop=' + aj.stop_reason + ' =====');
  for (const b of (aj.content || [])) {
    if (b.type === 'text') out.push(b.text);
    else if (b.type === 'tool_use') out.push('[tool_use ' + b.name + '] ' + JSON.stringify(b.input));
  }
  out.push('[' + reqID + '] ===== END RESPONSE =====');
  return out.join('\n');
}

function anthropicErrorType(status) {
  if (status === 429) return 'rate_limit_error';
  if (status === 400) return 'invalid_request_error';
  if (status === 401) return 'authentication_error';
  if (status === 403) return 'permission_error';
  if (status === 404) return 'not_found_error';
  return 'api_error';
}

function toAnthropicErrorBody(status, rawText) {
  let message = rawText.slice(0, 500);
  try {
    const parsed = JSON.parse(rawText);
    if (parsed?.error?.message) message = parsed.error.message;
  } catch {}
  return JSON.stringify({ type: 'error', error: { type: anthropicErrorType(status), message } });
}

function stripRelayNoiseText(s) {
  if (typeof s !== 'string') return '';
  return s
    .replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, '')
    .replace(/You are powered by the model named .+?\. The exact model ID is .+?\./g, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function stripRelayNoise(body) {
  let removed = 0;
  const strip = (s) => {
    if (typeof s !== 'string') return s;
    const out = stripRelayNoiseText(s);
    removed += s.length - out.length;
    return out;
  };
  if (typeof body.system === 'string') {
    body.system = strip(body.system);
  } else if (Array.isArray(body.system)) {
    for (const b of body.system) {
      if (b && typeof b.text === 'string') b.text = strip(b.text);
    }
  }
  for (const m of (body.messages || [])) {
    if (typeof m.content === 'string') {
      m.content = strip(m.content);
    } else if (Array.isArray(m.content)) {
      for (const b of m.content) {
        if (b.type === 'text' && typeof b.text === 'string') b.text = strip(b.text);
      }
      m.content = m.content.filter(b => !(b.type === 'text' && (b.text == null || b.text === '')));
    }
  }
  return removed;
}

function stripLeadingMarkerLine(text) {
  const lines = text.split('\n');
  let i = 0;
  while (i < lines.length && lines[i].trim() === '') i++;
  if (i < lines.length && /^RELAY-MODEL:[ \t]*\S/.test(lines[i])) {
    lines.splice(i, 1);
    return lines.join('\n');
  }
  return text;
}

function removeFirstUserMarkerLine(body) {
  const msgs = (body && body.messages) || [];
  for (let i = 0; i < msgs.length; i++) {
    if (msgs[i].role !== 'user') continue;
    const c = msgs[i].content;
    if (typeof c === 'string') {
      msgs[i].content = stripLeadingMarkerLine(c);
    } else if (Array.isArray(c)) {
      const idx = c.findIndex(b => b.type === 'text' && typeof b.text === 'string');
      if (idx !== -1) c[idx].text = stripLeadingMarkerLine(c[idx].text);
    }
    return;
  }
}

export function sanitizeMarkedBody(body, aliasFromPrompt) {
  const removed = stripRelayNoise(body);
  if (aliasFromPrompt) removeFirstUserMarkerLine(body);
  return removed;
}

const server = http.createServer((req, res) => {
  inflight++;
  if (idleTimer) {
    clearTimeout(idleTimer);
    idleTimer = null;
  }
  let settled = false;
  const onDone = () => {
    if (settled) return;
    settled = true;
    inflight--;
    armIdle();
  };
  res.on('finish', onDone);
  res.on('close', onDone);
  res.on('error', () => {});
  req.on('error', () => {});

  const reqID = randomUUID().slice(0, 8);

  if (req.method === 'HEAD' || req.method === 'GET') {
    if (req.method === 'GET') {
      const pathname = (req.url || '').split('?')[0];
      if (pathname === '/v1/models') {
        const body = JSON.stringify({ ...buildModelsListResponse(getModelsMap()), x_clover_idle_ms: IDLE_MS });
        if (RELAY_LOG) logts(`[${reqID}] GET /v1/models (model discovery) -> ${body}`);
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(body);
        return;
      }
    }
    if (RELAY_LOG) logts(`[${reqID}] ${req.method} ${req.url} (health/other)`);
    res.writeHead(200);
    res.end();
    return;
  }

  if (req.method === 'POST') {
    const pathname = (req.url || '').split('?')[0];
    if (pathname === '/__clover/shutdown') {
      if (IDLE_MS <= 0) {
        res.writeHead(403, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: 'idle reaper disabled on this relay instance' }));
        return;
      }
      const alive = sweepSessions();
      if (alive > 0) {
        res.writeHead(409, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: `${alive} session(s) still registered` }));
        return;
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.on('finish', () => { server.close(() => process.exit(0)); });
      res.end(JSON.stringify({ ok: true }));
      return;
    }
  }

  if (req.method !== 'POST') {
    res.writeHead(405);
    res.end();
    return;
  }

  const chunks = [];
  req.on('data', c => chunks.push(c));
  req.on('end', async () => {
    const rawBody = Buffer.concat(chunks);
    const modelsMap = getModelsMap();

    let alias = null;
    let aliasFromPrompt = false;
    let viaMarker = false;
    let parsedBody = null;
    try {
      parsedBody = JSON.parse(rawBody.toString('utf8'));
      const sysText = extractSystemText(parsedBody.system);
      const ms = sysText.match(MARKER_RE);
      if (ms) {
        alias = ms[1];
        const head = alias.split(',')[0];
        if (head !== alias) {
          logts(`[${reqID}] WARN comma-list marker "${alias}"; relay routes one model; using "${head}"; fan-out is the conductor's job`);
          alias = head;
        }
      }
      if (alias === null) {
        const clean = stripRelayNoiseText(firstUserText(parsedBody));
        const firstLn = clean.split('\n', 1)[0].trim();
        const mp = firstLn.match(PROMPT_MARKER_RE);
        if (mp) { alias = mp[1]; aliasFromPrompt = true; }
      }
      if (alias !== null) viaMarker = true;
      if (alias === null) {
        const direct = resolveDirectModel(parsedBody.model, modelsMap);
        if (direct !== null) {
          alias = direct;
          if (RELAY_LOG) logts(`[${reqID}] resolved via model field: "${parsedBody.model}" -> alias=${alias}`);
        }
      }
    } catch {}

    if (viaMarker && alias !== null && modelsMap.has(alias)) {
      const removed = sanitizeMarkedBody(parsedBody, aliasFromPrompt);
      if (RELAY_LOG && removed > 0) logts(`[${reqID}] stripped ${removed} chars (system-reminders + injected identity)`);
    }

    let upstreamUrl, forwardHeaders, bodyToSend, isOpenAI = false;

    if (alias !== null) {
      const cfg = modelsMap.get(alias);
      const pathname = (req.url || '').split('?')[0];
      if (!cfg) {
        logts(`[${reqID}] WARN unknown alias="${alias}" -> rejecting (fail-closed)`);
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ type: 'error', error: { type: 'invalid_request_error', message: `unknown relay alias: ${alias}. Check clover/models.json` } }));
        return;
      } else if (pathname !== '/v1/messages') {
        if (RELAY_LOG) logts(`[${reqID}] WARN unsupported endpoint for relay route: ${pathname} -> 404 (client falls back to local estimate)`);
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ type: 'error', error: { type: 'not_found_error', message: `clover relay does not support ${pathname} for routed models` } }));
        return;
      } else if (cfg.format === 'openai') {
        isOpenAI = true;
        let oaBody;
        try {
          oaBody = toOpenAIRequest(parsedBody, cfg.model, { effort: cfg.effort, verbosity: cfg.verbosity });
        } catch (e) {
          logts(`[${reqID}] request translate error: ${e.message}`);
          res.writeHead(502, { 'Content-Type': 'application/json' });
          res.end('{"type":"error","error":{"type":"api_error","message":"relay translate failed"}}');
          return;
        }
        oaBody.stream = true;
        oaBody.stream_options = { include_usage: true };
        bodyToSend = Buffer.from(JSON.stringify(oaBody), 'utf8');
        upstreamUrl = cfg.base_url + '/chat/completions';
        if (RELAY_LOG) logts(`[${reqID}] -> alias=${alias} via=${viaMarker ? 'marker' : 'model-field'} model=${cfg.model} stream=${parsedBody.stream === true} tools=${(parsedBody.tools || []).length} in=${JSON.stringify(lastUserText(parsedBody).slice(0, 200))}`);
        forwardHeaders = {};
        for (const [k, v] of Object.entries(req.headers)) {
          if (k === 'host' || k === 'content-length' || k === 'authorization' || k === 'x-api-key' || k === 'accept-encoding' || k === 'anthropic-version' || k === 'anthropic-beta') continue;
          forwardHeaders[k] = v;
        }
        forwardHeaders['authorization'] = 'Bearer ' + cfg.api_key;
        forwardHeaders['content-type'] = 'application/json';
        forwardHeaders['content-length'] = String(bodyToSend.length);
        forwardHeaders['accept-encoding'] = 'identity';
        forwardHeaders['x-clover-trace-id'] = reqID;
      } else {
        if (RELAY_LOG) logts(`[${reqID}] -> alias=${alias} via=${viaMarker ? 'marker' : 'model-field'} model=${cfg.model}`);
        const rewritten = Object.assign({}, parsedBody, { model: cfg.model });
        bodyToSend = Buffer.from(JSON.stringify(rewritten), 'utf8');
        upstreamUrl = cfg.base_url + req.url;
        forwardHeaders = {};
        for (const [k, v] of Object.entries(req.headers)) {
          if (k === 'host' || k === 'content-length' || k === 'authorization' || k === 'x-api-key' || k === 'accept-encoding') continue;
          forwardHeaders[k] = v;
        }
        forwardHeaders['authorization'] = 'Bearer ' + cfg.api_key;
        forwardHeaders['content-type'] = 'application/json';
        forwardHeaders['content-length'] = String(bodyToSend.length);
        forwardHeaders['accept-encoding'] = 'identity';
      }
    }

    if (alias === null) {
      bodyToSend = rawBody;
      upstreamUrl = ANTHROPIC_UPSTREAM + req.url;
      forwardHeaders = {};
      for (const [k, v] of Object.entries(req.headers)) {
        if (k === 'host' || k === 'accept-encoding') continue;
        forwardHeaders[k] = v;
      }
      forwardHeaders['accept-encoding'] = 'identity';
      if (RELAY_LOG && alias === null) logts(`[${reqID}] passthrough agent=${req.headers['x-claude-code-agent-id'] || '-'} ua=${(req.headers['user-agent']||'-').slice(0, 40)} url=${req.url}`);
    }

    if (alias !== null && RELAY_LOG_FULL) {
      logts(fullRequestDump(reqID, alias, modelsMap.get(alias).model, parsedBody));
    }

    const ac = new AbortController();
    const upstreamTimer = setTimeout(() => ac.abort(), RELAY_CONNECT_TIMEOUT_MS);
    const isNativePassthrough = (alias === null);
    try {
      let up;
      let nativeSlotCounted = false;
      if (isNativePassthrough) nativeSlotCounted = await acquireNativeSlot();
      try {
        if (isNativePassthrough && res.destroyed) { clearTimeout(upstreamTimer); return; }
        up = await fetch(upstreamUrl, {
          method: 'POST',
          headers: forwardHeaders,
          body: bodyToSend,
          duplex: 'half',
          signal: ac.signal,
        });

        if (isNativePassthrough && RELAY_NATIVE_MAX_CONCURRENCY > 0 && up.status === 429 && !res.headersSent) {
          const retryAfter = Number(up.headers.get('retry-after'));
          if (Number.isFinite(retryAfter) && retryAfter > 0 && !res.destroyed) {
            await new Promise((r) => setTimeout(r, Math.min(retryAfter, RELAY_NATIVE_RETRY_AFTER_CAP_S) * 1000));
            try { up.body?.cancel(); } catch {}
            up = await fetch(upstreamUrl, {
              method: 'POST',
              headers: forwardHeaders,
              body: bodyToSend,
              duplex: 'half',
              signal: ac.signal,
            });
          }
        }
      } finally {
        if (isNativePassthrough) releaseNativeSlot(nativeSlotCounted);
      }
      clearTimeout(upstreamTimer);

      if (up.status >= 400) {
        logts(`[${reqID}] upstream error alias=${alias ?? 'anthropic'} status=${up.status}`);
        if (isOpenAI) {
          const errText = await up.text();
          const errHeaders = { 'content-type': 'application/json' };
          const retryAfter = up.headers.get('retry-after');
          if (retryAfter) errHeaders['retry-after'] = retryAfter;
          res.writeHead(up.status, errHeaders);
          res.end(toAnthropicErrorBody(up.status, errText));
          return;
        }
      }

      if (isOpenAI && up.status < 400) {
        if (!up.body) { res.end(); return; }
        const routedModel = modelsMap.get(alias)?.model || alias;
        if (parsedBody.stream === true) {
          await streamOpenAIToAnthropic(up.body, res, routedModel, reqID);
        } else {
          const aj = await aggregateOpenAIStreamToAnthropic(up.body, routedModel, reqID);
          if (RELAY_LOG) logts(`[${reqID}] <- ${respSummary(aj)}`);
          if (RELAY_LOG_FULL) logts(fullResponseDump(reqID, aj));
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify(aj));
        }
        return;
      }

      const outHeaders = {};
      for (const [k, v] of up.headers.entries()) {
        outHeaders[k] = v;
      }
      delete outHeaders['transfer-encoding'];

      res.writeHead(up.status, outHeaders);

      if (!up.body) {
        res.end();
        return;
      }

      pipeline(Readable.fromWeb(up.body), res).catch(() => {
        if (!res.writableEnded) res.end();
      });
    } catch (e) {
      clearTimeout(upstreamTimer);
      if (!res.headersSent) {
        const aborted = e.name === 'AbortError';
        res.writeHead(aborted ? 504 : 502, { 'Content-Type': 'application/json' });
        res.end(aborted
          ? '{"type":"error","error":{"type":"timeout_error","message":"relay upstream timeout"}}'
          : '{"type":"error","error":{"type":"api_error","message":"relay forward failed"}}');
      } else {
        res.end();
      }
    }
  });
});

if (!process.env.RELAY_ROUTER_NO_LISTEN) {
  server.listen(PORT, '127.0.0.1', () => {
    armIdle();
  });
}
