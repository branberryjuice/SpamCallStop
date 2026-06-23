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
  ['checkout_started', 'Went to Stripe'],
  ['purchased', 'Purchased'],
];

const HOUR = 3600000, DAY = 86400000;
const RANGES = {
  'today': { bucketMs: HOUR, bucket: 'hour' }, // since local midnight; ms computed per-request
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
  let sinceMs;
  if (range === 'today') {
    // Start of the viewer's local calendar day. tz = browser getTimezoneOffset() in minutes.
    const off = parseInt(req.query.tz, 10);
    const tzMin = Number.isFinite(off) ? off : 0;
    const localNow = now - tzMin * 60000;
    sinceMs = Math.floor(localNow / DAY) * DAY + tzMin * 60000;
  } else {
    sinceMs = now - cfg.ms;
  }
  const sinceISO = new Date(sinceMs).toISOString();

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

    const alignedStart = Math.floor(sinceMs / cfg.bucketMs) * cfg.bucketMs;
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

// Data reveals: which numbers we've shown identity data for, what fields, and how
// far the lookup got. Each cell is 'y' (shown), 'n' (reached that level but empty),
// or '-' (never reached that level — e.g. fell back to name-only Twilio).
//
//   GET /api/analytics/reveals?range=today|24h|7d|30d|90d|all   (admin-gated)
const REVEAL_COLUMNS = [
  ['name', 'Name'], ['age', 'Age'], ['dob', 'DOB'], ['gender', 'Gender'],
  ['language', 'Language'], ['children', 'Children'],
  ['address', 'Address'], ['email', 'Email'], ['relatives', 'Relatives'],
];
// 'name' is attempted by every source; everything else is rich (Enformion only).
const RICH_KEYS = { age: 1, dob: 1, gender: 1, language: 1, children: 1, address: 1, email: 1, relatives: 1 };

router.get('/analytics/reveals', async (req, res) => {
  if (!authed(req)) return res.status(401).json({ ok: false, error: 'unauthorized' });

  const now = Date.now();
  let sinceISO = '1970-01-01T00:00:00.000Z';
  const range = req.query.range || 'all';
  if (range !== 'all' && RANGES[range]) {
    let sinceMs;
    if (range === 'today') {
      const off = parseInt(req.query.tz, 10);
      const tzMin = Number.isFinite(off) ? off : 0;
      const localNow = now - tzMin * 60000;
      sinceMs = Math.floor(localNow / DAY) * DAY + tzMin * 60000;
    } else {
      sinceMs = now - RANGES[range].ms;
    }
    sinceISO = new Date(sinceMs).toISOString();
  }

  try {
    const rows = await db.listReveals(sinceISO, 500);
    let full = 0, nameOnly = 0;
    const reveals = rows.map((r) => {
      const reachedRich = r.source === 'enformion-callerid-plus';
      if (reachedRich) full++; else nameOnly++;
      const vals = r.values || {};
      const cells = {};
      for (const [key] of REVEAL_COLUMNS) {
        if (RICH_KEYS[key] && !reachedRich) cells[key] = { state: 'dash' };
        else if (vals[key]) cells[key] = { state: 'val', text: vals[key] };
        else cells[key] = { state: 'empty' };
      }
      const sourceLabel = reachedRich ? 'Full' : (r.source === 'twilio' ? 'Name only' : (r.source || '—'));
      return { phone: r.phone || '', firstSeen: r.firstSeen, source: sourceLabel, cells };
    });

    res.json({
      ok: true,
      range,
      generatedAt: new Date().toISOString(),
      columns: REVEAL_COLUMNS.map(([key, label]) => ({ key, label })),
      totals: { reveals: reveals.length, full, nameOnly },
      reveals,
    });
  } catch (e) {
    console.error('[analytics] reveals error:', e && e.message);
    res.status(500).json({ ok: false, error: 'reveals_failed' });
  }
});

// Parse a DB timestamp (PG Date, or zone-less SQLite string) into millis as UTC.
function tsMillis(v) {
  if (!v) return 0;
  if (v instanceof Date) return v.getTime();
  let s = String(v).replace(' ', 'T');
  if (!/[zZ]|[+\-]\d\d:?\d\d$/.test(s)) s += 'Z';
  const t = new Date(s).getTime();
  return isNaN(t) ? 0 : t;
}

// Active customers tab: everyone currently protected, with the business columns
// that matter at a glance. Trial days left is ESTIMATED from signup date + the
// trial length (real trial end lives in Stripe); only shown while still active
// and inside the trial window.
//   GET /api/analytics/customers   (admin-gated)
router.get('/analytics/customers', async (req, res) => {
  if (!authed(req)) return res.status(401).json({ ok: false, error: 'unauthorized' });
  const TRIAL_DAYS = parseInt(process.env.TRIAL_DAYS || '7', 10);
  try {
    const customers = await db.listCustomersWithNumbers();
    const out = [];
    let active = 0, trialing = 0, numbersTotal = 0, inProgressTotal = 0, reportsTotal = 0;
    for (const c of customers) {
      const status = c.status || 'active';
      const stats = await db.getRemovalStats(c.id);
      let reports = 0;
      try { reports = await db.countSpamReportsForCustomer(c.id); } catch (e) {}
      let trialDaysLeft = null;
      const joinedMs = tsMillis(c.created_at);
      if (status === 'active' && joinedMs) {
        const elapsedDays = (Date.now() - joinedMs) / 86400000;
        if (elapsedDays < TRIAL_DAYS) trialDaysLeft = Math.max(0, Math.ceil(TRIAL_DAYS - elapsedDays));
      }
      const firstNumber = (c.numbers && c.numbers[0] && c.numbers[0].phone) || c.phone || '';
      const row = {
        id: c.id, name: c.name || '', email: c.email || '', phone: firstNumber,
        numbers: (c.numbers ? c.numbers.length : 0), plan: c.plan || '', status: status,
        trialDaysLeft: trialDaysLeft, joined: c.created_at,
        inProgress: stats.inProgress, confirmed: stats.confirmedRemoved, reports: reports,
      };
      out.push(row);
      reportsTotal += reports;
      if (status === 'active' || status === 'canceling') {
        active++;
        if (trialDaysLeft != null) trialing++;
        numbersTotal += row.numbers;
        inProgressTotal += stats.inProgress;
      }
    }
    res.json({
      ok: true, generatedAt: new Date().toISOString(),
      totals: { active, trialing, numbers: numbersTotal, inProgress: inProgressTotal, reports: reportsTotal, total: out.length },
      customers: out,
    });
  } catch (e) {
    console.error('[analytics] customers error:', e && e.message);
    res.status(500).json({ ok: false, error: 'customers_failed' });
  }
});

// Spam reports tab: numbers customers submitted from their dashboard.
//   GET /api/analytics/spam-reports   (admin-gated)
router.get('/analytics/spam-reports', async (req, res) => {
  if (!authed(req)) return res.status(401).json({ ok: false, error: 'unauthorized' });
  try {
    const rows = await db.listSpamReports(500);
    const reports = rows.map((r) => ({
      id: r.id, phone: r.phone, category: r.category || 'Other', note: r.note || '',
      customerId: r.customer_id, customerName: r.cust_name || '', customerEmail: r.cust_email || '',
      when: r.created_at,
    }));
    const byCat = {};
    for (const r of reports) byCat[r.category] = (byCat[r.category] || 0) + 1;
    res.json({ ok: true, generatedAt: new Date().toISOString(), totals: { total: reports.length, byCat }, reports });
  } catch (e) {
    console.error('[analytics] spam-reports error:', e && e.message);
    res.status(500).json({ ok: false, error: 'spam_reports_failed' });
  }
});

module.exports = router;
