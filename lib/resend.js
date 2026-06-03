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

module.exports = { send };
