'use strict';

/**
 * Pricing — the single source of truth for what we charge.
 *
 * Builds Stripe Checkout line items with inline price_data, so checkout works
 * immediately in test mode without having to create Products/Prices in the
 * dashboard first. (Later, for cleaner Stripe reporting, these can be swapped
 * for real Price IDs.) Amounts are in cents.
 */

const PLANS = {
  Solo: {
    m: { amount: 1900,  interval: 'month', label: 'SpamCallStop Solo (monthly)' },
    y: { amount: 19000, interval: 'year',  label: 'SpamCallStop Solo (yearly)' },
  },
  Dual: {
    m: { amount: 2900,  interval: 'month', label: 'SpamCallStop Dual (monthly)' },
    y: { amount: 29000, interval: 'year',  label: 'SpamCallStop Dual (yearly)' },
  },
};

const BUMP = {
  m: { amount: 500,  interval: 'month', label: 'Instant alerts add-on' },
  y: { amount: 5000, interval: 'year',  label: 'Instant alerts add-on' },
};

function lineItem(cfg) {
  return {
    quantity: 1,
    price_data: {
      currency: 'usd',
      unit_amount: cfg.amount,
      recurring: { interval: cfg.interval },
      product_data: { name: cfg.label },
    },
  };
}

function buildLineItems({ plan = 'Solo', billing = 'm', bump = false }) {
  const planCfg = PLANS[plan] || PLANS.Solo;
  const cycle = billing === 'y' ? 'y' : 'm';
  const items = [lineItem(planCfg[cycle])];
  if (bump) items.push(lineItem(BUMP[cycle]));
  return items;
}

module.exports = { PLANS, BUMP, buildLineItems };
