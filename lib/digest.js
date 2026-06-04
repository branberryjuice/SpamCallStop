'use strict';

/**
 * Daily digest: a once-a-day summary of removal activity, emailed to ADMIN_EMAIL
 * so Branden can act early on broker replies (especially the ones that need a
 * human decision). Reads the last 24h of replies plus the job pipeline. Dry-run
 * (logged, not sent) until RESEND_API_KEY is set.
 */

const db = require('./customers');
const resend = require('./resend');

const FROM = process.env.EMAIL_FROM || 'removals@spamcallstop.com';

function since24h() { return new Date(Date.now() - 24 * 3600 * 1000).toISOString(); }

async function buildDigest(sinceISO) {
  sinceISO = sinceISO || since24h();
  const jobs = await db.listRemovalJobs();
  const replies = await db.listRepliesSince(sinceISO);

  const sinceMs = new Date(sinceISO).getTime();
  const sentRecently = jobs.filter((j) => j.sent_at && new Date(j.sent_at).getTime() >= sinceMs).length;
  const byStatus = {};
  for (const j of jobs) byStatus[j.status] = (byStatus[j.status] || 0) + 1;
  const byKind = {};
  for (const r of replies) byKind[r.classification] = (byKind[r.classification] || 0) + 1;

  // Replies a human should look at: follow-ups, rejections, and anything we
  // couldn't auto-match to a job.
  const attention = replies.filter((r) => r.classification === 'needs_followup' || r.classification === 'rejected' || !r.job_id);

  const L = [];
  L.push('SpamCallStop removal activity, last 24 hours');
  L.push('');
  L.push('Opt-out emails sent: ' + sentRecently);
  L.push('Replies received: ' + replies.length);
  ['removed', 'no_record', 'needs_followup', 'rejected', 'other'].forEach((k) => {
    if (byKind[k]) L.push('  ' + k.replace(/_/g, ' ') + ': ' + byKind[k]);
  });
  L.push('');
  if (attention.length) {
    L.push('NEEDS YOUR DECISION (' + attention.length + '):');
    attention.slice(0, 30).forEach((r) => {
      L.push('  > [' + r.classification + '] ' + (r.broker_key || 'unmatched') + ': ' + String(r.subject || '').slice(0, 80));
      if (r.snippet) L.push('      "' + String(r.snippet).replace(/\s+/g, ' ').slice(0, 160) + '"');
    });
  } else {
    L.push('Nothing needs your decision today.');
  }
  L.push('');
  L.push('Job pipeline (all time):');
  ['pending', 'sent', 'removed', 'no_record', 'needs_followup', 'failed'].forEach((s) => {
    L.push('  ' + s.replace(/_/g, ' ') + ': ' + (byStatus[s] || 0));
  });

  const text = L.join('\n');
  const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;');
  const html = '<pre style="font-family:ui-monospace,Menlo,monospace;font-size:13px;line-height:1.5;color:#111;white-space:pre-wrap">' + esc(text) + '</pre>';
  const subject = 'SpamCallStop daily digest: ' + sentRecently + ' sent, ' + replies.length + ' replies, ' + attention.length + ' to review';
  return { subject, text, html, stats: { sent: sentRecently, replies: replies.length, attention: attention.length, byStatus, byKind } };
}

async function sendDigest() {
  const to = process.env.ADMIN_EMAIL || process.env.EMAIL_FROM;
  if (!to) return { ok: false, error: 'no_admin_email' };
  const d = await buildDigest();
  const r = await resend.send({ to, from: FROM, subject: d.subject, text: d.text, html: d.html });
  return { ok: r.ok, dryRun: !!r.dryRun, to, stats: d.stats };
}

module.exports = { buildDigest, sendDigest };
