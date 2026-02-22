import { Router } from 'express';

export const paymentRouter = Router();

/**
 * Payment integration — Lemon Squeezy for card payments, x402 for USDC on Base.
 * 
 * Flow:
 * 1. User gets a fix (free for pattern-matching, paid for AI analysis)
 * 2. Results page shows payment button
 * 3. Clicking opens Lemon Squeezy checkout overlay or x402 flow
 * 4. Webhook confirms payment
 * 
 * Environment variables:
 *   LEMONSQUEEZY_API_KEY    — API key from Lemon Squeezy dashboard
 *   LEMONSQUEEZY_STORE_ID   — Store ID
 *   LEMONSQUEEZY_VARIANT_ID — Product variant ID for "AI Fix" ($2)
 *   LEMONSQUEEZY_WEBHOOK_SECRET — Webhook signing secret
 *   PAYMENT_WALLET          — Wallet address for USDC payments
 */

const LS_CONFIG = {
  apiKey: process.env.LEMONSQUEEZY_API_KEY,
  storeId: process.env.LEMONSQUEEZY_STORE_ID,
  variantId: process.env.LEMONSQUEEZY_VARIANT_ID,
  webhookSecret: process.env.LEMONSQUEEZY_WEBHOOK_SECRET,
};

const WALLET = process.env.PAYMENT_WALLET || '0x1be93C700dDC596D701E8F2106B8F9166C625Adb';

