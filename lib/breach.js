'use strict';

/**
 * Have I Been Pwned (HIBP) breach lookup for the honest "exposure check".
 *
 * Email -> which known breaches it appears in + the TYPES of data exposed
 * (HIBP "data classes"). HIBP returns breach METADATA only, never the raw
 * leaked values, so we can truthfully say "found in N breaches, exposed data
 * may include Social Security numbers" without ever sourcing, storing, or
 * displaying an actual SSN.
 *
 * No-op when HIBP_API_KEY is unset: returns { ok:false, error:'not_configured' }
 * so the results page degrades gracefully before the key is added in Render.
 * checkEmail never throws.
 */

const API = 'https://haveibeenpwned.com/api/v3/breachedaccount/';
const TIMEOUT_MS = parseInt(process.env.HIBP_TIMEOUT_MS || '8000', 10);

async function fetchWithTimeout(url, opts) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    return await fetch(url, Object.assign({}, opts, { signal: ctrl.signal }));
  } finally {
    clearTimeout(timer);
  }
}

function normalizeEmail(e) {
  return String(e == null ? '' : e).trim().toLowerCase();
}

// Pure: HIBP breach array -> our summary. We expose a COUNT and the set of
// exposed data-class labels only; we never keep any per-breach raw detail.
function summarize(breaches) {
  const arr = Array.isArray(breaches) ? breaches : [];
  const set = new Set();
  for (const b of arr) {
    const dc = b && Array.isArray(b.DataClasses) ? b.DataClasses : [];
    for (const c of dc) set.add(String(c));
  }
  const dataClasses = Array.from(set);
  const hasSSN = dataClasses.some((c) => /social security/i.test(c));
  return { count: arr.length, dataClasses: dataClasses, hasSSN: hasSSN };
}

async function checkEmail(emailInput) {
  const email = normalizeEmail(emailInput);
  if (!email || email.indexOf('@') < 1) return { ok: false, error: 'invalid_email' };

  const key = process.env.HIBP_API_KEY;
  if (!key) return { ok: false, error: 'not_configured' };

  const url = API + encodeURIComponent(email) + '?truncateResponse=false';
  try {
    const resp = await fetchWithTimeout(url, {
      headers: {
        'hibp-api-key': key,
        // HIBP requires a descriptive User-Agent or it rejects the request.
        'User-Agent': process.env.HIBP_USER_AGENT || 'SpamCallStop-ExposureCheck',
        Accept: 'application/json',
      },
    });
    if (resp.status === 404) return Object.assign({ ok: true }, summarize([])); // clean: no breaches
    if (resp.status === 429) { console.error('[hibp] rate limited'); return { ok: false, error: 'rate_limited' }; }
    if (!resp.ok) { console.error('[hibp] http', resp.status); return { ok: false, error: 'http_' + resp.status }; }
    const j = await resp.json().catch(() => null);
    return Object.assign({ ok: true }, summarize(j));
  } catch (err) {
    console.error('[hibp] error:', err && err.message ? err.message : err);
    return { ok: false, error: 'lookup_failed' };
  }
}

module.exports = { checkEmail, summarize };
