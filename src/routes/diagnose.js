import { Router } from 'express';
import Anthropic from '@anthropic-ai/sdk';
import { nanoid } from 'nanoid';
import { detectIssues, KNOWN_ISSUES } from '../known-issues.js';

export const diagnoseRouter = Router();

const anthropic = new Anthropic();

// In-memory store for fix results (use Redis/DB in production)
const fixes = new Map();

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
        hint: 'Run the diagnostic script: curl -sSL clawfix.com/fix | bash'
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
    };

    fixes.set(fixId, result);

    // Clean up old fixes (keep last 1000)
    if (fixes.size > 1000) {
      const oldest = fixes.keys().next().value;
      fixes.delete(oldest);
    }

    res.json(result);
  } catch (error) {
    console.error('Diagnosis error:', error);
    res.status(500).json({
      error: 'Diagnosis failed',
      message: error.message,
      hint: 'If this persists, report at https://github.com/ArcaHQ/clawfix/issues'
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

async function analyzeWithAI(diagnostic, knownIssues) {
  try {
    const knownIds = knownIssues.map(i => i.id);

    const message = await anthropic.messages.create({
      model: 'claude-sonnet-4-6-20250514',
      max_tokens: 2000,
      system: SYSTEM_PROMPT,
      messages: [{
        role: 'user',
        content: `Analyze this OpenClaw diagnostic data. 
        
Known issues already detected by pattern matching: ${knownIds.join(', ') || 'none'}

Look for ADDITIONAL issues not covered by the known patterns. Also provide:
1. A brief plain-language summary of the overall health
2. Any optimization suggestions
3. Fix scripts for any new issues you find

Diagnostic data:
${JSON.stringify(diagnostic, null, 2)}`
      }],
    });

    const response = message.content[0].text;

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

  return lines.join('\n');
}
