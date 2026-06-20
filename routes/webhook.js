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
const { saveCustomer, markEventProcessed, unmarkEventProcessed, maskEmail, recordFunnelEvent, getCustomerBySubscription } = require('../lib/customers');

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

  // Abandoned-cart recovery: a checkout session expired unpaid. Stripe gives us
  // the email the customer entered + a one-click resume URL. Email it to them.
  if (event.type === 'checkout.session.expired') {
    let fresh = true;
    try { fresh = await markEventProcessed(event.id); }
    catch (de) { console.error('[webhook] dedupe store error (failing open):', de && de.message); }
    if (!fresh) return res.json({ received: true, duplicate: true });

    const s = event.data.object;
    const cd = s.customer_details || {};
    const email = s.customer_email || cd.email || (s.metadata && s.metadata.email) || '';
    const recoveryUrl = s.after_expiration && s.after_expiration.recovery && s.after_expiration.recovery.url;
    // Don't email on test-mode unless explicitly opted in.
    const allowSideEffects = event.livemode === true || process.env.PROCESS_TEST_EVENTS === '1';

    if (allowSideEffects && email && recoveryUrl) {
      try {
        const msg = require('../lib/emails').recoveryEmail(recoveryUrl);
        await require('../lib/resend').send({ to: email, from: process.env.EMAIL_FROM, replyTo: 'company@spamcallstop.com', subject: msg.subject, text: msg.text, html: msg.html });
        console.log('[recovery] abandoned-cart email sent to', maskEmail(email));
      } catch (re) {
        console.error('[recovery] send failed:', re && re.message);
      }
    } else {
      console.log('[recovery] expired session — no email (missing email/recovery URL or test-mode).');
    }
    return res.json({ received: true });
  }

  // Trial-ending reminder: Stripe fires this ~3 days before the first charge.
  // The paywall promises "we'll email you before your first charge," so we make
  // good on it here (and stay compliant with auto-renewal disclosure rules).
  if (event.type === 'customer.subscription.trial_will_end') {
    let fresh = true;
    try { fresh = await markEventProcessed(event.id); }
    catch (de) { console.error('[webhook] dedupe store error (failing open):', de && de.message); }
    if (!fresh) return res.json({ received: true, duplicate: true });

    const sub = event.data.object;
    const allowSideEffects = event.livemode === true || process.env.PROCESS_TEST_EVENTS === '1';

    try {
      const cust = sub.id ? await getCustomerBySubscription(sub.id) : null;
      if (allowSideEffects && cust && cust.email) {
        // Total recurring amount (plan + any add-on) and the billing interval.
        let cents = 0, interval = 'month';
        ((sub.items && sub.items.data) || []).forEach(function (it) {
          if (it.price) { cents += (it.price.unit_amount || 0) * (it.quantity || 1); if (it.price.recurring) interval = it.price.recurring.interval; }
        });
        const priceLabel = cents ? ('$' + (cents / 100).toFixed(2) + '/' + (interval === 'year' ? 'yr' : 'mo')) : '';
        const chargeDate = sub.trial_end ? new Date(sub.trial_end * 1000).toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' }) : '';

        const base = process.env.PUBLIC_BASE_URL || 'https://spamcallstop.com';
        const link = base + '/account.html?token=' + encodeURIComponent(require('../lib/token').signCustomer(cust.id));
        const msg = require('../lib/emails').trialEndingEmail(cust, link, priceLabel, chargeDate);
        await require('../lib/resend').send({ to: cust.email, from: process.env.EMAIL_FROM, replyTo: 'company@spamcallstop.com', subject: msg.subject, text: msg.text, html: msg.html });
        console.log('[trial] reminder sent to', maskEmail(cust.email), 'charge', chargeDate || '(unknown)');
      } else {
        console.log('[trial] trial_will_end — no email (no matching customer/email or test-mode).');
      }
    } catch (te) {
      console.error('[trial] reminder send failed:', te && te.message);
    }
    return res.json({ received: true });
  }

  return res.json({ received: true });
});

module.exports = router;
