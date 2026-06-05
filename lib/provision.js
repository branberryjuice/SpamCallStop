'use strict';

/**
 * Provision a customer from a paid Stripe Checkout Session: create the record,
 * kick off broker removals, send the welcome/dashboard email.
 *
 * Idempotent — if a customer already exists for this session's subscription (or
 * email), it's returned without creating a duplicate. This is the single source
 * of truth for "a purchase happened," shared by:
 *   - the Stripe webhook (primary path), and
 *   - the dashboard session-exchange (/api/account/session) as a BACKSTOP,
 * so a missed/misrouted webhook can never strand a paying customer.
 *
 * opts.sideEffects (default true): enqueue removals + send welcome.
 * opts.sendWelcome (default true): send the welcome email (requires sideEffects).
 */

const db = require('./customers');

async function provisionFromSession(session, opts) {
  opts = opts || {};
  const sideEffects = opts.sideEffects !== false;
  const sendWelcome = opts.sendWelcome !== false;

  const s = session || {};
  const m = s.metadata || {};
  const cd = s.customer_details || {};
  const email = String(s.customer_email || cd.email || m.email || '').trim().toLowerCase();
  const subscription = s.subscription || '';

  // Dedupe: already provisioned for this purchase?
  let existing = null;
  if (subscription) { try { existing = await db.getCustomerBySubscription(subscription); } catch (e) {} }
  if (!existing && email) { try { existing = await db.getCustomerByEmail(email); } catch (e) {} }
  if (existing) return { customer: existing, created: false };

  const phones = [m.phone, m.phone2].map((x) => String(x || '').trim()).filter(Boolean);
  const saved = await db.saveCustomer({
    email: email,
    name: m.name || cd.name || '',
    phone: phones[0] || m.phone || '',
    phones: phones,
    plan: m.plan || '',
    billing: m.billing || '',
    bump: m.bump === '1',
    stripeCustomer: s.customer || '',
    subscription: subscription,
  });

  // Authoritative purchase event for funnel analytics (best-effort).
  try {
    await db.recordFunnelEvent({
      visitorId: m.visitor_id || '', event: 'purchased', email: email,
      plan: m.plan || '', amount: s.amount_total || 0, meta: { source: 'provision' },
    });
  } catch (e) { /* best-effort */ }

  if (sideEffects) {
    try {
      const q = await require('./removal').enqueueForCustomer(saved.id);
      console.log('[provision] removals enqueued for', saved.id, JSON.stringify(q));
    } catch (e) { console.error('[provision] enqueue failed:', e && e.message); }

    if (sendWelcome && saved.email) {
      try {
        const base = process.env.PUBLIC_BASE_URL || 'https://spamcallstop.com';
        const link = base + '/account.html?token=' + encodeURIComponent(require('./token').signCustomer(saved.id));
        const msg = require('./emails').welcomeEmail(saved, link);
        await require('./resend').send({ to: saved.email, from: process.env.EMAIL_FROM, replyTo: 'company@spamcallstop.com', subject: msg.subject, text: msg.text, html: msg.html });
        console.log('[provision] welcome sent to', db.maskEmail(saved.email));
      } catch (e) { console.error('[provision] welcome failed:', e && e.message); }
    }
  }

  return { customer: saved, created: true };
}

module.exports = { provisionFromSession };
