'use strict';

/**
 * Application-level PII encryption (AES-256-GCM).
 *
 * Used to encrypt sensitive customer fields (names, phone numbers) at rest, so a
 * database dump or leaked DB credential does not directly expose who owns which
 * number. Render already encrypts the disk at rest; this is the next layer.
 *
 * Key: derived from ENCRYPTION_KEY if set, otherwise from APP_SECRET (always
 * present in prod). NOTE: rotating that secret makes existing ciphertext
 * unreadable — same caveat as signed tokens.
 *
 * Backward-compatible: decrypt() passes any non-prefixed value straight through,
 * so rows written before encryption (or in dev with no secret) still read fine.
 */

const crypto = require('crypto');
const PREFIX = 'enc:v1:';
let KEY;

function key() {
  if (KEY !== undefined) return KEY;
  const secret = process.env.ENCRYPTION_KEY || process.env.APP_SECRET || '';
  KEY = secret ? crypto.createHash('sha256').update('scs-pii|' + secret).digest() : null;
  return KEY;
}

function encrypt(plain) {
  if (plain == null || plain === '') return plain;
  const k = key();
  if (!k) return plain; // no secret (dev) -> store plaintext
  const s = String(plain);
  if (s.startsWith(PREFIX)) return s; // already encrypted
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', k, iv);
  const ct = Buffer.concat([cipher.update(s, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return PREFIX + Buffer.concat([iv, tag, ct]).toString('base64');
}

function decrypt(val) {
  if (val == null || val === '') return val;
  const s = String(val);
  if (!s.startsWith(PREFIX)) return val; // plaintext (legacy / dev) -> pass through
  const k = key();
  if (!k) return val;
  try {
    const raw = Buffer.from(s.slice(PREFIX.length), 'base64');
    const iv = raw.subarray(0, 12);
    const tag = raw.subarray(12, 28);
    const ct = raw.subarray(28);
    const d = crypto.createDecipheriv('aes-256-gcm', k, iv);
    d.setAuthTag(tag);
    return Buffer.concat([d.update(ct), d.final()]).toString('utf8');
  } catch (e) {
    return val; // never crash a read on a bad value
  }
}

// Deterministic, one-way fingerprint of a phone number so we can LOOK UP a
// customer by their number even though the number itself is stored encrypted
// (encrypt() uses a random IV, so the ciphertext can't be matched). Same number
// always yields the same hash; the raw number can't be recovered from it.
// Keyed off the same secret as encryption, with a distinct domain label so the
// fingerprint can never be confused with the encryption key.
function phoneHash(phone) {
  const d = String(phone == null ? '' : phone).replace(/\D/g, '').slice(-10);
  if (d.length !== 10) return null; // not a usable US number -> no fingerprint
  const secret = process.env.ENCRYPTION_KEY || process.env.APP_SECRET || '';
  if (!secret) return null; // dev with no secret: numbers stored plaintext, skip
  const k = crypto.createHash('sha256').update('scs-phidx|' + secret).digest();
  return crypto.createHmac('sha256', k).update(d).digest('hex');
}

module.exports = { encrypt, decrypt, phoneHash };
