import http from 'node:http';
import https from 'node:https';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { StringDecoder } from 'node:string_decoder';
import { hasLiveSessions, sweepSessions } from './lifecycle.mjs';

const PORT = Number(process.env.PORT || 8791);
const RELAY_LOG = process.env.RELAY_LOG === '1';
const IDLE_MS = num(process.env.RELAY_IDLE_MS) ?? 0;
function num(v) {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : undefined;
}
const RELAY_CONNECT_TIMEOUT_MS = num(process.env.RELAY_CONNECT_TIMEOUT_MS) ?? num(process.env.RELAY_UPSTREAM_TIMEOUT_MS) ?? 300000;
const RELAY_IDLE_TIMEOUT_MS = num(process.env.RELAY_IDLE_TIMEOUT_MS) ?? num(process.env.RELAY_UPSTREAM_TIMEOUT_MS) ?? 900000;
const MAX_KEEPALIVE_COUNT = Number(process.env.RELAY_MAX_KEEPALIVE_COUNT || 600);
const logts = (...a) => console.error(new Date().toISOString(), ...a);
const TRACE_ID_RE = /^[0-9a-fA-F-]{1,64}$/;
// gpt-5.5 の思考の深さ・回答の詳しさ。優先順: env > models.json > 既定。
function loadRelayConfig() {
  try {
    const p = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'models.json');
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch { return {}; }
}
const RELAY_CFG = loadRelayConfig();
const REASONING_EFFORT = process.env.CODEX_REASONING_EFFORT || RELAY_CFG.reasoning_effort || 'high';
const TEXT_VERBOSITY = process.env.CODEX_TEXT_VERBOSITY || RELAY_CFG.text_verbosity || 'medium';

export function normEffort(v) {
  const s = String(v || '').trim().toLowerCase().replace(/[-_ ]/g, '');
  if (/^(xhigh|extrahigh|veryhigh|max|maximum)$/.test(s)) return 'xhigh';
  if (s === 'high') return 'high';
  if (/^(medium|med)$/.test(s)) return 'medium';
  if (/^(low|minimal|min)$/.test(s)) return 'low';
  return 'high';
}

export function normVerbosity(v) {
  const s = String(v || '').trim().toLowerCase();
  if (s === 'high') return 'high';
  if (s === 'low') return 'low';
  if (/^(medium|med)$/.test(s)) return 'medium';
  return 'medium';
}

const AUTH_PATH = process.env.CODEX_AUTH_PATH || path.join(os.homedir(), '.codex', 'auth.json');
const UPSTREAM_HOST = 'chatgpt.com';
const UPSTREAM_PATH = '/backend-api/codex/responses';
const USER_AGENT = process.env.CODEX_USER_AGENT || 'codex-relay/0.1.0';
const ORIGINATOR = process.env.CODEX_ORIGINATOR || 'codex-relay';
const OAUTH_TOKEN_URL = 'https://auth.openai.com/oauth/token';
const OAUTH_CLIENT_ID = 'app_EMoamEEZ73f0CkXaXp7hrann';
const OAUTH_REFRESH_TIMEOUT_MS = 30000;
const REFRESH_MARGIN_MS = 5 * 60 * 1000;

let inflight = 0;
let idleTimer = null;

function armIdle() {
  if (IDLE_MS <= 0) return;
  if (idleTimer) { clearTimeout(idleTimer); idleTimer = null; }
  if (inflight > 0) return;
  idleTimer = setTimeout(() => {
    if (hasLiveSessions()) {
      armIdle();
      return;
    }
    server.close(() => process.exit(0));
  }, IDLE_MS);
}

function loadAuthFromDisk() {
  const raw = fs.readFileSync(AUTH_PATH, 'utf8');
  let a;
  try {
    a = JSON.parse(raw);
  } catch {
    throw new Error('auth.json: invalid JSON');
  }
  const accessToken = a?.tokens?.access_token;
  const accountId = a?.tokens?.account_id;
  const refreshToken = a?.tokens?.refresh_token || null;
  if (!accessToken || !accountId) throw new Error('auth.json: missing tokens.access_token or tokens.account_id');
  return { accessToken, accountId, refreshToken };
}

