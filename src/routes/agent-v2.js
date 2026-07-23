import { Router } from 'express';
import { randomUUID } from 'node:crypto';
import { getDiagnosis } from '../db.js';
import { getAIConfig, requestAI } from '../ai.js';
import { redactOutbound, redactText } from '../../cli/bin/security.js';
import {
  clientIp,
  createRateLimiter,
  isPaidAIEnabled,
  positiveEnvInteger,
  sharedAIRequestGuard,
} from '../security.js';
import {
  buildProposeRepairTool,
  validateAgentV2Request,
  validateProposeRepairCall,
} from '../agent/contract.js';
import { buildAgentV2SystemPrompt } from '../agent/prompt.js';
import { createSseWriter, writeSseHeaders } from '../agent/stream.js';

export const agentV2Router = Router();

const conversations = new Map();
const AI_CONFIG = getAIConfig();
const agentLimiter = createRateLimiter({
  limit: positiveEnvInteger(process.env.CHAT_RATE_LIMIT, 30),
  windowMs: positiveEnvInteger(process.env.RATE_LIMIT_WINDOW_MS, 60_000),
});

function isAgentV2Enabled(env = process.env) {
  // Additive endpoint. Default on; set CLAWFIX_AGENT_V2=0 to disable.
  return env.CLAWFIX_AGENT_V2 !== '0';
}

function chunkText(text, size = 48) {
  const chunks = [];
  for (let i = 0; i < text.length; i += size) chunks.push(text.slice(i, i + size));
  return chunks;
}

/**
 * POST /api/v2/agent/messages
 * Constrained conversational agent. Emits SSE events only.
 * Never returns executable shell. Repair proposals are IDs only.
 */
agentV2Router.post('/v2/agent/messages', async (req, res) => {
  let release = null;
  try {
    if (!isAgentV2Enabled()) {
      return res.status(404).json({ error: 'Agent v2 is disabled' });
    }

    const validated = validateAgentV2Request(req.body);
    if (!validated.ok) {
      return res.status(400).json({ error: validated.error });
    }

    if (!agentLimiter.consume(clientIp(req)).allowed) {
      return res.status(429).json({ error: 'Too many agent requests' });
    }

    const { conversationId, message, diagnosticId, availableRepairs } = validated.value;
    const safeMessage = redactText(message).slice(0, 4000);
    const aiEnabled = isPaidAIEnabled(AI_CONFIG);

    if (aiEnabled) {
      const capacity = sharedAIRequestGuard.acquire(req);
      if (!capacity.allowed) return res.status(capacity.status).json({ error: capacity.error });
      release = capacity.release;
    }

    if (!conversations.has(conversationId)) {
      conversations.set(conversationId, {
        messages: [],
        diagnosticId: diagnosticId || null,
        createdAt: Date.now(),
      });
    }
    const conv = conversations.get(conversationId);
    // Allow first message to bind diagnostic; later rescans may update intentionally.
    if (diagnosticId && conv.diagnosticId && conv.diagnosticId !== diagnosticId) {
      conv.diagnosticId = diagnosticId;
      conv.messages = [];
    } else if (diagnosticId && !conv.diagnosticId) {
      conv.diagnosticId = diagnosticId;
    }

    let diagnosticContext = '';
    if (conv.diagnosticId) {
      const diag = await getDiagnosis(conv.diagnosticId);
      if (diag) {
        diagnosticContext = `\n\nRedacted diagnostic (id=${conv.diagnosticId}):\n${JSON.stringify(redactOutbound(diag), null, 2)}`;
      }
    }

    conv.messages.push({ role: 'user', content: safeMessage });
    if (conv.messages.length > 12) conv.messages = conv.messages.slice(-12);

    writeSseHeaders(res);
    const sse = createSseWriter(res);
    sse.send('agent.meta', {
      conversationId,
      diagnosticId: conv.diagnosticId,
      protocol: 'clawfix.agent.v2',
      requestId: randomUUID(),
    });

    if (!aiEnabled) {
      const fallback =
        availableRepairs.length > 0
          ? 'AI chat is not available on this server. I can still list local reviewed repairs, but I will not invent commands. Use the local offline assistant or configure authenticated AI.'
          : 'AI chat is not available on this server. No reviewed repairs were supplied for this turn.';
      for (const part of chunkText(fallback)) {
        sse.send('assistant.delta', { text: part });
      }
      conv.messages.push({ role: 'assistant', content: fallback });
      sse.send('agent.done', { conversationId, repairProposed: false });
      sse.end();
      return;
    }

    const systemContent =
      buildAgentV2SystemPrompt({ availableRepairs }) + diagnosticContext;
    const aiMessages = [{ role: 'system', content: systemContent }, ...conv.messages];
    const tool = buildProposeRepairTool(availableRepairs);

    // Non-stream completion so tool calls are reliable. Content is then emitted as deltas.
    const completion = await requestAI({
      messages: aiMessages,
      stream: false,
      tools: tool ? [tool] : undefined,
      toolChoice: tool ? 'auto' : undefined,
      config: AI_CONFIG,
    });

    let assistantText = '';
    let repairProposed = null;

    if (completion?.toolCalls?.length) {
      for (const call of completion.toolCalls) {
        if (call?.function?.name !== 'propose_repair') continue;
        const checked = validateProposeRepairCall(call.function.arguments, availableRepairs);
        if (!checked.ok) {
          sse.send('agent.error', { error: checked.error, fatal: false });
          continue;
        }
        repairProposed = checked.value;
      }
    }

    assistantText =
      typeof completion?.content === 'string' && completion.content.trim()
        ? completion.content.trim()
        : repairProposed
          ? `I recommend the reviewed repair \`${repairProposed.repairId}\`.`
          : 'I do not have a reviewed repair to propose for that. A rescan may help if the environment changed.';

    for (const part of chunkText(assistantText)) {
      sse.send('assistant.delta', { text: part });
    }

    if (repairProposed) {
      sse.send('repair.proposed', {
        repairId: repairProposed.repairId,
        rationale: repairProposed.rationale,
      });
    }

    conv.messages.push({ role: 'assistant', content: assistantText });
    sse.send('agent.done', {
      conversationId,
      repairProposed: Boolean(repairProposed),
      repairId: repairProposed?.repairId || null,
    });
    sse.end();
  } catch (err) {
    if (!res.headersSent) {
      return res.status(500).json({ error: 'Agent request failed' });
    }
    try {
      res.write(
        `event: agent.error\ndata: ${JSON.stringify({ error: 'Agent request failed', fatal: true })}\n\n`,
      );
    } catch {
      // ignore write failures after disconnect
    }
    if (!res.writableEnded) res.end();
  } finally {
    if (typeof release === 'function') release();
  }
});
