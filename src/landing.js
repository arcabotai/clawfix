import { Router } from 'express';

export const landingRouter = Router();

landingRouter.get('/', (req, res) => {
  // If the request wants JSON (API clients), return JSON
  if (req.headers.accept?.includes('application/json') && !req.headers.accept?.includes('text/html')) {
    return res.json({
      name: 'ClawFix',
      tagline: 'OpenClaw diagnostics and guarded repairs',
      version: '0.11.2',
      install: 'curl --fail --show-error --silent --location https://clawfix.dev/install --output install.sh && bash install.sh',
      fix: 'npx clawfix@0.11.2',
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
  <meta name="theme-color" content="#0a0a0a">
  <title>ClawFix 0.11.2 — OpenClaw Diagnostics & Repair</title>
  <meta name="description" content="Run local, auditable OpenClaw diagnostics and review guarded repairs before applying them. ClawFix 0.11.2 is signed on npm, and the chat-first TUI is now merged on main.">
  <meta property="og:title" content="ClawFix 0.11.2 — Evidence Before Repair">
  <meta property="og:description" content="Local OpenClaw diagnostics, redacted evidence, guarded repairs, and a chat-first TUI now merged on main.">
  <meta property="og:url" content="https://clawfix.dev">
  <meta property="og:type" content="website">
  <meta name="twitter:card" content="summary_large_image">
  <meta name="twitter:title" content="ClawFix 0.11.2 — Evidence Before Repair">
  <meta name="twitter:description" content="Local OpenClaw diagnostics and guarded repairs. Chat-first TUI now merged on main.">
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

    html {
      color-scheme: dark;
      scroll-behavior: smooth;
    }

    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      background: var(--bg);
      color: var(--text);
      line-height: 1.6;
      min-height: 100vh;
      overflow-x: hidden;
    }

    .container {
      max-width: 920px;
      margin: 0 auto;
      padding: 0 24px;
    }

    .skip-link {
      position: fixed;
      top: 12px;
      left: 12px;
      z-index: 100;
      padding: 10px 14px;
      border-radius: 8px;
      background: var(--text);
      color: var(--bg);
      font-weight: 700;
      text-decoration: none;
      transform: translateY(-160%);
      transition: transform 0.2s;
    }
    .skip-link:focus-visible { transform: translateY(0); }
    :focus-visible {
      outline: 3px solid var(--blue);
      outline-offset: 3px;
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
    .logo,
    .nav-links a,
    .nav-toggle {
      min-height: 44px;
      touch-action: manipulation;
      -webkit-tap-highlight-color: rgba(239, 68, 68, 0.28);
    }
    .logo { display: inline-flex; align-items: center; }
    .logo span { color: var(--accent); }
    .nav-links {
      display: flex;
      align-items: center;
    }
    .nav-links a {
      display: inline-flex;
      align-items: center;
      color: var(--muted);
      text-decoration: none;
      font-size: 0.9rem;
      margin-left: 24px;
      transition: color 0.2s;
    }
    .nav-links a:hover { color: var(--text); }
    .nav-toggle {
      display: none;
      align-items: center;
      justify-content: center;
      border: 1px solid var(--border);
      border-radius: 8px;
      background: var(--surface);
      color: var(--text);
      padding: 8px 14px;
      font: inherit;
      font-weight: 700;
      cursor: pointer;
    }
    main:focus { outline: none; }
    section[id] { scroll-margin-top: 24px; }

    /* Hero */
    .hero {
      padding: 56px 0 48px;
      text-align: center;
    }
    .hero-emoji {
      font-size: 2.75rem;
      margin-bottom: 18px;
      display: block;
    }
    h1 {
      font-size: 2.75rem;
      font-weight: 800;
      letter-spacing: -0.03em;
      line-height: 1.1;
      margin-bottom: 16px;
    }
    h1, h2, h3 { text-wrap: balance; }
    h1 .highlight {
      background: linear-gradient(135deg, var(--accent), #f97316);
      -webkit-background-clip: text;
      -webkit-text-fill-color: transparent;
      background-clip: text;
    }
    .subtitle {
      font-size: 1.25rem;
      color: var(--muted);
      max-width: 680px;
      margin: 0 auto 28px;
    }

    /* Command box */
    .command-box {
      background: var(--surface);
      border: 1px solid var(--border);
      border-radius: 12px;
      padding: 18px 20px;
      max-width: 720px;
      margin: 0 auto 12px;
      display: grid;
      grid-template-columns: 20px minmax(0, 1fr) auto;
      align-items: center;
      gap: 12px;
      transition: border-color 0.2s, box-shadow 0.2s;
      position: relative;
      text-align: left;
    }
    .command-box:hover {
      border-color: var(--accent);
      box-shadow: 0 0 20px var(--accent-glow);
    }
    .command-box code {
      font-family: 'SF Mono', 'Fira Code', 'Cascadia Code', monospace;
      font-size: 0.98rem;
      color: var(--green);
      flex: 1;
      user-select: all;
      white-space: nowrap;
      overflow-x: auto;
      scrollbar-width: thin;
    }
    .command-box .prompt {
      color: var(--muted);
      user-select: none;
    }
    .copy-btn {
      background: var(--border);
      border: none;
      color: var(--muted);
      padding: 8px 14px;
      min-height: 44px;
      border-radius: 6px;
      cursor: pointer;
      font-size: 0.85rem;
      touch-action: manipulation;
      transition: background-color 0.2s, color 0.2s;
    }
    .copy-btn:hover {
      background: var(--accent);
      color: white;
    }

    .status-row {
      display: flex;
      justify-content: center;
      align-items: center;
      flex-wrap: wrap;
      gap: 10px;
      margin: 0 auto 28px;
    }
    .status-pill {
      display: inline-flex;
      align-items: center;
      gap: 8px;
      border: 1px solid var(--border);
      border-radius: 999px;
      background: rgba(255,255,255,0.025);
      color: var(--muted);
      font-size: 0.8rem;
      line-height: 1;
      padding: 9px 12px;
      text-decoration: none;
      transition: border-color 0.2s, color 0.2s;
    }
    .status-pill:hover { border-color: var(--accent); color: var(--text); }
    .status-pill strong {
      color: var(--accent);
      font-size: 0.68rem;
      font-weight: 800;
      letter-spacing: 0.06em;
      text-transform: uppercase;
    }
    .free-tag { color: var(--green); font-weight: 800; }

    .command-hint {
      color: var(--muted);
      font-size: 0.9rem;
      text-align: center;
      max-width: 760px;
      margin: 0 auto 10px;
    }
    .command-hint code {
      color: var(--text);
      background: rgba(255,255,255,0.045);
      border: 1px solid rgba(255,255,255,0.055);
      border-radius: 4px;
      padding: 1px 4px;
      font-size: 0.82rem;
    }
    .command-hint a { color: var(--muted); }
    .command-hint a:hover { color: var(--text); }

    .install-panel {
      max-width: 860px;
      margin: 0 auto;
      padding: 24px;
      border: 1px solid var(--border);
      border-radius: 16px;
      background: linear-gradient(180deg, rgba(255,255,255,0.035), rgba(20,20,20,0.76));
      text-align: left;
    }
    .install-heading {
      display: flex;
      align-items: flex-start;
      justify-content: space-between;
      gap: 20px;
      margin-bottom: 18px;
    }
    .install-heading h2 { font-size: 1.25rem; line-height: 1.3; }
    .install-heading p { color: var(--muted); font-size: 0.9rem; max-width: 520px; }
    .install-steps {
      display: grid;
      grid-template-columns: repeat(3, minmax(0, 1fr));
      gap: 12px;
    }
    .install-step {
      min-width: 0;
      padding: 14px;
      border: 1px solid var(--border);
      border-radius: 10px;
      background: rgba(10,10,10,0.55);
    }
    .install-step-label {
      display: flex;
      align-items: center;
      gap: 8px;
      margin-bottom: 8px;
      color: var(--text);
      font-size: 0.82rem;
      font-weight: 700;
    }
    .install-step-label span {
      display: inline-flex;
      width: 24px;
      height: 24px;
      align-items: center;
      justify-content: center;
      border-radius: 999px;
      background: var(--accent-glow);
      color: var(--accent);
    }
    .install-step .command-box,
    .quick-command .command-box {
      grid-template-columns: minmax(0, 1fr) auto;
      padding: 10px;
      margin: 0;
    }
    .install-step .command-box code,
    .quick-command .command-box code { font-size: 0.78rem; }
    .install-step .command-box code { white-space: normal; overflow-wrap: anywhere; }
    .install-step .command-box code span { white-space: nowrap; }
    .install-step .copy-btn { min-width: 44px; padding-inline: 8px; }
    .install-step-note { margin-top: 8px; color: var(--muted); font-size: 0.75rem; }
    .install-step-note a { color: var(--text); }
    .quick-command { margin-top: 12px; }
    .quick-command h3 { margin-bottom: 6px; font-size: 0.9rem; }
    .quick-command > p { margin-bottom: 8px; color: var(--muted); font-size: 0.8rem; }
    .privacy-summary {
      display: grid;
      grid-template-columns: repeat(3, minmax(0, 1fr));
      gap: 10px;
      margin-top: 16px;
    }
    .privacy-summary p {
      padding: 10px 12px;
      border-left: 2px solid var(--green);
      background: rgba(34,197,94,0.055);
      color: var(--muted);
      font-size: 0.78rem;
    }
    .privacy-summary strong { color: var(--text); }
    .privacy-summary a { color: var(--text); }

    .proof-row {
      display: flex;
      justify-content: center;
      flex-wrap: wrap;
      gap: 8px;
      margin: 20px auto 0;
    }
    .proof-pill {
      border: 1px solid var(--border);
      border-radius: 999px;
      padding: 6px 10px;
      color: var(--muted);
      font-size: 0.75rem;
      background: rgba(255,255,255,0.02);
    }
    .proof-pill strong { color: var(--green); }

    .release-panel {
      background: linear-gradient(180deg, rgba(239,68,68,0.08), rgba(20,20,20,0.6));
      border: 1px solid rgba(239,68,68,0.4);
      border-radius: 16px;
      padding: 32px;
    }
    .release-panel-head {
      display: flex;
      justify-content: space-between;
      align-items: flex-start;
      gap: 24px;
      margin-bottom: 24px;
    }
    .eyebrow {
      color: var(--accent);
      font-size: 0.75rem;
      font-weight: 800;
      letter-spacing: 0.08em;
      text-transform: uppercase;
      margin-bottom: 6px;
    }
    .release-panel h2 { font-size: 1.6rem; line-height: 1.2; }
    .release-panel-head p { color: var(--muted); max-width: 560px; margin-top: 8px; }
    .release-link { color: var(--text); white-space: nowrap; font-size: 0.85rem; }
    .release-grid {
      display: grid;
      grid-template-columns: repeat(3, 1fr);
      gap: 12px;
    }
    .release-item {
      background: rgba(10,10,10,0.55);
      border: 1px solid var(--border);
      border-radius: 10px;
      padding: 16px;
    }
    .release-item h3 { font-size: 0.9rem; margin-bottom: 6px; }
    .release-item p { color: var(--muted); font-size: 0.8rem; }

    /* Latest main update */
    .tui-section { padding-top: 0; }
    .tui-panel {
      display: grid;
      grid-template-columns: 0.9fr 1.1fr;
      gap: 24px;
      align-items: center;
      background: var(--surface);
      border: 1px solid var(--border);
      border-radius: 16px;
      padding: 32px;
    }
    .tui-copy h2 { font-size: 1.6rem; line-height: 1.2; margin-bottom: 10px; }
    .tui-copy p { color: var(--muted); font-size: 0.95rem; margin-bottom: 14px; }
    .tui-list { list-style: none; margin: 18px 0; }
    .tui-list li {
      display: flex;
      gap: 10px;
      align-items: flex-start;
      color: var(--muted);
      font-size: 0.9rem;
      margin-bottom: 10px;
    }
    .tui-list strong { color: var(--green); }
    .tui-note { font-size: 0.8rem !important; color: var(--muted); }
    .tui-preview {
      background: #050505;
      border: 1px solid var(--border);
      border-radius: 12px;
      padding: 18px;
      overflow: auto;
      box-shadow: 0 18px 50px rgba(0,0,0,0.35);
    }
    .tui-preview pre {
      font-family: 'SF Mono', 'Fira Code', 'Cascadia Code', monospace;
      font-size: 0.76rem;
      line-height: 1.45;
      color: #d4d4d8;
      white-space: pre;
    }
    .tui-preview .accent { color: var(--accent); font-weight: 700; }
    .tui-preview .green { color: var(--green); }
    .tui-preview .muted { color: var(--muted); }

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
    .issue-item h3 { font-size: 0.95rem; margin-bottom: 2px; }
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
      color: #140b0a;
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
    .trust-item h3 { font-size: 0.95rem; margin-bottom: 4px; }
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

    @media (max-width: 720px) {
      h1 { font-size: 2rem; }
      .hero { padding: 40px 0 36px; }
      header .container { flex-wrap: wrap; }
      .nav-toggle { display: inline-flex; }
      .nav-links {
        display: none;
        width: 100%;
        grid-template-columns: 1fr 1fr;
        gap: 6px;
        padding-top: 12px;
      }
      .nav-links.is-open { display: grid; }
      .nav-links a {
        justify-content: center;
        margin-left: 0;
        padding: 8px 10px;
        border: 1px solid var(--border);
        border-radius: 8px;
        background: var(--surface);
      }
      .status-row { gap: 8px; margin-bottom: 24px; }
      .status-pill { width: 100%; justify-content: center; }
      .install-panel { padding: 18px; }
      .install-heading { display: block; }
      .install-heading p { margin-top: 6px; }
      .install-steps,
      .privacy-summary { grid-template-columns: 1fr; }
      .install-step .command-box,
      .quick-command .command-box { grid-template-columns: minmax(0, 1fr) auto; }
      .command-box { gap: 8px; }
      .install-step .command-box code,
      .quick-command .command-box code { font-size: 14px; white-space: normal; overflow-wrap: anywhere; }
      .command-box code span { white-space: nowrap; }
      .proof-row { align-items: stretch; flex-direction: column; }
      .proof-pill { border-radius: 8px; }
      .release-panel { padding: 24px 18px; }
      .release-panel-head { display: block; }
      .release-link { display: inline-block; margin-top: 16px; }
      .release-grid { grid-template-columns: 1fr; }
      .tui-panel { grid-template-columns: 1fr; padding: 24px 18px; }
      .tui-preview pre { font-size: 0.68rem; }
      .issues-grid { grid-template-columns: 1fr; }
      .sent-grid { grid-template-columns: 1fr !important; }
    }

    @media (prefers-reduced-motion: reduce) {
      html { scroll-behavior: auto; }
      *, *::before, *::after {
        scroll-behavior: auto !important;
        transition-duration: 0.01ms !important;
      }
    }
  </style>
</head>
<body>
  <a class="skip-link" href="#main-content">Skip to main content</a>
  <header>
    <div class="container">
      <a href="/" class="logo">🦞 Claw<span>Fix</span></a>
      <button type="button" class="nav-toggle" aria-expanded="false" aria-controls="site-nav">Menu</button>
      <nav class="nav-links" id="site-nav" aria-label="Primary navigation">
        <a href="#tui">Next TUI</a>
        <a href="#release">v0.11.2</a>
        <a href="#how">How It Works</a>
        <a href="#security">Security</a>
        <a href="#pricing">Hosted Service</a>
        <a href="https://github.com/arcabotai/clawfix">GitHub</a>
      </nav>
    </div>
  </header>

  <main id="main-content" tabindex="-1">
    <section class="hero">
      <div class="container">
        <span class="hero-emoji" aria-hidden="true">🦞</span>
        <h1>Diagnose OpenClaw in one command. <br><span class="highlight">Review supported repairs.</span></h1>
        <p class="subtitle">
          Run deterministic checks first. Optional AI can explain unmatched problems, while executable changes stay limited to reviewed repair definitions.
        </p>

        <div class="status-row" aria-label="Release status">
          <a class="status-pill" href="https://github.com/arcabotai/clawfix/releases/tag/v0.11.2">
            <strong>Current release</strong>
            <span>v0.11.2 · installer + agent v2</span>
          </a>
          <a class="status-pill" href="https://github.com/arcabotai/clawfix/pull/20">
            <strong>Next release</strong>
            <span>Chat-first TUI · not in v0.11.2</span>
          </a>
        </div>

        <div class="install-panel" aria-labelledby="install-heading">
          <div class="install-heading">
            <div>
              <h2 id="install-heading">Recommended: verify, then install</h2>
              <p>Three explicit steps install under <code>~/.clawfix</code>. No global npm, no remote shell pipe.</p>
            </div>
            <p>macOS, Linux, WSL · Node.js 22+</p>
          </div>

          <div class="install-steps">
            <article class="install-step">
              <p class="install-step-label"><span>1</span> Download</p>
              <div class="command-box">
                <code id="cmd-install"><span>curl -fsSL</span> <span>https://clawfix.dev/install</span> <span>-o install.sh</span></code>
                <button type="button" class="copy-btn" id="copyBtn-install" data-copy-command="install" aria-live="polite">Copy</button>
              </div>
            </article>
            <article class="install-step">
              <p class="install-step-label"><span>2</span> Verify SHA-256</p>
              <div class="command-box">
                <code id="cmd-verify">shasum -a 256 install.sh</code>
                <button type="button" class="copy-btn" id="copyBtn-verify" data-copy-command="verify" aria-live="polite">Copy</button>
              </div>
              <p class="install-step-note">Compare with <a href="/install/sha256">the published hash</a>. On Linux, use <code>sha256sum</code>.</p>
            </article>
            <article class="install-step">
              <p class="install-step-label"><span>3</span> Install</p>
              <div class="command-box">
                <code id="cmd-run">bash install.sh</code>
                <button type="button" class="copy-btn" id="copyBtn-run" data-copy-command="run" aria-live="polite">Copy</button>
              </div>
            </article>
          </div>

          <div class="quick-command">
            <h3>Quick one-command alternative</h3>
            <p>Run the portable npm CLI without the chat-first TUI. Use <code>--dry-run</code> to inspect collected data without sending it.</p>
            <div class="command-box">
              <code id="cmd-npx">npx clawfix@0.11.2</code>
              <button type="button" class="copy-btn" id="copyBtn-npx" data-copy-command="npx" aria-live="polite">Copy</button>
            </div>
          </div>

          <div class="privacy-summary" aria-label="Privacy summary">
            <p><strong>Local first.</strong> Deterministic checks and local commands do not upload.</p>
            <p><strong>You choose.</strong> Remote analysis asks <code>[y/N]</code> before upload unless you explicitly override it.</p>
            <p><strong>Inspect first.</strong> Recognized secrets are redacted; workspace document contents stay local. <a href="#security">See exactly what may be sent.</a></p>
          </div>

          <div class="proof-row" aria-label="Release verification">
            <span class="proof-pill"><strong>✓</strong> GitHub OIDC publish</span>
            <span class="proof-pill"><strong>✓</strong> npm attestation verified</span>
            <span class="proof-pill"><strong>✓</strong> 21-file allowlisted package</span>
          </div>
        </div>
      </div>
    </section>

    <section class="section" id="release">
      <div class="container">
        <div class="release-panel">
          <div class="release-panel-head">
            <div>
              <div class="eyebrow">Release 0.11.2</div>
              <h2>Evidence before repair.</h2>
              <p>One end-to-end release: bash installer, 21-file CLI with plain interface and remote analyzer, constrained agent v2 on the host, and OpenTUI standalone binaries. Signed, attested, and reproducible from public source.</p>
            </div>
            <a class="release-link" href="https://github.com/arcabotai/clawfix/releases/tag/v0.11.2">Release notes →</a>
          </div>
          <div class="release-grid">
            <div class="release-item">
              <h3>Bash installer</h3>
              <p>Download, verify hash, install under ~/.clawfix — no global npm required.</p>
            </div>
            <div class="release-item">
              <h3>Agent v2 + privacy</h3>
              <p>SSE explanations may propose only client-supplied repair IDs. Model output never becomes shell.</p>
            </div>
            <div class="release-item">
              <h3>OpenTUI standalone</h3>
              <p>Optional conversation UI ships as verified Bun-compiled binaries on the GitHub release, for glibc and musl (Alpine) hosts alike. It is a separate download — the npm package stays a 21-file portable CLI with no Bun dependency.</p>
            </div>
          </div>
        </div>
      </div>
    </section>

    <section class="section tui-section" id="tui">
      <div class="container">
        <div class="tui-panel">
          <div class="tui-copy">
            <div class="eyebrow">Next release · not in v0.11.2</div>
            <h2>Chat-first TUI ships after v0.11.2.</h2>
            <p>The next standalone binary will open directly into a conversation, keep local commands offline, and ask before remote AI or guarded repairs. <strong>The npm package ships the portable CLI only</strong> — <code>npx clawfix</code> runs the plain readline session.</p>
            <ul class="tui-list">
              <li><strong>✓</strong><span>Scrollable transcript, findings sidebar, and responsive terminal layouts.</span></li>
              <li><strong>✓</strong><span>Approval defaults to Cancel and reports success only after verified repairs.</span></li>
              <li><strong>✓</strong><span>Remote AI stays opt-in. Deterministic local commands never upload.</span></li>
              <li><strong>✓</strong><span>Runs on glibc and musl hosts, so Alpine-based OpenClaw containers are covered.</span></li>
            </ul>
            <p><a class="release-link" href="https://github.com/arcabotai/clawfix/pull/20">Review the merge →</a></p>
            <p class="tui-note">v0.11.2 is the current signed release. The chat-first TUI ships in the next release, as a standalone binary on the GitHub release — not inside the npm package. Every release binary is driven through a real terminal before publishing: it has to render, accept typed input, and exit cleanly.</p>
          </div>
          <div class="tui-preview" aria-label="Preview of the chat-first ClawFix terminal interface">
<pre><span class="muted">assistant</span>
Your gateway service is registered but
currently stopped. The common cause is a
missing Node PATH after reboot.

I can restart it with the reviewed
gateway-restart repair. Want me to?

<span class="accent">│ Repair proposal · proposed</span>
<span class="accent">│</span> Restart the OpenClaw gateway service
<span class="accent">│</span> Why: Gateway is down; port 18789 closed.
<span class="accent">│</span> Risk: medium · gateway-restart

┌──────────────────────────────────────┐
│ Tell me what is going wrong...       │
└──────────────────────────────────────┘
<span class="green">Local only · Enter send · Ctrl+P help</span>
<span class="muted">🦞 ClawFix · revision a1b2c3d</span></pre>
          </div>
        </div>
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
            <h3>Deterministic Checks First</h3>
            <p>49 known issue detectors run first. Optional AI analysis can explain unmatched problems when it is configured.</p>
          </div>
          <div class="step">
            <div class="step-num">3</div>
            <h3>Review & Apply</h3>
            <p>You get a commented fix script. Read it, understand it, then run it. Nothing happens without your approval. One reviewed repair runs automatically today — restarting a stopped gateway on a host with systemd or launchd; everything else is diagnosis and guidance.</p>
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
              <h3>Gateway Crashes</h3>
              <p>Port conflicts, process hangs, restart loops</p>
            </div>
          </div>
          <div class="issue-item">
            <span class="issue-icon">🧠</span>
            <div>
              <h3>Memory Issues</h3>
              <p>Mem0 silent failures, missing flush, broken search</p>
            </div>
          </div>
          <div class="issue-item">
            <span class="issue-icon">🌐</span>
            <div>
              <h3>Browser Automation</h3>
              <p>CDP port failures, extension loading, headless issues</p>
            </div>
          </div>
          <div class="issue-item">
            <span class="issue-icon">🔌</span>
            <div>
              <h3>Plugin Configs</h3>
              <p>Broken plugins, missing dependencies, wrong settings</p>
            </div>
          </div>
          <div class="issue-item">
            <span class="issue-icon">⚡</span>
            <div>
              <h3>Native Codex Harness</h3>
              <p>PI route drift, Codex home mismatches, fast tier gaps, timeout boundaries</p>
            </div>
          </div>
          <div class="issue-item">
            <span class="issue-icon">💸</span>
            <div>
              <h3>Token Waste</h3>
              <p>Excessive heartbeats, no pruning, bloated context</p>
            </div>
          </div>
          <div class="issue-item">
            <span class="issue-icon">🍎</span>
            <div>
              <h3>macOS Quirks</h3>
              <p>Metal GPU crashes, Apple Silicon issues, Peekaboo</p>
            </div>
          </div>
          <div class="issue-item">
            <span class="issue-icon">🔧</span>
            <div>
              <h3>Service Manager Crashes</h3>
              <p>launchd/systemd SIGTERM recovery, crash loops, backoff detection</p>
            </div>
          </div>
          <div class="issue-item">
            <span class="issue-icon">👻</span>
            <div>
              <h3>Zombie Processes</h3>
              <p>PID exists but port not listening — stale gateway detection</p>
            </div>
          </div>
          <div class="issue-item">
            <span class="issue-icon">📜</span>
            <div>
              <h3>Error Log Bloat</h3>
              <p>Chrome extension spam, handshake storms, 200MB+ log files</p>
            </div>
          </div>
          <div class="issue-item">
            <span class="issue-icon">🐕</span>
            <div>
              <h3>Gateway Watchdog</h3>
              <p>Recommends independent health checks to avoid launchd backoff gaps</p>
            </div>
          </div>
          <div class="issue-item">
            <span class="issue-icon">🧵</span>
            <div>
              <h3>Provider Prefix Typos</h3>
              <p><code>codex/gpt-5.4</code> vs <code>openai-codex/gpt-5.4</code> — silent 403 + fallback loop on every cron</p>
            </div>
          </div>
          <div class="issue-item">
            <span class="issue-icon">🎣</span>
            <div>
              <h3>Discord Silent Drops</h3>
              <p><code>groupPolicy: allowlist</code> with empty <code>allowFrom</code> — group messages disappear without logs</p>
            </div>
          </div>
          <div class="issue-item">
            <span class="issue-icon">🔒</span>
            <div>
              <h3>Plaintext Secrets in Config</h3>
              <p>Flags fields still inline that should be SecretRefs pointing at <code>~/.openclaw/.env</code></p>
            </div>
          </div>
          <div class="issue-item">
            <span class="issue-icon">🪪</span>
            <div>
              <h3>Invalid GH Token Override</h3>
              <p>Invalid <code>GH_TOKEN</code> env shadows a working <code>gh</code> login and breaks every GitHub-using cron</p>
            </div>
          </div>
          <div class="issue-item">
            <span class="issue-icon">📡</span>
            <div>
              <h3>Stale Paired Nodes</h3>
              <p>Endless <code>skills-remote</code> probe timeouts from a paired node with no host daemon behind it</p>
            </div>
          </div>
          <div class="issue-item">
            <span class="issue-icon">🌊</span>
            <div>
              <h3>Context Overflow</h3>
              <p>Session stuck &gt;100 % of ctx window, auto-compaction failing — manifests as slow replies</p>
            </div>
          </div>
          <div class="issue-item">
            <span class="issue-icon">🔐</span>
            <div>
              <h3>FileVault Blocks Reboots</h3>
              <p>macOS — pre-boot prompt gates all services; any unattended reboot leaves the mac off-network</p>
            </div>
          </div>
          <div class="issue-item">
            <span class="issue-icon">📦</span>
            <div>
              <h3>Plist Stale Secrets</h3>
              <p>macOS — LaunchAgent <code>EnvironmentVariables</code> carries old secrets after a <code>.env</code> migration</p>
            </div>
          </div>
        </div>
      </div>
    </section>

    <section class="section" id="pricing">
      <div class="container">
        <h2 class="section-title">Hosted Service</h2>
        <div class="pricing-cards" style="grid-template-columns: minmax(300px, 520px); justify-content: center;">
          <div class="price-card featured">
            <span class="badge" style="background:var(--green);">Hosted</span>
            <div class="price free-tag">Free</div>
            <h3>MIT source, optional hosting</h3>
            <p>The CLI and server are MIT licensed. <code>clawfix.dev</code> is free to use, with no paid tier and no payment path in the product.</p>
            <p style="margin-top:12px;color:var(--muted);font-size:0.8rem;">Hosted limits may change. Self-hosting remains available under the MIT license.</p>
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
              <h3>Inspect Before Running</h3>
              <p><code>npx clawfix --dry-run</code> shows exactly what data would be collected — sends nothing. Read the output. Decide for yourself.</p>
            </div>
          </div>
          <div class="trust-item">
            <span class="trust-icon">🔓</span>
            <div>
              <h3>Open Source</h3>
              <p><a href="https://github.com/arcabotai/clawfix" style="color:var(--blue)">The CLI, server, and diagnostic script are public</a> under the MIT license.</p>
            </div>
          </div>
          <div class="trust-item">
            <span class="trust-icon">🔒</span>
            <div>
              <h3>Recognized Secrets Redacted</h3>
              <p>Recognized API keys, tokens, passwords, private keys, and home paths are redacted before upload. The top-level config <code>env</code> block is omitted. Inspect <code>--dry-run</code> before sending.</p>
            </div>
          </div>
          <div class="trust-item">
            <span class="trust-icon">🚫</span>
            <div>
              <h3>Workspace Documents Stay Local</h3>
              <p>ClawFix checks whether workspace documents such as SOUL.md exist, but it does not read their contents. Config fields and matching error lines may be collected.</p>
            </div>
          </div>
          <div class="trust-item">
            <span class="trust-icon">👀</span>
            <div>
              <h3>Consent by Default</h3>
              <p>The diagnostic asks <code>[y/N]</code> before uploading. Automatic upload only happens when you explicitly pass <code>--yes</code>, <code>-y</code>, or set <code>CLAWFIX_AUTO=1</code>.</p>
            </div>
          </div>
          <div class="trust-item">
            <span class="trust-icon">💾</span>
            <div>
              <h3>Fix Scripts = Your Review</h3>
              <p>Fix scripts are saved to <code>/tmp</code> for you to read first. Every fix backs up your config. Nothing auto-executes.</p>
            </div>
          </div>
        </div>
        <div style="background:var(--surface);border:1px solid var(--border);border-radius:12px;padding:24px;margin-top:32px;">
          <h3 style="font-size:1rem;margin-bottom:12px;">📦 What Exactly Is Sent</h3>
          <div class="sent-grid" style="display:grid;grid-template-columns:1fr 1fr;gap:24px;">
            <div>
              <p style="color:var(--green);font-weight:600;font-size:0.85rem;margin-bottom:8px;">SENT (redacted where recognized)</p>
              <ul style="color:var(--muted);font-size:0.85rem;list-style:none;padding:0;">
                <li>• OS type, version, architecture</li>
                <li>• Node.js and npm versions</li>
                <li>• OpenClaw version</li>
                <li>• Config fields and non-secret values; recognized secrets are redacted</li>
                <li>• Recent gateway log matches and stderr lines; limits vary by npm CLI and bash fallback</li>
                <li>• Plugin names + enabled status</li>
                <li>• Gateway status</li>
                <li>• Hostname hash (8 chars of SHA-256)</li>
              </ul>
            </div>
            <div>
              <p style="color:var(--accent);font-weight:600;font-size:0.85rem;margin-bottom:8px;">OMITTED OR NOT COLLECTED</p>
              <ul style="color:var(--muted);font-size:0.85rem;list-style:none;padding:0;">
                <li>• Top-level config env block</li>
                <li>• Workspace document contents (SOUL.md, memory, etc.)</li>
                <li>• Chat history or messages</li>
                <li>• Real hostname (an 8-character hash is sent)</li>
                <li>• Source IP is used transiently for abuse throttling and is not stored in diagnostic records</li>
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
      const btn = document.getElementById('copyBtn-' + type);
      navigator.clipboard.writeText(cmd).then(() => {
        btn.textContent = 'Copied';
        setTimeout(() => { btn.textContent = 'Copy'; }, 2000);
      }).catch(() => {
        btn.textContent = 'Select command';
        document.getElementById('cmd-' + type).focus?.();
        setTimeout(() => { btn.textContent = 'Copy'; }, 3000);
      });
    }

    function toggleNav(button) {
      const nav = document.getElementById('site-nav');
      const open = button.getAttribute('aria-expanded') === 'true';
      button.setAttribute('aria-expanded', String(!open));
      button.textContent = open ? 'Menu' : 'Close';
      nav.classList.toggle('is-open', !open);
    }

    document.querySelector('.nav-toggle').addEventListener('click', event => {
      toggleNav(event.currentTarget);
    });
    document.querySelectorAll('[data-copy-command]').forEach(button => {
      button.addEventListener('click', () => copyCommand(button.dataset.copyCommand));
    });

    document.querySelectorAll('#site-nav a').forEach(link => {
      link.addEventListener('click', () => {
        const button = document.querySelector('.nav-toggle');
        button.setAttribute('aria-expanded', 'false');
        button.textContent = 'Menu';
        document.getElementById('site-nav').classList.remove('is-open');
      });
    });
  </script>
</body>
</html>`;