let authLoaderImpl = loadAuthFromDisk;

function loadAuth() {
  return authLoaderImpl();
}

export function __setAuthLoaderForTest(fn) {
  authLoaderImpl = fn || loadAuthFromDisk;
}

export function accessTokenExpiryMs(accessToken) {
  try {
    const parts = accessToken.split('.');
    if (parts.length < 2) return null;
    const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
    if (typeof payload.exp !== 'number') return null;
    return payload.exp * 1000;
  } catch {
    return null;
  }
}

function fetchOAuthToken(refreshToken, signal) {
  return fetch(OAUTH_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      client_id: OAUTH_CLIENT_ID,
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
    }),
    signal,
  });
}

let oauthFetchImpl = fetchOAuthToken;

export function __setOAuthFetchForTest(fn) {
  oauthFetchImpl = fn || fetchOAuthToken;
}

function writeAuthFileAtomic(filePath, data) {
  const dir = path.dirname(filePath);
  const tmp = path.join(dir, `.${path.basename(filePath)}.${randomUUID()}.tmp`);
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, filePath);
}

let refreshInFlight = null;

function doRefresh() {
  return (async () => {
    const raw = fs.readFileSync(AUTH_PATH, 'utf8');
    let current;
    try {
      current = JSON.parse(raw);
    } catch {
      throw new Error('auth.json: invalid JSON');
    }
    const refreshToken = current?.tokens?.refresh_token;
    if (!refreshToken) throw new Error('auth.json: missing tokens.refresh_token, cannot refresh');

    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), OAUTH_REFRESH_TIMEOUT_MS);
    let resp;
    try {
      resp = await oauthFetchImpl(refreshToken, ac.signal);
    } finally {
      clearTimeout(timer);
    }
    if (!resp.ok) {
      throw new Error(`oauth refresh failed: status ${resp.status}`);
    }
    const json = await resp.json();
    if (!json.access_token) throw new Error('oauth refresh response missing access_token');

    current.tokens = current.tokens || {};
    current.tokens.access_token = json.access_token;
    if (json.refresh_token) current.tokens.refresh_token = json.refresh_token;
    if (json.id_token) current.tokens.id_token = json.id_token;
    current.last_refresh = new Date().toISOString();

    writeAuthFileAtomic(AUTH_PATH, current);

    return {
      accessToken: current.tokens.access_token,
      accountId: current.tokens.account_id,
      refreshToken: current.tokens.refresh_token || null,
    };
  })();
}

export function refreshAccessToken() {
  if (refreshInFlight) return refreshInFlight;
  refreshInFlight = doRefresh().finally(() => { refreshInFlight = null; });
  return refreshInFlight;
}

// Chat Completions messages[] -> Responses input[]
// Responses API requires:
//   - function_call items at top level (not nested in message content)
//   - id must start with 'fc_'
//   - call_id is the matching identifier for function_call_output
function chatToInput(messages) {
  const input = [];
  for (const m of messages) {
    if (m.role === 'system') {
      input.push({ type: 'message', role: 'developer', content: [{ type: 'input_text', text: m.content || '' }] });
      continue;
    }
    if (m.role === 'assistant') {
      if (m.content && m.content.length > 0) {
        input.push({ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: m.content }] });
      }
      if (m.tool_calls) {
        for (const tc of m.tool_calls) {
          const callId = tc.id;
          if (!callId) continue;
          const fcId = callId.startsWith('fc_') ? callId : 'fc_' + randomUUID().replace(/-/g, '');
          input.push({ type: 'function_call', id: fcId, call_id: callId, name: tc.function?.name || '', arguments: tc.function?.arguments || '{}', status: 'completed' });
        }
      }
      continue;
    }
    if (m.role === 'tool') {
      if (!m.tool_call_id) continue;
      input.push({ type: 'function_call_output', call_id: m.tool_call_id, output: m.content || '' });
      continue;
    }
    // user
    const text = typeof m.content === 'string' ? m.content : (Array.isArray(m.content) ? m.content.filter(b => b.type === 'text').map(b => b.text).join('\n') : '');
    input.push({ type: 'message', role: 'user', content: [{ type: 'input_text', text }] });
  }
  return input;
}

