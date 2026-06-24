'use strict';

/**
 * Scraper engine — the Phase 2 in-house exposure scanner. DORMANT BY DEFAULT.
 *
 * One engine feeds two existing (already-dormant) plug points:
 *   1. lib/scan.js  -> scanExposure(digits): the customer-facing "your number is
 *      listed on these sites" reveal (only ever returns brokers we CONFIRMED).
 *   2. lib/checkers.js -> buildCheckers(): the post-removal verification sweep
 *      (re-checks a site 24h+ after the opt-out to confirm the number is gone).
 *
 * Everything here returns the empty/no-op result unless the engine is live AND
 * the broker has been calibrated against a real sample (see parsers.js honesty
 * gate). So shipping this dormant — and even flipping the master switch — never
 * shows a customer anything false.
 */

const fetcher = require('./fetcher');
const { classify, calibratedParsers } = require('./parsers');

let phoneHash;
try {
  ({ phoneHash } = require('../crypto'));
} catch (e) {
  phoneHash = null;
}

// How many broker fetches to run at once. The set is small (the phone-searchable
// subset), and each fetch is already timeout-bounded, so we just fan them all
// out in parallel — wall-clock cost is the slowest single site, not the sum.
const MAX_CONCURRENCY = parseInt(process.env.SCRAPER_CONCURRENCY || '6', 10);
const CACHE_TTL_MS = parseInt(process.env.SCRAPER_CACHE_TTL_MS || String(6 * 3600000), 10);

// In-memory per-number cache so repeat scans of the same number (refreshes, ad
// retargeting, bots) don't re-pay the proxy bill within the TTL. Ephemeral on
// purpose for the dormant build — a persistent cache table is a flip-on TODO.
const _cache = new Map(); // hash -> { at:number, findings:[] }

function cacheKey(digits) {
  const d = String(digits || '').replace(/\D/g, '').slice(-10);
  if (d.length !== 10) return null;
  return (phoneHash && phoneHash(d)) || 'raw:' + d; // raw only in dev (no secret)
}

/** Live iff the fetcher is live AND at least one broker is calibrated. */
function isEnabled() {
  return fetcher.isLive() && calibratedParsers().length > 0;
}

/** Run a single calibrated broker -> 'found' | 'clear' | 'unknown'. */
async function checkBroker(broker, digits) {
  if (!broker || broker.calibrated !== true) return 'unknown';
  let url;
  try {
    url = broker.searchUrl(digits);
  } catch (e) {
    return 'unknown';
  }
  const html = await fetcher.fetchHtml(url); // null when dormant -> 'unknown'
  return classify(broker, html, digits);
}

/** Cap fan-out at MAX_CONCURRENCY (defensive; the set is already small). */
async function mapLimited(items, limit, fn) {
  const out = new Array(items.length);
  let i = 0;
  const workers = new Array(Math.max(1, Math.min(limit, items.length))).fill(0).map(async () => {
    while (i < items.length) {
      const idx = i++;
      out[idx] = await fn(items[idx], idx);
    }
  });
  await Promise.all(workers);
  return out;
}

/**
 * Customer-facing exposure scan. Returns ONLY confirmed listings:
 *   [ { name, key, status:'found' }, ... ]
 * Empty array when dormant, uncalibrated, or nothing confirmed — which keeps
 * lib/scan.js honest (it surfaces exactly what we return, nothing invented).
 */
async function scanExposure(digits) {
  if (!isEnabled()) return [];
  const d = String(digits || '').replace(/\D/g, '').slice(-10);
  if (d.length !== 10) return [];

  const ck = cacheKey(d);
  if (ck && _cache.has(ck)) {
    const hit = _cache.get(ck);
    if (Date.now() - hit.at < CACHE_TTL_MS) return hit.findings;
    _cache.delete(ck);
  }

  const brokers = calibratedParsers();
  const statuses = await mapLimited(brokers, MAX_CONCURRENCY, (b) => checkBroker(b, d));

  const findings = [];
  for (let k = 0; k < brokers.length; k++) {
    if (statuses[k] === 'found') {
      findings.push({ name: brokers[k].label, key: brokers[k].key, status: 'found' });
    }
  }

  if (ck) _cache.set(ck, { at: Date.now(), findings });
  return findings;
}

/**
 * Checker map for lib/checkers.js verification sweep. Only calibrated brokers
 * are included, so an uncalibrated guess can never mark a job "confirmed
 * removed". Returns {} when dormant.
 */
function buildCheckers() {
  const map = {};
  if (!fetcher.isLive()) return map;
  for (const b of calibratedParsers()) {
    map[b.key] = (digits) => checkBroker(b, digits);
  }
  return map;
}

function _clearCache() { _cache.clear(); } // test hook

module.exports = { isEnabled, scanExposure, buildCheckers, checkBroker, _clearCache };
