'use strict';

/**
 * POST /api/inbound — broker reply ingestion.
 *
 * An inbound-email provider (Resend inbound, a reply-subdomain parser, etc.)
 * POSTs broker replies here. We match the reply to a removal job via the
 * "[Ref: SCS-<id>]" tag in the subject, classify the body (removed / no_record
 * / needs_followup / rejected / other), update the job (which drives
 * suppression), and store the reply for the daily digest.
 *
 * Gated by INBOUND_SECRET (query ?key= or header x-inbound-secret). Disabled
 * (503) until that secret is set, so it can't be abused before it's configured.
 */

const express = require('express');
const router = express.Router();
const db = require('../lib/customers');
const { extractRef, classify, statusFor } = require('../lib/replies');
const resend = require('../lib/resend');

function authed(req) {
  const secret = process.env.INBOUND_SECRET;
  if (!secret) return null; // not configured
  const given = req.query.key || req.headers['x-inbound-secret'] || '';
  return !!given && String(given) === String(secret);
}

function addr(v) {
  if (!v) return '';
  if (typeof v === 'string') return v;
  return v.address || v.email || '';
}

// Normalize the common inbound-provider payload shapes into {from,to,subject,text}.
function normalize(raw) {
  const b = raw && raw.data ? raw.data : raw || {};
  const from = addr(b.from || b.sender || b.From) || (b.envelope && addr(b.envelope.from)) || '';
  const to = addr(b.to || b.recipient || b.To) || '';
  const subject = b.subject || b.Subject || '';
  const text = b.text || b['body-plain'] || b.stripped_text || b.TextBody || b.plain || b.body || '';
  return { from: String(from), to: String(to), subject: String(subject), text: String(text) };
}

router.post('/inbound', express.json({ limit: '2mb' }), async (req, res) => {
  const ok = authed(req);
  if (ok === null) return res.status(503).json({ ok: false, error: 'inbound_not_configured' });
  if (!ok) return res.status(401).json({ ok: false, error: 'unauthorized' });

  const msg = normalize(req.body);

  // Resend's inbound webhook delivers metadata only — fetch the body to classify.
  if (!msg.text && req.body && req.body.type === 'email.received' && req.body.data && req.body.data.email_id) {
    const full = await resend.getReceived(req.body.data.email_id);
    if (full) {
      if (full.text) msg.text = full.text;
      if (!msg.subject && full.subject) msg.subject = full.subject;
      if (!msg.from && full.from) msg.from = full.from;
    }
  }

  const classification = classify(msg.text + ' ' + msg.subject);
  const ref = extractRef(msg.subject) || extractRef(msg.text);

  let job = null;
  if (ref) { try { job = await db.getRemovalJobById(ref); } catch (e) { /* ignore */ } }

  try {
    if (job) {
      const fields = { last_reply_at: new Date().toISOString(), last_reply_kind: classification };
      const newStatus = statusFor(classification);
      if (newStatus) fields.status = newStatus;
      await db.updateRemovalJob(job.id, fields);
    }
    await db.insertReply({
      jobId: job ? job.id : null,
      customerId: job ? job.customer_id : null,
      brokerKey: job ? job.broker_key : null,
      fromAddr: msg.from.slice(0, 200),
      subject: msg.subject.slice(0, 300),
      snippet: msg.text.slice(0, 500),
      classification,
    });
  } catch (e) {
    console.error('[inbound] error:', e && e.message);
    return res.status(500).json({ ok: false, error: 'store_failed' });
  }
  return res.json({ ok: true, matched: !!job, classification });
});

module.exports = router;
