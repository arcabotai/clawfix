import { Router } from 'express';

export const resultsRouter = Router();

/**
 * Web-based results page — non-devs see diagnosis results in the browser.
 * Flow: user runs curl command → gets a fix ID → visits /results/:fixId in browser
 */
resultsRouter.get('/results/:fixId', (req, res) => {
  res.setHeader('Content-Type', 'text/html');
  res.send(resultsPage(req.params.fixId));
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
    const fixId = "${fixId}";
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
        '<p style="color:var(--muted)">Run the diagnostic again: <code>curl -sSL ' + API_BASE + '/fix | bash</code></p>';
    }

    function renderResults(data) {
      const issues = data.knownIssues || [];
      const count = data.issuesFound || issues.length;
      
      let html = '';
      
      // Summary
      html += '<div class="summary">';
      html += '<h2>' + (count === 0 ? '✅ No Issues Found' : '🔍 Found ' + count + ' Issue' + (count > 1 ? 's' : '')) + '</h2>';
      html += '<p style="color:var(--muted)">' + (data.analysis || 'Pattern matching analysis complete.') + '</p>';
      html += '</div>';

      // Issues list
      if (issues.length > 0) {
        issues.forEach(issue => {
          html += '<div class="issue">';
          html += '<h3><span class="badge badge-' + issue.severity + '">' + issue.severity + '</span> ' + issue.title + '</h3>';
          html += '<p>' + issue.description + '</p>';
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
        html += '<button class="btn btn-outline" onclick="copyScript()">Copy Script</button>';
        html += '<button class="btn" onclick="downloadScript()">Download fix.sh</button>';
        html += '</div></div>';
        html += '<pre id="fixScript">' + escapeHtml(data.fixScript) + '</pre>';
        html += '<p style="color:var(--muted);font-size:0.85rem;margin-top:8px">';
        html += '⚠️ Review the script before running it. Apply with: <code>bash fix.sh</code></p>';
        html += '</div>';
      }

      // Payment
      if (count > 0) {
        html += '<div class="payment">';
        html += '<h3>✅ Fix Generated!</h3>';
        html += '<p>This diagnosis saved you hours of debugging.<br>Pay what it\\'s worth — suggested: $2</p>';
        html += '<div class="payment-options">';
        html += '<button class="btn" onclick="alert(\\'Stripe payments coming soon!\\')">💳 Pay with Card</button>';
        html += '<button class="btn btn-outline" onclick="alert(\\'USDC payment coming soon!\\')">⬡ Pay with USDC</button>';
        html += '</div></div>';
      }

      // Meta
      html += '<p class="meta">Fix ID: ' + data.fixId + ' · Generated: ' + new Date(data.timestamp).toLocaleString();
      html += ' · Model: ' + (data.model || 'pattern-matching');
      html += '<br><a href="/">← Back to ClawFix</a></p>';

      document.getElementById('content').innerHTML = html;

      // Store script for copy/download
      window._fixScript = data.fixScript;
    }

    function escapeHtml(str) {
      return str.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
    }

    function copyScript() {
      navigator.clipboard.writeText(window._fixScript).then(() => {
        const btns = document.querySelectorAll('.btn-outline');
        btns.forEach(b => { if (b.textContent === 'Copy Script') { b.textContent = 'Copied!'; setTimeout(() => b.textContent = 'Copy Script', 2000); }});
      });
    }

    function downloadScript() {
      const blob = new Blob([window._fixScript], { type: 'text/x-sh' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url; a.download = 'clawfix-' + fixId + '.sh';
      a.click(); URL.revokeObjectURL(url);
    }

    loadResults();
  </script>
</body>
</html>`;
}
