import { Router } from 'express';

export const landingRouter = Router();

landingRouter.get('/', (req, res) => {
  // If the request wants JSON (API clients), return JSON
  if (req.headers.accept?.includes('application/json') && !req.headers.accept?.includes('text/html')) {
    return res.json({
      name: 'ClawFix',
      tagline: 'AI-powered OpenClaw repair',
      version: '0.9.0',
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
  <meta name="twitter:description" content="AI-powered diagnostic and repair for OpenClaw. Free during beta.">
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

    /* Beta banner */
    .beta-banner {
      background: linear-gradient(135deg, rgba(34,197,94,0.15), rgba(59,130,246,0.15));
      border: 1px solid var(--green);
      border-radius: 12px;
      padding: 16px 24px;
      max-width: 560px;
      margin: 0 auto 32px;
      text-align: center;
    }
    .beta-banner .beta-tag {
      display: inline-block;
      background: var(--green);
      color: #0a0a0a;
      font-size: 0.7rem;
      padding: 2px 8px;
      border-radius: 4px;
      font-weight: 700;
      text-transform: uppercase;
      letter-spacing: 0.05em;
      margin-bottom: 8px;
    }
    .beta-banner p {
      color: var(--green);
      font-size: 0.95rem;
      font-weight: 600;
    }
    .beta-banner .beta-sub {
      color: var(--muted);
      font-size: 0.8rem;
      font-weight: 400;
      margin-top: 4px;
    }
    .strikethrough {
      text-decoration: line-through;
      color: var(--muted);
      font-size: 1rem;
    }
    .free-tag {
      color: var(--green);
      font-weight: 800;
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
        <a href="#security">Security</a>
        <a href="#pricing">Pricing</a>
        <a href="https://github.com/arcabotai/clawfix">GitHub</a>
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

        <div class="beta-banner">
          <span class="beta-tag">🎉 Early Access</span>
          <p>Free during beta — all features, no payment required</p>
          <p class="beta-sub">Be an early user, help us improve, pay nothing</p>
        </div>

        <div class="command-box" onclick="copyCommand('npx')">
          <span class="prompt">$</span>
          <code id="cmd-npx">npx clawfix</code>
          <button class="copy-btn" id="copyBtn-npx">Copy</button>
        </div>
        <p class="command-hint" style="margin-bottom: 8px;">
          <strong style="color:var(--green)">Recommended</strong> — auditable source on <a href="https://www.npmjs.com/package/clawfix" style="color:var(--muted)">npm</a> and <a href="https://github.com/arcabotai/clawfix" style="color:var(--muted)">GitHub</a>
        </p>
        <p class="command-hint" style="margin-bottom: 4px;">Want to inspect before running? <code style="color:var(--green)">npx clawfix --dry-run</code></p>
        <p class="command-hint" style="margin-bottom: 48px;">Works on macOS, Linux, and WSL. Requires Node.js 18+.</p>
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
            <span class="issue-icon">⚡</span>
            <div>
              <h4>Native Codex Harness</h4>
              <p>PI route drift, Codex home mismatches, fast tier gaps, timeout boundaries</p>
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
          <div class="issue-item">
            <span class="issue-icon">🔧</span>
            <div>
              <h4>Service Manager Crashes</h4>
              <p>launchd/systemd SIGTERM recovery, crash loops, backoff detection</p>
            </div>
          </div>
          <div class="issue-item">
            <span class="issue-icon">👻</span>
            <div>
              <h4>Zombie Processes</h4>
              <p>PID exists but port not listening — stale gateway detection</p>
            </div>
          </div>
          <div class="issue-item">
            <span class="issue-icon">📜</span>
            <div>
              <h4>Error Log Bloat</h4>
              <p>Chrome extension spam, handshake storms, 200MB+ log files</p>
            </div>
          </div>
          <div class="issue-item">
            <span class="issue-icon">🐕</span>
            <div>
              <h4>Gateway Watchdog</h4>
              <p>Recommends independent health checks to avoid launchd backoff gaps</p>
            </div>
          </div>
          <div class="issue-item">
            <span class="issue-icon">🧵</span>
            <div>
              <h4>Provider Prefix Typos</h4>
              <p><code>codex/gpt-5.4</code> vs <code>openai-codex/gpt-5.4</code> — silent 403 + fallback loop on every cron</p>
            </div>
          </div>
          <div class="issue-item">
            <span class="issue-icon">🎣</span>
            <div>
              <h4>Discord Silent Drops</h4>
              <p><code>groupPolicy: allowlist</code> with empty <code>allowFrom</code> — group messages disappear without logs</p>
            </div>
          </div>
          <div class="issue-item">
            <span class="issue-icon">🔒</span>
            <div>
              <h4>Plaintext Secrets in Config</h4>
              <p>Flags fields still inline that should be SecretRefs pointing at <code>~/.openclaw/.env</code></p>
            </div>
          </div>
          <div class="issue-item">
            <span class="issue-icon">🪪</span>
            <div>
              <h4>Invalid GH Token Override</h4>
              <p>Invalid <code>GH_TOKEN</code> env shadows a working <code>gh</code> login and breaks every GitHub-using cron</p>
            </div>
          </div>
          <div class="issue-item">
            <span class="issue-icon">📡</span>
            <div>
              <h4>Stale Paired Nodes</h4>
              <p>Endless <code>skills-remote</code> probe timeouts from a paired node with no host daemon behind it</p>
            </div>
          </div>
          <div class="issue-item">
            <span class="issue-icon">🌊</span>
            <div>
              <h4>Context Overflow</h4>
              <p>Session stuck &gt;100 % of ctx window, auto-compaction failing — manifests as slow replies</p>
            </div>
          </div>
          <div class="issue-item">
            <span class="issue-icon">🔐</span>
            <div>
              <h4>FileVault Blocks Reboots</h4>
              <p>macOS — pre-boot prompt gates all services; any unattended reboot leaves the mac off-network</p>
            </div>
          </div>
          <div class="issue-item">
            <span class="issue-icon">📦</span>
            <div>
              <h4>Plist Stale Secrets</h4>
              <p>macOS — LaunchAgent <code>EnvironmentVariables</code> carries old secrets after a <code>.env</code> migration</p>
            </div>
          </div>
        </div>
      </div>
    </section>

    <section class="section" id="pricing">
      <div class="container">
        <h2 class="section-title">Pricing</h2>
        <div class="pricing-cards" style="grid-template-columns: minmax(300px, 520px); justify-content: center;">
          <div class="price-card featured">
            <span class="badge" style="background:var(--green);">For now</span>
            <div class="price free-tag">Free</div>
            <h3>Every feature, for everyone</h3>
            <p>Pattern-matching scan, AI analysis, generated fix scripts — all free while we're figuring out what&apos;s worth charging for.</p>
            <p style="margin-top:12px;color:var(--muted);font-size:0.8rem;">We may introduce paid tiers later (likely usage-based for heavy AI calls, or a hosted monitoring SKU). We&apos;ll announce before anything changes.</p>
          </div>
        </div>
      </div>
    </section>

    <section class="section" id="security">
      <div class="container">
        <h2 class="section-title">Security & Transparency</h2>
        <p style="color:var(--muted);text-align:center;max-width:600px;margin:0 auto 32px;font-size:0.95rem;">
          You're right to be skeptical of tools from the internet. Here's exactly what ClawFix does and doesn't do — verify it yourself.
        </p>
        <div class="trust-grid">
          <div class="trust-item">
            <span class="trust-icon">🔍</span>
            <div>
              <h4>Inspect Before Running</h4>
              <p><code>npx clawfix --dry-run</code> shows exactly what data would be collected — sends nothing. Read the output. Decide for yourself.</p>
            </div>
          </div>
          <div class="trust-item">
            <span class="trust-icon">🔓</span>
            <div>
              <h4>100% Open Source</h4>
              <p><a href="https://github.com/arcabotai/clawfix" style="color:var(--blue)">Every line on GitHub</a>. CLI source, server code, diagnostic script — all public. Audit it.</p>
            </div>
          </div>
          <div class="trust-item">
            <span class="trust-icon">🔒</span>
            <div>
              <h4>Secrets Auto-Redacted</h4>
              <p>API keys, tokens, passwords — all replaced with <code>***REDACTED***</code> before anything leaves your machine. The <code>env</code> block is skipped entirely.</p>
            </div>
          </div>
          <div class="trust-item">
            <span class="trust-icon">🚫</span>
            <div>
              <h4>No File Contents Read</h4>
              <p>ClawFix checks if SOUL.md exists — it never reads what's inside. No chat history, no memory files, no personal data.</p>
            </div>
          </div>
          <div class="trust-item">
            <span class="trust-icon">👀</span>
            <div>
              <h4>Consent Required</h4>
              <p>The diagnostic asks <code>[y/N]</code> before sending anything. No data leaves your machine without you typing "y".</p>
            </div>
          </div>
          <div class="trust-item">
            <span class="trust-icon">💾</span>
            <div>
              <h4>Fix Scripts = Your Review</h4>
              <p>Fix scripts are saved to <code>/tmp</code> for you to read first. Every fix backs up your config. Nothing auto-executes.</p>
            </div>
          </div>
        </div>
        <div style="background:var(--surface);border:1px solid var(--border);border-radius:12px;padding:24px;margin-top:32px;">
          <h3 style="font-size:1rem;margin-bottom:12px;">📦 What Exactly Is Sent</h3>
          <div style="display:grid;grid-template-columns:1fr 1fr;gap:24px;">
            <div>
              <p style="color:var(--green);font-weight:600;font-size:0.85rem;margin-bottom:8px;">✅ SENT (redacted)</p>
              <ul style="color:var(--muted);font-size:0.85rem;list-style:none;padding:0;">
                <li>• OS type, version, architecture</li>
                <li>• Node.js and npm versions</li>
                <li>• OpenClaw version</li>
                <li>• Config structure (all secrets redacted)</li>
                <li>• Recent error log lines</li>
                <li>• Plugin names + enabled status</li>
                <li>• Gateway status</li>
                <li>• Hostname hash (8 chars of SHA-256)</li>
              </ul>
            </div>
            <div>
              <p style="color:var(--accent);font-weight:600;font-size:0.85rem;margin-bottom:8px;">❌ NEVER SENT</p>
              <ul style="color:var(--muted);font-size:0.85rem;list-style:none;padding:0;">
                <li>• API keys, tokens, passwords</li>
                <li>• File contents (SOUL.md, memory, etc.)</li>
                <li>• Chat history or messages</li>
                <li>• IP address or real hostname</li>
                <li>• Environment variables</li>
                <li>• Personal data of any kind</li>
              </ul>
            </div>
          </div>
        </div>
      </div>
    </section>
  </main>

  <footer>
    <div class="container">
      <div class="footer-links">
        <a href="https://github.com/arcabotai/clawfix">Source Code</a>
        <a href="https://x.com/arcabotai">@arcabotai</a>
        <a href="https://arcabot.ai">arcabot.ai</a>
      </div>
      <p>Made by <a href="https://arcabot.ai">Arca</a> (arcabot.eth) · Not affiliated with OpenClaw</p>
    </div>
  </footer>

  <script>
    function copyCommand(type) {
      const cmd = document.getElementById('cmd-' + type).textContent;
      navigator.clipboard.writeText(cmd).then(() => {
        const btn = document.getElementById('copyBtn-' + type);
        btn.textContent = 'Copied!';
        setTimeout(() => { btn.textContent = 'Copy'; }, 2000);
      });
    }
  </script>
</body>
</html>`;
