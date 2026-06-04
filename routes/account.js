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
const stripe = require('../lib/stripe');

function ipOf(req) {
  const xff = req.headers['x-forwarded-for'];
  return (xff ? String(xff).split(',')[0].trim() : '') || req.socket.remoteAddress || 'unknown';
}
function baseUrl() { return process.env.PUBLIC_BASE_URL || 'https://spamcallstop.com'; }

router.get('/me', async (req, res) => {
  // Prefer the token in a header so it doesn't land in access logs / referrers;
  // fall back to the query param for the emailed link's first hop.
  const tok = String(req.headers['x-customer-token'] || (req.query && req.query.token) || '');
  const id = token.verifyCustomer(tok);
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

// Exchange a paid Stripe checkout session for a dashboard token, so a buyer who
// just paid lands straight in their dashboard (email pulled from Stripe) instead
// of an email-link wall. Only works for a paid session mapping to a known customer.
router.get('/account/session', async (req, res) => {
  if (!stripe) return res.status(503).json({ ok: false, error: 'not_configured' });
  const sid = String((req.query && req.query.session_id) || '');
  if (!/^cs_[A-Za-z0-9_]+$/.test(sid)) return res.status(400).json({ ok: false, error: 'bad_session' });
  if (!ratelimit.hit('sess-ip:' + ipOf(req), 30, 15 * 60 * 1000).allowed) {
    return res.status(429).json({ ok: false, error: 'too_many_requests' });
  }
  try {
    const session = await stripe.checkout.sessions.retrieve(sid);
    const paid = session && (session.payment_status === 'paid' || session.payment_status === 'no_payment_required' || session.status === 'complete');
    if (!paid) return res.json({ ok: false, error: 'pending' });
    const email = String(
      session.customer_email ||
      (session.customer_details && session.customer_details.email) ||
      (session.metadata && session.metadata.email) || ''
    ).trim().toLowerCase();
    const c = email ? await db.getCustomerByEmail(email) : null;
    if (!c) return res.json({ ok: false, error: 'pending' }); // webhook may not have created the customer yet
    const firstName = (c.name || '').trim().split(/\s+/)[0] || '';
    return res.json({ ok: true, token: token.signCustomer(c.id), firstName: firstName });
  } catch (e) {
    console.error('[account] session exchange error:', e && e.message);
    return res.json({ ok: false, error: 'pending' });
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
