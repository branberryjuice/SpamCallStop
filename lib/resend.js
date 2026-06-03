'use strict';

/**
 * Thin Resend email sender. Dry-run when RESEND_API_KEY is unset: it logs and
 * returns { ok:true, dryRun:true } instead of sending, so the removal engine is
 * fully testable (and safe to run) before the sending domain is verified.
 */

const API = 'https://api.resend.com/emails';

async function send({ to, from, subject, text, html, replyTo }) {
  if (!to || !subject) return { ok: false, error: 'missing_fields' };
  const key = process.env.RESEND_API_KEY;
  const fromAddr = from || process.env.EMAIL_FROM || 'removals@spamcallstop.com';

  if (!key) {
    console.log('[resend][dry-run] to=%s from=%s subject="%s"', to, fromAddr, subject);
    return { ok: true, dryRun: true };
  }

  try {
    const body = { from: fromAddr, to: [to], subject };
    if (text) body.text = text;
    if (html) body.html = html;
    if (replyTo) body.reply_to = replyTo;
    const resp = await fetch(API, {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + key, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!resp.ok) {
      const t = await resp.text().catch(() => '');
      console.error('[resend] http', resp.status, t.slice(0, 200));
      return { ok: false, error: 'http_' + resp.status };
    }
    const j = await resp.json().catch(() => ({}));
    return { ok: true, id: j.id };
  } catch (err) {
    console.error('[resend] error:', err && err.message ? err.message : err);
    return { ok: false, error: 'send_failed' };
  }
}

// Fetch a received email's body/headers. Resend's inbound webhook delivers only
// metadata (subject + sender); the body must be retrieved separately. Endpoint
// can be overridden with RESEND_RECEIVING_URL if Resend's path ever changes.
async function getReceived(id) {
  const key = process.env.RESEND_API_KEY;
  if (!key || !id) return null;
  const base = process.env.RESEND_RECEIVING_URL || 'https://api.resend.com/emails/receiving/';
  try {
    const resp = await fetch(base + encodeURIComponent(id), { headers: { Authorization: 'Bearer ' + key } });
    if (!resp.ok) { console.error('[resend] received fetch http', resp.status); return null; }
    const j = await resp.json().catch(() => null);
    if (!j) return null;
    const from = j.from && (j.from.address || j.from.email) ? (j.from.address || j.from.email) : j.from;
    return { text: j.text || '', html: j.html || '', subject: j.subject || '', from: from || '' };
  } catch (e) {
    console.error('[resend] received fetch error:', e && e.message);
    return null;
  }
}

module.exports = { send, getReceived };
