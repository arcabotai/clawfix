import { Router } from 'express';
import { getDiagnosis } from '../db.js';
import { getAIConfig, requestAI } from '../ai.js';
import { redactOutbound, redactText } from '../../cli/bin/security.js';
import {
  clientIp,
  createConcurrencyGate,
  createRateLimiter,
  positiveEnvInteger,
  validateChatBody,
} from '../security.js';

export const chatRouter = Router();

// In-memory conversation store (keyed by conversationId)
const conversations = new Map();

const AI_CONFIG = getAIConfig();
const chatLimiter = createRateLimiter({
  limit: positiveEnvInteger(process.env.CHAT_RATE_LIMIT, 30),
  windowMs: positiveEnvInteger(process.env.RATE_LIMIT_WINDOW_MS, 60_000),
});
const chatGate = createConcurrencyGate(
  positiveEnvInteger(process.env.AI_MAX_CONCURRENCY, 4),
);

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
  try {
    if (!validateChatBody(req.body).ok) {
      return res.status(400).json({ error: 'Invalid chat request' });
    }
    if (!chatLimiter.consume(clientIp(req)).allowed) {
      return res.status(429).json({ error: 'Too many chat requests' });
    }
    release = chatGate.tryAcquire();
    if (!release) return res.status(503).json({ error: 'Chat service is busy' });
    const { diagnosticId, message, conversationId } = req.body;
    const safeMessage = redactText(message).slice(0, 4000);

    // Retrieve diagnostic context if provided
    let diagnosticContext = '';
    if (diagnosticId) {
      const diag = await getDiagnosis(diagnosticId);
      if (diag) {
        diagnosticContext = `\n\nUser's redacted diagnostic data (fixId: ${diagnosticId}):\n${JSON.stringify(redactOutbound(diag), null, 2)}`;
      }
    }

    // Get or create conversation history
    if (!conversations.has(conversationId)) {
      conversations.set(conversationId, {
        messages: [],
        diagnosticId,
        createdAt: Date.now(),
      });
    }
    const conv = conversations.get(conversationId);
    if (conv.diagnosticId !== diagnosticId) {
      return res.status(409).json({ error: 'Conversation diagnostic mismatch' });
    }

    // Add user message
    conv.messages.push({ role: 'user', content: safeMessage });

    // Keep conversation history and provider spend bounded.
    if (conv.messages.length > 12) {
      conv.messages = conv.messages.slice(-12);
    }

    // Build messages array for AI
    const systemContent = CHAT_SYSTEM_PROMPT + diagnosticContext;
    const aiMessages = [
      { role: 'system', content: systemContent },
      ...conv.messages,
    ];

    // Check if AI is available
    if (!AI_CONFIG.apiKey) {
      const fallback = 'AI chat is not available (no API key configured on the server). Use `fix <id>` to apply pattern-matched fixes, or describe your issue and check back later.';
      conv.messages.push({ role: 'assistant', content: fallback });
      return res.json({ response: fallback, conversationId });
    }

    // Set up SSE headers
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders();

    // Stream from AI
    const aiResponse = await requestAI({
      config: AI_CONFIG,
      messages: aiMessages,
      stream: true,
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
      conv.messages.push({ role: 'assistant', content: fullResponse });
    }

    res.write('data: [DONE]\n\n');
    res.end();

    // Clean up old conversations (keep last 500)
    if (conversations.size > 500) {
      const oldest = [...conversations.entries()]
        .sort((a, b) => a[1].createdAt - b[1].createdAt)
        .slice(0, conversations.size - 500);
      for (const [key] of oldest) {
        conversations.delete(key);
      }
    }
  } catch (error) {
    console.error('Chat error:', redactText(error?.message || 'unknown error'));
    if (!res.headersSent) {
      res.status(500).json({ error: 'Chat failed' });
    } else {
      res.write(`data: ${JSON.stringify({ error: 'Chat failed' })}\n\n`);
      res.write('data: [DONE]\n\n');
      res.end();
    }
  } finally {
    release?.();
  }
});
