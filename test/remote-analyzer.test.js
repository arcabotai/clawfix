import assert from 'node:assert/strict';
import { ReadableStream } from 'node:stream/web';
import test from 'node:test';
import { TextEncoder } from 'node:util';

import {
  createRemoteAnalyzer,
  createSseParser,
  sanitizeAssistantText,
  validateInboundAgentEvent,
} from '../cli/adapters/remote-analyzer.js';
import {
  buildDisclosure,
  buildOutboundAgentPayload,
  projectAgentV2Request,
  projectAvailableRepairs,
  resolveDestination,
} from '../cli/core/privacy.js';

const GATEWAY = Object.freeze({
  id: 'gateway-not-running',
  title: 'Restart the OpenClaw gateway',
  risk: 'low',
});

function encode(text) {
  return new TextEncoder().encode(text);
}

function sseResponse(chunks, { status = 200, headers = {} } = {}) {
  const stream = new ReadableStream({
    start(controller) {
      for (const chunk of chunks) {
        controller.enqueue(typeof chunk === 'string' ? encode(chunk) : chunk);
      }
      controller.close();
    },
  });
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: {
      get(name) {
        const key = String(name).toLowerCase();
        const map = {
          'content-type': 'text/event-stream; charset=utf-8',
          ...Object.fromEntries(
            Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]),
          ),
        };
        return map[key] ?? null;
      },
    },
    body: stream,
    async json() {
      throw new Error('not json');
    },
    async text() {
      return chunks.join('');
    },
  };
}

async function collect(asyncIterable) {
  const events = [];
  for await (const event of asyncIterable) events.push(event);
  return events;
}

// ---------------------------------------------------------------------------
// Privacy / projection
// ---------------------------------------------------------------------------

test('resolveDestination and buildDisclosure expose exact host and provider chain', () => {
  const dest = resolveDestination('https://clawfix.dev');
  assert.equal(dest.hostname, 'clawfix.dev');
  assert.equal(dest.endpointUrl, 'https://clawfix.dev/api/v2/agent/messages');

  const disclosure = buildDisclosure({ baseUrl: 'https://clawfix.dev' });
  assert.equal(disclosure.destination, 'clawfix.dev');
  assert.match(disclosure.providerLabel, /ClawFix service/);
  assert.match(disclosure.providerLabel, /OpenRouter/);
  assert.ok(disclosure.included.length > 0);
  assert.ok(disclosure.excluded.some((line) => /shell/i.test(line)));
});

test('custom server disclosure names the exact hostname', () => {
  const disclosure = buildDisclosure({ baseUrl: 'https://repair.example.com:8443' });
  assert.equal(disclosure.destination, 'repair.example.com');
  assert.match(disclosure.providerLabel, /repair\.example\.com/);
  assert.equal(disclosure.endpointUrl, 'https://repair.example.com:8443/api/v2/agent/messages'.replace(':8443', ':8443'));
  // URL origin includes port when non-default
  assert.equal(disclosure.baseUrl, 'https://repair.example.com:8443');
});

test('projectAvailableRepairs strips to id/title/risk and rejects shell fields', () => {
  const projected = projectAvailableRepairs([GATEWAY]);
  assert.deepEqual(projected, [GATEWAY]);
  assert.throws(
    () => projectAvailableRepairs([{ ...GATEWAY, shell: 'rm -rf /' }]),
    /shell/,
  );
  assert.throws(
    () => projectAvailableRepairs([{ id: 'x', command: 'id' }]),
    /command/,
  );
});

test('buildOutboundAgentPayload redacts secrets at the network boundary', () => {
  const payload = buildOutboundAgentPayload({
    conversationId: 'conv-12345678',
    message: 'token=sk-or-v1-deadbeefdeadbeef and help me',
    availableRepairs: [GATEWAY],
  });
  assert.equal(payload.availableRepairs[0].id, 'gateway-not-running');
  assert.equal(JSON.stringify(payload).includes('sk-or-v1-deadbeef'), false);
  assert.match(payload.message, /REDACTED|token=/i);
});