// Chat Completions tools[] -> Responses tools[]
function chatToResponsesTools(tools) {
  if (!tools || !tools.length) return undefined;
  return tools.map(t => {
    const fn = t.function || t;
    return { type: 'function', name: fn.name, description: fn.description || '', strict: false, parameters: fn.parameters || {} };
  });
}

// Build Responses API request body from Chat Completions body
export function buildResponsesBody(chatBody) {
  const model = (chatBody.model || 'gpt-5.5').trim();
  const messages = chatBody.messages || [];
  let instructions = '';
  const nonSystem = [];
  for (const m of messages) {
    if (m.role === 'system') { instructions = m.content || ''; }
    else nonSystem.push(m);
  }

  const effortRaw = chatBody.reasoning_effort != null ? chatBody.reasoning_effort : REASONING_EFFORT;
  const verbosityRaw = chatBody.verbosity != null ? chatBody.verbosity : TEXT_VERBOSITY;

  const body = {
    model,
    stream: true,
    store: false,
    instructions: instructions || 'You are a helpful assistant.',
    input: chatToInput(nonSystem),
    reasoning: { effort: normEffort(effortRaw) },
    text: { verbosity: normVerbosity(verbosityRaw) },
    client_metadata: { 'x-codex-installation-id': 'codex-relay' },
  };

  const rTools = chatToResponsesTools(chatBody.tools);
  if (rTools) {
    body.tools = rTools;
    body.parallel_tool_calls = true;
  }

  if (chatBody.tool_choice) {
    const tc = chatBody.tool_choice;
    if (typeof tc === 'string') body.tool_choice = tc;
    else if (tc.type === 'function' && tc.function?.name) body.tool_choice = { type: 'function', name: tc.function.name };
    else body.tool_choice = 'auto';
  }

  return body;
}

// SSE helpers
function sseChunk(data) {
  return 'data: ' + JSON.stringify(data) + '\n\n';
}

