'use strict';

/**
 * POST /api/webhook — Stripe payment webhook.
 *
 * Stripe needs the RAW request body to verify the signature, so this route uses
 * express.raw (never json). Point a Stripe webhook endpoint at /api/webhook and
 * put its signing secret in STRIPE_WEBHOOK_SECRET.
 *
 * On `checkout.session.completed` we record the new customer. (Persistence is
 * the in-memory store for now; it moves to Postgres in the database step.)
 */

const express = require('express');
const router = express.Router();
const stripe = require('../lib/stripe');
const { saveCustomer } = require('../lib/customers');

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
    const s = event.data.object;
    const m = s.metadata || {};
    const phones = [m.phone, m.phone2].map((x) => String(x || '').trim()).filter(Boolean);
    try {
      const saved = await saveCustomer({
        email: s.customer_email || m.email || '',
        name: m.name || '',
        phone: phones[0] || m.phone || '',
        phones: phones,
        plan: m.plan || '',
        billing: m.billing || '',
        bump: m.bump === '1',
        stripeCustomer: s.customer || '',
        subscription: s.subscription || '',
      });
      // Kick off the autonomous opt-out engine for this customer's number(s).
      // Best-effort: a failure here must NOT 500 the webhook (Stripe would retry
      // and we'd double-process), so we log and move on.
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
          await require('../lib/resend').send({ to: saved.email, from: process.env.EMAIL_FROM, subject: msg.subject, text: msg.text, html: msg.html });
          console.log('[welcome] sent to', saved.email);
        }
      } catch (we) {
        console.error('[welcome] send failed:', we && we.message);
      }
    } catch (e) {
      console.error('failed to save customer:', e.message);
      return res.status(500).send('database error'); // 500 -> Stripe retries
    }
  }

  return res.json({ received: true });
});

module.exports = router;
