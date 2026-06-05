'use strict';

// Critical path: PII encryption at rest + the searchable phone fingerprint.
process.env.APP_SECRET = 'test-suite-secret';

const test = require('node:test');
const assert = require('node:assert');
const { encrypt, decrypt, phoneHash } = require('../lib/crypto');

test('encrypt/decrypt round-trips a value', () => {
  const ct = encrypt('John Q Public');
  assert.ok(ct.startsWith('enc:v1:'), 'ciphertext is tagged');
  assert.notStrictEqual(ct, 'John Q Public');
  assert.strictEqual(decrypt(ct), 'John Q Public');
});

test('decrypt passes legacy plaintext through unchanged', () => {
  assert.strictEqual(decrypt('plain-legacy-value'), 'plain-legacy-value');
});

test('encryption uses a random IV (non-deterministic ciphertext)', () => {
  assert.notStrictEqual(encrypt('5551234567'), encrypt('5551234567'));
});

test('empty / null values are not encrypted', () => {
  assert.strictEqual(encrypt(''), '');
  assert.strictEqual(encrypt(null), null);
});

test('phoneHash is deterministic and normalizes formatting', () => {
  const a = phoneHash('(424) 386-0093');
  assert.strictEqual(a, phoneHash('4243860093'));
  assert.strictEqual(a, phoneHash('1-424-386-0093'));
  assert.strictEqual(typeof a, 'string');
});

test('phoneHash rejects non-10-digit input', () => {
  assert.strictEqual(phoneHash('123'), null);
  assert.strictEqual(phoneHash(''), null);
});