// Send non-stream Chat Completions response
function makeChatResponse(id, content, toolCalls, finishReason, usage) {
  const message = { role: 'assistant', content: content || null };
  if (toolCalls && toolCalls.length > 0) message.tool_calls = toolCalls;
  return {
    id: id || ('chatcmpl-' + randomUUID().replace(/-/g, '').slice(0, 24)),
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model: 'gpt-5.5',
    choices: [{ index: 0, message, finish_reason: finishReason || 'stop', logprobs: null }],
    usage: usage || { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
  };
}

// Parse SSE stream from Responses API, accumulate all events, return parsed result
export async function parseResponsesSSE(responseStream, reqID, signal) {
  const decoder = new StringDecoder('utf8');
  let buf = '';
  const events = [];

  let onAbort;
  if (signal) {
    onAbort = () => { responseStream.destroy(); };
    signal.addEventListener('abort', onAbort, { once: true });
  }

  let idleTimer = setTimeout(() => responseStream.destroy(new Error('stream idle timeout')), RELAY_IDLE_TIMEOUT_MS);
  const bumpIdle = () => {
    clearTimeout(idleTimer);
    idleTimer = setTimeout(() => responseStream.destroy(new Error('stream idle timeout')), RELAY_IDLE_TIMEOUT_MS);
  };

  try {
    for await (const chunk of responseStream) {
      bumpIdle();
      buf += decoder.write(chunk);
      const lines = buf.split('\n');
      buf = lines.pop();
      for (const line of lines) {
        if (!line.startsWith('data: ')) continue;
        const payload = line.slice(6).trim();
        if (payload === '[DONE]') break;
        try { events.push(JSON.parse(payload)); } catch {}
      }
    }
  } finally {
    clearTimeout(idleTimer);
    if (signal && onAbort) signal.removeEventListener('abort', onAbort);
  }

  buf += decoder.end();
  const remainLines = buf.split('\n');
  buf = remainLines.pop();
  for (const line of remainLines) {
    if (!line.startsWith('data: ')) continue;
    const payload = line.slice(6).trim();
    if (payload === '[DONE]') break;
    try { events.push(JSON.parse(payload)); } catch {}
  }
  if (buf.startsWith('data: ')) {
    const payload = buf.slice(6).trim();
    if (payload && payload !== '[DONE]') {
      try { events.push(JSON.parse(payload)); } catch {}
    }
  }

  // Reconstruct from events
  let text = '';
  let responseId = 'chatcmpl-' + randomUUID().replace(/-/g, '').slice(0, 24);
  // itemId (fc_xxx) -> { callId, name, args }
  const byItemId = new Map();
  let usage = { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 };
  let finishReason = null;

  for (const e of events) {
    if (e.type === 'response.created' && e.response?.id) responseId = e.response.id;

    if (e.type === 'response.output_item.added' && e.item?.type === 'function_call') {
      byItemId.set(e.item.id, { callId: e.item.call_id, name: e.item.name, args: '' });
    }

    if (e.type === 'response.function_call_arguments.delta' && e.item_id) {
      const entry = byItemId.get(e.item_id);
      if (entry) entry.args += e.delta || '';
    }

    if (e.type === 'response.output_item.done' && e.item?.type === 'function_call') {
      const item = e.item;
      const entry = byItemId.get(item.id);
      if (entry) { entry.args = item.arguments || entry.args; }
      else { byItemId.set(item.id, { callId: item.call_id, name: item.name, args: item.arguments || '' }); }
    }

    if (e.type === 'response.output_text.delta' && e.delta) text += e.delta;

    if (e.type === 'response.completed') {
      const u = e.response?.usage;
      if (u) {
        usage = { prompt_tokens: u.input_tokens || 0, completion_tokens: u.output_tokens || 0, total_tokens: u.total_tokens || 0 };
      }
      finishReason = byItemId.size > 0 ? 'tool_calls' : 'stop';
    }
  }

  if (finishReason === null) {
    throw Object.assign(new Error('upstream stream ended prematurely'), { isStreamError: true });
  }

  const toolCalls = [];
  let tcIdx = 0;
  for (const [, entry] of byItemId) {
    toolCalls.push({
      index: tcIdx++,
      id: entry.callId,
      type: 'function',
      function: { name: entry.name, arguments: entry.args || '{}' },
    });
  }

  if (RELAY_LOG) {
    logts('[' + reqID + '] <- events=' + events.length + ' text=' + JSON.stringify(text.slice(0, 100)) + ' tools=' + toolCalls.length + ' finish=' + finishReason);
  }

  return { responseId, text, toolCalls, finishReason, usage };
}

// Stream Responses SSE -> Chat Completions SSE to client
export async function streamResponsesToChatSSE(responseStream, clientRes, reqID, { keepaliveMs = 10000 } = {}) {
  clientRes.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', 'connection': 'keep-alive' });

  const clientKeepalive = setInterval(() => {
    if (!clientRes.writableEnded && !clientRes.destroyed) clientRes.write(': keepalive\n\n');
  }, keepaliveMs);
  clientKeepalive.unref();

  const decoder = new StringDecoder('utf8');
  let buf = '';
  const responseId = 'chatcmpl-' + randomUUID().replace(/-/g, '').slice(0, 24);
  // itemId (fc_xxx) -> { callId, tcIdx }
  const byItemId = new Map();
  let tcNextIdx = 0;
  let toolCallCount = 0;
  let finishReason = null;
  let usage = null;
  let sentFirstChunk = false;
  let streamError = false;

  let writeSeq = 0;
  let keepaliveCount = 0;
  const send = (data) => { if (clientRes.writableEnded || clientRes.destroyed) return; writeSeq++; keepaliveCount = 0; clientRes.write(sseChunk(data)); };

  const onClose = () => { responseStream.destroy(); };
  clientRes.on('close', onClose);

  let idleTimer = setTimeout(() => responseStream.destroy(new Error('stream idle timeout')), RELAY_IDLE_TIMEOUT_MS);
  const bumpIdle = () => {
    clearTimeout(idleTimer);
    idleTimer = setTimeout(() => responseStream.destroy(new Error('stream idle timeout')), RELAY_IDLE_TIMEOUT_MS);
  };

  try {
    for await (const chunk of responseStream) {
      bumpIdle();
      buf += decoder.write(chunk);
      const lines = buf.split('\n');
      buf = lines.pop();

      for (const line of lines) {
        if (!line.startsWith('data: ')) continue;
        const payload = line.slice(6).trim();
        if (payload === '[DONE]') {
          finishReason = finishReason || 'stop';
          break;
        }
        let e;
        try { e = JSON.parse(payload); } catch { continue; }
        const beforeWrite = writeSeq;

        if (
          e.type === 'response.reasoning_summary_text.delta' ||
          e.type === 'response.reasoning.delta' ||
          e.type === 'response.reasoning_summary_part.added' ||
          e.type === 'response.reasoning_summary_part.done'
        ) {
          keepaliveCount = 0;
          continue;
        }

        if (e.type === 'response.output_item.added' && e.item?.type === 'function_call') {
          if (!sentFirstChunk) {
            send({ id: responseId, object: 'chat.completion.chunk', created: Math.floor(Date.now() / 1000), model: 'gpt-5.5', choices: [{ index: 0, delta: { role: 'assistant', content: null }, finish_reason: null }] });
            sentFirstChunk = true;
          }
          const idx = tcNextIdx++;
          toolCallCount++;
          // item.id = fc_xxx (used in delta events as item_id), item.call_id = call_xxx (for Chat Completions)
          byItemId.set(e.item.id, { callId: e.item.call_id, idx, args: '' });
          send({
            id: responseId, object: 'chat.completion.chunk', created: Math.floor(Date.now() / 1000), model: 'gpt-5.5',
            choices: [{ index: 0, delta: { tool_calls: [{ index: idx, id: e.item.call_id, type: 'function', function: { name: e.item.name, arguments: '' } }] }, finish_reason: null }],
          });
        }

        if (e.type === 'response.function_call_arguments.delta' && e.delta) {
          const entry = byItemId.get(e.item_id);
          if (entry != null) {
            entry.args += e.delta;
            send({
              id: responseId, object: 'chat.completion.chunk', created: Math.floor(Date.now() / 1000), model: 'gpt-5.5',
              choices: [{ index: 0, delta: { tool_calls: [{ index: entry.idx, function: { arguments: e.delta } }] }, finish_reason: null }],
            });
          }
        }

        if (e.type === 'response.function_call_arguments.done' && e.item_id) {
          const entry = byItemId.get(e.item_id);
          if (entry != null && e.arguments != null && e.arguments !== entry.args) {
            const missing = e.arguments.slice(entry.args.length);
            if (missing.length > 0) {
              entry.args = e.arguments;
              send({
                id: responseId, object: 'chat.completion.chunk', created: Math.floor(Date.now() / 1000), model: 'gpt-5.5',
                choices: [{ index: 0, delta: { tool_calls: [{ index: entry.idx, function: { arguments: missing } }] }, finish_reason: null }],
              });
            }
          }
        }

        if (e.type === 'response.output_item.done' && e.item?.type === 'function_call') {
          const item = e.item;
          const entry = byItemId.get(item.id);
          if (entry == null) {
            // item not seen via added — register and emit full header + arguments now
            const idx = tcNextIdx++;
            toolCallCount++;
            const newEntry = { callId: item.call_id, idx, args: item.arguments || '' };
            byItemId.set(item.id, newEntry);
            if (!sentFirstChunk) {
              send({ id: responseId, object: 'chat.completion.chunk', created: Math.floor(Date.now() / 1000), model: 'gpt-5.5', choices: [{ index: 0, delta: { role: 'assistant', content: null }, finish_reason: null }] });
              sentFirstChunk = true;
            }
            send({
              id: responseId, object: 'chat.completion.chunk', created: Math.floor(Date.now() / 1000), model: 'gpt-5.5',
              choices: [{ index: 0, delta: { tool_calls: [{ index: idx, id: item.call_id, type: 'function', function: { name: item.name, arguments: item.arguments || '{}' } }] }, finish_reason: null }],
            });
          } else if (item.arguments != null && item.arguments !== entry.args) {
            const missing = item.arguments.slice(entry.args.length);
            if (missing.length > 0) {
              entry.args = item.arguments;
              send({
                id: responseId, object: 'chat.completion.chunk', created: Math.floor(Date.now() / 1000), model: 'gpt-5.5',
                choices: [{ index: 0, delta: { tool_calls: [{ index: entry.idx, function: { arguments: missing } }] }, finish_reason: null }],
              });
            }
          }
        }

        if (e.type === 'response.output_text.delta' && e.delta) {
          if (!sentFirstChunk) {
            send({ id: responseId, object: 'chat.completion.chunk', created: Math.floor(Date.now() / 1000), model: 'gpt-5.5', choices: [{ index: 0, delta: { role: 'assistant', content: '' }, finish_reason: null }] });
            sentFirstChunk = true;
          }
          send({ id: responseId, object: 'chat.completion.chunk', created: Math.floor(Date.now() / 1000), model: 'gpt-5.5', choices: [{ index: 0, delta: { content: e.delta }, finish_reason: null }] });
        }

        if (e.type === 'response.completed') {
          finishReason = toolCallCount > 0 ? 'tool_calls' : 'stop';
          const u = e.response?.usage;
          if (u) usage = { prompt_tokens: u.input_tokens || 0, completion_tokens: u.output_tokens || 0, total_tokens: u.total_tokens || 0 };
        }

        if (writeSeq === beforeWrite) {
          keepaliveCount++;
          if (keepaliveCount > MAX_KEEPALIVE_COUNT) {
            logts('[' + reqID + '] keepalive limit exceeded (' + keepaliveCount + '/' + MAX_KEEPALIVE_COUNT + ') -> force abort');
            streamError = true;
            break;
          }
        }
      }
      if (streamError) break;
    }
    const tail = decoder.end();
    if (tail) {
      buf += tail;
      const tailLines = buf.split('\n');
      buf = tailLines.pop();
      for (const line of tailLines) {
        if (!line.startsWith('data: ')) continue;
        const payload = line.slice(6).trim();
        if (payload === '[DONE]') { finishReason = finishReason || 'stop'; break; }
        let e; try { e = JSON.parse(payload); } catch { continue; }
        if (e.type === 'response.output_text.delta' && e.delta) {
          send({ id: responseId, object: 'chat.completion.chunk', created: Math.floor(Date.now() / 1000), model: 'gpt-5.5', choices: [{ index: 0, delta: { content: e.delta }, finish_reason: null }] });
        }
      }
    }
  } catch (err) {
    if (err.code !== 'ERR_STREAM_DESTROYED') {
      streamError = true;
      logts('[' + reqID + '] stream error: ' + err.message);
    }
  } finally {
    clearTimeout(idleTimer);
    clearInterval(clientKeepalive);
    clientRes.off('close', onClose);
  }

  if (RELAY_LOG) logts('[' + reqID + '] stream done finish=' + (finishReason || (streamError ? 'error' : 'stop')) + ' tools=' + toolCallCount);

  if (streamError || finishReason === null) {
    // abnormal termination — signal error to caller, do not send stop chunk
    if (!clientRes.writableEnded) {
      try {
        clientRes.write('data: {"error":{"message":"upstream stream ended prematurely","type":"upstream_error"}}\n\n');
      } catch {}
      clientRes.end();
    }
    return;
  }

  // Normal completion — send finish chunk and [DONE]
  if (!clientRes.writableEnded && !clientRes.destroyed) {
    send({
      id: responseId, object: 'chat.completion.chunk', created: Math.floor(Date.now() / 1000), model: 'gpt-5.5',
      choices: [{ index: 0, delta: {}, finish_reason: finishReason }],
      usage: usage || undefined,
    });
    clientRes.write('data: [DONE]\n\n');
    clientRes.end();
  }
}

// Make HTTPS request to Responses API, return { status, headers, stream }
function requestResponsesViaHttps(bodyStr, auth, signal) {
  return new Promise((resolve, reject) => {
    const options = {
      hostname: UPSTREAM_HOST,
      port: 443,
      path: UPSTREAM_PATH,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(bodyStr),
        'Accept': 'text/event-stream',
        'Authorization': 'Bearer ' + auth.accessToken,
        'ChatGPT-Account-ID': auth.accountId,
        'originator': ORIGINATOR,
        'User-Agent': USER_AGENT,
      },
      signal,
    };
    const req = https.request(options, (res) => resolve({ status: res.statusCode, headers: res.headers, stream: res }));
    req.on('error', (err) => {
      if (err.name === 'AbortError') reject(Object.assign(new Error('upstream request timed out'), { isAbort: true }));
      else reject(err);
    });
    req.write(bodyStr);
    req.end();
  });
}

