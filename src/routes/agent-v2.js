import { Router } from 'express';
import { randomUUID } from 'node:crypto';
import { getDiagnosis, getPool } from '../db.js';
import { getAIConfig, requestAI } from '../ai.js';
import { redactOutbound, redactText } from '../../cli/bin/security.js';
import { getRuntimeEnv } from '../runtime-env.js';
import {
  acquireConcurrencyLease,
  appendConversationMessage,
  beginConversationTurn,
} from '../shared-state.js';
import {
  consumeRouteRateLimit,
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

const CONVERSATION_TTL_MS = 30 * 60_000;
const MAX_CONVERSATIONS = 1000;

export function pruneConversations(now = Date.now(), store = new Map()) {
  for (const [id, conv] of store) {
    const touchedAt = Number(conv?.lastSeenAt || conv?.createdAt || 0);
    if (!Number.isFinite(touchedAt) || now - touchedAt > CONVERSATION_TTL_MS) store.delete(id);
  }
  if (store.size <= MAX_CONVERSATIONS) return store.size;
  const overflow = [...store.entries()]
    .sort((a, b) => {
      const aTouched = Number(a[1]?.lastSeenAt || a[1]?.createdAt || 0);
      const bTouched = Number(b[1]?.lastSeenAt || b[1]?.createdAt || 0);
      return aTouched - bTouched;
    })
    .slice(0, store.size - MAX_CONVERSATIONS);
  for (const [id] of overflow) store.delete(id);
  return store.size;
}
function isAgentV2Enabled(env = getRuntimeEnv()) {
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
  let conversationRelease = null;
  let upstreamAbort = null;
  let closeHandler = null;
  const releaseGuards = async () => {
    const errors = [];
    if (conversationRelease) {
      try {
        await conversationRelease();
        conversationRelease = null;
      } catch (error) {
        errors.push(error);
      }
    }
    if (release) {
      try {
        await release();
        release = null;
      } catch (error) {
        errors.push(error);
      }
    }
    if (errors.length) throw new AggregateError(errors, 'Guard lease release failed');
  };
  try {
    const env = getRuntimeEnv();
    const db = getPool();
    const aiConfig = getAIConfig(env);
    if (!isAgentV2Enabled(env)) {
      return res.status(404).json({ error: 'Agent v2 is disabled' });
    }

    const validated = validateAgentV2Request(req.body);
    if (!validated.ok) {
      return res.status(400).json({ error: validated.error });
    }

    const rate = await consumeRouteRateLimit('agent-v2-ip', req, {
      env,
      db,
      limit: positiveEnvInteger(env.CHAT_RATE_LIMIT, 30),
    });
    if (!rate.allowed) {
      return res.status(429).json({ error: 'Too many agent requests' });
    }

    const { conversationId, message, diagnosticId, availableRepairs } = validated.value;
    const safeMessage = redactText(message).slice(0, 4000);
    const aiEnabled = isPaidAIEnabled(aiConfig, env);
    const conversationLease = await acquireConcurrencyLease({
      scope: `conversation:agent-v2:${conversationId}`,
      limit: 1,
      ttlMs: aiConfig.timeoutMs + 30_000,
      db,
    });
    if (!conversationLease.allowed) {
      return res.status(409).json({ error: 'Conversation already has an active turn' });
    }
    conversationRelease = conversationLease.release;

    if (aiEnabled) {
      const capacity = await sharedAIRequestGuard.acquire(req, { env, db });
      if (!capacity.allowed) {
        await releaseGuards();
        return res.status(capacity.status).json({ error: capacity.error });
      }
      release = capacity.release;
    }

    const turn = await beginConversationTurn({
      route: 'agent-v2',
      id: conversationId,
      diagnosticId,
      message: { role: 'user', content: safeMessage },
      db,
    });
    const conv = turn.conversation;

    let diagnosticContext = '';
    if (conv.diagnosticId) {
      const diag = await getDiagnosis(conv.diagnosticId);
      if (diag) {
        diagnosticContext = `\n\nRedacted diagnostic (id=${conv.diagnosticId}):\n${JSON.stringify(redactOutbound(diag), null, 2)}`;
      }
    }


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
      await appendConversationMessage({
        route: 'agent-v2', id: conversationId,
        message: { role: 'assistant', content: fallback }, db,
      });
      await releaseGuards();
      sse.send('agent.done', { conversationId, repairProposed: false });
      sse.end();
      return;
    }

    const systemContent =
      buildAgentV2SystemPrompt({ availableRepairs }) + diagnosticContext;
    const aiMessages = [{ role: 'system', content: systemContent }, ...conv.messages];
    const tool = buildProposeRepairTool(availableRepairs);

    upstreamAbort = new AbortController();
    closeHandler = () => {
      if (!res.writableEnded) upstreamAbort.abort();
    };
    res.once('close', closeHandler);

    // Non-stream completion so tool calls are reliable. Content is then emitted as deltas.
    const completion = await requestAI({
      messages: aiMessages,
      stream: false,
      tools: tool ? [tool] : undefined,
      toolChoice: tool ? 'auto' : undefined,
      config: aiConfig,
      signal: upstreamAbort.signal,
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

    await appendConversationMessage({
      route: 'agent-v2', id: conversationId,
      message: { role: 'assistant', content: assistantText }, db,
    });
    await releaseGuards();
    sse.send('agent.done', {
      conversationId,
      repairProposed: Boolean(repairProposed),
      repairId: repairProposed?.repairId || null,
    });
    sse.end();
  } catch (err) {
    console.error('Agent v2 error:', redactText(err?.message || 'unknown error'));
    await releaseGuards().catch(releaseError => {
      console.error('Agent v2 lease release error:', redactText(releaseError?.message || 'unknown error'));
    });
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
    if (closeHandler) res.off('close', closeHandler);
    await releaseGuards().catch(releaseError => {
      console.error('Agent v2 final lease release error:', redactText(releaseError?.message || 'unknown error'));
    });
  }
});