test('projectAgentV2Request rejects short conversation ids and empty messages', () => {
  assert.throws(() => projectAgentV2Request({ conversationId: 'short', message: 'hi' }), /conversationId/);
  assert.throws(() => projectAgentV2Request({ conversationId: 'conv-12345678', message: '   ' }), /message/);
});

// ---------------------------------------------------------------------------
// SSE parser
// ---------------------------------------------------------------------------

test('createSseParser reassembles fragmented frames across chunk boundaries', () => {
  const parser = createSseParser();
  const parts = [
    'event: assistant',
    '.delta\ndata: {"text":"Hel',
    'lo"}\n\nevent: agent.done\ndata: {"conversationId":"c1","repairProposed":false}\n\n',
  ];
  const frames = [];
  for (const part of parts) frames.push(...parser.push(part));
  frames.push(...parser.end());

  assert.equal(frames.length, 2);
  assert.equal(frames[0].event, 'assistant.delta');
  assert.equal(JSON.parse(frames[0].data).text, 'Hello');
  assert.equal(frames[1].event, 'agent.done');
});

test('createSseParser supports multi-line data fields and ignores comments', () => {
  const parser = createSseParser();
  const frames = parser.push(
    ': keep-alive\n'
    + 'event: assistant.delta\n'
    + 'data: {"text":"line1\\n'
    + 'data: still-json-broken"}\n\n',
  );
  // Second data line concatenates with newline per SSE — resulting JSON may be malformed;
  // parser still delivers the frame for higher-level validation.
  assert.equal(frames.length, 1);
  assert.equal(frames[0].event, 'assistant.delta');
  assert.match(frames[0].data, /line1/);
});

// ---------------------------------------------------------------------------
// Inbound validation
// ---------------------------------------------------------------------------

test('validateInboundAgentEvent accepts deltas and rejects shell-bearing payloads', () => {
  const delta = validateInboundAgentEvent('assistant.delta', '{"text":"hi\\u001b[31m"}');
  assert.equal(delta.type, 'assistant.delta');
  assert.equal(delta.text.includes('\u001b'), false);

  const shell = validateInboundAgentEvent('repair.proposed', {
    repairId: 'gateway-not-running',
    rationale: 'x',
    shell: 'rm -rf /',
  }, {
    knownRepairIds: new Set(['gateway-not-running']),
    availableRepairIds: new Set(['gateway-not-running']),
  });
  assert.equal(shell.type, 'remote.rejected');
  assert.equal(shell.reason, 'forbidden_field');
});

test('validateInboundAgentEvent revalidates repair IDs against local catalog and turn list', () => {
  const invented = validateInboundAgentEvent('repair.proposed', {
    repairId: 'drop-database',
    rationale: 'nope',
  }, {
    knownRepairIds: new Set(['gateway-not-running']),
    availableRepairIds: new Set(['gateway-not-running']),
  });
  assert.equal(invented.type, 'repair.rejected');
  assert.equal(invented.reason, 'not_in_local_catalog');

  const notInTurn = validateInboundAgentEvent('repair.proposed', {
    repairId: 'gateway-not-running',
    rationale: 'ok',
  }, {
    knownRepairIds: new Set(['gateway-not-running']),
    availableRepairIds: new Set(['other-repair']),
  });
  assert.equal(notInTurn.type, 'repair.rejected');
  assert.equal(notInTurn.reason, 'not_in_available_repairs');

  const ok = validateInboundAgentEvent('repair.proposed', {
    repairId: 'gateway-not-running',
    rationale: 'Gateway down',
  }, {
    knownRepairIds: new Set(['gateway-not-running']),
    availableRepairIds: new Set(['gateway-not-running']),
  });
  assert.equal(ok.type, 'repair.proposed');
  assert.equal(ok.repairId, 'gateway-not-running');
});

test('sanitizeAssistantText strips controls and bounds length', () => {
  assert.equal(sanitizeAssistantText('a\u0000b\u001bc'), 'ab\u001bc'.replace(/\u001b/, '') || 'ab');
  // More precise:
  const cleaned = sanitizeAssistantText('x\u0007y\u001b[0mz');
  assert.equal(cleaned.includes('\u0007'), false);
  assert.equal(cleaned.includes('\u001b'), false);
  assert.equal(sanitizeAssistantText('a'.repeat(100), { maxChars: 10 }).length, 10);
});

