import { Router } from 'express';
import { nanoid } from 'nanoid';
import { detectIssues, KNOWN_ISSUES } from '../known-issues.js';
import { storeDiagnosis, storeFeedback, getStats } from '../db.js';

export const diagnoseRouter = Router();

// In-memory store for fix results (use Redis/DB in production)
const fixes = new Map();

// Model configuration — swap easily via env vars
const AI_CONFIG = {
  provider: process.env.AI_PROVIDER || 'openrouter', // openrouter | anthropic | deepseek | gemini
  model: process.env.AI_MODEL || 'minimax/minimax-m2.5',
  apiKey: process.env.AI_API_KEY || process.env.OPENROUTER_API_KEY || process.env.ANTHROPIC_API_KEY,
  baseUrl: process.env.AI_BASE_URL || 'https://openrouter.ai/api/v1',
  maxTokens: 2000,
};

// Provider base URLs
const PROVIDER_URLS = {
  openrouter: 'https://openrouter.ai/api/v1',
  anthropic: 'https://api.anthropic.com/v1',
  deepseek: 'https://api.deepseek.com/v1',
  gemini: 'https://generativelanguage.googleapis.com/v1beta',
  together: 'https://api.together.xyz/v1',
  minimax: 'https://api.minimax.chat/v1',
};

const SYSTEM_PROMPT = `You are ClawFix, an expert AI diagnostician for OpenClaw installations.
You analyze diagnostic data from users' OpenClaw setups and generate precise fix scripts.

Your expertise comes from real-world experience running OpenClaw in production:
- Memory configuration (hybrid search, context pruning, compaction, Mem0)
- Gateway issues (port conflicts, crashes, restarts)
- Browser automation (Chrome relay, managed browser, headless deployments)
- Plugin configuration (Mem0, LanceDB, Matrix, Discord)
- Token usage optimization (heartbeat intervals, model selection, pruning)
- VPS and headless deployment issues
- macOS-specific issues (Metal GPU, Peekaboo, Apple Silicon)

Rules:
1. Generate bash fix scripts that are safe, idempotent, and well-commented
2. ALWAYS create a backup before modifying any file
3. Explain each fix in plain language
4. If you're not sure about something, say so — don't guess
5. Never include secrets, tokens, or API keys in your output
6. Prioritize fixes by severity (critical > high > medium > low)
7. Each fix should be independently runnable
8. Test commands should be included so users can verify the fix worked`;

diagnoseRouter.post('/diagnose', async (req, res) => {
  try {
    const diagnostic = req.body;

    if (!diagnostic || !diagnostic.system) {
      return res.status(400).json({
        error: 'Invalid diagnostic payload',
        hint: 'Run the diagnostic script: curl -sSL clawfix.dev/fix | bash'
      });
    }

    // Step 1: Pattern matching (fast, free)
    const knownIssues = detectIssues(diagnostic);

    // Step 2: AI analysis (for novel issues and better explanations)
    const aiAnalysis = await analyzeWithAI(diagnostic, knownIssues);

    // Generate fix ID
    const fixId = nanoid(12);

    // Combine known fixes + AI fixes into a single script
    const fixScript = generateFixScript(knownIssues, aiAnalysis, fixId);

    // Store for later retrieval
    const result = {
      fixId,
      timestamp: new Date().toISOString(),
      issuesFound: knownIssues.length + (aiAnalysis.additionalIssues?.length || 0),
      knownIssues: knownIssues.map(i => ({
        id: i.id,
        severity: i.severity,
        title: i.title,
        description: i.description,
      })),
      analysis: aiAnalysis.summary,
      fixScript,
      aiInsights: aiAnalysis.insights || '',
      model: AI_CONFIG.model,
      // Internal metadata for DB (not sent to client)
      _hostHash: diagnostic.hostHash,
      _os: diagnostic.system?.os,
      _arch: diagnostic.system?.arch,
      _nodeVersion: diagnostic.system?.nodeVersion,
      _openclawVersion: diagnostic.openclaw?.version,
      _aiIssues: aiAnalysis.additionalIssues || [],
    };

    fixes.set(fixId, result);

    // Persist to database
    const source = req.headers['user-agent']?.includes('node') ? 'npx' : 'curl';
    storeDiagnosis(result, source).catch(() => {});

    // Clean up old fixes (keep last 1000)
    if (fixes.size > 1000) {
      const oldest = fixes.keys().next().value;
      fixes.delete(oldest);
    }

    // Strip internal metadata before sending to client
    const { _hostHash, _os, _arch, _nodeVersion, _openclawVersion, _aiIssues, ...clientResult } = result;
    res.json(clientResult);
  } catch (error) {
    console.error('Diagnosis error:', error);
    res.status(500).json({
      error: 'Diagnosis failed',
      message: error.message,
      hint: 'If this persists, report at https://github.com/arcaboteth/clawfix/issues'
    });
  }
});

// Retrieve a previously generated fix
diagnoseRouter.get('/fix/:fixId', (req, res) => {
  const fix = fixes.get(req.params.fixId);
  if (!fix) {
    return res.status(404).json({ error: 'Fix not found or expired' });
  }
  
  // Return just the script as plain text
  if (req.headers.accept === 'text/plain' || req.query.format === 'script') {
    res.setHeader('Content-Type', 'text/plain');
    return res.send(fix.fixScript);
  }
  
  res.json(fix);
});

// Stats endpoint
diagnoseRouter.get('/stats', async (req, res) => {
  const dbStats = await getStats();
  
  res.json({
    totalDiagnoses: dbStats?.totalDiagnoses || fixes.size,
    last24h: dbStats?.last24h || 0,
    topIssues: dbStats?.topIssues || [],
    versionBreakdown: dbStats?.versionBreakdown || [],
    outcomes: dbStats?.outcomes || [],
    uptime: process.uptime(),
    version: '0.1.0',
    aiProvider: AI_CONFIG.provider,
    aiModel: AI_CONFIG.model,
    aiAvailable: !!AI_CONFIG.apiKey,
  });
});

