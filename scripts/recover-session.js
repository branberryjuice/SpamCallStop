'use strict';

/**
 * Recover a customer from a paid Stripe Checkout Session when the webhook missed.
 *   node scripts/recover-session.js cs_live_xxxxxxxx
 *
 * Retrieves the session from Stripe (using STRIPE_SECRET_KEY), then provisions the
 * customer + removals + welcome email. Idempotent — safe to run more than once.
 * Run it in Render's Shell, where the live keys + DB are available.
 */

const stripe = require('../lib/stripe');
const { provisionFromSession } = require('../lib/provision');
const db = require('../lib/customers');

(async () => {
  const sid = String(process.argv[2] || '');
  if (!/^cs_[A-Za-z0-9_]+$/.test(sid)) {
    console.error('Usage: node scripts/recover-session.js <checkout_session_id>');
    process.exit(1);
  }
  if (!stripe) { console.error('Stripe not configured (STRIPE_SECRET_KEY missing).'); process.exit(1); }

  await db.init();
  const session = await stripe.checkout.sessions.retrieve(sid);
  const paid = session && (session.payment_status === 'paid' || session.payment_status === 'no_payment_required' || session.status === 'complete');
  if (!paid) { console.log('Session is not paid (payment_status=' + (session && session.payment_status) + '). Aborting.'); process.exit(1); }

  const r = await provisionFromSession(session, { sideEffects: true, sendWelcome: true });
  if (r.created) console.log('CREATED customer id=' + r.customer.id + ' email=' + r.customer.email + ' plan=' + r.customer.plan);
  else console.log('ALREADY EXISTS — customer id=' + r.customer.id + ' email=' + r.customer.email);
  process.exit(0);
})().catch((e) => { console.error('Error:', e && e.message ? e.message : e); process.exit(1); });