// ---------------------------------------------------------------------------
// createRemoteAnalyzer end-to-end with mock fetch
// ---------------------------------------------------------------------------

test('createRemoteAnalyzer requires explicit consent and never fetches without it', async () => {
  let fetchCalls = 0;
  const analyzer = createRemoteAnalyzer({
    baseUrl: 'https://clawfix.dev',
    fetchImpl: async () => {
      fetchCalls += 1;
      throw new Error('should not fetch');
    },
    knownRepairIds: ['gateway-not-running'],
  });

  const events = await collect(analyzer.analyze({
    message: 'help',
    conversationId: 'conv-12345678',
    availableRepairs: [GATEWAY],
    // consentGranted omitted
  }));

  assert.equal(fetchCalls, 0);
  assert.equal(events[0].type, 'privacy.approval-required');
  assert.equal(events[0].disclosure.destination, 'clawfix.dev');
});

test('analyze streams fragmented SSE, validates repairs, and never surfaces shell', async () => {
  const requests = [];
  const sse =
    'event: agent.meta\ndata: {"conversationId":"conv-12345678","protocol":"clawfix.agent.v2"}\n\n'
    + 'event: assistant.delta\ndata: {"text":"I can restart "}\n\n'
    + 'event: assistant.delta\ndata: {"text":"the gateway."}\n\n'
    + 'event: repair.proposed\ndata: {"repairId":"gateway-not-running","rationale":"Gateway is down"}\n\n'
    + 'event: agent.done\ndata: {"conversationId":"conv-12345678","repairProposed":true,"repairId":"gateway-not-running"}\n\n';

  // Fragment every 17 bytes to stress the parser.
  const chunks = [];
  for (let i = 0; i < sse.length; i += 17) chunks.push(sse.slice(i, i + 17));

  const analyzer = createRemoteAnalyzer({
    baseUrl: 'https://clawfix.dev',
    knownRepairIds: new Set(['gateway-not-running']),
    fetchImpl: async (url, init) => {
      requests.push({ url, init });
      return sseResponse(chunks);
    },
  });

  const events = await collect(analyzer.analyze({
    message: 'Telegram bot silent sk-or-v1-secretvalue99',
    conversationId: 'conv-12345678',
    availableRepairs: [GATEWAY],
    consentGranted: true,
  }));

  assert.equal(requests.length, 1);
  assert.equal(requests[0].url, 'https://clawfix.dev/api/v2/agent/messages');
  assert.equal(requests[0].init.method, 'POST');
  const sent = JSON.parse(requests[0].init.body);
  assert.equal(sent.availableRepairs[0].id, 'gateway-not-running');
  assert.equal(Object.prototype.hasOwnProperty.call(sent.availableRepairs[0], 'shell'), false);
  assert.equal(JSON.stringify(sent).includes('sk-or-v1-secretvalue99'), false);

  assert.equal(events[0].type, 'assistant.started');
  assert.equal(events[0].disclosure.destination, 'clawfix.dev');

  const deltas = events.filter((e) => e.type === 'assistant.delta');
  assert.deepEqual(deltas.map((d) => d.text), ['I can restart ', 'the gateway.']);

  const proposed = events.find((e) => e.type === 'repair.proposed');
  assert.equal(proposed.repairId, 'gateway-not-running');
  assert.equal(Object.prototype.hasOwnProperty.call(proposed, 'shell'), false);

  const done = events.filter((e) => e.type === 'agent.done');
  assert.equal(done.length, 1);
  assert.equal(done[0].repairProposed, true);

  const serialized = JSON.stringify(events);
  assert.doesNotMatch(serialized, /rm -rf|bash -c|powershell/i);
});

