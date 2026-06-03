'use strict';

/**
 * Autonomous email opt-out engine.
 *
 * On payment we create one removal job per protected number x per email-broker.
 * processDue() sends the opt-out request via Resend, then won't contact that
 * broker for that number again until the 30-day cooldown passes, and never again
 * once the broker replies "removed" or "no record" (suppression).
 *
 * Anti-spam guarantees:
 *   - one job row per (number, broker) — no duplicates
 *   - at most one successful send per (number, broker) per REMOVAL_COOLDOWN_DAYS
 *   - terminal replies (removed / no_record) suppress all future contact
 *
 * We can't reliably know in advance which brokers list a given person
 * (people-search sites block automated lookups), so we send one polite request
 * to each email-broker and learn from the reply, suppressing those that report
 * no record. Sending is dry-run (logged, not sent) until RESEND_API_KEY is set.
 */

const { listEmailBrokers, getBroker } = require('./email-brokers');
const db = require('./customers');
const resend = require('./resend');
const { formatPhone } = require('./phone');

const COOLDOWN_DAYS = parseInt(process.env.REMOVAL_COOLDOWN_DAYS || '30', 10);
const MAX_ATTEMPTS = 5;
const FROM = process.env.EMAIL_FROM || 'removals@spamcallstop.com';
const REPLY_TO = process.env.REPLY_TO || FROM; // where broker replies should land (a real inbox)

function isoInDays(d) { return new Date(Date.now() + d * 86400000).toISOString(); }

// Create a pending job for every (protected number x email-broker) that doesn't
// already have one. Existing jobs are left alone — resends and suppression are
// decided later by status + cooldown, so this never spams or duplicates.
async function enqueueForCustomer(customerId) {
  const numbers = await db.getNumbersForCustomer(customerId);
  const brokers = listEmailBrokers();
  let created = 0;
  for (const n of numbers) {
    for (const b of brokers) {
      const existing = await db.getRemovalJob(n.id, b.key);
      if (existing) continue;
      await db.insertRemovalJob({
        customerId, numberId: n.id, phone: n.phone,
        brokerKey: b.key, brokerName: b.name, brokerEmail: b.email,
      });
      created++;
    }
  }
  return { created, numbers: numbers.length, brokers: brokers.length };
}

function jobIsDue(j, now) {
  if (j.status === 'removed' || j.status === 'no_record') return false; // suppressed
  if (j.status === 'pending') return true;
  if (j.status === 'failed' && (j.attempts || 0) >= MAX_ATTEMPTS) return false;
  if (j.status === 'sent' || j.status === 'needs_followup' || j.status === 'failed') {
    return !j.next_eligible_at || new Date(j.next_eligible_at) <= now; // cooldown elapsed
  }
  return false;
}

function composeEmail(job, customer) {
  const broker = getBroker(job.broker_key);
  const name = (customer && customer.name) || 'the consumer';
  const phone = formatPhone(job.phone) || job.phone || '';
  const subject = 'Opt-out and deletion request for ' + name + ' [Ref: SCS-' + job.id + ']';
  const lines = [
    'To the privacy team at ' + (job.broker_name || (broker && broker.name) || 'your company') + ',',
    '',
    'I am writing as the authorized agent for the consumer below to request, under the California Consumer Privacy Act and other applicable state privacy laws, that you opt the consumer out of any sale or sharing of, and delete, all personal information you hold for:',
    '',
    'Name: ' + name,
    'Phone: ' + phone,
    '',
    'This request is made with the consumer’s authorization. Please confirm by reply once the information has been suppressed and removed, or tell us what you need to locate the record. If you have no record matching this consumer, please reply to let us know.',
    '',
    'Thank you,',
    'SpamCallStop, on behalf of the consumer',
    FROM,
  ];
  const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;');
  const html = '<div style="font-family:Arial,Helvetica,sans-serif;font-size:14px;line-height:1.6;color:#111">' +
    lines.map((l) => (l === '' ? '<br>' : '<div>' + esc(l) + '</div>')).join('') + '</div>';
  return { subject, text: lines.join('\n'), html };
}

// Send all jobs that are due (pending, or past cooldown and not suppressed).
async function processDue(limit) {
  limit = limit || 20;
  const now = new Date();
  const all = await db.listRemovalJobs();
  const due = all.filter((j) => jobIsDue(j, now)).slice(0, limit);

  const results = { processed: 0, sent: 0, dryRun: 0, failed: 0 };
  for (const job of due) {
    results.processed++;
    const customer = await db.getCustomerById(job.customer_id);
    const msg = composeEmail(job, customer);
    const r = await resend.send({ to: job.broker_email, from: FROM, replyTo: REPLY_TO, subject: msg.subject, text: msg.text, html: msg.html });
    if (r.ok) {
      await db.updateRemovalJob(job.id, {
        status: 'sent', sent_at: new Date().toISOString(),
        next_eligible_at: isoInDays(COOLDOWN_DAYS), attempts: (job.attempts || 0) + 1, last_error: null,
      });
      if (r.dryRun) results.dryRun++; else results.sent++;
    } else {
      await db.updateRemovalJob(job.id, {
        status: 'failed', attempts: (job.attempts || 0) + 1,
        last_error: String(r.error || 'send_failed').slice(0, 300), next_eligible_at: isoInDays(1),
      });
      results.failed++;
    }
  }
  return results;
}

module.exports = { enqueueForCustomer, processDue, composeEmail, jobIsDue, COOLDOWN_DAYS, MAX_ATTEMPTS };