let requestResponsesImpl = requestResponsesViaHttps;

function requestResponses(bodyStr, auth, signal) {
  return requestResponsesImpl(bodyStr, auth, signal);
}

export function __setRequestResponsesForTest(fn) {
  requestResponsesImpl = fn || requestResponsesViaHttps;
}

export function resolveReqId(headers) {
  const incomingTraceId = headers && headers['x-clover-trace-id'];
  return (typeof incomingTraceId === 'string' && TRACE_ID_RE.test(incomingTraceId))
    ? incomingTraceId
    : randomUUID().slice(0, 8);
}

export async function handle(req, res, reqID) {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const rawBody = Buffer.concat(chunks);

  let chatBody;
  try { chatBody = JSON.parse(rawBody.toString('utf8')); }
  catch { res.writeHead(400, { 'Content-Type': 'application/json' }); res.end('{"error":{"message":"invalid JSON"}}'); return; }

  let auth;
  try { auth = loadAuth(); }
  catch {
    logts('[' + reqID + '] auth load failed');
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end('{"error":{"message":"auth load failed"}}');
    return;
  }

  if (auth.refreshToken) {
    const expMs = accessTokenExpiryMs(auth.accessToken);
    if (expMs != null && expMs - Date.now() < REFRESH_MARGIN_MS) {
      try {
        auth = await refreshAccessToken();
        if (RELAY_LOG) logts('[' + reqID + '] pre-emptive token refresh ok');
      } catch (e) {
        logts('[' + reqID + '] pre-emptive token refresh failed: ' + e.message);
      }
    }
  }

  const responsesBody = buildResponsesBody(chatBody);
  const bodyStr = JSON.stringify(responsesBody);

  if (RELAY_LOG) {
    logts('[' + reqID + '] -> model=' + responsesBody.model + ' stream=' + responsesBody.stream + ' tools=' + (responsesBody.tools?.length || 0) + ' input_items=' + responsesBody.input.length);
  }

  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), RELAY_CONNECT_TIMEOUT_MS);
  let activeSignal = ac.signal;

  let upResp;
  try { upResp = await requestResponses(bodyStr, auth, ac.signal); }
  catch (e) {
    clearTimeout(timer);
    if (e.isAbort) {
      logts('[' + reqID + '] upstream request timed out');
      res.writeHead(504, { 'Content-Type': 'application/json' });
      res.end('{"error":{"message":"upstream request timed out"}}');
    } else {
      logts('[' + reqID + '] upstream request error: ' + e.message);
      res.writeHead(502, { 'Content-Type': 'application/json' });
      res.end('{"error":{"message":"upstream request failed"}}');
    }
    return;
  }
  clearTimeout(timer);

  if (upResp.status === 401) {
    upResp.stream.resume();
    let refreshed = false;
    let auth3 = null;
    try {
      const auth2 = loadAuth();
      if (auth2.accessToken !== auth.accessToken) {
        auth3 = auth2;
      } else if (auth2.refreshToken) {
        auth3 = await refreshAccessToken();
      }
    } catch (e) {
      logts('[' + reqID + '] token refresh after 401 failed: ' + e.message);
    }
    if (auth3) {
      const ac2 = new AbortController();
      const timer2 = setTimeout(() => ac2.abort(), RELAY_CONNECT_TIMEOUT_MS);
      try {
        const upResp2 = await requestResponses(bodyStr, auth3, ac2.signal);
        clearTimeout(timer2);
        if (upResp2.status < 400) { upResp = upResp2; activeSignal = ac2.signal; refreshed = true; }
        else { upResp2.stream.resume(); }
      } catch { clearTimeout(timer2); }
    }
    if (!refreshed) {
      clearTimeout(timer);
      logts('[' + reqID + '] 401 from upstream (token expired -- run `codex login` to refresh)');
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end('{"error":{"message":"upstream 401: token expired, run codex login to refresh"}}');
      return;
    }
  }

  if (upResp.status === 429) {
    clearTimeout(timer);
    upResp.stream.resume();
    logts('[' + reqID + '] 429 rate limit from upstream');
    const headers429 = { 'Content-Type': 'application/json' };
    if (upResp.headers['retry-after']) headers429['Retry-After'] = upResp.headers['retry-after'];
    res.writeHead(429, headers429);
    res.end('{"error":{"message":"rate limit exceeded (429 from upstream)"}}');
    return;
  }

  if (upResp.status >= 400) {
    const errChunks = [];
    let errDone = false;
    await new Promise((resolve) => {
      const errTimer = setTimeout(() => {
        if (!errDone) { errDone = true; resolve(); }
      }, 5000);
      upResp.stream.on('data', c => errChunks.push(c));
      upResp.stream.on('end', () => {
        clearTimeout(errTimer);
        if (!errDone) { errDone = true; resolve(); }
      });
      upResp.stream.on('error', () => {
        clearTimeout(errTimer);
        if (!errDone) { errDone = true; resolve(); }
      });
    });
    clearTimeout(timer);
    const errText = Buffer.concat(errChunks).toString('utf8');
    logts('[' + reqID + '] upstream error ' + upResp.status + ' model=' + responsesBody.model + ' effort=' + responsesBody.reasoning?.effort + ' verbosity=' + responsesBody.text?.verbosity + ': ' + errText.slice(0, 200));
    res.writeHead(upResp.status, { 'Content-Type': 'application/json' });
    res.end('{"error":{"message":"upstream error ' + upResp.status + '"}}');
    return;
  }

  if (chatBody.stream === true) {
    clearTimeout(timer);
    await streamResponsesToChatSSE(upResp.stream, res, reqID);
  } else {
    try {
      const result = await parseResponsesSSE(upResp.stream, reqID, activeSignal);
      clearTimeout(timer);
      const chatResp = makeChatResponse(result.responseId, result.text || null, result.toolCalls.length > 0 ? result.toolCalls : undefined, result.finishReason, result.usage);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(chatResp));
    } catch (e) {
      clearTimeout(timer);
      logts('[' + reqID + '] parseResponsesSSE error: ' + e.message);
      res.writeHead(502, { 'Content-Type': 'application/json' });
      res.end('{"error":{"message":"upstream stream ended prematurely"}}');
    }
  }
}

