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

const app = express();
const PORT = process.env.PORT || 3000;
const STATIC_DIR = __dirname;

app.disable('x-powered-by');

// --- API ------------------------------------------------------------------
// Health check (Render pings this to confirm the app is up; handy for us too).
app.get('/api/health', (req, res) => {
  res.json({ ok: true, service: 'spamcallstop', time: new Date().toISOString() });
});

// Future API routes mount here as we build them:
//   /api/scan      -> real phone-number exposure checker
//   /api/checkout  -> Stripe Checkout Session
//   /api/webhook   -> Stripe payment webhook
//   /api/signup    -> persist the customer record
// e.g. app.use('/api', require('./routes/scan'));

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

app.listen(PORT, () => {
  console.log(`SpamCallStop server listening on port ${PORT}`);
});
