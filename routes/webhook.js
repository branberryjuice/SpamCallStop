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

router.post('/webhook', express.raw({ type: 'application/json' }), (req, res) => {
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
    saveCustomer({
      email: s.customer_email || m.email || '',
      name: m.name || '',
      phone: m.phone || '',
      plan: m.plan || '',
      billing: m.billing || '',
      bump: m.bump === '1',
      stripeCustomer: s.customer || '',
      subscription: s.subscription || '',
    });
  }

  return res.json({ received: true });
});

module.exports = router;
