'use strict';

/**
 * Per-broker presence checkers — the Phase 2 plug point for real site scanning.
 *
 * checkNumber(brokerKey, digits) resolves to one of:
 *   'found'   - the number is currently listed on that broker's site
 *   'clear'   - confirmed NOT listed
 *   'unknown' - could not determine
 *
 * HONESTY RULE (matches scan.js): until a real checker is wired up — these sites
 * block servers, so each needs residential proxies + a per-site parser — every
 * broker returns 'unknown'. Nothing is ever marked confirmed-removed on a guess.
 * To light a broker up, add an async checker to CHECKERS[brokerKey] that returns
 * 'found' / 'clear' and the verification sweep below will start confirming removals.
 */

const db = require('./customers');

// brokerKey -> async (digits) => 'found' | 'clear' | 'unknown'
// Intentionally empty until real, proxy-backed checkers exist (Phase 2).
const CHECKERS = {
  // Example shape for when proxies are ready:
  // radaris: async (digits) => {
  //   const html = await fetchViaProxy('https://radaris.com/...'+digits);
  //   return /no results|not found/i.test(html) ? 'clear' : /\b\d{3}[) -]*\d{3}[ -]*\d{4}\b/.test(html) ? 'found' : 'unknown';
  // },
};

async function checkNumber(brokerKey, digits) {
  const fn = CHECKERS[brokerKey];
  if (!fn) return 'unknown';
  const d = String(digits || '').replace(/\D/g, '').slice(-10);
  if (d.length !== 10) return 'unknown';
  try {
    const r = await fn(d);
    return (r === 'found' || r === 'clear') ? r : 'unknown';
  } catch (e) {
    console.error('[checker] ' + brokerKey + ' error:', e && e.message);
    return 'unknown';
  }
}

function anyCheckersLive() { return Object.keys(CHECKERS).length > 0; }

/**
 * Verify recent sends: 24h+ after a removal email, re-check the broker site. If
 * the number is gone, mark the job confirmed-removed and alert the customer; if
 * it's still listed past the 30-day grace, the removal engine's cadence already
 * fires the weekly follow-up. No-op while no real checker is live.
 */
async function runVerificationSweep(limit) {
  if (!anyCheckersLive()) return { checked: 0, confirmed: 0, skipped: 'no_live_checkers' };
  limit = limit || 50;
  const now = Date.now();
  const jobs = await db.listRemovalJobs();
  let checked = 0, confirmed = 0, stillListed = 0;
  for (const j of jobs) {
    if (checked >= limit) break;
    if (j.status === 'removed' || j.status === 'no_record') continue;          // already terminal
    if (!j.sent_at) continue;                                                  // never sent yet
    if (now - new Date(j.sent_at).getTime() < 24 * 3600000) continue;          // give it 24h first
    checked++;
    const r = await checkNumber(j.broker_key, j.phone); // j.phone is decrypted by listRemovalJobs
    if (r === 'clear') {
      await db.updateRemovalJob(j.id, {
        status: 'removed', last_reply_kind: 'verified_clear', last_reply_at: new Date().toISOString(),
      });
      confirmed++;
      try {
        await db.insertAlert({
          customerId: j.customer_id, kind: 'removed', title: 'Confirmed removed',
          body: 'Our check confirmed your number is no longer listed on a data broker.',
          brokerKey: j.broker_key,
        });
      } catch (e) { /* best-effort */ }
    } else if (r === 'found') {
      stillListed++; // the engine's 7-day follow-up cadence handles re-contacting
    }
  }
  return { checked, confirmed, stillListed };
}

module.exports = { checkNumber, runVerificationSweep, anyCheckersLive, CHECKERS };
