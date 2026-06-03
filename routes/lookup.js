'use strict';

/**
 * Identity lookup for the verified owner of a phone number.
 *
 *   POST /api/lookup  { phone, token, verificationSid? }
 *     -> { ok, name, address, hasAddress, sources }
 *
 * Gated by the "phone verified" token from the OTP step: the token is bound to
 * the same digits, so a caller can only pull the name/address for a number they
 * proved they control. No valid token -> 401, nothing revealed. This is the
 * doxxing / compliance safeguard, not just UX.
 */

const express = require('express');
const router = express.Router();
const { normalizePhone } = require('../lib/phone');
const token = require('../lib/token');
const ratelimit = require('../lib/ratelimit');
const { lookupIdentity } = require('../lib/lookup');

function ipOf(req) {
  const xff = req.headers['x-forwarded-for'];
  return (xff ? String(xff).split(',')[0].trim() : '') || req.socket.remoteAddress || 'unknown';
}

router.post('/lookup', express.json(), async (req, res) => {
  const digits = normalizePhone(req.body && req.body.phone);
  const tok = String((req.body && req.body.token) || '');
  if (!digits) return res.status(400).json({ ok: false, error: 'invalid_phone' });

  // Must prove ownership of THIS number — token is bound to the digits.
  if (!token.verify(tok, digits)) {
    return res.status(401).json({ ok: false, error: 'not_verified' });
  }

  // Cost guard: a verified user can't spin the paid lookup endlessly.
  const ip = ipOf(req);
  if (!ratelimit.hit('lookup-ip:' + ip, 20, 15 * 60 * 1000).allowed) {
    return res.status(429).json({ ok: false, error: 'too_many_requests' });
  }

  const verificationSid = req.body && req.body.verificationSid;
  const out = await lookupIdentity(digits, { verificationSid });
  if (!out.ok) {
    const code = out.error === 'lookup_not_configured' ? 503 : 502;
    return res.status(code).json(out);
  }
  return res.json(out);
});

module.exports = router;
