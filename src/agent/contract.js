/**
 * ClawFix agent API v2 contracts.
 *
 * The model may explain findings and propose existing repair IDs only.
 * It must never return shell, paths, or arbitrary patches for execution.
 */

export const AGENT_V2_MAX_MESSAGE_CHARS = 4000;
export const AGENT_V2_MAX_RATIONALE_CHARS = 1000;
export const AGENT_V2_MAX_REPAIRS = 32;
export const AGENT_V2_MAX_REPAIR_ID_CHARS = 128;
export const AGENT_V2_MAX_TITLE_CHARS = 200;

const ID_RE = /^[a-z0-9][a-z0-9._-]{0,127}$/i;
const CONV_RE = /^[A-Za-z0-9_-]{8,128}$/;
const RISK_SET = new Set(['low', 'medium', 'high', 'critical', 'info', 'informational']);

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function asTrimmedString(value, max) {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > max) return null;
  return trimmed;
}

/**
 * @param {unknown} body
 * @returns {{ ok: true, value: object } | { ok: false, error: string }}
 */
export function validateAgentV2Request(body) {
  if (!isPlainObject(body)) {
    return { ok: false, error: 'Request body must be a JSON object' };
  }

  // Reject legacy/dangerous fields outright.
  for (const banned of ['shell', 'command', 'script', 'patch', 'exec', 'commands', 'files']) {
    if (Object.prototype.hasOwnProperty.call(body, banned)) {
      return { ok: false, error: `Field "${banned}" is not allowed` };
    }
  }

  const conversationId = asTrimmedString(body.conversationId, 128);
  if (!conversationId || !CONV_RE.test(conversationId)) {
    return { ok: false, error: 'conversationId is required' };
  }

  const message = asTrimmedString(body.message, AGENT_V2_MAX_MESSAGE_CHARS);
  if (!message) {
    return { ok: false, error: 'message is required' };
  }

  let diagnosticId = null;
  if (body.diagnosticId != null && body.diagnosticId !== '') {
    diagnosticId = asTrimmedString(body.diagnosticId, 128);
    if (!diagnosticId || !CONV_RE.test(diagnosticId)) {
      return { ok: false, error: 'diagnosticId is invalid' };
    }
  }

  if (!Array.isArray(body.availableRepairs)) {
    return { ok: false, error: 'availableRepairs must be an array' };
  }
  if (body.availableRepairs.length > AGENT_V2_MAX_REPAIRS) {
    return { ok: false, error: 'too many availableRepairs' };
  }

  const seen = new Set();
  const availableRepairs = [];
  for (const entry of body.availableRepairs) {
    if (!isPlainObject(entry)) {
      return { ok: false, error: 'availableRepairs entries must be objects' };
    }
    for (const banned of ['shell', 'command', 'script', 'patch', 'apply', 'exec']) {
      if (Object.prototype.hasOwnProperty.call(entry, banned)) {
        return { ok: false, error: `Repair field "${banned}" is not allowed` };
      }
    }
    const id = asTrimmedString(entry.id, AGENT_V2_MAX_REPAIR_ID_CHARS);
    if (!id || !ID_RE.test(id)) {
      return { ok: false, error: 'availableRepairs[].id is invalid' };
    }
    if (seen.has(id)) {
      return { ok: false, error: `duplicate repair id: ${id}` };
    }
    seen.add(id);

    const title = asTrimmedString(entry.title ?? id, AGENT_V2_MAX_TITLE_CHARS);
    if (!title) {
      return { ok: false, error: 'availableRepairs[].title is invalid' };
    }

    let risk = 'medium';
    if (entry.risk != null) {
      const r = asTrimmedString(String(entry.risk), 32)?.toLowerCase();
      if (!r || !RISK_SET.has(r)) {
        return { ok: false, error: 'availableRepairs[].risk is invalid' };
      }
      risk = r === 'informational' ? 'info' : r;
    }

    availableRepairs.push(Object.freeze({ id, title, risk }));
  }

  return {
    ok: true,
    value: Object.freeze({
      conversationId,
      message,
      diagnosticId,
      availableRepairs: Object.freeze(availableRepairs),
    }),
  };
}

/**
 * Build the constrained tool schema for the current request.
 * repairId enum is exactly the client-supplied available repair IDs.
 */
export function buildProposeRepairTool(availableRepairs) {
  const ids = availableRepairs.map((r) => r.id);
  if (ids.length === 0) {
    return null;
  }
  return Object.freeze({
    type: 'function',
    function: Object.freeze({
      name: 'propose_repair',
      description:
        'Propose one reviewed local repair ID from the allowed list. The server does not execute it.',
      parameters: Object.freeze({
        type: 'object',
        additionalProperties: false,
        properties: Object.freeze({
          repairId: Object.freeze({
            type: 'string',
            enum: Object.freeze([...ids]),
          }),
          rationale: Object.freeze({
            type: 'string',
            maxLength: AGENT_V2_MAX_RATIONALE_CHARS,
          }),
        }),
        required: Object.freeze(['repairId', 'rationale']),
      }),
    }),
  });
}

/**
 * Validate a model tool call. Never trust prose for repair intent.
 * @returns {{ ok: true, value: { repairId: string, rationale: string } } | { ok: false, error: string }}
 */
export function validateProposeRepairCall(rawArgs, availableRepairs) {
  const allowed = new Set(availableRepairs.map((r) => r.id));
  let args = rawArgs;
  if (typeof args === 'string') {
    try {
      args = JSON.parse(args);
    } catch {
      return { ok: false, error: 'propose_repair arguments are not valid JSON' };
    }
  }
  if (!isPlainObject(args)) {
    return { ok: false, error: 'propose_repair arguments must be an object' };
  }
  for (const banned of ['shell', 'command', 'script', 'patch', 'path', 'exec', 'files']) {
    if (Object.prototype.hasOwnProperty.call(args, banned)) {
      return { ok: false, error: `propose_repair field "${banned}" is not allowed` };
    }
  }

  const repairId = asTrimmedString(args.repairId, AGENT_V2_MAX_REPAIR_ID_CHARS);
  if (!repairId || !allowed.has(repairId)) {
    return { ok: false, error: 'repairId is not in the allowed enum' };
  }

  const rationale = asTrimmedString(args.rationale, AGENT_V2_MAX_RATIONALE_CHARS);
  if (!rationale) {
    return { ok: false, error: 'rationale is required' };
  }

  return {
    ok: true,
    value: Object.freeze({ repairId, rationale }),
  };
}

export function formatSseEvent(event, data) {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}
