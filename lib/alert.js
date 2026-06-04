'use strict';

/**
 * Throttled admin alert — emails ADMIN_EMAIL when something goes wrong
 * (crashes, unhandled rejections). Best-effort and rate-limited per key so a
 * flapping error can't spam the inbox. No-op if ADMIN_EMAIL isn't set.
 */

const resend = require('./resend');

const lastSent = {};

function alertAdmin(subject, text, opts) {
  opts = opts || {};
  const to = process.env.ADMIN_EMAIL;
  if (!to) return;
  const k = opts.key || subject;
  const throttleMs = opts.throttleMs || 30 * 60 * 1000;
  const now = Date.now();
  if (lastSent[k] && now - lastSent[k] < throttleMs) return;
  lastSent[k] = now;
  Promise.resolve()
    .then(() => resend.send({
      to: to,
      from: process.env.EMAIL_FROM,
      replyTo: 'company@spamcallstop.com',
      subject: 'SpamCallStop alert: ' + subject,
      text: String(text || ''),
    }))
    .then(() => console.log('[alert] emailed:', subject))
    .catch((e) => console.error('[alert] send failed:', e && e.message));
}

module.exports = { alertAdmin };
