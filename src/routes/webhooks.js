import { Router } from 'express';

import { verifySvixSignature } from '../webhook-signatures.js';

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
  // This endpoint sends mail from a real domain to a real inbox, so it has to be certain the
  // caller is Resend. Checking only that the svix-* headers are *present* let anyone forge an
  // email.received event and use the route as an unauthenticated relay; an unset secret did
  // the same. The signature is now verified over the raw body, and both cases fail closed.
  const verified = verifySvixSignature({
    secret: RESEND_CONFIG.webhookSecret,
    rawBody: req.rawBody,
    id: req.headers['svix-id'],
    timestamp: req.headers['svix-timestamp'],
    signature: req.headers['svix-signature'],
  });
  if (!verified.ok) {
    console.warn(`Rejected Resend webhook: ${verified.reason}`);
    return res.status(401).json({ error: 'Invalid signature' });
  }

  const event = req.body;
  
  if (!event || !event.type) {
    return res.status(400).json({ error: 'Invalid event' });
  }

  console.log(`📧 Resend webhook: ${event.type}`);

  if (event.type === 'email.received') {
    const data = event.data;
    console.log(`📨 Inbound from ${data.from} → ${data.to?.join(', ')} — ${data.subject}`);

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
 * Fetch inbound email content from Resend Receiving API
 * Note: /emails/receiving/:id (NOT /emails/:id which is for sent emails only)
 */
async function fetchEmailContent(emailId) {
  // The id comes from the webhook body and is interpolated into a path on an API called with
  // the full-access key, so anything but an opaque id is refused rather than encoded away.
  if (typeof emailId !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(emailId)) {
    console.warn('Refusing to fetch email content for a malformed id');
    return { text: '', html: '' };
  }
  try {
    const res = await fetch(`https://api.resend.com/emails/receiving/${encodeURIComponent(emailId)}`, {
      headers: { 'Authorization': `Bearer ${RESEND_CONFIG.apiKeyFull}` },
    });
    if (!res.ok) {
      console.warn(`Failed to fetch received email ${emailId}: ${res.status}`);
      return { text: '', html: '' };
    }
    const data = await res.json();
    return { text: data.text || '', html: data.html || '' };
  } catch (e) {
    console.warn(`Error fetching email content: ${e.message}`);
    return { text: '', html: '' };
  }
}

/** Inbound values are attacker-controlled; escape before interpolating into forwarded HTML. */
function escapeHtml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
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
    ? `<div style="border-left:3px solid #ccc;padding-left:12px;margin-bottom:16px;color:#666"><strong>From:</strong> ${escapeHtml(from)}<br><strong>To:</strong> ${escapeHtml(to)}<br><strong>Subject:</strong> ${escapeHtml(subject)}<br><strong>Date:</strong> ${escapeHtml(emailData.created_at || 'unknown')}</div>${htmlBody}`
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
