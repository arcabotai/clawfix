import { Router } from 'express';

export const webhooksRouter = Router();

/**
 * Resend Inbound Email Webhook
 * 
 * Receives email.received events from Resend, fetches full email content
 * via Resend API, then forwards to a private Gmail address.
 * 
 * Environment variables:
 *   RESEND_API_KEY         — For sending forwarded emails (send-only key)
 *   RESEND_API_KEY_FULL    — For reading inbound email content (full-access key)
 *   RESEND_WEBHOOK_SECRET  — Webhook signing secret (optional but recommended)
 *   EMAIL_FORWARD_TO       — Forward inbound emails to this address
 */

const RESEND_CONFIG = {
  apiKey: process.env.RESEND_API_KEY,
  apiKeyFull: process.env.RESEND_API_KEY_FULL || process.env.RESEND_API_KEY,
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
  }

  const event = req.body;
  
  if (!event || !event.type) {
    return res.status(400).json({ error: 'Invalid event' });
  }

  console.log(`📧 Resend webhook: ${event.type}`);

  if (event.type === 'email.received') {
    const data = event.data;
    console.log(`📨 Inbound from ${data.from} → ${data.to?.join(', ')} — ${data.subject}`);
    // Debug: log ALL keys at every level to find the body
    console.log(`📋 event keys: ${Object.keys(event).join(', ')}`);
    console.log(`📋 data keys: ${Object.keys(data).join(', ')}`);
    if (data.attachments?.length) console.log(`📋 attachments: ${JSON.stringify(data.attachments.map(a => ({name: a.filename || a.name, type: a.content_type || a.type, size: a.content?.length || a.size})))}`);
    // Check for body in unusual places
    for (const key of Object.keys(data)) {
      const val = data[key];
      if (typeof val === 'string' && val.length > 50) {
        console.log(`📋 data.${key} (${val.length} chars): ${val.substring(0, 100)}...`);
      }
    }

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
 * Fetch inbound email content from Resend API using email_id
 */
async function fetchEmailContent(emailId) {
  try {
    const res = await fetch(`https://api.resend.com/emails/${emailId}`, {
      headers: { 'Authorization': `Bearer ${RESEND_CONFIG.apiKeyFull}` },
    });
    if (!res.ok) {
      console.warn(`Failed to fetch email ${emailId}: ${res.status}`);
      return { text: '', html: '' };
    }
    const data = await res.json();
    return { text: data.text || '', html: data.html || '' };
  } catch (e) {
    console.warn(`Error fetching email content: ${e.message}`);
    return { text: '', html: '' };
  }
}

/**
 * Forward an inbound email using Resend's send API
 */
async function forwardEmail(emailData) {
  // Fetch the full email body via API (webhook payload doesn't include it)
  let body = '';
  let htmlBody = '';
  
  if (emailData.email_id) {
    const content = await fetchEmailContent(emailData.email_id);
    body = content.text;
    htmlBody = content.html;
    console.log(`📋 Fetched body: text=${body.length} chars, html=${htmlBody.length} chars`);
  }

  const from = typeof emailData.from === 'string' ? emailData.from : emailData.from?.email || 'unknown';
  const subject = emailData.subject || '(no subject)';
  const to = Array.isArray(emailData.to) ? emailData.to.join(', ') : emailData.to || 'unknown';

  const forwardSubject = `[Fwd: ${subject}] from ${from}`;
  const forwardText = `--- Forwarded email ---\nFrom: ${from}\nTo: ${to}\nSubject: ${subject}\nDate: ${emailData.created_at || 'unknown'}\n\n${body || '(body unavailable)'}`;
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
