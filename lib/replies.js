'use strict';

/**
 * Classify broker replies to our opt-out emails and pull the job reference.
 *
 * Each opt-out email carries a "[Ref: SCS-<jobId>]" tag in the subject, so a
 * reply ("Re: ... [Ref: SCS-42]") maps back to the exact removal job. The body
 * is classified with keyword rules — heuristic v1, refined as we see real
 * replies. Order matters: "no record found, nothing to remove" should read as
 * no_record, not removed.
 */

function extractRef(s) {
  const m = String(s == null ? '' : s).match(/SCS-(\d+)/i);
  return m ? parseInt(m[1], 10) : null;
}

function classify(text) {
  const t = String(text == null ? '' : text).toLowerCase();
  if (/no record|not found|unable to (locate|find)|no match|do not have|couldn'?t find|no results|nothing to remove|not in our/.test(t)) return 'no_record';
  if (/removed|deleted|suppress|opted out|opt[- ]out (is )?complete|has been (removed|deleted)|no longer (appear|listed)|honored|de-?listed/.test(t)) return 'removed';
  if (/verify|confirm|complete the (form|request)|fill out|click the link|additional information|driver'?s license|identity|reply with|please provide|in order to process|need(s)? more/.test(t)) return 'needs_followup';
  if (/cannot|will not|\bdeny\b|denied|unable to process|not eligible|do not (accept|process)|third part|reject/.test(t)) return 'rejected';
  return 'other';
}

const STATUS_FROM = {
  removed: 'removed',
  no_record: 'no_record',
  needs_followup: 'needs_followup',
  rejected: 'needs_followup', // surface for a human decision; don't auto-suppress
  other: null,               // no status change; just logged for the digest
};

function statusFor(classification) { return STATUS_FROM[classification] || null; }

module.exports = { extractRef, classify, statusFor };
