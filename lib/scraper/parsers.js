'use strict';

/**
 * Per-broker reverse-phone parsers for the scraper engine.
 *
 * Only the phone-SEARCHABLE brokers live here: at scan time the only thing we
 * know is the phone number, so a broker is usable only if it has a public
 * reverse-phone lookup page. (Most of the full broker list in lib/brokers.js is
 * name-indexed and can't be queried from a number alone.)
 *
 * Each entry:
 *   key        slug used as the checker key (align with removal_jobs.broker_key
 *              at calibration time so the verification sweep maps correctly)
 *   label      display name — MUST match the name in lib/brokers.js
 *   searchUrl  (digits) => the reverse-phone results URL
 *   noResults  regexes that prove the number is NOT listed ('clear')
 *   extract    (html) => { name, city, state }  best-effort, optional
 *   calibrated FALSE until verified against a REAL fetched sample.
 *
 * ── HONESTY GATE ─────────────────────────────────────────────────────────────
 * `calibrated: false` means "the URL and the found/clear signals are a best
 * guess we have NOT checked against a live page." The engine refuses to surface
 * findings or run verification for any uncalibrated broker, so flipping the
 * master switch on still shows the customer NOTHING false. Going live is two
 * stages: (1) enable + proxy, (2) fetch one real sample per broker, confirm the
 * URL + signals, flip its `calibrated` to true. Never set calibrated:true on a
 * guess — a wrong 'clear' would tell a customer they're removed when they're not.
 */

// ---- phone formatting helpers (what brokers print in their HTML) ----
function tenDigits(input) {
  return String(input == null ? '' : input).replace(/\D/g, '').slice(-10);
}
function phoneVariants(digits) {
  const d = tenDigits(digits);
  if (d.length !== 10) return [];
  const a = d.slice(0, 3), b = d.slice(3, 6), c = d.slice(6);
  return [
    d, // 5551234567
    `(${a}) ${b}-${c}`, // (555) 123-4567
    `${a}-${b}-${c}`, // 555-123-4567
    `${a}.${b}.${c}`, // 555.123.4567
    `${a} ${b} ${c}`, // 555 123 4567
    `+1${d}`, // +15551234567
  ];
}

function stripTags(html) {
  return String(html || '')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// Phrases that, across most people-search sites, mean "no record for this number".
const GENERIC_NO_RESULTS = [
  /no\s+results?\s+found/i,
  /no\s+records?\s+found/i,
  /we\s+(?:could|couldn'?t|did\s+not|didn'?t)\s+find/i,
  /0\s+results/i,
  /nothing\s+(?:was\s+)?found/i,
  /sorry[,!]?\s+no/i,
];

/**
 * Pure, unit-testable. Given a broker entry + raw HTML + the queried digits,
 * decide presence. Conservative on purpose:
 *   'clear'   only when a no-results signal is present
 *   'found'   only when the queried number literally appears in the page
 *   'unknown' otherwise (and always when html is null/empty)
 * 'unknown' is the safe default — it never tells the customer anything.
 */
function classify(broker, html, digits) {
  if (!html) return 'unknown';
  const text = stripTags(html);
  if (!text) return 'unknown';

  const noResults = (broker && broker.noResults) || GENERIC_NO_RESULTS;
  for (const re of noResults) {
    if (re.test(text)) return 'clear';
  }

  const hay = text.toLowerCase();
  const variants = phoneVariants(digits);
  for (const v of variants) {
    if (v && hay.indexOf(v.toLowerCase()) !== -1) return 'found';
  }

  return 'unknown';
}

// ---- the phone-searchable broker set (URLs are best-guess until calibrated) ----
const PARSERS = [
  {
    key: 'spydialer',
    label: 'Spy Dialer',
    // Spy Dialer's reverse-phone is a POST form; the GET pattern below is a
    // placeholder to confirm at calibration.
    searchUrl: (d) => `https://www.spydialer.com/default.aspx?p=${tenDigits(d)}`,
    calibrated: false,
  },
  {
    key: 'usphonebook',
    label: 'USPhonebook',
    searchUrl: (d) => `https://www.usphonebook.com/${tenDigits(d)}`,
    calibrated: false,
  },
  {
    key: 'thatsthem',
    label: 'ThatsThem',
    searchUrl: (d) => {
      const x = tenDigits(d);
      return `https://thatsthem.com/phone/${x.slice(0, 3)}-${x.slice(3, 6)}-${x.slice(6)}`;
    },
    calibrated: false,
  },
  {
    key: 'zabasearch',
    label: 'ZabaSearch',
    searchUrl: (d) => `https://www.zabasearch.com/phone/${tenDigits(d)}`,
    calibrated: false,
  },
  {
    key: 'nuwber',
    label: 'Nuwber',
    searchUrl: (d) => `https://nuwber.com/search?phone=${tenDigits(d)}`,
    calibrated: false,
  },
  {
    key: 'spokeo',
    label: 'Spokeo',
    searchUrl: (d) => `https://www.spokeo.com/${tenDigits(d)}`,
    calibrated: false,
  },
];

const BY_KEY = {};
for (const p of PARSERS) BY_KEY[p.key] = p;

function calibratedParsers() {
  return PARSERS.filter((p) => p.calibrated === true);
}

module.exports = {
  PARSERS,
  BY_KEY,
  classify,
  calibratedParsers,
  // exported for tests / reuse
  phoneVariants,
  stripTags,
  tenDigits,
  GENERIC_NO_RESULTS,
};
