'use strict';

/**
 * POST /api/checkout — create a Stripe Checkout Session (subscription).
 *
 * Body: { name, email, phone, plan: 'Solo'|'Dual', billing: 'm'|'y', bump: bool, embedded?: bool }
 * Returns: { ok:true, clientSecret } for the in-page embedded checkout (embedded:true),
 *          or { ok:true, url } to redirect to Stripe's hosted page (default/fallback),
 *          or { ok:false, error } on problems.
 *
 * We never collect card data ourselves — Stripe's checkout (hosted or embedded
 * via Stripe.js) does that, so card details never touch our server.
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
    const phone2 = String(b.phone2 || '').trim().slice(0, 40); // Couple plan: 2nd number
    const plan = b.plan === 'Dual' ? 'Dual' : 'Solo';
    const billing = b.billing === 'y' ? 'y' : 'm';
    const bump = b.bump === true || b.bump === '1' || b.bump === 1;
    const visitorId = String(b.visitor_id || '').slice(0, 64); // ties the sale to the funnel journey
    const embedded = b.embedded === true || b.embedded === '1' || b.embedded === 1;

    const base = process.env.PUBLIC_BASE_URL || (req.protocol + '://' + req.get('host'));

    const params = {
      mode: 'subscription',
      line_items: buildLineItems({ plan, billing, bump }),
      customer_email: email || undefined,
      allow_promotion_codes: true,
      metadata: { name, phone, phone2, plan, billing, bump: bump ? '1' : '0', visitor_id: visitorId },
      subscription_data: { metadata: { name, phone, phone2, plan, billing } },
    };

    if (embedded) {
      // In-page checkout: Stripe.js mounts the card form on our own page. Embedded
      // mode uses return_url (no success_url/cancel_url) and hands the browser a
      // client_secret instead of a hosted redirect URL.
      params.ui_mode = 'embedded';
      params.return_url = base + '/thank-you.html?session_id={CHECKOUT_SESSION_ID}';
    } else {
      // Hosted redirect (the original flow) — kept as the automatic fallback.
      params.success_url = base + '/thank-you.html?session_id={CHECKOUT_SESSION_ID}';
      params.cancel_url = base + '/checkout.html';
    }

    const session = await stripe.checkout.sessions.create(params);

    return res.json(embedded
      ? { ok: true, clientSecret: session.client_secret }
      : { ok: true, url: session.url });
  } catch (err) {
    console.error('checkout error:', err && err.message ? err.message : err);
    return res.status(500).json({ ok: false, error: 'checkout_failed' });
  }
});

module.exports = router;
