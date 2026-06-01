'use strict';

/**
 * Phone number helpers (US / NANP, 10 digits).
 */

// Strip to digits, drop a leading country-code 1, validate as a 10-digit US
// number (area code and exchange start 2-9). Returns the 10 digits or null.
function normalizePhone(input) {
  if (input == null) return null;
  let d = String(input).replace(/\D/g, '');
  if (d.length === 11 && d[0] === '1') d = d.slice(1);
  if (!/^[2-9]\d{9}$/.test(d)) return null;
  return d;
}

// "2025550123" -> "(202) 555-0123"
function formatPhone(digits) {
  const d = normalizePhone(digits);
  if (!d) return null;
  return `(${d.slice(0, 3)}) ${d.slice(3, 6)}-${d.slice(6)}`;
}

module.exports = { normalizePhone, formatPhone };
