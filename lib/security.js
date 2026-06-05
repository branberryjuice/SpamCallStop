'use strict';

/**
 * App-layer security hardening (no external deps).
 *
 *  - securityHeaders: defense-in-depth response headers (HSTS, CSP, anti-
 *    clickjacking, nosniff, referrer policy, etc.) on every response.
 *  - apiRateLimit: a backstop per-IP limit across the whole API, on top of the
 *    stricter per-route limits (verify, lookup). Stripe webhook + Resend inbound
 *    + health are exempt so those server-to-server callers aren't throttled.
 *  - bootSecurityCheck: warns at startup if critical secrets are missing.
 *
 * Transport is HTTPS-only (Render TLS, enforced by HSTS); the database is
 * encrypted at rest by Render; secrets live only in env vars (see .gitignore).
 */

const ratelimit = require('./ratelimit');

// CSP allows inline script/style because the site is built with inline code,
// plus Google Fonts. Everything else is locked to same-origin.
const CSP = [
  "default-src 'self'",
  "script-src 'self' 'unsafe-inline'",
  "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
  "font-src 'self' https://fonts.gstatic.com",
  "img-src 'self' data:",
  "connect-src 'self'",
  "form-action 'self'",
  "frame-ancestors 'none'",
  "base-uri 'self'",
  "object-src 'none'",
].join('; ');

function securityHeaders(req, res, next) {
  res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains; preload');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
  res.setHeader('X-Permitted-Cross-Domain-Policies', 'none');
  res.setHeader('Permissions-Policy', 'geolocation=(), microphone=(), camera=()');
  res.setHeader('Content-Security-Policy', CSP);
  next();
}

function ipOf(req) {
  const xff = req.headers['x-forwarded-for'];
  return (xff ? String(xff).split(',')[0].trim() : '') || req.socket.remoteAddress || 'unknown';
}

function apiRateLimit(max, windowMs) {
  max = max || 120;
  windowMs = windowMs || 15 * 60 * 1000;
  const EXEMPT = ['/webhook', '/inbound', '/health', '/track'];
  return function (req, res, next) {
    if (EXEMPT.some((p) => req.path === p || req.path.startsWith(p + '/'))) return next();
    if (!ratelimit.hit('api:' + ipOf(req), max, windowMs).allowed) {
      return res.status(429).json({ ok: false, error: 'too_many_requests' });
    }
    next();
  };
}

function bootSecurityCheck() {
  // Fail CLOSED in production: without APP_SECRET, login tokens are forgeable and
  // customer PII would be stored in plaintext. Refuse to boot rather than warn.
  // Production is identified by DATABASE_URL (the same signal the app uses to pick
  // Postgres over the dev SQLite db), so dev and tests are unaffected.
  if (process.env.DATABASE_URL && !process.env.APP_SECRET) {
    console.error('[security] FATAL: APP_SECRET is not set in production — login tokens would be forgeable and customer PII would be stored in plaintext. Refusing to start. Set APP_SECRET in the environment and redeploy.');
    process.exit(1);
  }
  const warn = [];
  if (!process.env.APP_SECRET) {
    warn.push('APP_SECRET is not set — phone-verified tokens fall back to an insecure default and could be forged. Set a long random value in the environment.');
  }
  if (!process.env.ADMIN_KEY) warn.push('ADMIN_KEY is not set — the admin dashboard API stays locked, but set a strong key to use it.');
  if (!process.env.INBOUND_SECRET) warn.push('INBOUND_SECRET is not set — /api/inbound stays disabled until you set it.');
  if (warn.length) warn.forEach((w) => console.warn('[security] ' + w));
  else console.log('[security] critical secrets present.');
}

module.exports = { securityHeaders, apiRateLimit, bootSecurityCheck, CSP };
