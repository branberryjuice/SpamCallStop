'use strict';

/**
 * Order reconciliation — the last line of defense for "a paid customer must never
 * be lost." Periodically lists recent paid Stripe Checkout Sessions and provisions
 * any that don't have a customer yet. This catches purchases the webhook missed
 * AND buyers who paid but never returned to the dashboard — entirely server-side,
 * no user action. Idempotent (provisionFromSession dedupes by subscription).
 *
 * Together with the webhook (instant) and the /api/account/session backstop
 * (on dashboard load), this is triple coverage: a checkout that completes always
 * ends up with an account within ~10 minutes at the very worst.
 */

const { provisionFromSession } = require('./provision');

async function reconcileRecentSessions(stripe, windowMinutes) {
  if (!stripe) return { scanned: 0, provisioned: 0, skipped: 'no_stripe' };
  windowMinutes = windowMinutes || 180;
  const gte = Math.floor(Date.now() / 1000) - windowMinutes * 60;
  let scanned = 0, provisioned = 0, startingAfter;

  for (let page = 0; page < 5; page++) { // cap pages so a run stays cheap
    const params = { limit: 100, created: { gte: gte } };
    if (startingAfter) params.starting_after = startingAfter;
    const res = await stripe.checkout.sessions.list(params);
    const data = (res && res.data) || [];
    for (const s of data) {
      scanned++;
      const paid = s.payment_status === 'paid' || s.payment_status === 'no_payment_required' || s.status === 'complete';
      if (!paid) continue;
      try {
        const r = await provisionFromSession(s, { sideEffects: true, sendWelcome: true });
        if (r.created) { provisioned++; console.log('[reconcile] provisioned missed purchase', s.id, '-> customer', r.customer && r.customer.id); }
      } catch (e) { console.error('[reconcile] provision error for', s.id, e && e.message); }
    }
    if (!res.has_more || !data.length) break;
    startingAfter = data[data.length - 1].id;
  }
  return { scanned, provisioned };
}

module.exports = { reconcileRecentSessions };
