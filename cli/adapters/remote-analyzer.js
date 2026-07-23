/**
 * Remote analyzer adapter — client for POST /api/v2/agent/messages (SSE).
 *
 * Security invariants:
 * - Never executes shell, applies patches, or runs server-supplied commands.
 * - Outbound bodies are projected + redacted at the network boundary.
 * - Requires explicit consentGranted=true; errors never imply silent retry/upload.
 * - Inbound events are validated; repair.proposed IDs are rechecked against the local catalog.
 */

import { randomUUID } from 'node:crypto';

import {
  buildDisclosure,
  buildOutboundAgentPayload,
  DEFAULT_CLAWFIX_BASE_URL,
  resolveDestination,
} from '../core/privacy.js';
import { redactOutbound } from '../bin/security.js';
import { repairCatalog } from '../core/repair-catalog.js';

export const REMOTE_ANALYZER_PROTOCOL = 'clawfix.agent.v2';
export const DEFAULT_REMOTE_TIMEOUT_MS = 95_000;
export const DEFAULT_MAX_SSE_BYTES = 2 * 1024 * 1024;
export const DEFAULT_MAX_ASSISTANT_CHARS = 32_000;

const ALLOWED_EVENTS = new Set([
  'agent.meta',
  'assistant.delta',
  'repair.proposed',
  'agent.done',
  'agent.error',
]);

const BANNED_INBOUND_KEYS = Object.freeze([
  'shell',
  'command',
  'script',
  'patch',
  'exec',
  'commands',
  'files',
  'path',
  'apply',
]);

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function isAbortSignal(value) {
  return value !== null
    && typeof value === 'object'
    && typeof value.aborted === 'boolean'
    && typeof value.addEventListener === 'function';
}

function freezeEvent(type, fields = {}) {
  return Object.freeze({ type, ...fields });
}

/** Strip terminal control / ANSI-ish sequences from model text before UI consumption. */
export function sanitizeAssistantText(value, { maxChars = DEFAULT_MAX_ASSISTANT_CHARS } = {}) {
  if (typeof value !== 'string') return '';
  let text = value
    .replace(/\u001b\[[0-9;?]*[ -/]*[@-~]/g, '')
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '');
  if (text.length > maxChars) text = text.slice(0, maxChars);
  return text;
}

function assertNoBannedKeys(obj, where) {
  if (!isPlainObject(obj)) return;
  for (const key of Object.keys(obj)) {
    if (BANNED_INBOUND_KEYS.includes(key)) {
      const err = new Error(`Inbound ${where} contains forbidden field "${key}"`);
      err.code = 'REMOTE_ANALYZER_FORBIDDEN_FIELD';
      throw err;
    }
  }
}

/**
 * Incremental SSE parser. Handles fragmented TCP chunks and multi-line data fields.
 */
export function createSseParser() {
  let buffer = '';
  let eventName = 'message';
  let dataLines = [];

  function flush() {
    if (dataLines.length === 0) {
      eventName = 'message';
      return null;
    }
    const data = dataLines.join('\n');
    const name = eventName || 'message';
    eventName = 'message';
    dataLines = [];
    return Object.freeze({ event: name, data });
  }

  return {
    /**
     * @param {string} chunk
     * @returns {Array<{ event: string, data: string }>}
     */
    push(chunk) {
      if (typeof chunk !== 'string' || chunk.length === 0) return [];
      buffer += chunk;
      const out = [];
      // Normalize CRLF as we go; keep incomplete trailing line in buffer.
      let idx;
      while ((idx = buffer.search(/\r?\n/)) !== -1) {
        let line = buffer.slice(0, idx);
        const nl = buffer[idx] === '\r' && buffer[idx + 1] === '\n' ? 2 : 1;
        buffer = buffer.slice(idx + nl);
        if (line.endsWith('\r')) line = line.slice(0, -1);

        if (line === '') {
          const frame = flush();
          if (frame) out.push(frame);
          continue;
        }
        if (line.startsWith(':')) continue; // comment / keepalive
        if (line.startsWith('event:')) {
          eventName = line.slice(6).trim() || 'message';
          continue;
        }
        if (line.startsWith('data:')) {
          // Spec: optional single space after colon
          const value = line.slice(5).startsWith(' ') ? line.slice(6) : line.slice(5);
          dataLines.push(value);
          continue;
        }
        if (line.startsWith('id:') || line.startsWith('retry:')) {
          continue;
        }
        // Unknown field — ignore per SSE spec
      }
      return out;
    },
    end() {
      const out = [];
      if (buffer.length > 0) {
        // Final incomplete line without trailing newline — treat as a line if it has content.
        const frames = this.push('\n');
        out.push(...frames);
      }
      const frame = flush();
      if (frame) out.push(frame);
      buffer = '';
      return out;
    },
    get pendingBytes() {
      return buffer.length;
    },
  };
}