// Create a checkout session for a fix
paymentRouter.post('/checkout', async (req, res) => {
  const { fixId } = req.body;

  if (!fixId) {
    return res.status(400).json({ error: 'fixId is required' });
  }

  if (!LS_CONFIG.apiKey || !LS_CONFIG.storeId || !LS_CONFIG.variantId) {
    return res.json({
      checkoutUrl: null,
      message: 'Payment not yet configured. Fix is free during beta!',
      walletAddress: WALLET,
      chain: 'Base',
      amount: '2 USDC',
    });
  }

  try {
    // Create Lemon Squeezy checkout
    const response = await fetch('https://api.lemonsqueezy.com/v1/checkouts', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${LS_CONFIG.apiKey}`,
        'Content-Type': 'application/vnd.api+json',
        'Accept': 'application/vnd.api+json',
      },
      body: JSON.stringify({
        data: {
          type: 'checkouts',
          attributes: {
            custom_price: null, // Use variant price
            product_options: {
              name: `ClawFix AI Diagnosis — ${fixId}`,
              description: 'AI-powered diagnostic and fix script for your OpenClaw installation.',
            },
            checkout_options: {
              dark: true,
              logo: false,
            },
            checkout_data: {
              custom: {
                fix_id: fixId,
              },
            },
            expires_at: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(), // 24h expiry
          },
          relationships: {
            store: { data: { type: 'stores', id: LS_CONFIG.storeId } },
            variant: { data: { type: 'variants', id: LS_CONFIG.variantId } },
          },
        },
      }),
    });

    if (!response.ok) {
      const err = await response.text();
      console.error('Lemon Squeezy error:', err);
      throw new Error('Payment provider error');
    }

    const data = await response.json();
    const checkoutUrl = data.data.attributes.url;

    res.json({
      checkoutUrl,
      fixId,
      // Also offer crypto option
      crypto: {
        walletAddress: WALLET,
        chain: 'Base',
        amount: '2',
        currency: 'USDC',
      },
    });
  } catch (error) {
    console.error('Checkout error:', error.message);
    res.status(500).json({
      error: 'Failed to create checkout',
      message: 'Try paying with USDC instead',
      crypto: {
        walletAddress: WALLET,
        chain: 'Base',
        amount: '2',
        currency: 'USDC',
      },
    });
  }
});

// Lemon Squeezy webhook handler
paymentRouter.post('/webhook/lemonsqueezy', async (req, res) => {
  // Verify webhook signature
  if (LS_CONFIG.webhookSecret) {
    const crypto = await import('crypto');
    const signature = req.headers['x-signature'];
    const rawBody = JSON.stringify(req.body);
    const hmac = crypto.createHmac('sha256', LS_CONFIG.webhookSecret)
      .update(rawBody)
      .digest('hex');
    
    if (signature !== hmac) {
      console.warn('Invalid webhook signature');
      return res.status(401).json({ error: 'Invalid signature' });
    }
  }

  const event = req.headers['x-event-name'];
  const data = req.body;

  console.log(`Lemon Squeezy webhook: ${event}`);

  if (event === 'order_created') {
    const fixId = data.meta?.custom_data?.fix_id;
    const amount = data.data?.attributes?.total_formatted;
    console.log(`💰 Payment received! Fix: ${fixId}, Amount: ${amount}`);
    // TODO: Mark fix as paid in database
  }

  res.json({ received: true });
});

// Payment status page
paymentRouter.get('/pay/:fixId', (req, res) => {
  const { fixId } = req.params;
  const lsConfigured = !!(LS_CONFIG.apiKey && LS_CONFIG.storeId && LS_CONFIG.variantId);

  res.setHeader('Content-Type', 'text/html');
  res.send(paymentPage(fixId, lsConfigured));
});

function paymentPage(fixId, lsConfigured) {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>ClawFix — Pay for Fix ${fixId}</title>
  <link rel="icon" href="data:image/svg+xml,<svg xmlns=%22http://www.w3.org/2000/svg%22 viewBox=%220 0 100 100%22><text y=%22.9em%22 font-size=%2290%22>🦞</text></svg>">
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    :root { --bg: #0a0a0a; --surface: #141414; --border: #262626; --text: #fafafa; --muted: #a1a1aa; --green: #22c55e; --red: #ef4444; }
    body { font-family: -apple-system, sans-serif; background: var(--bg); color: var(--text); min-height: 100vh; display: flex; align-items: center; justify-content: center; padding: 24px; }
    .card { background: var(--surface); border: 1px solid var(--border); border-radius: 16px; padding: 40px; max-width: 440px; width: 100%; text-align: center; }
    h1 { font-size: 1.5rem; margin-bottom: 8px; }
    .price { font-size: 3rem; font-weight: 800; color: var(--green); margin: 16px 0; }
    .subtitle { color: var(--muted); margin-bottom: 32px; }
    .btn { display: block; width: 100%; padding: 14px; border-radius: 8px; font-size: 1rem; font-weight: 600; cursor: pointer; border: none; margin-bottom: 12px; transition: opacity 0.2s; }
    .btn:hover { opacity: 0.9; }
    .btn-card { background: var(--red); color: white; }
    .btn-crypto { background: transparent; border: 1px solid var(--border); color: var(--text); }
    .or { color: var(--muted); font-size: 0.85rem; margin: 16px 0; }
    .wallet { background: var(--bg); border: 1px solid var(--border); border-radius: 8px; padding: 12px; margin-top: 16px; font-family: monospace; font-size: 0.8rem; word-break: break-all; color: var(--muted); cursor: pointer; }
    .wallet:hover { color: var(--text); border-color: var(--green); }
    .beta { background: rgba(34,197,94,0.1); border: 1px solid var(--green); border-radius: 8px; padding: 16px; margin-bottom: 24px; }
    .beta p { color: var(--green); font-size: 0.9rem; }
    .footer { margin-top: 24px; color: var(--muted); font-size: 0.8rem; }
    .footer a { color: var(--muted); }
  </style>
</head>
<body>
  <div class="card">
    <h1>🦞 ClawFix</h1>
    
    ${!lsConfigured ? `
    <div class="beta">
      <p><strong>🎉 Free during beta!</strong><br>All fixes are free while we're in beta. Enjoy!</p>
    </div>
    <p class="subtitle">Fix ID: ${fixId}</p>
    <a href="/results/${fixId}" class="btn btn-card" style="text-decoration:none">← View Your Fix</a>
    ` : `
    <div class="price">$2</div>
    <p class="subtitle">AI diagnosis + fix script for your OpenClaw</p>
    
    <button class="btn btn-card" onclick="payCard()">💳 Pay with Card</button>
    <p class="or">— or —</p>
    <button class="btn btn-crypto" onclick="payCrypto()">⬡ Pay 2 USDC on Base</button>
    <div class="wallet" id="wallet" onclick="copyWallet()" style="display:none">
      ${WALLET}
      <br><small>Click to copy · Send 2 USDC on Base</small>
    </div>
    `}
    
    <p class="footer">
      <a href="/results/${fixId}">View results</a> · 
      <a href="/">ClawFix</a> · 
      <a href="https://arcabot.ai">arcabot.ai</a>
    </p>
  </div>
  <script>
    async function payCard() {
      const res = await fetch('/api/checkout', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ fixId: '${fixId}' })
      });
      const data = await res.json();
      if (data.checkoutUrl) {
        window.location.href = data.checkoutUrl;
      } else {
        alert(data.message || 'Payment not available yet');
      }
    }
    function payCrypto() {
      document.getElementById('wallet').style.display = 'block';
    }
    function copyWallet() {
      navigator.clipboard.writeText('${WALLET}');
      document.getElementById('wallet').querySelector('small').textContent = 'Copied! Send 2 USDC on Base';
    }
  </script>
</body>
</html>`;
}
