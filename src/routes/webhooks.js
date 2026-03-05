import { Router } from 'express';

export const webhooksRouter = Router();

/**
 * Resend Inbound Email Webhook
 * 
 * Receives email.received events from Resend so inbound emails
 * to arca@arcabot.ai show up in the Resend dashboard's Receiving tab.
 * 
 * Optionally forwards emails via Resend API to a private address.
 * 
 * Environment variables:
 *   RESEND_API_KEY         — For forwarding emails
 *   RESEND_WEBHOOK_SECRET  — Webhook signing secret (optional but recommended)
 *   EMAIL_FORWARD_TO       — Forward inbound emails to this address
 */

const RESEND_CONFIG = {
  apiKey: process.env.RESEND_API_KEY,
  webhookSecret: process.env.RESEND_WEBHOOK_SECRET,
  forwardTo: process.env.EMAIL_FORWARD_TO,
};

// Resend webhook: email.received
webhooksRouter.post('/webhooks/resend', async (req, res) => {
  // Verify signature if secret is configured
  if (RESEND_CONFIG.webhookSecret) {
    const svixId = req.headers['svix-id'];
    const svixTimestamp = req.headers['svix-timestamp'];
    const svixSignature = req.headers['svix-signature'];

    if (!svixId || !svixTimestamp || !svixSignature) {
      console.warn('Missing Resend webhook signature headers');
      return res.status(401).json({ error: 'Missing signature' });
    }

    // TODO: Full svix signature verification (requires @svix/webhook package)
    // For now, accept if headers are present
  }

  const event = req.body;
  
  if (!event || !event.type) {
    return res.status(400).json({ error: 'Invalid event' });
  }

  console.log(`📧 Resend webhook: ${event.type}`);

  if (event.type === 'email.received') {
    const data = event.data;
    console.log(`📨 Inbound email from ${data.from} to ${data.to?.join(', ')} — Subject: ${data.subject}`);
    console.log(`📋 Webhook payload keys: ${Object.keys(data).join(', ')}`);
    console.log(`📋 Has text: ${!!data.text} (${typeof data.text}), Has html: ${!!data.html} (${typeof data.html})`);

    // Forward if configured
    if (RESEND_CONFIG.apiKey && RESEND_CONFIG.forwardTo) {
      try {
        await forwardEmail(data);
        console.log(`📬 Forwarded to ${RESEND_CONFIG.forwardTo}`);
      } catch (err) {
        console.error('Forward failed:', err.message);
      }
    }
  }

  // Always respond 200 so Resend marks delivery as successful
  res.json({ received: true });
});

/**
 * Forward an inbound email using Resend's send API
 */
async function forwardEmail(emailData) {
  // Email body is included directly in the webhook payload
  const body = emailData.text || '';
  const htmlBody = emailData.html || '';

  const from = typeof emailData.from === 'string' ? emailData.from : emailData.from?.email || 'unknown';
  const subject = emailData.subject || '(no subject)';
  const to = Array.isArray(emailData.to) ? emailData.to.join(', ') : emailData.to || 'unknown';

  const forwardSubject = `[Fwd: ${subject}] from ${from}`;
  const forwardText = `--- Forwarded email ---\nFrom: ${from}\nTo: ${to}\nSubject: ${subject}\nDate: ${emailData.created_at || 'unknown'}\n\n${body || '(no text body in webhook payload)'}`;
  const forwardHtml = htmlBody 
    ? `<div style="border-left:3px solid #ccc;padding-left:12px;margin-bottom:16px;color:#666"><strong>From:</strong> ${from}<br><strong>To:</strong> ${to}<br><strong>Subject:</strong> ${subject}<br><strong>Date:</strong> ${emailData.created_at || 'unknown'}</div>${htmlBody}`
    : undefined;

  const response = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${RESEND_CONFIG.apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      from: 'Arca Inbox <arca@arcabot.ai>',
      to: RESEND_CONFIG.forwardTo,
      subject: forwardSubject,
      text: forwardText,
      ...(forwardHtml && { html: forwardHtml }),
    }),
  });

  if (!response.ok) {
    const err = await response.text();
    throw new Error(`Resend send failed: ${response.status} ${err}`);
  }
}
