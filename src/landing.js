import { Router } from 'express';

export const landingRouter = Router();

landingRouter.get('/', (req, res) => {
  // If the request wants JSON (API clients), return JSON
  if (req.headers.accept?.includes('application/json') && !req.headers.accept?.includes('text/html')) {
    return res.json({
      name: 'ClawFix',
      tagline: 'AI-powered OpenClaw repair',
      version: '0.1.0',
      fix: 'curl -sSL clawfix.dev/fix | bash',
    });
  }

  res.setHeader('Content-Type', 'text/html');
  res.send(LANDING_HTML);
});

const LANDING_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>ClawFix — AI-Powered OpenClaw Repair</title>
  <meta name="description" content="Fix your broken OpenClaw in one command. AI diagnoses issues and generates fix scripts automatically. No SSH access needed.">
  <meta property="og:title" content="ClawFix — Fix Your OpenClaw in One Command">
  <meta property="og:description" content="AI-powered diagnostic and repair for OpenClaw installations. Run one command, get a fix.">
  <meta property="og:url" content="https://clawfix.dev">
  <meta property="og:type" content="website">
  <meta name="twitter:card" content="summary_large_image">
  <meta name="twitter:title" content="ClawFix — Fix Your OpenClaw in One Command">
  <meta name="twitter:description" content="AI-powered diagnostic and repair for OpenClaw. $2 per fix.">
  <link rel="icon" href="data:image/svg+xml,<svg xmlns=%22http://www.w3.org/2000/svg%22 viewBox=%220 0 100 100%22><text y=%22.9em%22 font-size=%2290%22>🦞</text></svg>">
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    
    :root {
      --bg: #0a0a0a;
      --surface: #141414;
      --border: #262626;
      --text: #fafafa;
      --muted: #a1a1aa;
      --accent: #ef4444;
      --accent-glow: rgba(239, 68, 68, 0.15);
      --green: #22c55e;
      --yellow: #eab308;
      --blue: #3b82f6;
    }

    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      background: var(--bg);
      color: var(--text);
      line-height: 1.6;
      min-height: 100vh;
    }

    .container {
      max-width: 800px;
      margin: 0 auto;
      padding: 0 24px;
    }

    /* Header */
    header {
      padding: 20px 0;
      border-bottom: 1px solid var(--border);
    }
    header .container {
      display: flex;
      justify-content: space-between;
      align-items: center;
    }
    .logo {
      font-size: 1.25rem;
      font-weight: 700;
      text-decoration: none;
      color: var(--text);
    }
    .logo span { color: var(--accent); }
    .nav-links a {
      color: var(--muted);
      text-decoration: none;
      font-size: 0.9rem;
      margin-left: 24px;
      transition: color 0.2s;
    }
    .nav-links a:hover { color: var(--text); }

    /* Hero */
    .hero {
      padding: 80px 0 60px;
      text-align: center;
    }
    .hero-emoji {
      font-size: 4rem;
      margin-bottom: 24px;
      display: block;
    }
    h1 {
      font-size: 2.75rem;
      font-weight: 800;
      letter-spacing: -0.03em;
      line-height: 1.1;
      margin-bottom: 16px;
    }
    h1 .highlight {
      background: linear-gradient(135deg, var(--accent), #f97316);
      -webkit-background-clip: text;
      -webkit-text-fill-color: transparent;
      background-clip: text;
    }
    .subtitle {
      font-size: 1.25rem;
      color: var(--muted);
      max-width: 600px;
      margin: 0 auto 40px;
    }

    /* Command box */
    .command-box {
      background: var(--surface);
      border: 1px solid var(--border);
      border-radius: 12px;
      padding: 20px 24px;
      max-width: 560px;
      margin: 0 auto 16px;
      display: flex;
      align-items: center;
      gap: 12px;
      cursor: pointer;
      transition: border-color 0.2s, box-shadow 0.2s;
      position: relative;
    }
    .command-box:hover {
      border-color: var(--accent);
      box-shadow: 0 0 20px var(--accent-glow);
    }
    .command-box code {
      font-family: 'SF Mono', 'Fira Code', 'Cascadia Code', monospace;
      font-size: 1.1rem;
      color: var(--green);
      flex: 1;
      user-select: all;
    }
    .command-box .prompt {
      color: var(--muted);
      user-select: none;
    }
    .copy-btn {
      background: var(--border);
      border: none;
      color: var(--muted);
      padding: 6px 12px;
      border-radius: 6px;
      cursor: pointer;
      font-size: 0.85rem;
      transition: all 0.2s;
    }
    .copy-btn:hover {
      background: var(--accent);
      color: white;
    }
    .command-hint {
      color: var(--muted);
      font-size: 0.85rem;
      text-align: center;
      margin-bottom: 48px;
    }

    /* How it works */
    .section { padding: 60px 0; }
    .section-title {
      font-size: 1.5rem;
      font-weight: 700;
      margin-bottom: 32px;
      text-align: center;
    }
    
    .steps {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
      gap: 20px;
    }
    .step {
      background: var(--surface);
      border: 1px solid var(--border);
      border-radius: 12px;
      padding: 24px;
    }
    .step-num {
      display: inline-flex;
      width: 32px; height: 32px;
      align-items: center; justify-content: center;
      background: var(--accent-glow);
      color: var(--accent);
      border-radius: 8px;
      font-weight: 700;
      font-size: 0.9rem;
      margin-bottom: 12px;
    }
    .step h3 {
      font-size: 1rem;
      margin-bottom: 8px;
    }
    .step p {
      color: var(--muted);
      font-size: 0.9rem;
    }

    /* What it detects */
    .issues-grid {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(340px, 1fr));
      gap: 12px;
    }
    .issue-item {
      display: flex;
      align-items: flex-start;
      gap: 12px;
      padding: 16px;
      background: var(--surface);
      border: 1px solid var(--border);
      border-radius: 8px;
    }
    .issue-icon { font-size: 1.2rem; flex-shrink: 0; }
    .issue-item h4 { font-size: 0.95rem; margin-bottom: 2px; }
    .issue-item p { color: var(--muted); font-size: 0.8rem; }

    /* Pricing */
    .pricing-cards {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
      gap: 16px;
      max-width: 700px;
      margin: 0 auto;
    }
    .price-card {
      background: var(--surface);
      border: 1px solid var(--border);
      border-radius: 12px;
      padding: 24px;
      text-align: center;
    }
    .price-card.featured {
      border-color: var(--accent);
      box-shadow: 0 0 30px var(--accent-glow);
    }
    .price { font-size: 2rem; font-weight: 800; }
    .price-label { color: var(--muted); font-size: 0.85rem; }
    .price-card h3 { margin: 12px 0 8px; font-size: 1.1rem; }
    .price-card p { color: var(--muted); font-size: 0.85rem; }
    .price-card .badge {
      display: inline-block;
      background: var(--accent);
      color: white;
      font-size: 0.7rem;
      padding: 2px 8px;
      border-radius: 4px;
      margin-bottom: 8px;
      font-weight: 600;
      text-transform: uppercase;
    }

    /* Trust */
    .trust-grid {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(300px, 1fr));
      gap: 16px;
    }
    .trust-item {
      display: flex;
      gap: 12px;
      align-items: flex-start;
    }
    .trust-icon { font-size: 1.5rem; flex-shrink: 0; }
    .trust-item h4 { font-size: 0.95rem; margin-bottom: 4px; }
    .trust-item p { color: var(--muted); font-size: 0.85rem; }

    /* Footer */
    footer {
      padding: 40px 0;
      border-top: 1px solid var(--border);
      text-align: center;
      color: var(--muted);
      font-size: 0.85rem;
    }
    footer a {
      color: var(--muted);
      text-decoration: underline;
      text-underline-offset: 2px;
    }
    footer a:hover { color: var(--text); }
    .footer-links {
      display: flex;
      justify-content: center;
      gap: 24px;
      margin-bottom: 12px;
    }

    @media (max-width: 640px) {
      h1 { font-size: 2rem; }
      .hero { padding: 48px 0 40px; }
      .command-box code { font-size: 0.9rem; }
      .issues-grid { grid-template-columns: 1fr; }
    }
  </style>
