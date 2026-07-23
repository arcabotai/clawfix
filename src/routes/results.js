import { Router } from 'express';
import { safeJsonForHtml, validateFixId } from '../../cli/bin/security.js';

export const resultsRouter = Router();

/**
 * Web-based results page — non-devs see diagnosis results in the browser.
 * Flow: user runs curl command → gets a fix ID → visits /results/:fixId in browser
 */
resultsRouter.get('/results/:fixId', (req, res) => {
  const fixId = validateFixId(req.params.fixId);
  if (!fixId) return res.status(400).type('text/plain').send('Invalid fix ID');
  res.setHeader('Content-Type', 'text/html');
  res.send(resultsPage(fixId));
});

function resultsPage(fixId) {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>ClawFix — Diagnosis Results</title>
  <link rel="icon" href="data:image/svg+xml,<svg xmlns=%22http://www.w3.org/2000/svg%22 viewBox=%220 0 100 100%22><text y=%22.9em%22 font-size=%2290%22>🦞</text></svg>">
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    :root {
      --bg: #0a0a0a; --surface: #141414; --border: #262626;
      --text: #fafafa; --muted: #a1a1aa;
      --red: #ef4444; --green: #22c55e; --yellow: #eab308; --blue: #3b82f6;
    }
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      background: var(--bg); color: var(--text); line-height: 1.6; min-height: 100vh;
      padding: 40px 24px;
    }
    .container { max-width: 720px; margin: 0 auto; }
    .header { display: flex; align-items: center; gap: 12px; margin-bottom: 32px; }
    .header a { color: var(--text); text-decoration: none; font-size: 1.25rem; font-weight: 700; }
    .header a span { color: var(--red); }
    .loading { text-align: center; padding: 80px 0; }
    .spinner {
      width: 40px; height: 40px; border: 3px solid var(--border);
      border-top-color: var(--red); border-radius: 50%;
      animation: spin 0.8s linear infinite; margin: 0 auto 16px;
    }
    @keyframes spin { to { transform: rotate(360deg); } }
    .error-box {
      background: rgba(239,68,68,0.1); border: 1px solid var(--red);
      border-radius: 8px; padding: 16px; margin-bottom: 24px;
    }
    .summary {
      background: var(--surface); border: 1px solid var(--border);
      border-radius: 12px; padding: 24px; margin-bottom: 24px;
    }
    .summary h2 { font-size: 1.25rem; margin-bottom: 12px; }
    .badge {
      display: inline-block; padding: 2px 8px; border-radius: 4px;
      font-size: 0.75rem; font-weight: 600; text-transform: uppercase;
    }
    .badge-critical { background: rgba(239,68,68,0.2); color: var(--red); }
    .badge-high { background: rgba(249,115,22,0.2); color: #f97316; }
    .badge-medium { background: rgba(234,179,8,0.2); color: var(--yellow); }
    .badge-low { background: rgba(59,130,246,0.2); color: var(--blue); }
    .issue {
      background: var(--surface); border: 1px solid var(--border);
      border-radius: 8px; padding: 16px; margin-bottom: 12px;
    }
    .issue h3 { font-size: 1rem; margin-bottom: 4px; display: flex; align-items: center; gap: 8px; }
    .issue p { color: var(--muted); font-size: 0.9rem; }
    .fix-section { margin-top: 32px; }
    .fix-section h2 { font-size: 1.25rem; margin-bottom: 16px; }
    pre {
      background: var(--surface); border: 1px solid var(--border);
      border-radius: 8px; padding: 16px; overflow-x: auto;
      font-family: 'SF Mono', 'Fira Code', monospace; font-size: 0.85rem;
      line-height: 1.5; white-space: pre-wrap; word-break: break-all;
    }
    .copy-bar {
      display: flex; justify-content: space-between; align-items: center;
      margin-bottom: 8px;
    }
    .copy-bar span { color: var(--muted); font-size: 0.85rem; }
    .btn {
      background: var(--red); color: white; border: none; padding: 8px 16px;
      border-radius: 6px; cursor: pointer; font-size: 0.85rem; font-weight: 600;
    }
    .btn:hover { opacity: 0.9; }
    .btn-outline {
      background: transparent; border: 1px solid var(--border); color: var(--text);
    }
    .btn-outline:hover { border-color: var(--red); }
    .ai-insights {
      background: var(--surface); border: 1px solid var(--border);
      border-radius: 12px; padding: 24px; margin-top: 24px;
    }
    .ai-insights h2 { font-size: 1.1rem; margin-bottom: 12px; display: flex; align-items: center; gap: 8px; }
    .ai-insights p { color: var(--muted); font-size: 0.9rem; white-space: pre-wrap; }
    .payment {
      background: var(--surface); border: 1px solid var(--green);
      border-radius: 12px; padding: 24px; margin-top: 32px; text-align: center;
    }
    .payment h3 { color: var(--green); margin-bottom: 8px; }
    .payment p { color: var(--muted); font-size: 0.9rem; margin-bottom: 16px; }
    .payment-options { display: flex; gap: 12px; justify-content: center; flex-wrap: wrap; }
    .meta { color: var(--muted); font-size: 0.8rem; margin-top: 24px; text-align: center; }
    .meta a { color: var(--muted); }
  </style>
</head>
<body>
  <div class="container">
    <div class="header">
      <a href="/">🦞 Claw<span>Fix</span></a>
    </div>
    <div id="content">
      <div class="loading">
        <div class="spinner"></div>
        <p>Loading diagnosis results...</p>
      </div>
    </div>
  </div>

  <script>
    const fixId = ${safeJsonForHtml(fixId)};
    const API_BASE = window.location.origin;

    async function loadResults() {
      try {
        const res = await fetch(API_BASE + '/api/fix/' + fixId);
        if (!res.ok) {
          if (res.status === 404) {
            showError('Fix not found or expired. Results are stored temporarily — try running the diagnostic again.');
            return;
          }
          throw new Error('API error: ' + res.status);
        }
        const data = await res.json();
        renderResults(data);
      } catch (err) {
        showError('Failed to load results: ' + err.message);
      }
    }

    function showError(msg) {
      document.getElementById('content').innerHTML = 
        '<div class="error-box"><strong>❌ Error</strong><br>' + msg + '</div>' +
        '<p style="color:var(--muted)">Run the diagnostic again: <code>npx clawfix@0.10.0</code></p>';
    }

    function renderResults(data) {
      const issues = data.knownIssues || [];
      const count = typeof data.issuesFound === 'number'
        ? data.issuesFound
        : issues.filter(issue => issue.kind !== 'optimization').length;
      const optimizationCount = typeof data.optimizationsFound === 'number'
        ? data.optimizationsFound
        : issues.filter(issue => issue.kind === 'optimization').length;

      let html = '';

      // System Info section
      if (data.systemInfo || data._systemInfo) {
        const sys = data.systemInfo || data._systemInfo || {};
        html += '<div class="summary" style="margin-bottom:16px">';
        html += '<h2>🖥 System Info</h2>';
        html += '<div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-top:12px;font-size:0.9rem">';
        if (sys.os) html += '<div><span style="color:var(--muted)">OS:</span> ' + escapeHtml(sys.os) + '</div>';
        if (sys.nodeVersion) html += '<div><span style="color:var(--muted)">Node:</span> ' + escapeHtml(sys.nodeVersion) + '</div>';
        if (sys.openclawVersion) html += '<div><span style="color:var(--muted)">OpenClaw:</span> ' + escapeHtml(sys.openclawVersion) + '</div>';
        if (sys.serviceManager) {
          var smColor = sys.serviceState === 'running' ? 'var(--green)' : (sys.serviceState === 'sigterm' || sys.serviceState === 'crashed' || sys.serviceState === 'failed') ? 'var(--red)' : 'var(--yellow)';
          html += '<div><span style="color:var(--muted)">Service:</span> ' + escapeHtml(sys.serviceManager) + ' <span style="color:' + smColor + '">(' + escapeHtml(sys.serviceState || 'unknown') + ')</span></div>';
        }
        html += '</div></div>';
      }

      // Summary
      html += '<div class="summary">';
      html += '<h2>' + (count === 0
        ? '✅ Healthy' + (optimizationCount > 0 ? ' — ' + optimizationCount + ' Optional Optimization' + (optimizationCount > 1 ? 's' : '') : '')
        : '🔍 Found ' + count + ' Issue' + (count > 1 ? 's' : '') + (optimizationCount > 0 ? ' and ' + optimizationCount + ' Optimization' + (optimizationCount > 1 ? 's' : '') : '')) + '</h2>';
      html += '<p style="color:var(--muted)">' + escapeHtml(data.analysis || 'Pattern matching analysis complete.') + '</p>';
      html += '</div>';

      // Issues list
      if (issues.length > 0) {
        issues.forEach(issue => {
          var severity = ['critical', 'high', 'medium', 'low'].includes(issue.severity) ? issue.severity : 'medium';
          var optional = issue.kind === 'optimization';
          var borderColor = optional ? 'var(--blue)' : ({critical: 'var(--red)', high: '#f97316', medium: 'var(--yellow)', low: 'var(--blue)'}[severity] || 'var(--border)');
          html += '<div class="issue" style="border-left:3px solid ' + borderColor + '">';
          html += '<h3><span class="badge badge-' + severity + '" style="font-size:0.8rem;padding:3px 10px">' + (optional ? 'OPTIONAL' : severity.toUpperCase()) + '</span> ' + escapeHtml(issue.title || 'Finding') + '</h3>';
          html += '<p>' + escapeHtml(issue.description || '') + '</p>';
          html += '</div>';
        });
      }

      // AI insights
      if (data.aiInsights) {
        html += '<div class="ai-insights">';
        html += '<h2>🧠 AI Insights</h2>';
        html += '<p>' + escapeHtml(data.aiInsights) + '</p>';
        html += '</div>';
      }

      // Fix script
      if (data.fixScript) {
        html += '<div class="fix-section">';
        html += '<div class="copy-bar">';
        html += '<h2>🔧 Fix Script</h2>';
        html += '<div style="display:flex;gap:8px">';
        html += '<button class="btn btn-outline" onclick="copyScript()">📋 Copy Script</button>';
        html += '<a class="btn" href="' + API_BASE + '/api/fix/' + fixId + '?format=script" download="clawfix-' + fixId + '.sh" style="text-decoration:none;display:inline-block">⬇ Download fix.sh</a>';
        html += '</div></div>';
        html += '<pre id="fixScript">' + escapeHtml(data.fixScript) + '</pre>';
        html += '<p style="color:var(--muted);font-size:0.85rem;margin-top:8px">';
        html += '⚠️ Review the script before running it. Apply with: <code>bash fix.sh</code></p>';
        if (data.systemInfo && data.systemInfo.os && data.systemInfo.os.includes('Darwin')) {
          html += '<p style="color:var(--yellow);font-size:0.85rem;margin-top:8px">';
          html += '🍎 macOS detected — fix scripts may use <code>launchctl unload/load</code> for gateway recovery instead of <code>openclaw gateway restart</code>.</p>';
        }
        html += '</div>';
      }

      // Beta notice (no payment during beta)
      if (count > 0) {
        html += '<div class="payment" style="border-color: var(--green);">';
        html += '<h3>🎉 Free During Beta!</h3>';
        html += '<p>This diagnosis is on us. Enjoy full AI analysis for free while we\\'re in early access.<br>';
        html += 'Like ClawFix? Star us on <a href="https://github.com/arcabotai/clawfix" style="color:var(--green)">GitHub</a> — it helps a lot.</p>';
        html += '</div>';
      }

      // Meta
      html += '<p class="meta">Fix ID: ' + escapeHtml(data.fixId || fixId) + ' · Generated: ' + escapeHtml(new Date(data.timestamp).toLocaleString());
      html += ' · Model: ' + escapeHtml(data.model || 'pattern-matching');
      html += '<br><a href="/">← Back to ClawFix</a></p>';

      document.getElementById('content').innerHTML = html;

      // Store script for copy/download
      window._fixScript = data.fixScript;
    }

    function escapeHtml(str) {
      return String(str).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;');
    }

    function copyScript() {
      if (!window._fixScript) { alert('No fix script available'); return; }
      
      // Method 1: Modern clipboard API
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(window._fixScript).then(() => {
          showCopySuccess();
        }).catch(() => fallbackCopy());
      } else {
        fallbackCopy();
      }
    }

    function fallbackCopy() {
      // Method 2: textarea + execCommand (works on mobile)
      const ta = document.createElement('textarea');
      ta.value = window._fixScript;
      ta.style.position = 'fixed';
      ta.style.left = '-9999px';
      document.body.appendChild(ta);
      ta.focus();
      ta.select();
      try {
        document.execCommand('copy');
        showCopySuccess();
      } catch(e) {
        // Method 3: Select the pre element text
        const pre = document.getElementById('fixScript');
        if (pre) {
          const range = document.createRange();
          range.selectNodeContents(pre);
          const sel = window.getSelection();
          sel.removeAllRanges();
          sel.addRange(range);
          alert('Text selected — press Ctrl+C / Cmd+C to copy');
        }
      }
      document.body.removeChild(ta);
    }

    function showCopySuccess() {
      const btn = document.querySelector('[onclick="copyScript()"]');
      if (btn) {
        btn.textContent = '✅ Copied!';
        setTimeout(() => btn.textContent = '📋 Copy Script', 2000);
      }
    }

    loadResults();
  </script>
</body>
</html>`;
}
