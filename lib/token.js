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

module.exports = { sign, verify };