// Feedback endpoint — did the fix work?
diagnoseRouter.post('/feedback/:fixId', async (req, res) => {
  const { fixId } = req.params;
  const success = req.body?.success ?? req.query?.success === 'true';
  const issuesRemaining = req.body?.issuesRemaining ?? (parseInt(req.query?.remaining) || null);
  const comment = req.body?.comment || null;

  await storeFeedback(fixId, success, issuesRemaining, comment);

  res.json({ received: true, fixId, success });
});

/**
 * Call AI via OpenAI-compatible API (works with OpenRouter, Together, DeepSeek, etc.)
 */
async function callAI(systemPrompt, userMessage) {
  const baseUrl = AI_CONFIG.baseUrl || PROVIDER_URLS[AI_CONFIG.provider] || PROVIDER_URLS.openrouter;
  
  const headers = {
    'Content-Type': 'application/json',
    'Authorization': `Bearer ${AI_CONFIG.apiKey}`,
  };

  // OpenRouter-specific headers
  if (AI_CONFIG.provider === 'openrouter') {
    headers['HTTP-Referer'] = 'https://clawfix.dev';
    headers['X-Title'] = 'ClawFix';
  }

  const body = {
    model: AI_CONFIG.model,
    max_tokens: AI_CONFIG.maxTokens,
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userMessage },
    ],
  };

  const response = await fetch(`${baseUrl}/chat/completions`, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const err = await response.text();
    throw new Error(`AI API ${response.status}: ${err}`);
  }

  const data = await response.json();
  return data.choices?.[0]?.message?.content || '';
}

async function analyzeWithAI(diagnostic, knownIssues) {
  try {
    if (!AI_CONFIG.apiKey) {
      return {
        summary: `Pattern matching found ${knownIssues.length} issue(s). AI analysis unavailable (no API key configured).`,
        insights: '',
        additionalIssues: [],
        additionalFixes: '',
      };
    }

    const knownIds = knownIssues.map(i => i.id);

    const userMessage = `Analyze this OpenClaw diagnostic data. 
        
Known issues already detected by pattern matching: ${knownIds.join(', ') || 'none'}

Look for ADDITIONAL issues not covered by the known patterns. Also provide:
1. A brief plain-language summary of the overall health
2. Any optimization suggestions
3. Fix scripts for any new issues you find

Diagnostic data:
${JSON.stringify(diagnostic, null, 2)}`;

    const response = await callAI(SYSTEM_PROMPT, userMessage);

    return {
      summary: extractSection(response, 'summary') || response.slice(0, 500),
      insights: extractSection(response, 'optimization') || '',
      additionalIssues: [],
      additionalFixes: extractSection(response, 'fix') || '',
      raw: response,
    };
  } catch (error) {
    console.error('AI analysis failed:', error.message);
    return {
      summary: `Pattern matching found ${knownIssues.length} issue(s). AI analysis unavailable (${error.message}).`,
      insights: '',
      additionalIssues: [],
      additionalFixes: '',
    };
  }
}

function extractSection(text, keyword) {
  const regex = new RegExp(`(?:^|\\n)(?:#+\\s*)?(?:${keyword})[:\\s]*\\n([\\s\\S]*?)(?=\\n#+|$)`, 'i');
  const match = text.match(regex);
  return match ? match[1].trim() : '';
}

function generateFixScript(knownIssues, aiAnalysis, fixId) {
  const lines = [
    '#!/usr/bin/env bash',
    `# ClawFix Fix Script — ${fixId}`,
    `# Generated: ${new Date().toISOString()}`,
    '# Review each step before running!',
    '#',
    '# Usage: bash fix.sh',
    '',
    'set -euo pipefail',
    '',
    '# Backup current config',
    'if [ -f ~/.openclaw/openclaw.json ]; then',
    '  cp ~/.openclaw/openclaw.json ~/.openclaw/openclaw.json.bak.$(date +%s)',
    '  echo "✅ Config backed up"',
    'fi',
    '',
  ];

  // Add known issue fixes
  for (const issue of knownIssues) {
    lines.push(`# ─── Fix: ${issue.title} (${issue.severity}) ───`);
    lines.push(`# ${issue.description}`);
    lines.push(issue.fix);
    lines.push('');
  }

  // Add AI-generated fixes
  if (aiAnalysis.additionalFixes) {
    lines.push('# ─── Additional AI-Recommended Fixes ───');
    lines.push(aiAnalysis.additionalFixes);
    lines.push('');
  }

  // Restart gateway
  if (knownIssues.some(i => i.fix.includes('openclaw.json'))) {
    lines.push('# ─── Restart Gateway to Apply Changes ───');
    lines.push('echo "Restarting OpenClaw gateway..."');
    lines.push('openclaw gateway restart 2>/dev/null || echo "⚠️  Could not restart gateway automatically. Run: openclaw gateway restart"');
    lines.push('');
  }

  lines.push('echo ""');
  lines.push('echo "🦞 All fixes applied! Run \'openclaw status\' to verify."');
  lines.push(`echo "Fix ID: ${fixId}"`);
  lines.push('');
  lines.push('# ─── Optional: Tell ClawFix if this worked ───');
  lines.push('# This helps us improve fixes for everyone. Remove if you prefer.');
  lines.push(`curl -s -X POST "https://clawfix.dev/api/feedback/${fixId}" \\`);
  lines.push('  -H "Content-Type: application/json" \\');
  lines.push('  -d \'{"success": true}\' &>/dev/null || true');

  return lines.join('\n');
}
