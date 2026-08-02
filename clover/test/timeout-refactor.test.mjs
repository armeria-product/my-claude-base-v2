import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import {
  streamOpenAIToAnthropic,
  aggregateOpenAIStreamToAnthropic,
} from '../src/openai-adapter.mjs';

function sseStream(chunks, { delayMs = 0 } = {}) {
  return new ReadableStream({
    async start(controller) {
      const encoder = new TextEncoder();
      for (const chunk of chunks) {
        if (delayMs > 0) await new Promise(r => setTimeout(r, delayMs));
        controller.enqueue(encoder.encode(chunk));
      }
      controller.close();
    },
  });
}

function stallingStream(chunks, { gapMs }) {
  return new ReadableStream({
    async start(controller) {
      const encoder = new TextEncoder();
      for (const chunk of chunks) {
        controller.enqueue(encoder.encode(chunk));
      }
      await new Promise(r => setTimeout(r, gapMs));
      try { controller.close(); } catch {}
    },
  });
}

function sse(obj) {
  return 'data: ' + JSON.stringify(obj) + '\n\n';
}

class MockRes extends EventEmitter {
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
  end() {
    this.writableEnded = true;
    this.emit('finish');
  }
  events() {
    return this.writes
      .join('')
      .split('\n\n')
      .filter(Boolean)
      .map(block => {
        const lines = block.split('\n');
        const eventLine = lines.find(l => l.startsWith('event: '));
        const dataLine = lines.find(l => l.startsWith('data: '));
        return {
          event: eventLine ? eventLine.slice(7) : null,
          data: dataLine ? JSON.parse(dataLine.slice(6)) : null,
        };
      });
  }
}

test('aggregateOpenAIStreamToAnthropic: content + split tool_call + usage + [DONE]', async () => {
  const chunks = [
    sse({ id: 'chatcmpl-abc', choices: [{ delta: { role: 'assistant', content: '' } }] }),
    sse({ choices: [{ delta: { content: 'Hello ' } }] }),
    sse({ choices: [{ delta: { content: 'world' } }] }),
    sse({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_1', function: { name: 'get_weather', arguments: '' } }] } }] }),
    sse({ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '{"city":' } }] } }] }),
    sse({ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '"NYC"}' } }] } }] }),
    sse({ choices: [{ delta: {}, finish_reason: 'tool_calls' }], usage: { prompt_tokens: 42, completion_tokens: 7 } }),
    'data: [DONE]\n\n',
  ];

  const webBody = sseStream(chunks);
  const msg = await aggregateOpenAIStreamToAnthropic(webBody, 'gpt-5-5', 'req1');

  assert.equal(msg.type, 'message');
  assert.equal(msg.role, 'assistant');
  assert.equal(msg.model, 'gpt-5-5');
  assert.equal(msg.id, 'chatcmpl-abc');

  const textBlock = msg.content.find(b => b.type === 'text');
  assert.ok(textBlock, 'expected a text block');
  assert.equal(textBlock.text, 'Hello world');

  const toolBlocks = msg.content.filter(b => b.type === 'tool_use');
  assert.equal(toolBlocks.length, 1);
  assert.equal(toolBlocks[0].name, 'get_weather');
  assert.deepEqual(toolBlocks[0].input, { city: 'NYC' });

  assert.equal(msg.usage.input_tokens, 42);
  assert.equal(msg.usage.output_tokens, 7);
  assert.equal(msg.stop_reason, 'tool_use');
});

test('streamOpenAIToAnthropic: emits message_start/content_block_start/delta/message_delta/message_stop', async () => {
  const chunks = [
    sse({ id: 'chatcmpl-xyz', choices: [{ delta: { role: 'assistant', content: '' } }] }),
    sse({ choices: [{ delta: { content: 'Hi' } }] }),
    sse({ choices: [{ delta: {}, finish_reason: 'stop' }], usage: { completion_tokens: 3 } }),
    'data: [DONE]\n\n',
  ];
  const webBody = sseStream(chunks);
  const res = new MockRes();

  await streamOpenAIToAnthropic(webBody, res, 'gpt-5.4-mini', 'req2');

  const events = res.events();
  const types = events.map(e => e.event);

  assert.ok(types.includes('message_start'));
  assert.ok(types.includes('content_block_start'));
  assert.ok(types.includes('content_block_delta'));
  assert.ok(types.includes('message_delta'));
  assert.ok(types.includes('message_stop'));

  const messageDelta = events.find(e => e.event === 'message_delta');
  assert.equal(messageDelta.data.delta.stop_reason, 'end_turn');

  const contentDelta = events.find(e => e.event === 'content_block_delta');
  assert.equal(contentDelta.data.delta.text, 'Hi');

  assert.ok(res.writableEnded);
});

