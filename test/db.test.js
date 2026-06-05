'use strict';

// Critical paths against a throwaway SQLite db: PII storage, phone-hash login,
// webhook idempotency, in-app alerts, removal stats + threat math, and cadence.
process.env.APP_SECRET = 'test-suite-secret';
delete process.env.DATABASE_URL;     // force the SQLite dev driver
delete process.env.RESEND_API_KEY;   // force dry-run sends (no real email)
process.env.SQLITE_PATH = '/tmp/scs_dbtest_' + process.pid + '.db';
try { require('fs').unlinkSync(process.env.SQLITE_PATH); } catch (e) {}

const test = require('node:test');
const assert = require('node:assert');
const db = require('../lib/customers');
const removal = require('../lib/removal');
const { phoneHash } = require('../lib/crypto');

test('database critical paths', async (t) => {
  await db.init();

  await t.test('saveCustomer stores name/phone and reads them back decrypted', async () => {
    const c = await db.saveCustomer({ email: 'a@b.com', name: 'Pat Doe', phone: '4243860093', plan: 'Individual', status: 'active' });
    const got = await db.getCustomerByEmail('a@b.com');
    assert.strictEqual(got.id, c.id);
    assert.strictEqual(got.name, 'Pat Doe');
    assert.strictEqual(got.phone, '4243860093');
  });

  await t.test('phone-hash login finds an active member, not an unknown number', async () => {
    const found = await db.getCustomerByPhoneHash(phoneHash('4243860093'));
    assert.ok(found && found.email === 'a@b.com');
    assert.ok(!(await db.getCustomerByPhoneHash(phoneHash('9998887777'))));
  });

  await t.test('phone-hash login excludes canceling members', async () => {
    await db.saveCustomer({ email: 'c@d.com', name: 'Cee Cee', phone: '2125559999', plan: 'Individual', status: 'canceling' });
    assert.ok(!(await db.getCustomerByPhoneHash(phoneHash('2125559999'))));
  });

  await t.test('webhook idempotency: an event id records once, dup returns false', async () => {
    assert.strictEqual(await db.markEventProcessed('evt_dedupe_1'), true);
    assert.strictEqual(await db.markEventProcessed('evt_dedupe_1'), false);
  });

  await t.test('alerts: insert, list, unread count, mark read', async () => {
    const c = await db.getCustomerByEmail('a@b.com');
    await db.insertAlert({ customerId: c.id, kind: 'info', title: 'Hi', body: 'there' });
    assert.strictEqual(await db.countUnreadAlerts(c.id), 1);
    const list = await db.listAlertsForCustomer(c.id, 10);
    assert.strictEqual(list[0].title, 'Hi');
    assert.strictEqual(list[0].read, false);
    await db.markAlertsRead(c.id);
    assert.strictEqual(await db.countUnreadAlerts(c.id), 0);
  });

  await t.test('removal stats + threat bar: 100 -> 55 (sent) -> 0 (confirmed)', async () => {
    const c = await db.getCustomerByEmail('a@b.com');
    assert.strictEqual((await db.getRemovalStats(c.id)).threatPct, 100); // no jobs yet
    await removal.enqueueForCustomer(c.id);
    await removal.processDue(50);                                        // dry-run sends
    let s = await db.getRemovalStats(c.id);
    assert.ok(s.requestsSent > 0);
    assert.strictEqual(s.confirmedRemoved, 0);
    assert.strictEqual(s.threatPct, 55);                                // all in flight
    const jobs = (await db.listRemovalJobs()).filter((j) => j.customer_id === c.id);
    for (const j of jobs) await db.updateRemovalJob(j.id, { status: 'removed' });
    s = await db.getRemovalStats(c.id);
    assert.strictEqual(s.confirmedRemoved, jobs.length);
    assert.strictEqual(s.threatPct, 0);                                 // all confirmed
  });

  await t.test('removal cadence: pending due, in-cooldown not, elapsed due, suppressed terminal', () => {
    const now = new Date();
    const future = new Date(Date.now() + 5 * 86400000).toISOString();
    const past = new Date(Date.now() - 1000).toISOString();
    assert.strictEqual(removal.jobIsDue({ status: 'pending' }, now), true);
    assert.strictEqual(removal.jobIsDue({ status: 'sent', next_eligible_at: future }, now), false);
    assert.strictEqual(removal.jobIsDue({ status: 'sent', next_eligible_at: past }, now), true);
    assert.strictEqual(removal.jobIsDue({ status: 'removed' }, now), false);
    assert.strictEqual(removal.jobIsDue({ status: 'no_record' }, now), false);
  });
});
