import { Router } from 'express';
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
  validateChatBody,
} from '../security.js';

export const chatRouter = Router();

const CHAT_SYSTEM_PROMPT = `You are ClawFix, an expert AI diagnostician for OpenClaw installations.
You're in an interactive debugging session with a user. You have their full diagnostic data available.

Your expertise:
- Memory configuration (hybrid search, context pruning, compaction, Mem0)
- Gateway issues (port conflicts, crashes, restarts, zombie processes)
- Browser automation (Chrome relay, managed browser, headless deployments)
- Plugin configuration (Mem0, LanceDB, Matrix, Discord)
- Token usage optimization (heartbeat intervals, model selection, pruning)
- VPS and headless deployment issues
- macOS-specific issues (Metal GPU, Peekaboo, Apple Silicon)
- Service manager recovery (launchd on macOS, systemd on Linux)

Rules:
1. Be concise and direct — the user is in a terminal, not a web browser
2. Provide advisory troubleshooting only; never generate shell or executable code
3. Reference their actual diagnostic data when relevant
4. Deterministic trusted repairs are handled outside chat
5. Never include secrets, tokens, or API keys
6. Ask clarifying questions if the problem description is vague
7. You are ClawFix by Arca (arcabot.eth) — https://clawfix.dev`;

/**
 * POST /api/chat — streaming chat with diagnostic context
 * Body: { diagnosticId, message, conversationId }
 * Response: SSE stream of AI response chunks
 */
chatRouter.post('/chat', async (req, res) => {
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
    const aiEnabled = isPaidAIEnabled(aiConfig, env);
    if (!validateChatBody(req.body).ok) {
      return res.status(400).json({ error: 'Invalid chat request' });
    }
    const rate = await consumeRouteRateLimit('chat-ip', req, {
      env,
      db,
      limit: positiveEnvInteger(env.CHAT_RATE_LIMIT, 30),
    });
    if (!rate.allowed) {
      return res.status(429).json({ error: 'Too many chat requests' });
    }
    const { diagnosticId, message, conversationId } = req.body;
    const safeMessage = redactText(message).slice(0, 4000);
    const conversationLease = await acquireConcurrencyLease({
      scope: `conversation:legacy-chat:${conversationId}`,
      limit: 1,
      ttlMs: aiConfig.timeoutMs + 30_000,
      db,
    });
    if (!conversationLease.allowed) {
      await releaseGuards();
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

    // Retrieve diagnostic context if provided
    let diagnosticContext = '';
    if (diagnosticId) {
      const diag = await getDiagnosis(diagnosticId);
      if (diag) {
        diagnosticContext = `\n\nUser's redacted diagnostic data (fixId: ${diagnosticId}):\n${JSON.stringify(redactOutbound(diag), null, 2)}`;
      }
    }

    const turn = await beginConversationTurn({
      route: 'legacy-chat',
      id: conversationId,
      diagnosticId,
      message: { role: 'user', content: safeMessage },
      db,
    });
    if (!turn.ok) {
      await releaseGuards();
      return res.status(409).json({ error: 'Conversation diagnostic mismatch' });
    }
    const conv = turn.conversation;

    // Build messages array for AI
    const systemContent = CHAT_SYSTEM_PROMPT + diagnosticContext;
    const aiMessages = [
      { role: 'system', content: systemContent },
      ...conv.messages,
    ];

    // Check if AI is available
    if (!aiEnabled) {
      const fallback = 'AI chat is not available on this server. Use `fix <id>` to apply pattern-matched fixes, or ask the operator to configure authenticated AI or explicitly enable public AI.';
      await appendConversationMessage({
        route: 'legacy-chat', id: conversationId,
        message: { role: 'assistant', content: fallback }, db,
      });
      await releaseGuards();
      return res.json({ response: fallback, conversationId });
    }

    // Set up SSE headers
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders();

    upstreamAbort = new AbortController();
    closeHandler = () => {
      if (!res.writableEnded) upstreamAbort.abort();
    };
    res.once('close', closeHandler);

    // Stream from AI
    const aiResponse = await requestAI({
      config: aiConfig,
      messages: aiMessages,
      stream: true,
      signal: upstreamAbort.signal,
    });

    // Stream the response chunks
    let fullResponse = '';
    const reader = aiResponse.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || !trimmed.startsWith('data: ')) continue;

        const data = trimmed.slice(6);
        if (data === '[DONE]') {
          break;
        }

        try {
          const parsed = JSON.parse(data);
          const content = parsed.choices?.[0]?.delta?.content;
          if (content) {
            fullResponse += content;
            res.write(`data: ${JSON.stringify({ content })}\n\n`);
          }
        } catch {
          // Skip malformed chunks
        }
      }
    }

    // Store assistant response in conversation
    if (fullResponse) {
      await appendConversationMessage({
        route: 'legacy-chat', id: conversationId,
        message: { role: 'assistant', content: fullResponse }, db,
      });
    }

    await releaseGuards();
    res.write('data: [DONE]\n\n');
    res.end();
  } catch (error) {
    console.error('Chat error:', redactText(error?.message || 'unknown error'));
    await releaseGuards().catch(releaseError => {
      console.error('Chat lease release error:', redactText(releaseError?.message || 'unknown error'));
    });
    if (!res.headersSent) {
      res.status(500).json({ error: 'Chat failed' });
    } else {
      res.write(`data: ${JSON.stringify({ error: 'Chat failed' })}\n\n`);
      res.write('data: [DONE]\n\n');
      res.end();
    }
  } finally {
    if (closeHandler) res.off('close', closeHandler);
    await releaseGuards().catch(releaseError => {
      console.error('Chat final lease release error:', redactText(releaseError?.message || 'unknown error'));
    });
  }
});
