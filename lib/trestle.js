'use strict';

/**
 * Trestle Reverse Phone API (v3.2) — real-time phone -> owner identity.
 *
 *   GET https://api.trestleiq.com/3.2/phone?phone=2065551234
 *   header: x-api-key: <TRESTLE_API_KEY>
 *
 * Returns the owner's name, current address, and a 5-year age range (NOT an
 * exact date of birth — Trestle does not provide DOB). ~$0.07/query,
 * pay-as-you-go. US coverage. No SSN, no DOB.
 *
 * reversePhone() never throws — returns { ok:false, error } on any problem so
 * the caller can fall back or degrade gracefully.
 */

const DEFAULT_URL = 'https://api.trestleiq.com/3.2/phone';
const TIMEOUT_MS = 6000;

function titleCase(s) {
  s = String(s == null ? '' : s).trim();
  if (!s) return '';
  return s.toLowerCase().replace(/\b[a-z]/g, (c) => c.toUpperCase());
}

// Pure: Trestle response JSON -> our normalized identity shape (matches the
// Twilio parser's shape, plus `age`).
function parseTrestle(json) {
  json = json || {};
  const owners = Array.isArray(json.owners) ? json.owners : [];
  // Prefer the first Person owner; fall back to the first owner of any type.
  const owner = owners.find((o) => o && o.type === 'Person') || owners[0] || null;

  if (!owner) {
    return {
      ok: true, name: '', first: '', last: '',
      address: { line: '', city: '', state: '', postal: '' },
      age: '', hasAddress: false, source: 'trestle',
    };
  }

  const first = owner.firstname || '';
  const last = owner.lastname || '';
  const name = owner.name || (first + ' ' + last).trim();

  const addrs = Array.isArray(owner.current_addresses) ? owner.current_addresses : [];
  const a = addrs[0] || {};
  const line = [a.street_line_1, a.street_line_2].filter(Boolean).join(' ').trim();
  const address = {
    line: titleCase(line),
    city: titleCase(a.city || ''),
    state: String(a.state_code || '').toUpperCase(),
    postal: a.postal_code || '',
  };
  const hasAddress = !!(address.line || address.city || address.state || address.postal);

  return {
    ok: true,
    name: titleCase(name),
    first: titleCase(first),
    last: titleCase(last),
    address,
    age: owner.age_range || '',
    hasAddress,
    source: 'trestle',
  };
}

async function reversePhone(digitsInput) {
  const key = process.env.TRESTLE_API_KEY;
  if (!key) return { ok: false, error: 'trestle_not_configured' };

  const digits = String(digitsInput || '').replace(/\D/g, '').slice(-10);
  if (digits.length !== 10) return { ok: false, error: 'invalid_phone' };

  const base = process.env.TRESTLE_BASE_URL || DEFAULT_URL;
  const url = base + '?phone=' + encodeURIComponent(digits) + '&phone.country_hint=US';

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const resp = await fetch(url, {
      method: 'GET',
      headers: { 'x-api-key': key, Accept: 'application/json' },
      signal: ctrl.signal,
    });
    if (!resp.ok) {
      console.error('[trestle] http', resp.status);
      return { ok: false, error: 'trestle_http_' + resp.status };
    }
    const json = await resp.json();
    const out = parseTrestle(json);
    out.phone = '+1' + digits;
    if (Array.isArray(json.warnings) && json.warnings.length) out.warnings = json.warnings;
    return out;
  } catch (err) {
    console.error('[trestle] error:', err && err.message ? err.message : err);
    return { ok: false, error: 'trestle_failed' };
  } finally {
    clearTimeout(timer);
  }
}

module.exports = { reversePhone, parseTrestle };
