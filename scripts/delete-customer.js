'use strict';

/**
 * Delete a customer (and ALL their data) by phone number.
 *
 *   node scripts/delete-customer.js 4243860093          # preview — shows matches, deletes nothing
 *   node scripts/delete-customer.js 4243860093 --yes    # actually delete
 *
 * Matches via the encrypted-safe phone hash, then removes the customer plus their
 * protected numbers, removal jobs, alerts, and reply logs. Runs against whatever
 * DATABASE_URL is set (so run it in Render's Shell, where the live creds live).
 * Intended for clearing test data and honoring deletion requests.
 */

const db = require('../lib/customers');

(async () => {
  const phone = String(process.argv[2] || '').replace(/\D/g, '');
  const apply = process.argv.includes('--yes');
  if (phone.length < 10) {
    console.error('Usage: node scripts/delete-customer.js <10-digit-phone> [--yes]');
    process.exit(1);
  }

  await db.init();
  const matches = await db.findCustomersByPhone(phone);

  if (!matches.length) {
    console.log('No customer found for ' + phone + '. Nothing to delete.');
    process.exit(0);
  }

  console.log('Matched ' + matches.length + ' customer record(s) for ' + phone + ':');
  for (const m of matches) {
    console.log('  id=' + m.id + '  email=' + m.email + '  plan=' + m.plan + '  status=' + m.status + '  created=' + m.created_at);
  }

  if (!apply) {
    console.log('\nPreview only — nothing deleted. Re-run with --yes to delete these and all their numbers / jobs / alerts.');
    process.exit(0);
  }

  const n = await db.deleteCustomersByIds(matches.map((m) => m.id));
  console.log('\nDeleted ' + n + ' customer(s) and their related rows. That number is now free to re-test.');
  process.exit(0);
})().catch((e) => { console.error('Error:', e && e.message ? e.message : e); process.exit(1); });
