'use strict';

/**
 * SpamCallStop — application server.
 *
 * Serves the marketing funnel (the HTML/CSS already in this folder) and will
 * host the API for the real scan, Stripe checkout, and customer signup as we
 * build it out.
 *
 * This file is ADDITIVE: it does not change any existing site page. GitHub
 * Pages ignores it; Render runs it via `npm start`.
 */

const path = require('path');
const express = require('express');
const { securityHeaders, apiRateLimit, bootSecurityCheck } = require('./lib/security');
const { alertAdmin } = require('./lib/alert');

// Last-resort crash visibility: log + email the admin so an outage isn't silent.
process.on('unhandledRejection', (reason) => {
  const msg = reason && reason.stack ? reason.stack : String(reason);
  console.error('[fatal] unhandledRejection:', msg);
  alertAdmin('unhandled promise rejection', msg.slice(0, 1200), { key: 'unhandledRejection' });
});
process.on('uncaughtException', (err) => {
  const msg = err && err.stack ? err.stack : String(err);
  console.error('[fatal] uncaughtException:', msg);
  alertAdmin('uncaught exception — server is restarting', msg.slice(0, 1200), { key: 'uncaughtException' });
  // The process is in an undefined state; let it exit so Render restarts a clean one.
  setTimeout(() => process.exit(1), 1500);
});

const app = express();
const PORT = process.env.PORT || 3000;
const STATIC_DIR = __dirname;

app.disable('x-powered-by');
app.use(securityHeaders);

// --- API ------------------------------------------------------------------
// Health check (Render pings this to confirm the app is up; handy for us too).
app.get('/api/health', (req, res) => {
  res.json({ ok: true, service: 'spamcallstop', time: new Date().toISOString() });
});

// Backstop rate limit across the API (per IP). Stripe webhook + Resend inbound
// + health are exempt inside the limiter so those callers aren't throttled.
app.use('/api', apiRateLimit());
// Never let browsers/proxies cache API responses — several carry the customer's
// own PII (name, phone, alerts). Static assets get their own cache policy below.
app.use('/api', (req, res, next) => { res.set('Cache-Control', 'no-store'); next(); });

// Future API routes mount here as we build them:
//   /api/scan      -> real phone-number exposure checker
//   /api/checkout  -> Stripe Checkout Session
//   /api/webhook   -> Stripe payment webhook
//   /api/signup    -> persist the customer record
// /api/scan retired — the results page now uses /api/lookup. Route file kept on disk.
app.use('/api', require('./routes/checkout'));
app.use('/api', require('./routes/webhook'));
app.use('/api', require('./routes/verify'));
app.use('/api', require('./routes/lookup'));
app.use('/api', require('./routes/admin'));
app.use('/api', require('./routes/inbound'));
app.use('/api', require('./routes/account'));
app.use('/api', require('./routes/track'));
app.use('/api', require('./routes/analytics'));
app.use('/api', require('./routes/alerts'));

// --- Static site -----------------------------------------------------------
// Never hand out our server code or config as if it were a web page.
const BLOCKED = new Set([
  '/server.js', '/package.json', '/package-lock.json', '/render.yaml'
]);
app.use((req, res, next) => {
  const p = req.path.toLowerCase();
  if (
    BLOCKED.has(p) ||
    p.startsWith('/routes') ||
    p.startsWith('/lib') ||
    p.startsWith('/node_modules') ||
    /^\/\d{4}-\d{2}-\d{2}-/.test(p) || // internal dated preview/mockup files — never public
    p.endsWith('.md') ||               // README and notes — never public
    p.includes('.env')
  ) {
    return res.status(404).type('text/plain').send('Not found');
  }
  next();
});

// Gate the admin dashboard page behind the admin key (HTTP Basic Auth, password
// = ADMIN_KEY) so the page itself won't load without it — not just its data API.
// If ADMIN_KEY is unset, the page is hidden (404).
app.get(['/dashboard', '/dashboard.html', '/analytics', '/analytics.html'], (req, res, next) => {
  const key = process.env.ADMIN_KEY;
  if (!key) return res.status(404).type('text/plain').send('Not found');
  const m = /^Basic\s+(.+)$/i.exec(req.headers.authorization || '');
  if (m) {
    let pass = '';
    try { const dec = Buffer.from(m[1], 'base64').toString('utf8'); pass = dec.slice(dec.indexOf(':') + 1); } catch (e) {}
    if (pass && pass === key) return next();
  }
  res.set('WWW-Authenticate', 'Basic realm="SpamCallStop Admin"');
  return res.status(401).type('text/plain').send('Authentication required');
});

