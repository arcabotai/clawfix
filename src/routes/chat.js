import { Router } from 'express';
import { getDiagnosis } from '../db.js';

export const chatRouter = Router();

// In-memory conversation store (keyed by conversationId)
const conversations = new Map();

// Model configuration — same as diagnose.js
const AI_CONFIG = {
  provider: process.env.AI_PROVIDER || 'openrouter',
  model: process.env.AI_MODEL || 'minimax/minimax-m2.5',
  apiKey: process.env.AI_API_KEY || process.env.OPENROUTER_API_KEY || process.env.ANTHROPIC_API_KEY,
  baseUrl: process.env.AI_BASE_URL || 'https://openrouter.ai/api/v1',
  maxTokens: 2000,
};

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
2. When suggesting fixes, provide exact commands they can copy-paste
3. Reference their actual diagnostic data when relevant
4. If you generate a bash script, wrap it in \`\`\`bash blocks
5. Never include secrets, tokens, or API keys
6. Ask clarifying questions if the problem description is vague
7. You are ClawFix by Arca (arcabot.eth) — https://clawfix.dev`;

/**
 * POST /api/chat — streaming chat with diagnostic context
 * Body: { diagnosticId, message, conversationId }
 * Response: SSE stream of AI response chunks
 */
chatRouter.post('/chat', async (req, res) => {
  try {
    const { diagnosticId, message, conversationId } = req.body;

    if (!message || !conversationId) {
      return res.status(400).json({ error: 'message and conversationId are required' });
    }

    // Retrieve diagnostic context if provided
    let diagnosticContext = '';
    if (diagnosticId) {
      const diag = await getDiagnosis(diagnosticId);
      if (diag) {
        diagnosticContext = `\n\nUser's diagnostic data (fixId: ${diagnosticId}):\n${JSON.stringify(diag, null, 2)}`;
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

    // Add user message
    conv.messages.push({ role: 'user', content: message });

    // Keep conversation history manageable (last 20 messages)
    if (conv.messages.length > 20) {
      conv.messages = conv.messages.slice(-20);
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
    const baseUrl = AI_CONFIG.baseUrl || 'https://openrouter.ai/api/v1';
    const headers = {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${AI_CONFIG.apiKey}`,
    };

    if (AI_CONFIG.provider === 'openrouter') {
      headers['HTTP-Referer'] = 'https://clawfix.dev';
      headers['X-Title'] = 'ClawFix';
    }

    const aiResponse = await fetch(`${baseUrl}/chat/completions`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        model: AI_CONFIG.model,
        max_tokens: AI_CONFIG.maxTokens,
        stream: true,
        messages: aiMessages,
      }),
    });

    if (!aiResponse.ok) {
      const err = await aiResponse.text();
      res.write(`data: ${JSON.stringify({ error: `AI error: ${aiResponse.status}` })}\n\n`);
      res.write('data: [DONE]\n\n');
      res.end();
      return;
    }

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
    console.error('Chat error:', error.message);
    if (!res.headersSent) {
      res.status(500).json({ error: 'Chat failed', message: error.message });
    } else {
      res.write(`data: ${JSON.stringify({ error: error.message })}\n\n`);
      res.write('data: [DONE]\n\n');
      res.end();
    }
  }
});
