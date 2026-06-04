'use strict';

/**
 * Phone ownership verification via Twilio Verify (SMS OTP).
 *
 *   POST /api/verify/start  { phone }          -> texts a 6-digit code
 *   POST /api/verify/check  { phone, code }    -> { verified, token } on success
 *
 * The returned token proves the browser controls that number; the scan only
 * reveals data when a valid token is presented. No A2P 10DLC needed (Verify).
 */

const express = require('express');
const router = express.Router();
const twilio = require('../lib/twilio');
const { normalizePhone, formatPhone } = require('../lib/phone');
const token = require('../lib/token');
const ratelimit = require('../lib/ratelimit');
const { incrementVerifySends, getVerifySendsToday } = require('../lib/customers');
const resend = require('../lib/resend');

const SERVICE = process.env.TWILIO_VERIFY_SERVICE_SID;
const DAILY_CAP = parseInt(process.env.VERIFY_DAILY_CAP || '500', 10);

// Alert ADMIN_EMAIL the first time the daily SMS cap locks out new users (once
// per UTC day). Fire-and-forget — never blocks or fails the request.
let capAlertedDay = '';
function maybeAlertCap(count) {
  const today = new Date().toISOString().slice(0, 10);
  if (capAlertedDay === today) return;
  capAlertedDay = today;
  const to = process.env.ADMIN_EMAIL;
  if (!to) return;
  const text =
    'Heads up: the daily SMS verification cap (' + DAILY_CAP + ') was reached on ' + today + ' (UTC).\n\n' +
    'New visitors cannot get a verification code for the rest of the day; it resets at UTC midnight. ' +
    'This is usually heavy traffic or a bot surge hitting the phone-entry box. ' +
    'Check Twilio Verify usage and the Render logs.';
  Promise.resolve()
    .then(function () {
      return resend.send({
        to: to,
        from: process.env.EMAIL_FROM,
        replyTo: 'company@spamcallstop.com',
        subject: 'SpamCallStop: daily SMS verification cap reached',
        text: text,
        html: '<p>' + text.replace(/\n/g, '<br>') + '</p>',
      });
    })
    .then(function () { console.log('[verify] cap alert emailed to', to); })
    .catch(function (e) { console.error('[verify] cap alert failed:', e && e.message); });
}

function ipOf(req) {
  const xff = req.headers['x-forwarded-for'];
  return (xff ? String(xff).split(',')[0].trim() : '') || req.socket.remoteAddress || 'unknown';
}

router.post('/verify/start', express.json(), async (req, res) => {
  const digits = normalizePhone(req.body && req.body.phone);
  if (!digits) return res.status(400).json({ ok: false, error: 'invalid_phone' });

  // Guard 1: per-IP — one device can't hammer the endpoint.
  const ip = ipOf(req);
  if (!ratelimit.hit('vstart-ip:' + ip, 5, 15 * 60 * 1000).allowed) {
    return res.status(429).json({ ok: false, error: 'too_many_requests' });
  }

  if (!twilio || !SERVICE) return res.status(503).json({ ok: false, error: 'verify_not_configured' });

  // Guard 2: per-phone — no spamming codes to one number. Cap 5/hour to match the
  // client's 5-code resend limit (1 initial + up to 4 resends).
  if (!ratelimit.hit('vstart-ph:' + digits, 5, 60 * 60 * 1000).allowed) {
    return res.status(429).json({ ok: false, error: 'too_many_for_number' });
  }

  // Guard 3: app-wide daily ceiling (durable) — the hard cost cap. Check the
  // count first and only increment AFTER a successful send, so failed sends
  // (which cost nothing) don't burn the cap. At ~$0.05 each, 500/day caps the
  // worst case near $25/day.
  try {
    const sentToday = await getVerifySendsToday();
    if (sentToday >= DAILY_CAP) {
      console.error('[verify] daily cap reached:', sentToday, '/', DAILY_CAP);
      maybeAlertCap(sentToday);
      return res.status(429).json({ ok: false, error: 'temporarily_unavailable' });
    }
  } catch (e) {
    console.error('[verify] daily counter read error:', e && e.message);
  }

  try {
    await twilio.verify.v2.services(SERVICE).verifications.create({ to: '+1' + digits, channel: 'sms' });
    try { await incrementVerifySends(); } catch (ce) { console.error('[verify] daily counter inc error:', ce && ce.message); }
    return res.json({ ok: true, sent: true });
  } catch (err) {
    console.error('verify start error:', err && err.message ? err.message : err);
    return res.status(502).json({ ok: false, error: 'send_failed' });
  }
});

router.post('/verify/check', express.json(), async (req, res) => {
  const digits = normalizePhone(req.body && req.body.phone);
  const code = String((req.body && req.body.code) || '').trim();
  if (!digits || !/^\d{6}$/.test(code)) return res.status(400).json({ ok: false, error: 'invalid_input' });
  if (!twilio || !SERVICE) return res.status(503).json({ ok: false, error: 'verify_not_configured' });

  // Slow down code brute-forcing (Twilio also locks after a few wrong codes).
  const ip = ipOf(req);
  if (!ratelimit.hit('vcheck-ip:' + ip, 15, 15 * 60 * 1000).allowed) {
    return res.status(429).json({ ok: false, error: 'too_many_requests' });
  }

  try {
    const check = await twilio.verify.v2.services(SERVICE).verificationChecks.create({ to: '+1' + digits, code });
    if (check.status === 'approved') {
      return res.json({ ok: true, verified: true, token: token.sign(digits), phone: formatPhone(digits) });
    }
    return res.json({ ok: true, verified: false });
  } catch (err) {
    console.error('verify check error:', err && err.message ? err.message : err);
    return res.status(400).json({ ok: false, error: 'check_failed' });
  }
});

module.exports = router;