const server = http.createServer((req, res) => {
  inflight++;
  if (idleTimer) { clearTimeout(idleTimer); idleTimer = null; }
  let settled = false;
  const onDone = () => { if (settled) return; settled = true; inflight--; armIdle(); };
  res.on('finish', onDone);
  res.on('close', onDone);
  res.on('error', () => {});
  req.on('error', () => {});

  const reqID = resolveReqId(req.headers);

  if (req.method === 'HEAD' || req.method === 'GET') {
    res.writeHead(200);
    res.end();
    return;
  }

  if (req.method === 'POST' && (req.url || '').split('?')[0] === '/__clover/shutdown') {
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

  if (req.method !== 'POST') {
    res.writeHead(405);
    res.end();
    return;
  }

  handle(req, res, reqID).catch(e => {
    logts('[' + reqID + '] unhandled error: ' + e.message);
    if (!res.headersSent) { res.writeHead(500, { 'Content-Type': 'application/json' }); }
    if (!res.writableEnded) res.end('{"error":{"message":"internal error"}}');
  });
});

if (!process.env.RELAY_SHIM_NO_LISTEN) {
  server.listen(PORT, '127.0.0.1', () => {
    logts('codex-responses-shim listening on 127.0.0.1:' + PORT);
    armIdle();
  });
}
