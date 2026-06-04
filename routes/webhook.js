'use strict';

/**
 * POST /api/webhook — Stripe payment webhook.
 *
 * Stripe needs the RAW request body to verify the signature, so this route uses
 * express.raw (never json). Point a Stripe webhook endpoint at /api/webhook and
 * put its signing secret in STRIPE_WEBHOOK_SECRET.
 *
 * On `checkout.session.completed` we record the new customer, then (live mode
 * only) kick off the removal engine and send the welcome/dashboard email.
 *
 * Two safeguards:
 *  - Idempotency: Stripe delivers events at-least-once and retries on non-2xx.
 *    We record each event id atomically and no-op on duplicates, so a retry can
 *    never create a second customer or send a second welcome email.
 *  - Test-mode gate: outbound side effects (broker opt-out emails + welcome
 *    email) only fire for live-mode purchases, so test checkouts during setup
 *    don't email real brokers/customers. Set PROCESS_TEST_EVENTS=1 to opt in.
 */

const express = require('express');
const router = express.Router();
const stripe = require('../lib/stripe');
const { saveCustomer, markEventProcessed, unmarkEventProcessed, maskEmail, recordFunnelEvent } = require('../lib/customers');

router.post('/webhook', express.raw({ type: 'application/json' }), async (req, res) => {
  if (!stripe) return res.status(503).send('payments not configured');

  const sig = req.headers['stripe-signature'];
  const secret = process.env.STRIPE_WEBHOOK_SECRET;
  let event;
  try {
    event = stripe.webhooks.constructEvent(req.body, sig, secret);
  } catch (err) {
    console.error('webhook signature verification failed:', err.message);
    return res.status(400).send('invalid signature');
  }

  if (event.type === 'checkout.session.completed') {
    // Idempotency: record the event id atomically. A retried delivery returns
    // false and we stop here, so the rest only ever runs once per real event.
    let fresh = true;
    try { fresh = await markEventProcessed(event.id); }
    catch (de) { console.error('[webhook] dedupe store error (failing open):', de && de.message); }
    if (!fresh) {
      console.log('[webhook] duplicate event ignored:', event.id);
      return res.json({ received: true, duplicate: true });
    }

    const s = event.data.object;
    const m = s.metadata || {};
    const phones = [m.phone, m.phone2].map((x) => String(x || '').trim()).filter(Boolean);
    const cd = s.customer_details || {}; // Stripe-collected name/email (we no longer collect them ourselves)

    // Only fire outbound effects for real purchases. Test-mode checkouts must
    // not email real brokers or customers. PROCESS_TEST_EVENTS=1 opts in.
    const allowSideEffects = event.livemode === true || process.env.PROCESS_TEST_EVENTS === '1';

    try {
      const saved = await saveCustomer({
        email: s.customer_email || cd.email || m.email || '',
        name: m.name || cd.name || '',
        phone: phones[0] || m.phone || '',
        phones: phones,
        plan: m.plan || '',
        billing: m.billing || '',
        bump: m.bump === '1',
        stripeCustomer: s.customer || '',
        subscription: s.subscription || '',
      });

      // Authoritative purchase for funnel analytics — tied to the visitor's
      // journey via metadata.visitor_id. Best-effort; never fails the webhook.
      try {
        await recordFunnelEvent({
          visitorId: m.visitor_id || '',
          event: 'purchased',
          email: s.customer_email || cd.email || m.email || '',
          plan: m.plan || '',
          amount: s.amount_total || 0,
          meta: { livemode: event.livemode === true },
        });
      } catch (fe) { console.error('[analytics] purchase record failed:', fe && fe.message); }

      if (allowSideEffects) {
        // Kick off the autonomous opt-out engine for this customer's number(s).
        // Best-effort: a failure here must NOT 500 the webhook (Stripe would
        // retry and we'd double-process), so we log and move on.
        try {
          const q = await require('../lib/removal').enqueueForCustomer(saved.id);
          console.log('[removal] enqueued for customer', saved.id, JSON.stringify(q));
        } catch (re) {
          console.error('[removal] enqueue failed:', re && re.message);
        }
        // Welcome the customer + send their dashboard magic link. Best-effort.
        try {
          if (saved.email) {
            const base = process.env.PUBLIC_BASE_URL || 'https://spamcallstop.com';
            const link = base + '/account.html?token=' + encodeURIComponent(require('../lib/token').signCustomer(saved.id));
            const msg = require('../lib/emails').welcomeEmail(saved, link);
            await require('../lib/resend').send({ to: saved.email, from: process.env.EMAIL_FROM, replyTo: 'company@spamcallstop.com', subject: msg.subject, text: msg.text, html: msg.html });
            console.log('[welcome] sent to', maskEmail(saved.email));
          }
        } catch (we) {
          console.error('[welcome] send failed:', we && we.message);
        }
      } else {
        console.log('[webhook] test-mode checkout saved (id ' + saved.id + '); skipped removal + welcome. Set PROCESS_TEST_EVENTS=1 to enable.');
      }
    } catch (e) {
      console.error('failed to process checkout:', e.message);
      try { await unmarkEventProcessed(event.id); } catch (_) {} // un-record so Stripe's retry re-processes
      return res.status(500).send('database error'); // 500 -> Stripe retries
    }
  }

  return res.json({ received: true });
});

module.exports = router;
