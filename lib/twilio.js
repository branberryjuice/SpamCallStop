'use strict';

/**
 * Twilio client, initialized from env. Null until credentials are set, so the
 * app still boots and the rest of the site works without phone verification.
 * Used only for Twilio Verify (SMS OTP) — exempt from A2P 10DLC registration.
 */

const sid = process.env.TWILIO_ACCOUNT_SID;
const token = process.env.TWILIO_AUTH_TOKEN;
module.exports = (sid && token) ? require('twilio')(sid, token) : null;