test('streamOpenAIToAnthropic: upstream comment lines are forwarded as keepalive comments', async () => {
  const chunks = [
    sse({ id: 'chatcmpl-ka', choices: [{ delta: { role: 'assistant', content: '' } }] }),
    ': keepalive\n\n',
    sse({ choices: [{ delta: { content: 'Hi' } }] }),
    sse({ choices: [{ delta: {}, finish_reason: 'stop' }], usage: { completion_tokens: 1 } }),
    'data: [DONE]\n\n',
  ];
  const webBody = sseStream(chunks);
  const res = new MockRes();

  await streamOpenAIToAnthropic(webBody, res, 'gpt-5.4-mini', 'req5');

  const rawOutput = res.writes.join('');
  assert.ok(rawOutput.includes(': keepalive\n\n'), 'expected a forwarded keepalive comment line');
  assert.ok(res.writableEnded);
});

test('streamOpenAIToAnthropic: an independent client keepalive fires during total silence, and its interval is cleared when the stream ends (no leaked timer)', async () => {
  const webBody = stallingStream([], { gapMs: 120 });
  const res = new MockRes();

  const originalSetInterval = global.setInterval;
  const originalClearInterval = global.clearInterval;
  let createdHandle = null;
  const clearedHandles = [];
  global.setInterval = (fn, ms) => { createdHandle = originalSetInterval(fn, ms); return createdHandle; };
  global.clearInterval = (h) => { clearedHandles.push(h); return originalClearInterval(h); };

  try {
    await streamOpenAIToAnthropic(webBody, res, 'gpt-5-5', 'req-stall', { keepaliveMs: 20 });
  } finally {
    global.setInterval = originalSetInterval;
    global.clearInterval = originalClearInterval;
  }

  const rawOutput = res.writes.join('');
  const keepaliveCount = rawOutput.split(': keepalive\n\n').length - 1;
  assert.ok(keepaliveCount >= 1, 'expected the independent client keepalive to write at least once during total silence (no events at all)');
  assert.ok(createdHandle, 'expected the keepalive interval to be created');
  assert.ok(clearedHandles.includes(createdHandle), 'expected the keepalive interval to be cleared when the stream finished (no leaked timer)');
  assert.ok(res.writableEnded);
});

test('aggregateOpenAIStreamToAnthropic: idle timeout destroys a stalling stream', async () => {
  process.env.RELAY_IDLE_TIMEOUT_MS = '50';
  try {
    const chunks = [
      sse({ id: 'chatcmpl-stall', choices: [{ delta: { role: 'assistant', content: '' } }] }),
    ];
    const webBody = stallingStream(chunks, { gapMs: 500 });

    await assert.rejects(
      () => aggregateOpenAIStreamToAnthropic(webBody, 'gpt-5-5', 'req3'),
      /idle timeout|prematurely|finish_reason/i,
    );
  } finally {
    delete process.env.RELAY_IDLE_TIMEOUT_MS;
  }
});

test('aggregateOpenAIStreamToAnthropic: within-idle-window stream does not false-fire', async () => {
  process.env.RELAY_IDLE_TIMEOUT_MS = '500';
  try {
    const chunks = [
      sse({ id: 'chatcmpl-ok', choices: [{ delta: { role: 'assistant', content: '' } }] }),
      sse({ choices: [{ delta: { content: 'still here' } }] }),
      sse({ choices: [{ delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 1, completion_tokens: 2 } }),
      'data: [DONE]\n\n',
    ];
    const webBody = sseStream(chunks, { delayMs: 20 });

    const msg = await aggregateOpenAIStreamToAnthropic(webBody, 'gpt-5-5', 'req4');
    assert.equal(msg.content[0].text, 'still here');
    assert.equal(msg.stop_reason, 'end_turn');
  } finally {
    delete process.env.RELAY_IDLE_TIMEOUT_MS;
  }
});
