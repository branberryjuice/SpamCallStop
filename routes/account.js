'use strict';

/**
 * Customer-facing account / dashboard API.
 *
 *   GET  /api/me?token=...            -> the signed-in customer's own status
 *   POST /api/dashboard-link {email}  -> emails that customer a fresh magic link
 *
 * Access is by a signed customer token (the emailed magic link) — no password.
 * The token only ever exposes that one customer's roll-up numbers; no broker
 * names, no phone/address. /api/dashboard-link never reveals whether an email
 * belongs to a customer (same response either way).
 */

const express = require('express');
const router = express.Router();
const token = require('../lib/token');
const db = require('../lib/customers');
const resend = require('../lib/resend');
const ratelimit = require('../lib/ratelimit');
const { loginLinkEmail } = require('../lib/emails');

function ipOf(req) {
  const xff = req.headers['x-forwarded-for'];
  return (xff ? String(xff).split(',')[0].trim() : '') || req.socket.remoteAddress || 'unknown';
}
function baseUrl() { return process.env.PUBLIC_BASE_URL || 'https://spamcallstop.com'; }

router.get('/me', async (req, res) => {
  const id = token.verifyCustomer(String((req.query && req.query.token) || ''));
  if (!id) return res.status(401).json({ ok: false, error: 'not_signed_in' });
  try {
    const c = await db.getCustomerById(id);
    if (!c) return res.status(404).json({ ok: false, error: 'not_found' });
    const stats = await db.getRemovalStats(id);
    const firstName = (c.name || '').trim().split(/\s+/)[0] || '';
    res.json({ ok: true, name: c.name || '', firstName: firstName, plan: c.plan || '', cleared: stats.cleared, inProgress: stats.inProgress });
  } catch (e) {
    console.error('[account] me error:', e && e.message);
    res.status(500).json({ ok: false, error: 'server_error' });
  }
});

router.post('/dashboard-link', express.json(), async (req, res) => {
  const email = String((req.body && req.body.email) || '').trim().toLowerCase();
  if (!ratelimit.hit('dlink-ip:' + ipOf(req), 5, 15 * 60 * 1000).allowed) {
    return res.status(429).json({ ok: false, error: 'too_many_requests' });
  }
  if (email.indexOf('@') > 0 && ratelimit.hit('dlink-em:' + email, 3, 60 * 60 * 1000).allowed) {
    try {
      const c = await db.getCustomerByEmail(email);
      if (c) {
        const link = baseUrl() + '/account.html?token=' + encodeURIComponent(token.signCustomer(c.id));
        const msg = loginLinkEmail(c, link);
        await resend.send({ to: c.email, from: process.env.EMAIL_FROM, replyTo: 'company@spamcallstop.com', subject: msg.subject, text: msg.text, html: msg.html });
      }
    } catch (e) {
      console.error('[account] dashboard-link error:', e && e.message);
    }
  }
  res.json({ ok: true });
});

module.exports = router;
