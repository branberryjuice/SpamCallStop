'use strict';

/**
 * Customer store — TEMPORARY in-memory list.
 *
 * This gets replaced by the Postgres layer in the database step. It survives
 * only until the server restarts, which is fine for wiring and testing the
 * payment flow now.
 */

const customers = [];

function saveCustomer(record) {
  const c = Object.assign({ createdAt: new Date().toISOString() }, record);
  customers.push(c);
  console.log('[customer] saved (in-memory):', c.email || '(no email)', '-', c.plan, c.billing);
  return c;
}

function listCustomers() {
  return customers.slice();
}

module.exports = { saveCustomer, listCustomers };
