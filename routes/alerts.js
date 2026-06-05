'use strict';

/**
 * Customer-facing in-app alerts (dashboard notifications, NOT email).
 *
 *   GET  /api/alerts        -> recent alerts + unread count
 *   POST /api/alerts/read   -> mark all of this customer's alerts read
 *
 * Auth is the signed customer token (the same one /api/me uses): header
 * x-customer-token, or token in the body/query. Only ever returns the
 * signed-in customer's own alerts.
 */

const express = require('express');
const router = express.Router();
const token = require('../lib/token');
const db = require('../lib/customers');
const ratelimit = require('../lib/ratelimit');

function ipOf(req) {
  const xff = req.headers['x-forwarded-for'];
  return (xff ? String(xff).split(',')[0].trim() : '') || req.socket.remoteAddress || 'unknown';
}

router.get('/alerts', async (req, res) => {
  const tok = String(req.headers['x-customer-token'] || (req.query && req.query.token) || '');
  const id = token.verifyCustomer(tok);
  if (!id) return res.status(401).json({ ok: false, error: 'not_signed_in' });
  if (!ratelimit.hit('alerts-ip:' + ipOf(req), 120, 15 * 60 * 1000).allowed) {
    return res.status(429).json({ ok: false, error: 'too_many_requests' });
  }
  try {
    const [alerts, unread] = await Promise.all([
      db.listAlertsForCustomer(id, 100),
      db.countUnreadAlerts(id),
    ]);
    return res.json({ ok: true, unread: unread, alerts: alerts });
  } catch (e) {
    console.error('[alerts] list error:', e && e.message);
    return res.status(500).json({ ok: false, error: 'server_error' });
  }
});

router.post('/alerts/read', express.json(), async (req, res) => {
  const tok = String(req.headers['x-customer-token'] || (req.body && req.body.token) || '');
  const id = token.verifyCustomer(tok);
  if (!id) return res.status(401).json({ ok: false, error: 'not_signed_in' });
  try {
    await db.markAlertsRead(id);
    return res.json({ ok: true });
  } catch (e) {
    console.error('[alerts] read error:', e && e.message);
    return res.status(500).json({ ok: false, error: 'server_error' });
  }
});

module.exports = router;
