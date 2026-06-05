'use strict';

// Critical path: signed tokens gate the scan data and the customer dashboard.
process.env.APP_SECRET = 'test-suite-secret';

const test = require('node:test');
const assert = require('node:assert');
const token = require('../lib/token');

test('phone-verify token validates only for its own number', () => {
  const t = token.sign('4243860093');
  assert.strictEqual(token.verify(t, '4243860093'), true);
  assert.strictEqual(token.verify(t, '4243860094'), false);
});

test('tampered phone-verify token is rejected', () => {
  const t = token.sign('4243860093');
  assert.strictEqual(token.verify(t + 'x', '4243860093'), false);
  assert.strictEqual(token.verify('garbage', '4243860093'), false);
});

test('customer token round-trips to the customer id', () => {
  assert.strictEqual(token.verifyCustomer(token.signCustomer(42)), '42');
  assert.strictEqual(token.verifyCustomer(token.signCustomer(7)), '7');
});

test('invalid customer tokens return null (no access)', () => {
  assert.strictEqual(token.verifyCustomer(''), null);
  assert.strictEqual(token.verifyCustomer('nope.nope'), null);
  assert.strictEqual(token.verifyCustomer(token.signCustomer(1) + 'x'), null);
});
