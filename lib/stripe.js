'use strict';

/**
 * Stripe client, initialized from env.
 *
 * Exports the Stripe instance, or `null` when STRIPE_SECRET_KEY isn't set — so
 * the app still boots and the rest of the site works without payments wired up.
 * Use TEST keys (sk_test_...) until launch, then swap to live keys.
 */

const key = process.env.STRIPE_SECRET_KEY;
module.exports = key ? require('stripe')(key) : null;
