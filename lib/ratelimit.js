'use strict';

/**
 * Tiny in-memory sliding-window rate limiter (per server instance).
 *
 * hit(key, max, windowMs) -> { allowed, retryAfter }
 *
 * Used to throttle the SMS verify endpoints so a bot can't spam them. The
 * durable app-wide daily cap (in the database) is the hard cost ceiling; this
 * is the fast first line of defense per IP and per phone number.
 */

const buckets = new Map();

function hit(key, max, windowMs) {
  const now = Date.now();
  let arr = buckets.get(key);
  if (!arr) { arr = []; buckets.set(key, arr); }
  while (arr.length && arr[0] <= now - windowMs) arr.shift();
  if (arr.length >= max) {
    return { allowed: false, retryAfter: Math.ceil((arr[0] + windowMs - now) / 1000) };
  }
  arr.push(now);
  return { allowed: true };
}

// Periodically drop empty/old buckets so memory stays bounded.
setInterval(() => {
  const cutoff = Date.now() - 24 * 60 * 60 * 1000;
  for (const [k, arr] of buckets) {
    while (arr.length && arr[0] <= cutoff) arr.shift();
    if (arr.length === 0) buckets.delete(k);
  }
}, 60 * 60 * 1000).unref();

module.exports = { hit };
