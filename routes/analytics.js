'use strict';

/**
 * Private funnel analytics API for the owner's dashboard.
 *
 *   GET /api/analytics/funnel?days=30   (admin-gated, same key as /api/admin)
 *
 * Aggregates raw funnel_events into: the funnel (distinct visitors per stage),
 * step + overall conversion, a daily time series, revenue, average time to
 * purchase, and the most recent submitted emails with how far each person got.
 */

const express = require('express');
const router = express.Router();
const db = require('../lib/customers');

// Same gate as /api/admin: query key, x-admin-key header, or HTTP Basic Auth.
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

// Funnel stages in order. Every page beacon + the webhook map to one of these.
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

function dayKey(ts) { return new Date(ts).toISOString().slice(0, 10); }

router.get('/analytics/funnel', async (req, res) => {
  if (!authed(req)) return res.status(401).json({ ok: false, error: 'unauthorized' });

  const days = Math.min(Math.max(parseInt(req.query.days || '30', 10) || 30, 1), 365);
  const sinceISO = new Date(Date.now() - days * 86400000).toISOString();

  try {
    const rows = await db.getFunnelEventsSince(sinceISO);

    const stageOrder = {};
    STAGES.forEach(([k], i) => { stageOrder[k] = i; });

    const stageVisitors = {};
    STAGES.forEach(([k]) => { stageVisitors[k] = new Set(); });

    const visitors = {};   // visitor_id -> { firstTs, purchasedTs }
    const emailsMap = {};  // email -> { email, firstTs, maxStage }
    const daily = {};      // 'YYYY-MM-DD' -> { visitors:Set, purchases:int }
    let purchases = 0, revenueCents = 0;

    for (const r of rows) {
      const ev = r.event;
      const ts = new Date(r.created_at).getTime();
      const vid = r.visitor_id || ('row-' + (r.id || Math.random()));
      const dk = dayKey(r.created_at);

      if (stageVisitors[ev]) stageVisitors[ev].add(vid);

      daily[dk] = daily[dk] || { visitors: new Set(), purchases: 0 };
      if (ev === 'landing_view') daily[dk].visitors.add(vid);
      if (ev === 'purchased') daily[dk].purchases++;

      if (r.visitor_id) {
        const v = visitors[vid] = visitors[vid] || { firstTs: ts, purchasedTs: null };
        if (ts < v.firstTs) v.firstTs = ts;
        if (ev === 'purchased') v.purchasedTs = ts;
      }

      if (ev === 'purchased') { purchases++; revenueCents += (r.amount || 0); }

      if (r.email) {
        const e = emailsMap[r.email] = emailsMap[r.email] || { email: r.email, firstTs: ts, maxStage: -1 };
        if (ts < e.firstTs) e.firstTs = ts;
        if (stageOrder[ev] != null && stageOrder[ev] > e.maxStage) e.maxStage = stageOrder[ev];
      }
    }

    const funnel = STAGES.map(([key, label], i) => ({ key, label, count: stageVisitors[key].size }));
    const top = funnel[0].count || 0;
    funnel.forEach((s, i) => {
      s.pctOfTop = top ? Math.round((s.count / top) * 1000) / 10 : 0;
      s.stepPct = i === 0 ? 100 : (funnel[i - 1].count ? Math.round((s.count / funnel[i - 1].count) * 1000) / 10 : 0);
    });

    // Daily series across the whole window, zero-filled.
    const series = [];
    for (let i = days - 1; i >= 0; i--) {
      const d = dayKey(Date.now() - i * 86400000);
      const row = daily[d];
      series.push({ date: d, visitors: row ? row.visitors.size : 0, purchases: row ? row.purchases : 0 });
    }

    // Average minutes from a visitor's first event to their purchase.
    const convTimes = Object.values(visitors).filter((v) => v.purchasedTs).map((v) => v.purchasedTs - v.firstTs).filter((x) => x >= 0);
    const avgMinutesToPurchase = convTimes.length ? Math.round((convTimes.reduce((a, b) => a + b, 0) / convTimes.length) / 60000) : null;

    const emails = Object.values(emailsMap)
      .sort((a, b) => b.firstTs - a.firstTs)
      .slice(0, 200)
      .map((e) => ({ email: e.email, when: new Date(e.firstTs).toISOString(), stage: (STAGES[e.maxStage] ? STAGES[e.maxStage][1] : '—') }));

    const totals = {
      visitors: stageVisitors['landing_view'].size,
      purchases: purchases,
      revenueCents: revenueCents,
      overallConvPct: top ? Math.round((stageVisitors['purchased'].size / top) * 1000) / 10 : 0,
      avgMinutesToPurchase: avgMinutesToPurchase,
      emailsCount: Object.keys(emailsMap).length,
    };

    res.json({ ok: true, days, generatedAt: new Date().toISOString(), funnel, series, emails, totals });
  } catch (e) {
    console.error('[analytics] error:', e && e.message);
    res.status(500).json({ ok: false, error: 'analytics_failed' });
  }
});

module.exports = router;
