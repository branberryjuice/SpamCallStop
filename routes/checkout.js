'use strict';

/**
 * POST /api/checkout — create a Stripe Checkout Session (subscription).
 *
 * Body: { name, email, phone, plan: 'Solo'|'Dual', billing: 'm'|'y', bump: bool }
 * Returns: { ok:true, url } to redirect the browser to Stripe's hosted page,
 *          or { ok:false, error } on problems.
 *
 * We never collect card data ourselves — Stripe's hosted checkout does that.
 */

const express = require('express');
const router = express.Router();
const stripe = require('../lib/stripe');
const { buildLineItems } = require('../lib/pricing');

router.post('/checkout', express.json(), async (req, res) => {
  if (!stripe) {
    return res.status(503).json({ ok: false, error: 'payments_not_configured' });
  }
  try {
    const b = req.body || {};
    const name = String(b.name || '').trim().slice(0, 120);
    const email = String(b.email || '').trim().slice(0, 200);
    const phone = String(b.phone || '').trim().slice(0, 40);
    const plan = b.plan === 'Dual' ? 'Dual' : 'Solo';
    const billing = b.billing === 'y' ? 'y' : 'm';
    const bump = b.bump === true || b.bump === '1' || b.bump === 1;

    const base = process.env.PUBLIC_BASE_URL || (req.protocol + '://' + req.get('host'));

    const session = await stripe.checkout.sessions.create({
      mode: 'subscription',
      line_items: buildLineItems({ plan, billing, bump }),
      customer_email: email || undefined,
      allow_promotion_codes: true,
      metadata: { name, phone, plan, billing, bump: bump ? '1' : '0' },
      subscription_data: { metadata: { name, phone, plan, billing } },
      success_url: base + '/thank-you.html?session_id={CHECKOUT_SESSION_ID}',
      cancel_url: base + '/checkout.html',
    });

    return res.json({ ok: true, url: session.url });
  } catch (err) {
    console.error('checkout error:', err && err.message ? err.message : err);
    return res.status(500).json({ ok: false, error: 'checkout_failed' });
  }
});

module.exports = router;