test('invented repair ids from the server are rejected and not proposed', async () => {
  const sse =
    'event: assistant.delta\ndata: {"text":"bad idea"}\n\n'
    + 'event: repair.proposed\ndata: {"repairId":"drop-database","rationale":"no"}\n\n'
    + 'event: agent.done\ndata: {"conversationId":"conv-12345678","repairProposed":true,"repairId":"drop-database"}\n\n';

  const analyzer = createRemoteAnalyzer({
    baseUrl: 'https://clawfix.dev',
    knownRepairIds: ['gateway-not-running'],
    fetchImpl: async () => sseResponse([sse]),
  });

  const events = await collect(analyzer.analyze({
    message: 'fix everything',
    conversationId: 'conv-12345678',
    availableRepairs: [GATEWAY],
    consentGranted: true,
  }));

  assert.ok(events.some((e) => e.type === 'repair.rejected' && e.repairId === 'drop-database'));
  assert.equal(events.some((e) => e.type === 'repair.proposed'), false);
});

test('duplicate agent.done yields a malformed marker and does not double-complete cleanly', async () => {
  const sse =
    'event: assistant.delta\ndata: {"text":"ok"}\n\n'
    + 'event: agent.done\ndata: {"conversationId":"conv-12345678","repairProposed":false}\n\n'
    + 'event: agent.done\ndata: {"conversationId":"conv-12345678","repairProposed":false}\n\n';

  const analyzer = createRemoteAnalyzer({
    baseUrl: 'https://clawfix.dev',
    knownRepairIds: [],
    fetchImpl: async () => sseResponse([sse]),
  });

  const events = await collect(analyzer.analyze({
    message: 'status',
    conversationId: 'conv-12345678',
    availableRepairs: [],
    consentGranted: true,
  }));

  assert.equal(events.filter((e) => e.type === 'agent.done').length, 1);
  assert.ok(events.some((e) => e.type === 'remote.malformed' && e.reason === 'duplicate_completion'));
});

test('malformed SSE data becomes remote.malformed without throwing', async () => {
  const sse =
    'event: assistant.delta\ndata: not-json\n\n'
    + 'event: agent.done\ndata: {"conversationId":"conv-12345678","repairProposed":false}\n\n';

  const analyzer = createRemoteAnalyzer({
    baseUrl: 'https://clawfix.dev',
    knownRepairIds: [],
    fetchImpl: async () => sseResponse([sse]),
  });

  const events = await collect(analyzer.analyze({
    message: 'hello world!!',
    conversationId: 'conv-12345678',
    availableRepairs: [],
    consentGranted: true,
  }));

  assert.ok(events.some((e) => e.type === 'remote.malformed'));
  assert.ok(events.some((e) => e.type === 'agent.done'));
});

test('HTTP error responses do not trigger an implicit upload fallback', async () => {
  let calls = 0;
  const analyzer = createRemoteAnalyzer({
    baseUrl: 'https://clawfix.dev',
    knownRepairIds: [],
    fetchImpl: async () => {
      calls += 1;
      return {
        ok: false,
        status: 503,
        headers: { get: () => 'application/json' },
        body: null,
        async json() { return { error: 'upstream unavailable' }; },
        async text() { return '{"error":"upstream unavailable"}'; },
      };
    },
  });

  const events = await collect(analyzer.analyze({
    message: 'are you there?',
    conversationId: 'conv-12345678',
    availableRepairs: [],
    consentGranted: true,
  }));

  assert.equal(calls, 1);
  const err = events.find((e) => e.type === 'error');
  assert.ok(err);
  assert.match(err.error.message, /upstream unavailable|503/i);
  assert.equal(events.some((e) => e.type === 'repair.proposed'), false);
});

test('abort signal cancels an in-flight stream', async () => {
  const controller = new AbortController();
  const analyzer = createRemoteAnalyzer({
    baseUrl: 'https://clawfix.dev',
    knownRepairIds: [],
    timeoutMs: 30_000,
    fetchImpl: async (_url, init) => {
      // Abort after the request starts but before body is fully consumed.
      queueMicrotask(() => controller.abort());
      return {
        ok: true,
        status: 200,
        headers: { get: () => 'text/event-stream' },
        body: new ReadableStream({
          async start(streamController) {
            streamController.enqueue(encode('event: assistant.delta\ndata: {"text":"slow"}\n\n'));
            await new Promise((resolve) => {
              const t = setTimeout(resolve, 5_000);
              init.signal.addEventListener('abort', () => {
                clearTimeout(t);
                resolve();
              }, { once: true });
            });
            if (init.signal.aborted) {
              streamController.error(Object.assign(new Error('aborted'), { name: 'AbortError' }));
              return;
            }
            streamController.close();
          },
        }),
      };
    },
  });

  const events = await collect(analyzer.analyze({
    message: 'stream please',
    conversationId: 'conv-12345678',
    availableRepairs: [],
    consentGranted: true,
    signal: controller.signal,
  }));

  assert.ok(
    events.some((e) => e.type === 'remote.aborted' || (e.type === 'error' && /abort/i.test(e.error?.message || ''))),
    `expected abort event, got ${events.map((e) => e.type).join(',')}`,
  );
});