// Serve the existing pages. `extensions:['html']` lets /offer load offer.html.
// `dotfiles:'ignore'` (the default) keeps .env and .git out of reach.
app.use(express.static(STATIC_DIR, {
  extensions: ['html'],
  setHeaders: (res, p) => {
    // HTML revalidates so a new deploy shows immediately; other assets cache briefly.
    res.set('Cache-Control', p.endsWith('.html') ? 'no-cache' : 'public, max-age=3600');
  },
}));

// Anything else: send people to the home page.
app.use((req, res) => {
  res.status(404).sendFile(path.join(STATIC_DIR, 'index.html'));
});

// Generic error handler — never leak stack traces or internals to clients.
app.use((err, req, res, next) => {
  console.error('[error]', err && err.message ? err.message : err);
  if (res.headersSent) return next(err);
  res.status(500).json({ ok: false, error: 'server_error' });
});

// Boot-time security self-check (warns about missing critical secrets).
bootSecurityCheck();

// Make sure the customer table exists before we start taking traffic.
require('./lib/customers').init().catch((e) => console.error('[db] init failed:', e.message));

// Removal engine: process due opt-out jobs on an interval. Dry-run safe — no
// email is sent unless RESEND_API_KEY is set. Set REMOVALS_PAUSED=1 to disable.
if (process.env.REMOVALS_PAUSED !== '1') {
  const removal = require('./lib/removal');
  let removalBusy = false; // never overlap a slow run — overlap could double-send opt-outs
  setInterval(() => {
    if (removalBusy) return;
    removalBusy = true;
    removal.processDue(20)
      .then((r) => { if (r.processed) console.log('[removal] processed', JSON.stringify(r)); })
      .catch((e) => console.error('[removal] loop error:', e && e.message))
      .finally(() => { removalBusy = false; });
  }, 60 * 1000);
}

// Verification sweep: 24h+ after a removal email, re-check the broker site and
// confirm removals (Phase 2). Inert until real per-broker checkers are wired in
// lib/checkers.js — until then every check is 'unknown' and this does nothing.
if (process.env.REMOVALS_PAUSED !== '1') {
  const checkers = require('./lib/checkers');
  let sweepBusy = false;
  setInterval(() => {
    if (sweepBusy || !checkers.anyCheckersLive()) return;
    sweepBusy = true;
    checkers.runVerificationSweep(50)
      .then((r) => { if (r.checked) console.log('[verify-sweep]', JSON.stringify(r)); })
      .catch((e) => console.error('[verify-sweep] error:', e && e.message))
      .finally(() => { sweepBusy = false; });
  }, 6 * 60 * 60 * 1000);
}

// Order reconciliation: every 10 min, scan recent paid Checkout Sessions and
// provision any the webhook missed (idempotent), so a paying customer is never
// lost even if the webhook fails and they never return to the dashboard.
if (process.env.STRIPE_SECRET_KEY) {
  const stripeCli = require('./lib/stripe');
  const { reconcileRecentSessions } = require('./lib/reconcile');
  let reconcileBusy = false;
  setInterval(() => {
    if (reconcileBusy) return;
    reconcileBusy = true;
    reconcileRecentSessions(stripeCli, 180)
      .then((r) => { if (r.provisioned) console.log('[reconcile]', JSON.stringify(r)); })
      .catch((e) => console.error('[reconcile] loop error:', e && e.message))
      .finally(() => { reconcileBusy = false; });
  }, 10 * 60 * 1000);
}

// Daily digest: email ADMIN_EMAIL a summary of broker replies once a day.
if (process.env.ADMIN_EMAIL) {
  const digest = require('./lib/digest');
  const DIGEST_HOUR = parseInt(process.env.DIGEST_HOUR_UTC || '13', 10);
  let lastDigestDay = '';
  setInterval(() => {
    const now = new Date();
    const day = now.toISOString().slice(0, 10);
    if (now.getUTCHours() === DIGEST_HOUR && lastDigestDay !== day) {
      lastDigestDay = day;
      digest.sendDigest()
        .then((r) => console.log('[digest] sent', JSON.stringify(r)))
        .catch((e) => console.error('[digest] error:', e && e.message));
    }
  }, 15 * 60 * 1000);
}

app.listen(PORT, () => {
  console.log(`SpamCallStop server listening on port ${PORT}`);
});
