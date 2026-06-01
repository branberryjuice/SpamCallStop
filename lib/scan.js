'use strict';

/**
 * SpamCallStop — scan engine.
 *
 * HONESTY RULES (do not break these):
 *  - We never invent a per-number exposure count.
 *  - `verifiedFindings` only ever contains listings a real connector actually
 *    confirmed. Until live connectors exist (they need residential proxies and
 *    per-site parsers, and most brokers block automated lookups), it stays [].
 *  - `coverage` is a TRUE number: how many broker sites our service removes from.
 *  - `typicalExposure` is a general statement about people-search sites overall,
 *    explicitly NOT a claim about this specific number.
 *
 * As real connectors come online, they push confirmed results into
 * `verifiedFindings` and the page can show a genuine, per-number count.
 */

const { BROKERS, count } = require('./brokers');
const { normalizePhone, formatPhone } = require('./phone');

// Placeholder for real, per-broker presence checks. Each future checker returns
// { name, status: 'found' | 'clear' | 'unknown' }. We only surface 'found'.
async function runVerifiedChecks(/* digits */) {
  // No reliable in-house checker is live yet, so we return nothing rather than
  // fabricate. This is intentional — see HONESTY RULES above.
  return [];
}

async function scan(rawPhone) {
  const digits = normalizePhone(rawPhone);
  if (!digits) {
    return { ok: false, error: 'invalid_phone' };
  }

  const verifiedFindings = await runVerifiedChecks(digits);

  return {
    ok: true,
    digits,
    phone: formatPhone(digits),
    coverage: count,
    brokers: BROKERS.map((b) => b.name),
    verifiedFindings,
    typicalExposure:
      'Most US phone numbers are listed and sold across dozens of people-search sites.',
    basis:
      'General estimate from public research on people-search sites, not a confirmed lookup of your specific number.',
  };
}

module.exports = { scan, runVerifiedChecks };
