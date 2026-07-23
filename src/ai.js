const DEFAULT_BASE_URL = 'https://openrouter.ai/api/v1';
const DEFAULT_MODEL = 'deepseek/deepseek-v4-flash';
const DEFAULT_MAX_TOKENS = 3000;
const DEFAULT_TIMEOUT_MS = 90_000;

export const AI_ANALYSIS_SCHEMA = {
  name: 'clawfix_diagnosis',
  strict: true,
  schema: {
    type: 'object',
    additionalProperties: false,
    properties: {
      summary: {
        type: 'string',
        description: 'A concise plain-language assessment of overall OpenClaw health.',
      },
      insights: {
        type: 'string',
        description: 'Optional optimization or follow-up advice. Use an empty string when none.',
      },
      additionalIssues: {
        type: 'array',
        description: 'Issues not already covered by the supplied known issue IDs.',
        items: {
          type: 'object',
          additionalProperties: false,
          properties: {
            severity: { type: 'string', enum: ['critical', 'high', 'medium', 'low'] },
            title: { type: 'string' },
            description: { type: 'string' },
            evidence: { type: 'string' },
          },
          required: ['severity', 'title', 'description', 'evidence'],
        },
      },
    },
    required: ['summary', 'insights', 'additionalIssues'],
  },
};

function positiveInteger(value, fallback) {
  const parsed = Number.parseInt(value, 10);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}

export function getAIConfig(env = process.env) {
  return {
    provider: env.AI_PROVIDER || 'openrouter',
    model: env.AI_MODEL || DEFAULT_MODEL,
    apiKey: env.AI_API_KEY || env.OPENROUTER_API_KEY || '',
    baseUrl: (env.AI_BASE_URL || DEFAULT_BASE_URL).replace(/\/$/, ''),
    maxTokens: positiveInteger(env.AI_MAX_TOKENS, DEFAULT_MAX_TOKENS),
    timeoutMs: positiveInteger(env.AI_TIMEOUT_MS, DEFAULT_TIMEOUT_MS),
  };
}

export async function requestAI({
  messages,
  stream = false,
  responseFormat,
  tools,
  toolChoice,
  config = getAIConfig(),
  fetchImpl = fetch,
}) {
  if (!config.apiKey) {
    throw new Error('AI is not configured');
  }

  const headers = {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${config.apiKey}`,
  };

  if (config.provider === 'openrouter') {
    headers['HTTP-Referer'] = 'https://clawfix.dev';
    headers['X-Title'] = 'ClawFix';
  }

  const body = {
    model: config.model,
    max_tokens: config.maxTokens,
    stream,
    messages,
  };

  if (Array.isArray(tools) && tools.length > 0) {
    body.tools = tools;
    if (toolChoice != null) body.tool_choice = toolChoice;
  }

  if (responseFormat) {
    body.response_format = responseFormat;
    if (config.provider === 'openrouter') {
      body.provider = { require_parameters: true };
    }
  }

  const response = await fetchImpl(`${config.baseUrl}/chat/completions`, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(config.timeoutMs),
  });

  if (!response.ok) {
    const detail = (await response.text()).replace(/\s+/g, ' ').slice(0, 500);
    throw new Error(`AI API ${response.status}${detail ? `: ${detail}` : ''}`);
  }

  if (stream) return response;

  const data = await response.json();
  const message = data.choices?.[0]?.message || {};
  const content = typeof message.content === 'string' ? message.content : '';
  const toolCalls = Array.isArray(message.tool_calls) ? message.tool_calls : [];

  if ((!content || content.trim() === '') && toolCalls.length === 0) {
    throw new Error('AI API returned no message content');
  }

  return {
    content,
    toolCalls,
    usage: data.usage || null,
  };
}

function stripMarkdownFence(value) {
  const trimmed = value.trim();
  const match = trimmed.match(/^```(?:json|bash|sh)?\s*([\s\S]*?)\s*```$/i);
  return match ? match[1].trim() : trimmed;
}

export function sanitizeAIRepairScript(value) {
  // Compatibility boundary: historical providers may still return this field.
  // Model-authored shell is never executable, downloadable, or persisted.
  return '';
}

export function parseAIAnalysis(content) {
  const parsed = JSON.parse(stripMarkdownFence(content));
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('AI analysis is not an object');
  }

  const summary = typeof parsed.summary === 'string' ? parsed.summary.trim() : '';
  if (!summary) throw new Error('AI analysis is missing a summary');

  const additionalIssues = Array.isArray(parsed.additionalIssues)
    ? parsed.additionalIssues
        .filter(issue => issue && typeof issue === 'object')
        .map(issue => ({
          severity: ['critical', 'high', 'medium', 'low'].includes(issue.severity)
            ? issue.severity
            : 'medium',
          title: String(issue.title || '').trim(),
          description: String(issue.description || '').trim(),
          evidence: String(issue.evidence || '').trim(),
        }))
        .filter(issue => issue.title && issue.description)
    : [];

  return {
    summary,
    insights: typeof parsed.insights === 'string' ? parsed.insights.trim() : '',
    additionalIssues,
    additionalFixes: '',
  };
}
