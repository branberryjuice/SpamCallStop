'use strict';

/**
 * POST /api/track — funnel analytics beacon (public, best-effort).
 *
 * Funnel pages send small events ({ visitor_id, event, email? }) as the visitor
 * moves through the funnel. We only accept an allowlist of view/intent events;
 * the authoritative "purchased" event is recorded server-side by the Stripe
 * webhook, so a client can never fake a sale. Recording is best-effort and must
 * never break or slow the page.
 */

const express = require('express');
const router = express.Router();
const ratelimit = require('../lib/ratelimit');
const db = require('../lib/customers');

const ALLOWED = new Set([
  'landing_view', 'scan_started', 'verified', 'results_view',
  'paywall_open', 'checkout_view', 'checkout_started',
]);

function ipOf(req) {
  const xff = req.headers['x-forwarded-for'];
  return (xff ? String(xff).split(',')[0].trim() : '') || req.socket.remoteAddress || 'unknown';
}

// `type: () => true` so sendBeacon bodies parse regardless of Content-Type.
router.post('/track', express.json({ limit: '4kb', type: () => true }), async (req, res) => {
  // Generous per-IP cap (shared/office IPs fire many legit beacons); analytics
  // is best-effort, so going over just drops the beacon.
  if (!ratelimit.hit('track:' + ipOf(req), 300, 5 * 60 * 1000).allowed) {
    return res.status(429).json({ ok: false });
  }
  const b = req.body || {};
  const event = String(b.event || '');
  if (!ALLOWED.has(event)) return res.status(400).json({ ok: false, error: 'bad_event' });
  try {
    await db.recordFunnelEvent({
      visitorId: b.visitor_id,
      event: event,
      email: b.email || null,
      phone: b.phone || null,
      plan: b.plan || null,
      meta: b.meta || null,
    });
  } catch (e) {
    console.error('[track] error:', e && e.message);
  }
  return res.json({ ok: true });
});

module.exports = router;
