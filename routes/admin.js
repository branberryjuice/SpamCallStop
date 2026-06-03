'use strict';

/**
 * Internal admin API — customer + protected-number overview for the dashboard.
 *
 *   GET /api/admin/customers?key=ADMIN_KEY      (or header x-admin-key)
 *
 * Gated by ADMIN_KEY from the environment. If ADMIN_KEY is unset the endpoint
 * stays locked (401), so it can never leak customer data by accident.
 */

const express = require('express');
const router = express.Router();
const { listCustomersWithNumbers } = require('../lib/customers');
const { planLabel } = require('../lib/pricing');
const digest = require('../lib/digest');

function authed(req) {
  const key = process.env.ADMIN_KEY;
  if (!key) return false; // no key configured => locked
  const given = req.query.key || req.headers['x-admin-key'] || '';
  return !!given && String(given) === String(key);
}

router.get('/admin/customers', async (req, res) => {
  if (!authed(req)) return res.status(401).json({ ok: false, error: 'unauthorized' });
  try {
    const rows = await listCustomersWithNumbers();
    const customers = rows.map((c) => ({
      id: c.id,
      created_at: c.created_at,
      name: c.name || '',
      email: c.email || '',
      plan: c.plan || '',
      planLabel: planLabel(c.plan),
      billing: c.billing === 'y' ? 'yearly' : c.billing === 'm' ? 'monthly' : c.billing || '',
      status: c.status || '',
      subscription: c.stripe_subscription || '',
      numbers: c.numbers || [],
    }));
    const summary = {
      total: customers.length,
      individual: customers.filter((c) => c.plan === 'Solo').length,
      couple: customers.filter((c) => c.plan === 'Dual').length,
      numbers: customers.reduce((n, c) => n + (c.numbers ? c.numbers.length : 0), 0),
    };
    res.json({ ok: true, summary, customers });
  } catch (e) {
    console.error('[admin] list error:', e && e.message);
    res.status(500).json({ ok: false, error: 'list_failed' });
  }
});

// Manually trigger the daily digest (also hit by the in-app scheduler / an
// external cron). Key-gated like the rest of /api/admin.
router.get('/admin/daily-digest', async (req, res) => {
  if (!authed(req)) return res.status(401).json({ ok: false, error: 'unauthorized' });
  try {
    const r = await digest.sendDigest();
    res.json(r);
  } catch (e) {
    console.error('[admin] digest error:', e && e.message);
    res.status(500).json({ ok: false, error: 'digest_failed' });
  }
});

module.exports = router;