test('timeout aborts when the server never responds', async () => {
  const analyzer = createRemoteAnalyzer({
    baseUrl: 'https://clawfix.dev',
    knownRepairIds: [],
    timeoutMs: 30,
    fetchImpl: async (_url, init) => new Promise((resolve, reject) => {
      const timer = setTimeout(() => resolve(sseResponse(['event: agent.done\ndata: {}\n\n'])), 5_000);
      init.signal.addEventListener('abort', () => {
        clearTimeout(timer);
        reject(Object.assign(new Error('The operation was aborted'), { name: 'AbortError' }));
      }, { once: true });
    }),
  });

  const events = await collect(analyzer.analyze({
    message: 'hang',
    conversationId: 'conv-12345678',
    availableRepairs: [],
    consentGranted: true,
  }));

  assert.ok(events.some((e) => e.type === 'remote.aborted' && e.reason === 'timeout'));
});

test('disconnect mid-stream surfaces a network error without proposing repairs', async () => {
  let pulls = 0;
  const analyzer = createRemoteAnalyzer({
    baseUrl: 'https://clawfix.dev',
    knownRepairIds: ['gateway-not-running'],
    fetchImpl: async () => ({
      ok: true,
      status: 200,
      headers: { get: () => 'text/event-stream' },
      body: new ReadableStream({
        pull(controller) {
          pulls += 1;
          if (pulls === 1) {
            controller.enqueue(encode('event: assistant.delta\ndata: {"text":"partial"}\n\n'));
            return;
          }
          controller.error(new Error('socket hang up'));
        },
      }),
    }),
  });

  const events = await collect(analyzer.analyze({
    message: 'continue',
    conversationId: 'conv-12345678',
    availableRepairs: [GATEWAY],
    consentGranted: true,
  }));

  assert.ok(events.some((e) => e.type === 'assistant.delta'));
  assert.ok(events.some((e) => e.type === 'error' && e.error.code === 'REMOTE_ANALYZER_DISCONNECT'));
  assert.equal(events.some((e) => e.type === 'repair.proposed'), false);
});

test('capabilities and send alias match the analyzer contract', async () => {
  const analyzer = createRemoteAnalyzer({
    baseUrl: 'https://custom.example',
    knownRepairIds: [],
    fetchImpl: async () => sseResponse([
      'event: assistant.delta\ndata: {"text":"hi"}\n\n'
      + 'event: agent.done\ndata: {"conversationId":"conv-12345678","repairProposed":false}\n\n',
    ]),
  });

  const caps = analyzer.capabilities();
  assert.equal(caps.chat, true);
  assert.equal(caps.local, false);
  assert.match(caps.providerLabel, /custom\.example/);
  assert.equal(caps.endpointUrl, 'https://custom.example/api/v2/agent/messages');

  const events = await collect(analyzer.send({
    message: 'hello there',
    conversationId: 'conv-12345678',
    availableRepairs: [],
    consentGranted: true,
  }));
  assert.ok(events.some((e) => e.type === 'assistant.delta' && e.text === 'hi'));
});

test('createRemoteAnalyzer exposes analyze for session wiring', () => {
  const analyzer = createRemoteAnalyzer({
    baseUrl: 'https://clawfix.dev',
    fetchImpl: async () => { throw new Error('no'); },
  });
  assert.equal(typeof analyzer.analyze, 'function');
  assert.equal(typeof analyzer.send, 'function');
  assert.equal(typeof analyzer.disclosure, 'function');
});