</head>
<body>
  <header>
    <div class="container">
      <a href="/" class="logo">🦞 Claw<span>Fix</span></a>
      <nav class="nav-links">
        <a href="#how">How It Works</a>
        <a href="#pricing">Pricing</a>
        <a href="https://github.com/arcaboteth/clawfix">GitHub</a>
      </nav>
    </div>
  </header>

  <main>
    <section class="hero">
      <div class="container">
        <span class="hero-emoji">🦞</span>
        <h1>Fix your OpenClaw<br>in <span class="highlight">one command</span></h1>
        <p class="subtitle">
          AI-powered diagnostic and repair. No SSH access needed. 
          Runs locally, sends redacted logs, gets a fix script back.
        </p>

        <div class="command-box" onclick="copyCommand()">
          <span class="prompt">$</span>
          <code id="cmd">curl -sSL clawfix.dev/fix | bash</code>
          <button class="copy-btn" id="copyBtn">Copy</button>
        </div>
        <p class="command-hint">Works on macOS, Linux, and WSL. Requires Node.js.</p>
      </div>
    </section>

    <section class="section" id="how">
      <div class="container">
        <h2 class="section-title">How It Works</h2>
        <div class="steps">
          <div class="step">
            <div class="step-num">1</div>
            <h3>Run One Command</h3>
            <p>The diagnostic script scans your OpenClaw installation. Config, logs, plugins, ports — everything checked in seconds.</p>
          </div>
          <div class="step">
            <div class="step-num">2</div>
            <h3>AI Analyzes</h3>
            <p>Pattern matching catches known issues instantly. AI handles novel problems with deep analysis of your specific setup.</p>
          </div>
          <div class="step">
            <div class="step-num">3</div>
            <h3>Review & Apply</h3>
            <p>You get a commented fix script. Read it, understand it, then run it. Nothing happens without your approval.</p>
          </div>
        </div>
      </div>
    </section>

    <section class="section">
      <div class="container">
        <h2 class="section-title">What It Detects</h2>
        <div class="issues-grid">
          <div class="issue-item">
            <span class="issue-icon">💀</span>
            <div>
              <h4>Gateway Crashes</h4>
              <p>Port conflicts, process hangs, restart loops</p>
            </div>
          </div>
          <div class="issue-item">
            <span class="issue-icon">🧠</span>
            <div>
              <h4>Memory Issues</h4>
              <p>Mem0 silent failures, missing flush, broken search</p>
            </div>
          </div>
          <div class="issue-item">
            <span class="issue-icon">🌐</span>
            <div>
              <h4>Browser Automation</h4>
              <p>CDP port failures, extension loading, headless issues</p>
            </div>
          </div>
          <div class="issue-item">
            <span class="issue-icon">🔌</span>
            <div>
              <h4>Plugin Configs</h4>
              <p>Broken plugins, missing dependencies, wrong settings</p>
            </div>
          </div>
          <div class="issue-item">
            <span class="issue-icon">💸</span>
            <div>
              <h4>Token Waste</h4>
              <p>Excessive heartbeats, no pruning, bloated context</p>
            </div>
          </div>
          <div class="issue-item">
            <span class="issue-icon">🍎</span>
            <div>
              <h4>macOS Quirks</h4>
              <p>Metal GPU crashes, Apple Silicon issues, Peekaboo</p>
            </div>
          </div>
        </div>
      </div>
    </section>

    <section class="section" id="pricing">
      <div class="container">
        <h2 class="section-title">Pricing</h2>
        <div class="pricing-cards">
          <div class="price-card">
            <div class="price">Free</div>
            <h3>Quick Scan</h3>
            <p>Pattern matching against 12+ known issues. Instant results, no AI needed.</p>
          </div>
          <div class="price-card featured">
            <span class="badge">Most Popular</span>
            <div class="price">$2</div>
            <h3>AI Fix</h3>
            <p>Full AI analysis + generated fix script for novel issues. Pay after you see the fix.</p>
          </div>
          <div class="price-card">
            <div class="price">$9<span class="price-label">/mo</span></div>
            <h3>Monitoring</h3>
            <p>Continuous health checks. Get alerts before things break. <em>Coming soon.</em></p>
          </div>
        </div>
      </div>
    </section>

    <section class="section">
      <div class="container">
        <h2 class="section-title">Why Trust a Script From the Internet?</h2>
        <div class="trust-grid">
          <div class="trust-item">
            <span class="trust-icon">🔓</span>
            <div>
              <h4>Open Source</h4>
              <p>The diagnostic script is on GitHub. Read every line before running it.</p>
            </div>
          </div>
          <div class="trust-item">
            <span class="trust-icon">🔒</span>
            <div>
              <h4>Secrets Redacted</h4>
              <p>API keys, tokens, passwords — all stripped before anything leaves your machine.</p>
            </div>
          </div>
          <div class="trust-item">
            <span class="trust-icon">👀</span>
            <div>
              <h4>Review Before Apply</h4>
              <p>Fix scripts are shown to you first. Nothing runs without your explicit approval.</p>
            </div>
          </div>
          <div class="trust-item">
            <span class="trust-icon">💾</span>
            <div>
              <h4>Auto Backup</h4>
              <p>Every fix backs up your config first. One command to rollback if needed.</p>
            </div>
          </div>
        </div>
      </div>
    </section>
  </main>

  <footer>
    <div class="container">
      <div class="footer-links">
        <a href="https://github.com/arcaboteth/clawfix">Source Code</a>
        <a href="https://x.com/arcaboteth">@arcaboteth</a>
        <a href="https://arcabot.ai">arcabot.ai</a>
      </div>
      <p>Made by <a href="https://arcabot.ai">Arca</a> (arcabot.eth) · Not affiliated with OpenClaw</p>
    </div>
  </footer>

  <script>
    function copyCommand() {
      const cmd = document.getElementById('cmd').textContent;
      navigator.clipboard.writeText(cmd).then(() => {
        const btn = document.getElementById('copyBtn');
        btn.textContent = 'Copied!';
        setTimeout(() => { btn.textContent = 'Copy'; }, 2000);
      });
    }
  </script>
</body>
</html>`;