/**
 * Validate one inbound SSE event from agent v2. Returns a frozen client event or null to skip.
 * Throws on hostile executable fields.
 */
export function validateInboundAgentEvent(eventName, rawData, {
  knownRepairIds = null,
  availableRepairIds = null,
} = {}) {
  if (typeof eventName !== 'string' || !ALLOWED_EVENTS.has(eventName)) {
    return freezeEvent('remote.ignored', { reason: 'unknown_event', eventName: String(eventName || '') });
  }

  let data = rawData;
  if (typeof data === 'string') {
    if (data === '[DONE]') {
      return freezeEvent('remote.ignored', { reason: 'done_sentinel' });
    }
    try {
      data = JSON.parse(data);
    } catch {
      return freezeEvent('remote.malformed', { eventName, reason: 'invalid_json' });
    }
  }
  if (!isPlainObject(data)) {
    return freezeEvent('remote.malformed', { eventName, reason: 'non_object_data' });
  }

  try {
    assertNoBannedKeys(data, eventName);
  } catch (error) {
    return freezeEvent('remote.rejected', {
      eventName,
      reason: 'forbidden_field',
      message: error.message,
    });
  }

  switch (eventName) {
    case 'agent.meta':
      return freezeEvent('agent.meta', {
        conversationId: typeof data.conversationId === 'string' ? data.conversationId : null,
        diagnosticId: data.diagnosticId == null ? null : String(data.diagnosticId),
        protocol: typeof data.protocol === 'string' ? data.protocol : null,
        requestId: typeof data.requestId === 'string' ? data.requestId : null,
      });

    case 'assistant.delta': {
      const text = sanitizeAssistantText(
        typeof data.text === 'string' ? data.text : (typeof data.content === 'string' ? data.content : ''),
      );
      if (!text) {
        return freezeEvent('remote.ignored', { reason: 'empty_delta' });
      }
      return freezeEvent('assistant.delta', { text });
    }

    case 'repair.proposed': {
      const repairId = typeof data.repairId === 'string' ? data.repairId.trim() : '';
      const rationale = sanitizeAssistantText(
        typeof data.rationale === 'string' ? data.rationale : '',
        { maxChars: 1000 },
      );
      if (!repairId) {
        return freezeEvent('remote.malformed', { eventName, reason: 'missing_repair_id' });
      }

      const allowedLocal = knownRepairIds instanceof Set
        ? knownRepairIds
        : new Set(Array.isArray(knownRepairIds) ? knownRepairIds : []);
      const allowedTurn = availableRepairIds instanceof Set
        ? availableRepairIds
        : new Set(Array.isArray(availableRepairIds) ? availableRepairIds : []);

      if (allowedLocal.size > 0 && !allowedLocal.has(repairId)) {
        return freezeEvent('repair.rejected', {
          repairId,
          reason: 'not_in_local_catalog',
          rationale,
        });
      }
      if (allowedTurn.size > 0 && !allowedTurn.has(repairId)) {
        return freezeEvent('repair.rejected', {
          repairId,
          reason: 'not_in_available_repairs',
          rationale,
        });
      }
      return freezeEvent('repair.proposed', { repairId, rationale });
    }

    case 'agent.done':
      return freezeEvent('agent.done', {
        conversationId: typeof data.conversationId === 'string' ? data.conversationId : null,
        repairProposed: Boolean(data.repairProposed),
        repairId: typeof data.repairId === 'string' ? data.repairId : null,
      });

    case 'agent.error':
      return freezeEvent('agent.error', {
        error: sanitizeAssistantText(typeof data.error === 'string' ? data.error : 'Agent error', { maxChars: 2000 }),
        fatal: Boolean(data.fatal),
      });

    default:
      return freezeEvent('remote.ignored', { reason: 'unknown_event', eventName });
  }
}

