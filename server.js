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

// Future API routes mount here as we build them:
//   /api/scan      -> real phone-number exposure checker
//   /api/checkout  -> Stripe Checkout Session
//   /api/webhook   -> Stripe payment webhook
//   /api/signup    -> persist the customer record
app.use('/api', require('./routes/scan'));
app.use('/api', require('./routes/checkout'));
app.use('/api', require('./routes/webhook'));
app.use('/api', require('./routes/verify'));
app.use('/api', require('./routes/lookup'));
app.use('/api', require('./routes/admin'));
app.use('/api', require('./routes/inbound'));

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
    p.includes('.env')
  ) {
    return res.status(404).type('text/plain').send('Not found');
  }
  next();
});

// Serve the existing pages. `extensions:['html']` lets /offer load offer.html.
// `dotfiles:'ignore'` (the default) keeps .env and .git out of reach.
app.use(express.static(STATIC_DIR, { extensions: ['html'] }));

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
  setInterval(() => {
    removal.processDue(20)
      .then((r) => { if (r.processed) console.log('[removal] processed', JSON.stringify(r)); })
      .catch((e) => console.error('[removal] loop error:', e && e.message));
  }, 60 * 1000);
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
