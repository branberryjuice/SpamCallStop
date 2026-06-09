'use strict';

/**
 * EnformionGO "Caller ID Plus" connector: phone -> full people-search profile.
 *
 * Returns name, partial DOB, age, gender, ethnicity, language, a children flag,
 * an on-record address, email, and relatives. This is people-search / public-record
 * data (NOT FCRA, no SSN). It is only ever surfaced to the OTP-verified owner of
 * the number (gated upstream in routes/lookup.js).
 *
 * Auth: EnformionGO uses two header credentials, set in Render:
 *     ENFORMION_AP_NAME, ENFORMION_AP_PASSWORD
 * Endpoint + search-type are env-overridable so they can be corrected from Render
 * without a code change (defaults are our best guess; confirm against the dashboard):
 *     ENFORMION_BASE_URL     (default https://devapi.enformion.com)
 *     ENFORMION_CALLERID_PATH(default /Phone/EnrichPlus  -- confirmed from API docs)
 *     ENFORMION_SEARCH_TYPE  (default DevAPICallerIdPlus -- best guess, overridable)
 *
 * lookup() never throws; it returns { ok:false, error } on any problem so the
 * results page degrades gracefully. parseCallerIdPlus is a pure, unit-testable
 * function (we test it against a real sample before shipping).
 */

const TIMEOUT_MS = parseInt(process.env.ENFORMION_TIMEOUT_MS || '8000', 10);

async function fetchWithTimeout(url, opts) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    return await fetch(url, Object.assign({}, opts, { signal: ctrl.signal }));
  } finally {
    clearTimeout(timer);
  }
}

function midInitial(m) {
  m = String(m == null ? '' : m).trim();
  return m ? m.charAt(0).toUpperCase() + '.' : '';
}

function fullName(nm) {
  nm = nm || {};
  return [nm.firstName, midInitial(nm.middleName), nm.lastName]
    .filter(Boolean).join(' ').replace(/\s+/g, ' ').trim();
}

/**
 * Pure: Caller ID Plus JSON -> our normalized profile shape.
 * Tolerates the response being wrapped in { person: {...} } or returned bare.
 * Deceased relatives are dropped so we never show one in the reveal.
 */
function parseCallerIdPlus(raw) {
  const j = raw && raw.person ? raw.person : raw;
  if (!j || typeof j !== 'object') return { ok: false, error: 'no_data' };

  const a = j.address || (Array.isArray(j.addresses) ? j.addresses[0] : null) || {};
  const address = {
    line: [a.street, a.unit].filter(Boolean).join(' ').trim(),
    city: a.city || '',
    state: String(a.state || '').toUpperCase(),
    postal: a.zip || '',
  };
  const hasAddress = !!(address.line || address.city || address.state || address.postal);

  const cps = j.consumerProfileSummary || {};
  const noc = String(cps.numberOfChildren || '').trim();
  const children = noc ? (/^(0|no\b|none)/i.test(noc) ? 'No' : 'Yes') : '';

  const relatives = (Array.isArray(j.relatives) ? j.relatives : [])
    .filter(function (r) { return r && r.name && String(r.age || '').toLowerCase() !== 'deceased'; })
    .map(function (r) { return { name: fullName(r.name), age: String(r.age || '') }; })
    .filter(function (r) { return r.name; });

  let email = j.email || '';
  if (!email && Array.isArray(j.emails) && j.emails[0]) email = j.emails[0].email || '';

  return {
    ok: true,
    name: fullName(j.name),
    first: (j.name && j.name.firstName) || '',
    last: (j.name && j.name.lastName) || '',
    age: String(j.age || ''),
    dob: j.partialDob || '',
    gender: cps.gender || '',
    ethnicity: cps.ethnicGroup || cps.ethnicity || '',
    language: cps.language || '',
    children: children,
    address: address,
    hasAddress: hasAddress,
    email: email,
    relatives: relatives,
    source: 'enformion-callerid-plus',
  };
}

async function lookup(digitsInput) {
  const apName = process.env.ENFORMION_AP_NAME;
  const apPass = process.env.ENFORMION_AP_PASSWORD;
  if (!apName || !apPass) return { ok: false, error: 'enformion_not_configured' };

  const digits = String(digitsInput || '').replace(/\D/g, '').slice(-10);
  if (digits.length !== 10) return { ok: false, error: 'invalid_phone' };

  const base = (process.env.ENFORMION_BASE_URL || 'https://devapi.enformion.com').replace(/\/+$/, '');
  // Confirmed from EnformionGO API docs: Caller ID Plus = POST /Phone/EnrichPlus.
  // The galaxy-search-type value is the one remaining unknown; overridable via env.
  const path = process.env.ENFORMION_CALLERID_PATH || '/Phone/EnrichPlus';
  const searchType = process.env.ENFORMION_SEARCH_TYPE || 'DevAPICallerIdPlus';

  try {
    const resp = await fetchWithTimeout(base + path, {
      method: 'POST',
      headers: {
        'galaxy-ap-name': apName,
        'galaxy-ap-password': apPass,
        'galaxy-search-type': searchType,
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: JSON.stringify({ phone: digits }),
    });
    if (!resp.ok) {
      console.error('[enformion] http', resp.status);
      return { ok: false, error: 'enformion_http_' + resp.status };
    }
    const json = await resp.json().catch(function () { return null; });
    if (!json) return { ok: false, error: 'enformion_bad_json' };
    const out = parseCallerIdPlus(json);
    out.phone = '+1' + digits;
    return out;
  } catch (err) {
    console.error('[enformion] error:', err && err.message ? err.message : err);
    return { ok: false, error: 'enformion_failed' };
  }
}

module.exports = { lookup, parseCallerIdPlus };