function catalogRepairIds(catalog = repairCatalog) {
  if (catalog instanceof Map) return new Set(catalog.keys());
  if (Array.isArray(catalog)) {
    return new Set(catalog.map((e) => (typeof e === 'string' ? e : e?.id)).filter(Boolean));
  }
  if (isPlainObject(catalog)) return new Set(Object.keys(catalog));
  return new Set();
}

/**
 * @typedef {object} RemoteAnalyzerOptions
 * @property {string} [baseUrl]
 * @property {typeof fetch} [fetchImpl]
 * @property {() => Record<string, string>} [getHeaders]
 * @property {Iterable<string>|Set<string>|Record<string, unknown>} [knownRepairIds]
 * @property {number} [timeoutMs]
 * @property {number} [maxSseBytes]
 * @property {(value: unknown) => unknown} [redact]
 * @property {boolean} [customServer]
 * @property {string[]} [providerChain]
 */

export function createRemoteAnalyzer(options = {}) {
  if (options === null || typeof options !== 'object' || Array.isArray(options)) {
    throw new TypeError('options must be an object');
  }

  const baseUrl = typeof options.baseUrl === 'string' && options.baseUrl.trim()
    ? options.baseUrl.trim()
    : (process.env.CLAWFIX_API || DEFAULT_CLAWFIX_BASE_URL);

  const destination = resolveDestination(baseUrl);
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  if (typeof fetchImpl !== 'function') {
    throw new TypeError('fetchImpl must be a function');
  }

  const getHeaders = typeof options.getHeaders === 'function'
    ? options.getHeaders
    : () => {
      const headers = {};
      const token = process.env.CLAWFIX_API_TOKEN;
      if (token) headers.Authorization = `Bearer ${token}`;
      return headers;
    };

  const knownRepairIds = options.knownRepairIds != null
    ? (options.knownRepairIds instanceof Set
      ? options.knownRepairIds
      : catalogRepairIds(options.knownRepairIds))
    : catalogRepairIds(repairCatalog);

  const timeoutMs = options.timeoutMs ?? DEFAULT_REMOTE_TIMEOUT_MS;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) {
    throw new TypeError('timeoutMs must be a positive safe integer');
  }
  const maxSseBytes = options.maxSseBytes ?? DEFAULT_MAX_SSE_BYTES;
  if (!Number.isSafeInteger(maxSseBytes) || maxSseBytes <= 0) {
    throw new TypeError('maxSseBytes must be a positive safe integer');
  }

  const redact = options.redact ?? redactOutbound;
  if (typeof redact !== 'function') throw new TypeError('redact must be a function');

  const customServer = Boolean(
    options.customServer
    ?? (destination.hostname !== 'clawfix.dev'),
  );
  const providerChain = options.providerChain;

  function capabilities() {
    return Object.freeze({
      chat: true,
      repairProposals: true,
      local: false,
      providerLabel: buildDisclosure({
        baseUrl: destination.baseUrl,
        providerChain,
        customServer,
      }).providerLabel,
      protocol: REMOTE_ANALYZER_PROTOCOL,
      endpointUrl: destination.endpointUrl,
    });
  }

  function disclosure(extra = {}) {
    return buildDisclosure({
      baseUrl: destination.baseUrl,
      providerChain,
      customServer,
      ...extra,
    });
  }

  /**
   * Stream analysis events. Requires consentGranted === true to contact the network.
   * @param {object} input
   * @param {string} input.message
   * @param {string} [input.conversationId]
   * @param {string|null} [input.diagnosticId]
   * @param {Array<object>} [input.availableRepairs]
   * @param {boolean} input.consentGranted
   * @param {AbortSignal} [input.signal]
   * @returns {AsyncGenerator<object>}
   */
  async function* analyze(input = {}) {
    if (!isPlainObject(input)) throw new TypeError('input must be an object');

    if (input.consentGranted !== true) {
      yield freezeEvent('privacy.approval-required', {
        disclosure: disclosure(),
        message: 'Remote analysis requires explicit consent before any upload.',
      });
      return;
    }

    if (input.signal !== undefined && !isAbortSignal(input.signal)) {
      throw new TypeError('signal must be an AbortSignal');
    }
    if (input.signal?.aborted) {
      yield freezeEvent('remote.aborted', { reason: 'already_aborted' });
      return;
    }

    let body;
    try {
      body = buildOutboundAgentPayload({
        conversationId: input.conversationId || randomUUID().replace(/-/g, '').slice(0, 16),
        message: input.message,
        diagnosticId: input.diagnosticId ?? null,
        availableRepairs: input.availableRepairs ?? [],
      }, { redact });
    } catch (error) {
      yield freezeEvent('error', {
        error: Object.freeze({
          message: error instanceof Error ? error.message : String(error),
          code: 'REMOTE_ANALYZER_OUTBOUND_INVALID',
        }),
      });
      return;
    }

    // Never silently attach shell-bearing fields after projection.
    assertNoBannedKeys(body, 'outbound');
    for (const repair of body.availableRepairs) assertNoBannedKeys(repair, 'outbound.repair');

    const availableRepairIds = new Set(body.availableRepairs.map((r) => r.id));

    yield freezeEvent('assistant.started', {
      conversationId: body.conversationId,
      destination: destination.hostname,
      endpointUrl: destination.endpointUrl,
      disclosure: disclosure(),
    });

    const timeoutController = new AbortController();
    const timer = setTimeout(() => {
      timeoutController.abort();
    }, timeoutMs);

    const onExternalAbort = () => timeoutController.abort();
    if (input.signal) {
      if (input.signal.aborted) timeoutController.abort();
      else input.signal.addEventListener('abort', onExternalAbort, { once: true });
    }

    let sawDone = false;
    let bytes = 0;
    let response;

    try {
      response = await fetchImpl(destination.endpointUrl, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          accept: 'text/event-stream',
          ...getHeaders(),
        },
        body: JSON.stringify(body),
        signal: timeoutController.signal,
      });
    } catch (error) {
      clearTimeout(timer);
      if (input.signal) input.signal.removeEventListener('abort', onExternalAbort);

      const aborted = timeoutController.signal.aborted
        || input.signal?.aborted
        || error?.name === 'AbortError';
      if (aborted) {
        const reason = input.signal?.aborted ? 'aborted' : 'timeout';
        yield freezeEvent('remote.aborted', { reason });
        return;
      }
      yield freezeEvent('error', {
        error: Object.freeze({
          message: error instanceof Error ? error.message : String(error),
          code: 'REMOTE_ANALYZER_NETWORK',
        }),
      });
      // Explicit: do not fall back to implicit upload or alternate endpoint.
      return;
    }

    try {
      if (!response || typeof response !== 'object') {
        yield freezeEvent('error', {
          error: Object.freeze({ message: 'Invalid fetch response', code: 'REMOTE_ANALYZER_RESPONSE' }),
        });
        return;
      }

      if (!response.ok) {
        let detail = `HTTP ${response.status}`;
        try {
          const ct = response.headers?.get?.('content-type') || '';
          if (ct.includes('application/json') && typeof response.json === 'function') {
            const json = await response.json();
            if (json && typeof json.error === 'string') detail = json.error;
          } else if (typeof response.text === 'function') {
            const text = await response.text();
            if (text) detail = sanitizeAssistantText(text, { maxChars: 500 });
          }
        } catch {
          // ignore body read failures
        }
        yield freezeEvent('error', {
          error: Object.freeze({
            message: detail,
            code: 'REMOTE_ANALYZER_HTTP',
            status: response.status,
          }),
        });
        return;
      }

      const contentType = response.headers?.get?.('content-type') || '';
      if (contentType.includes('application/json') && !contentType.includes('text/event-stream')) {
        // Non-SSE error/JSON body — never treat as executable.
        try {
          const json = await response.json();
          assertNoBannedKeys(json, 'json_response');
          yield freezeEvent('error', {
            error: Object.freeze({
              message: typeof json?.error === 'string' ? json.error : 'Unexpected JSON response from agent endpoint',
              code: 'REMOTE_ANALYZER_UNEXPECTED_JSON',
            }),
          });
        } catch (error) {
          yield freezeEvent('error', {
            error: Object.freeze({
              message: error instanceof Error ? error.message : String(error),
              code: 'REMOTE_ANALYZER_UNEXPECTED_JSON',
            }),
          });
        }
        return;
      }

      if (!response.body || typeof response.body.getReader !== 'function') {
        // Fallback for environments that buffer the whole body as text
        if (typeof response.text === 'function') {
          const text = await response.text();
          const parser = createSseParser();
          const frames = [...parser.push(text), ...parser.end()];
          for (const frame of frames) {
            const event = validateInboundAgentEvent(frame.event, frame.data, {
              knownRepairIds,
              availableRepairIds,
            });
            if (!event) continue;
            if (event.type === 'agent.done') {
              if (sawDone) {
                yield freezeEvent('remote.malformed', { reason: 'duplicate_completion' });
                continue;
              }
              sawDone = true;
            }
            yield event;
          }
          if (!sawDone) {
            yield freezeEvent('agent.done', {
              conversationId: body.conversationId,
              repairProposed: false,
              repairId: null,
              incomplete: true,
            });
          }
          return;
        }
        yield freezeEvent('error', {
          error: Object.freeze({
            message: 'Response body is not readable',
            code: 'REMOTE_ANALYZER_BODY',
          }),
        });
        return;
      }

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      const parser = createSseParser();

      while (true) {
        if (timeoutController.signal.aborted || input.signal?.aborted) {
          try { await reader.cancel(); } catch { /* ignore */ }
          yield freezeEvent('remote.aborted', {
            reason: input.signal?.aborted ? 'aborted' : 'timeout',
          });
          return;
        }

        let readResult;
        try {
          readResult = await reader.read();
        } catch (error) {
          if (timeoutController.signal.aborted || input.signal?.aborted || error?.name === 'AbortError') {
            yield freezeEvent('remote.aborted', {
              reason: input.signal?.aborted ? 'aborted' : 'timeout',
            });
            return;
          }
          yield freezeEvent('error', {
            error: Object.freeze({
              message: error instanceof Error ? error.message : String(error),
              code: 'REMOTE_ANALYZER_DISCONNECT',
            }),
          });
          return;
        }

        const { done, value } = readResult;
        if (done) break;

        const chunk = typeof value === 'string'
          ? value
          : decoder.decode(value, { stream: true });
        bytes += chunk.length;
        if (bytes > maxSseBytes) {
          try { await reader.cancel(); } catch { /* ignore */ }
          yield freezeEvent('error', {
            error: Object.freeze({
              message: 'SSE response exceeded size limit',
              code: 'REMOTE_ANALYZER_SIZE_LIMIT',
            }),
          });
          return;
        }

        for (const frame of parser.push(chunk)) {
          const event = validateInboundAgentEvent(frame.event, frame.data, {
            knownRepairIds,
            availableRepairIds,
          });
          if (event.type === 'agent.done') {
            if (sawDone) {
              yield freezeEvent('remote.malformed', { reason: 'duplicate_completion' });
              continue;
            }
            sawDone = true;
          }
          yield event;
        }
      }

      // Flush decoder + parser tail
      const tail = decoder.decode();
      if (tail) {
        for (const frame of parser.push(tail)) {
          const event = validateInboundAgentEvent(frame.event, frame.data, {
            knownRepairIds,
            availableRepairIds,
          });
          if (event.type === 'agent.done') {
            if (sawDone) {
              yield freezeEvent('remote.malformed', { reason: 'duplicate_completion' });
              continue;
            }
            sawDone = true;
          }
          yield event;
        }
      }
      for (const frame of parser.end()) {
        const event = validateInboundAgentEvent(frame.event, frame.data, {
          knownRepairIds,
          availableRepairIds,
        });
        if (event.type === 'agent.done') {
          if (sawDone) {
            yield freezeEvent('remote.malformed', { reason: 'duplicate_completion' });
            continue;
          }
          sawDone = true;
        }
        yield event;
      }

      if (!sawDone) {
        yield freezeEvent('agent.done', {
          conversationId: body.conversationId,
          repairProposed: false,
          repairId: null,
          incomplete: true,
        });
      }
    } finally {
      clearTimeout(timer);
      if (input.signal) input.signal.removeEventListener('abort', onExternalAbort);
    }
  }

  /**
   * Plan Analyzer interface alias: send(...) yields the same stream as analyze(...).
   */
  function send(input, signal) {
    const payload = isPlainObject(input) ? { ...input } : { message: input };
    if (signal !== undefined) payload.signal = signal;
    return analyze(payload);
  }

  return Object.freeze({
    capabilities,
    disclosure,
    analyze,
    send,
    destination: Object.freeze({ ...destination }),
  });
}
