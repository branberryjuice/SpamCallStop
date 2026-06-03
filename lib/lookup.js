'use strict';

/**
 * Phone -> identity (name + address) via Twilio Lookup v2.
 *
 * We use two Lookup data packages (no extra vendor — same Twilio account that
 * runs Verify):
 *
 *   caller_name : the name on the line (CNAM). US numbers, self-service.
 *                 Coverage is partial, especially on mobiles.
 *   pre_fill    : first/last name + address line, city, state, postal code
 *                 associated with the phone. Ties to a Verify verificationSid
 *                 (the OTP step we already run) for consent. NOTE: pre_fill is
 *                 not a self-serve package — Twilio must enable it on the
 *                 account, otherwise it comes back null and we fall back to the
 *                 caller_name only.
 *
 * No date of birth — product decision (revisit later if it lifts conversion).
 *
 * lookupIdentity never throws; it returns { ok:false, error } on any problem so
 * the results page can degrade gracefully instead of erroring.
 */

const twilio = require('./twilio');
const trestle = require('./trestle');

function titleCase(s) {
  s = String(s == null ? '' : s).trim();
  if (!s) return '';
  return s.toLowerCase().replace(/\b[a-z]/g, (c) => c.toUpperCase());
}

function pick(obj, keys) {
  if (!obj) return '';
  for (const k of keys) {
    if (obj[k]) return obj[k];
  }
  return '';
}

/**
 * Pure: turn a Twilio Lookup v2 response into our normalized identity shape.
 * Handles both camelCase and snake_case nested keys (the SDK leaves the data
 * packages close to the raw API JSON).
 */
function parseLookup(r) {
  r = r || {};
  const pf = r.preFill || r.pre_fill || null;
  const cn = r.callerName || r.caller_name || null;

  const first = pick(pf, ['firstName', 'first_name']);
  const last = pick(pf, ['lastName', 'last_name']);
  const cnName = pick(cn, ['callerName', 'caller_name']);
  const name = first || last ? (first + ' ' + last).trim() : cnName;

  const line = pick(pf, ['addressLine1', 'address_line1', 'addressLine', 'address_line']);
  const city = pick(pf, ['city']);
  const state = pick(pf, ['state']);
  const postal = pick(pf, ['postalCode', 'postal_code']);
  const hasAddress = !!(line || city || state || postal);

  return {
    ok: true,
    name: titleCase(name),
    first: titleCase(first),
    last: titleCase(last),
    address: {
      line: titleCase(line),
      city: titleCase(city),
      state: String(state || '').toUpperCase(),
      postal: postal || '',
    },
    age: '',
    hasAddress,
    source: 'twilio',
    sources: { caller_name: !!cn, pre_fill: !!pf },
  };
}

async function lookupIdentity(digitsInput, opts) {
  opts = opts || {};
  const digits = String(digitsInput || '').replace(/\D/g, '').slice(-10);
  if (digits.length !== 10) return { ok: false, error: 'invalid_phone' };
  const e164 = '+1' + digits;

  // 1) Trestle — real-time name + current address + age range (primary source).
  if (process.env.TRESTLE_API_KEY) {
    const t = await trestle.reversePhone(digits);
    if (t && t.ok && (t.name || t.hasAddress)) return t;
    // no hit / error -> fall through to Twilio for at least a name
  }

  // 2) Twilio Caller Name (+ pre_fill if ever enabled) — fallback / name source.
  if (twilio) {
    const params = { fields: 'caller_name,pre_fill' };
    if (opts.verificationSid) params.verificationSid = opts.verificationSid;
    try {
      const r = await twilio.lookups.v2.phoneNumbers(e164).fetch(params);
      const out = parseLookup(r);
      out.phone = e164;
      return out;
    } catch (err) {
      console.error('[lookup] twilio error:', err && err.message ? err.message : err);
    }
  }

  return { ok: false, error: 'lookup_not_configured' };
}

module.exports = { lookupIdentity, parseLookup };
