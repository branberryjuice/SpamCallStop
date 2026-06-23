'use strict';

/**
 * Customer-facing spam-call reporting.
 *
 *   POST /api/report-spam  { phone, category, note }  (auth: customer token)
 *        -> store the reported number (encrypted), email Branden instantly,
 *           and drop an in-app confirmation alert on the customer's dashboard.
 *   GET  /api/report-spam                              (auth: customer token)
 *        -> the signed-in customer's own reported numbers, newest first.
 *
 * Access is the same signed customer token used by the rest of the dashboard
 * (x-customer-token header, or ?token= on the first hop). Reported numbers are
 * the CALLER's number (spam intel), never a removal target.
 */

const express = require('express');
const router = express.Router();
const token = require('../lib/token');
const db = require('../lib/customers');
const ratelimit = require('../lib/ratelimit');
const { alertAdmin } = require('../lib/alert');
const { formatPhone, normalizePhone } = require('../lib/phone');

function ipOf(req) {
  const xff = req.headers['x-forwarded-for'];
  return (xff ? String(xff).split(',')[0].trim() : '') || req.socket.remoteAddress || 'unknown';
}

function customerIdFrom(req) {
  const tok = String(req.headers['x-customer-token'] || (req.body && req.body.token) || (req.query && req.query.token) || '');
  return token.verifyCustomer(tok);
}

// Email Branden the moment a report comes in. Unique key + zero throttle so every
// distinct submission sends (the throttle in alertAdmin is for flapping crashes,
// not for these). No-op if ADMIN_EMAIL is unset; dry-run until RESEND_API_KEY set.
function emailAdmin(report, customer) {
  const disp = formatPhone(report.phone) || report.phone || '(number)';
  const who = (customer && customer.name) ? customer.name : 'A member';
  const lines = [
    'A customer just reported a spam call.',
    '',
    'Reported number: ' + disp,
    'Category: ' + (report.category || 'Other'),
    'From customer: ' + who + ' (member #' + (customer ? customer.id : '?') + ')',
    'Email: ' + ((customer && customer.email) || 'unknown'),
    'Note: ' + (report.note || '(none)'),
    'When: ' + new Date().toISOString(),
  ];
  alertAdmin('new spam report ' + disp, lines.join('\n'), { key: 'spam-report:' + report.id, throttleMs: 0 });
}

router.post('/report-spam', express.json(), async (req, res) => {
  const id = customerIdFrom(req);
  if (!id) return res.status(401).json({ ok: false, error: 'not_signed_in' });
  if (!ratelimit.hit('report-ip:' + ipOf(req), 20, 60 * 60 * 1000).allowed) {
    return res.status(429).json({ ok: false, error: 'too_many_requests' });
  }
  if (!ratelimit.hit('report-cust:' + id, 15, 60 * 60 * 1000).allowed) {
    return res.status(429).json({ ok: false, error: 'too_many_requests' });
  }
  const body = req.body || {};
  const phone = normalizePhone(body.phone);
  if (!phone) return res.status(400).json({ ok: false, error: 'bad_phone' });
  const category = (db.SPAM_CATEGORIES.indexOf(body.category) >= 0) ? body.category : 'Other';
  const note = body.note == null ? null : String(body.note).slice(0, 500);
  try {
    const c = await db.getCustomerById(id);
    if (!c || (c.status || 'active') === 'canceled') return res.status(403).json({ ok: false, error: 'no_access' });
    const report = await db.insertSpamReport({ customerId: id, phone: phone, category: category, note: note });
    if (!report) return res.status(500).json({ ok: false, error: 'save_failed' });
    // Instant alert to Branden.
    try { emailAdmin(report, c); } catch (ae) { console.error('[report] admin email failed:', ae && ae.message); }
    // In-app confirmation so the customer sees it logged in their feed.
    try {
      await db.insertAlert({
        customerId: id,
        kind: 'spam_report',
        title: 'Spam number logged',
        body: 'Thanks. We logged ' + (formatPhone(phone) || phone) + ' and flagged it on our end. We keep an eye out for numbers like this.',
      });
    } catch (ie) { console.error('[report] confirm alert failed:', ie && ie.message); }
    return res.json({ ok: true, report: { id: report.id, phone: report.phone, category: report.category, note: report.note, created_at: report.created_at } });
  } catch (e) {
    console.error('[report] submit error:', e && e.message);
    return res.status(500).json({ ok: false, error: 'server_error' });
  }
});

router.get('/report-spam', async (req, res) => {
  const id = customerIdFrom(req);
  if (!id) return res.status(401).json({ ok: false, error: 'not_signed_in' });
  try {
    const rows = await db.listSpamReportsForCustomer(id, 50);
    const reports = rows.map((r) => ({ id: r.id, phone: r.phone, category: r.category, note: r.note, created_at: r.created_at }));
    return res.json({ ok: true, reports: reports });
  } catch (e) {
    console.error('[report] list error:', e && e.message);
    return res.status(500).json({ ok: false, error: 'server_error' });
  }
});

module.exports = router;
