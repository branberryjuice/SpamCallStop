'use strict';

/**
 * Private funnel analytics API for the owner's dashboard.
 *
 *   GET /api/analytics/funnel?range=24h|7d|30d|90d   (admin-gated)
 *
 * Aggregates raw funnel_events into: the funnel (distinct visitors per stage),
 * step + overall conversion, a time series (hourly for 24h, daily otherwise)
 * carrying visitors / purchases / revenue, totals (incl. phones + emails
 * captured, revenue, avg time to purchase), and a per-visitor leads list with
 * the phone number entered and email submitted.
 */

const express = require('express');
const router = express.Router();
const db = require('../lib/customers');

function authed(req) {
  const key = process.env.ADMIN_KEY;
  if (!key) return false;
  let given = req.query.key || req.headers['x-admin-key'] || '';
  if (!given) {
    const m = /^Basic\s+(.+)$/i.exec(req.headers.authorization || '');
    if (m) { try { const dec = Buffer.from(m[1], 'base64').toString('utf8'); given = dec.slice(dec.indexOf(':') + 1); } catch (e) {} }
  }
  return !!given && String(given) === String(key);
}

const STAGES = [
  ['landing_view', 'Visited site'],
  ['scan_started', 'Entered phone'],
  ['verified', 'Verified number'],
  ['results_view', 'Saw results'],
  ['paywall_open', 'Opened paywall'],
  ['checkout_view', 'Reached checkout'],
  ['checkout_started', 'Went to Stripe'],
  ['purchased', 'Purchased'],
];

const HOUR = 3600000, DAY = 86400000;
const RANGES = {
  '24h': { ms: 24 * HOUR, bucketMs: HOUR, bucket: 'hour' },
  '7d': { ms: 7 * DAY, bucketMs: DAY, bucket: 'day' },
  '30d': { ms: 30 * DAY, bucketMs: DAY, bucket: 'day' },
  '90d': { ms: 90 * DAY, bucketMs: DAY, bucket: 'day' },
};

router.get('/analytics/funnel', async (req, res) => {
  if (!authed(req)) return res.status(401).json({ ok: false, error: 'unauthorized' });

  const range = RANGES[req.query.range] ? req.query.range : '30d';
  const cfg = RANGES[range];
  const now = Date.now();
  const sinceISO = new Date(now - cfg.ms).toISOString();

  try {
    const rows = await db.getFunnelEventsSince(sinceISO);

    const stageOrder = {};
    STAGES.forEach(([k], i) => { stageOrder[k] = i; });
    const stageVisitors = {};
    STAGES.forEach(([k]) => { stageVisitors[k] = new Set(); });

    const visitors = {};   // vid -> { firstTs, purchasedTs }
    const people = {};     // vid -> { phone, email, maxStage, firstTs, lastTs }
    const phoneSet = new Set(), emailSet = new Set();
    let purchases = 0, revenueCents = 0;

    const alignedStart = Math.floor((now - cfg.ms) / cfg.bucketMs) * cfg.bucketMs;
    const nB = Math.max(1, Math.ceil((now - alignedStart) / cfg.bucketMs));
    const buckets = [];
    for (let i = 0; i < nB; i++) buckets.push({ ts: alignedStart + i * cfg.bucketMs, vis: new Set(), purchases: 0, revenueCents: 0 });

    for (const r of rows) {
      const ev = r.event;
      const ts = new Date(r.created_at).getTime();
      const vid = r.visitor_id || ('row-' + (r.id || Math.random()));

      if (stageVisitors[ev]) stageVisitors[ev].add(vid);
      if (r.phone) phoneSet.add(r.phone);
      if (r.email) emailSet.add(r.email);

      const bi = Math.floor((ts - alignedStart) / cfg.bucketMs);
      if (bi >= 0 && bi < buckets.length) {
        if (ev === 'landing_view') buckets[bi].vis.add(vid);
        if (ev === 'purchased') { buckets[bi].purchases++; buckets[bi].revenueCents += (r.amount || 0); }
      }

      if (r.visitor_id) {
        const v = visitors[vid] = visitors[vid] || { firstTs: ts, purchasedTs: null };
        if (ts < v.firstTs) v.firstTs = ts;
        if (ev === 'purchased') v.purchasedTs = ts;
        const p = people[vid] = people[vid] || { phone: '', email: '', maxStage: -1, firstTs: ts, lastTs: ts };
        if (ts < p.firstTs) p.firstTs = ts;
        if (ts > p.lastTs) p.lastTs = ts;
        if (r.phone && !p.phone) p.phone = r.phone;
        if (r.email && !p.email) p.email = r.email;
        if (stageOrder[ev] != null && stageOrder[ev] > p.maxStage) p.maxStage = stageOrder[ev];
      }
      if (ev === 'purchased') { purchases++; revenueCents += (r.amount || 0); }
    }

    const funnel = STAGES.map(([key, label]) => ({ key, label, count: stageVisitors[key].size }));
    const top = funnel[0].count || 0;
    funnel.forEach((s, i) => {
      s.pctOfTop = top ? Math.round((s.count / top) * 1000) / 10 : 0;
      s.stepPct = i === 0 ? 100 : (funnel[i - 1].count ? Math.round((s.count / funnel[i - 1].count) * 1000) / 10 : 0);
    });

    const series = buckets.map((b) => ({ ts: b.ts, visitors: b.vis.size, purchases: b.purchases, revenueCents: b.revenueCents }));

    const convTimes = Object.values(visitors).filter((v) => v.purchasedTs).map((v) => v.purchasedTs - v.firstTs).filter((x) => x >= 0);
    const avgMinutesToPurchase = convTimes.length ? Math.round((convTimes.reduce((a, b) => a + b, 0) / convTimes.length) / 60000) : null;

    const leads = Object.values(people)
      .filter((p) => p.phone || p.email)
      .sort((a, b) => b.lastTs - a.lastTs)
      .slice(0, 200)
      .map((p) => ({ phone: p.phone, email: p.email, stage: (STAGES[p.maxStage] ? STAGES[p.maxStage][1] : '—'), when: new Date(p.firstTs).toISOString() }));

    const totals = {
      visitors: stageVisitors['landing_view'].size,
      phonesCount: phoneSet.size,
      emailsCount: emailSet.size,
      purchases: purchases,
      revenueCents: revenueCents,
      overallConvPct: top ? Math.round((stageVisitors['purchased'].size / top) * 1000) / 10 : 0,
      avgMinutesToPurchase: avgMinutesToPurchase,
    };

    res.json({ ok: true, range, bucket: cfg.bucket, generatedAt: new Date().toISOString(), funnel, series, leads, totals });
  } catch (e) {
    console.error('[analytics] error:', e && e.message);
    res.status(500).json({ ok: false, error: 'analytics_failed' });
  }
});

module.exports = router;
