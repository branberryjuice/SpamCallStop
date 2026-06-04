'use strict';

/**
 * Short-lived "this phone was verified" token.
 *
 * After SMS verification, we hand the browser a signed token tied to the phone
 * number. The scan endpoint requires a valid token before returning anything
 * personal, so only the verified owner of a number can see data for it.
 *
 * HMAC-signed, 30-minute expiry. Set APP_SECRET to a long random value in prod.
 */

const crypto = require('crypto');

const SECRET = process.env.APP_SECRET || 'dev-insecure-secret-change-me';
const TTL_MS = 30 * 60 * 1000; // 30 minutes

function sign(digits) {
  const payload = digits + '.' + (Date.now() + TTL_MS);
  const body = Buffer.from(payload).toString('base64url');
  const mac = crypto.createHmac('sha256', SECRET).update(body).digest('base64url');
  return body + '.' + mac;
}

function verify(token, digits) {
  if (!token || typeof token !== 'string') return false;
  const parts = token.split('.');
  if (parts.length !== 2) return false;
  const [body, mac] = parts;
  const expected = crypto.createHmac('sha256', SECRET).update(body).digest('base64url');
  const a = Buffer.from(mac);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return false;
  let payload;
  try { payload = Buffer.from(body, 'base64url').toString('utf8'); } catch (e) { return false; }
  const [tokDigits, expStr] = payload.split('.');
  if (tokDigits !== digits) return false;
  if (Date.now() > Number(expStr)) return false;
  return true;
}

// --- customer access token (the emailed magic link) -----------------------
const CUSTOMER_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days (re-auth via the email sign-in)

function signCustomer(id) {
  const payload = 'c' + String(id) + '.' + (Date.now() + CUSTOMER_TTL_MS);
  const body = Buffer.from(payload).toString('base64url');
  const mac = crypto.createHmac('sha256', SECRET).update(body).digest('base64url');
  return body + '.' + mac;
}

function verifyCustomer(tok) {
  if (!tok || typeof tok !== 'string') return null;
  const parts = tok.split('.');
  if (parts.length !== 2) return null;
  const [body, mac] = parts;
  const expected = crypto.createHmac('sha256', SECRET).update(body).digest('base64url');
  const a = Buffer.from(mac);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  let payload;
  try { payload = Buffer.from(body, 'base64url').toString('utf8'); } catch (e) { return null; }
  const dot = payload.lastIndexOf('.');
  if (dot < 1 || payload[0] !== 'c') return null;
  if (Date.now() > Number(payload.slice(dot + 1))) return null;
  return payload.slice(1, dot); // customer id (string)
}

module.exports = { sign, verify, signCustomer, verifyCustomer };
