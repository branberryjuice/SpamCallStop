'use strict';

// Critical path: the Phase 2 scraper must (a) classify presence honestly and
// (b) stay completely inert while dormant. These tests run with NO scraper env
// set, which is the shipped default.
delete process.env.SCRAPER_ENABLED;
delete process.env.SCRAPER_PROXY_URL;

const test = require('node:test');
const assert = require('node:assert');

const parsers = require('../lib/scraper/parsers');
const fetcher = require('../lib/scraper/fetcher');
const engine = require('../lib/scraper/index');

test('phoneVariants produces the formats brokers print', () => {
  const v = parsers.phoneVariants('5551234567');
  assert.ok(v.includes('5551234567'));
  assert.ok(v.includes('(555) 123-4567'));
  assert.ok(v.includes('555-123-4567'));
  assert.strictEqual(parsers.phoneVariants('123').length, 0); // not 10 digits
});

test('classify: no-results page -> clear', () => {
  const html = '<html><body><h1>No results found for that number</h1></body></html>';
  assert.strictEqual(parsers.classify(null, html, '5551234567'), 'clear');
});

test('classify: page containing the number -> found', () => {
  const html = '<div>Listing for (555) 123-4567 — John P.</div>';
  assert.strictEqual(parsers.classify(null, html, '5551234567'), 'found');
});

test('classify: unrelated page -> unknown', () => {
  const html = '<div>Welcome. Please search to begin.</div>';
  assert.strictEqual(parsers.classify(null, html, '5551234567'), 'unknown');
});

test('classify: null / empty html -> unknown (never clear)', () => {
  assert.strictEqual(parsers.classify(null, null, '5551234567'), 'unknown');
  assert.strictEqual(parsers.classify(null, '', '5551234567'), 'unknown');
});

test('every shipped broker is uncalibrated (honesty gate)', () => {
  assert.ok(parsers.PARSERS.length > 0, 'broker set is non-empty');
  for (const b of parsers.PARSERS) {
    assert.strictEqual(b.calibrated, false, b.key + ' must ship uncalibrated');
    assert.match(b.searchUrl('5551234567'), /^https:\/\//, b.key + ' builds an https url');
  }
  assert.strictEqual(parsers.calibratedParsers().length, 0);
});

test('DORMANT: fetcher makes no request without flag + proxy', async () => {
  assert.strictEqual(fetcher.isLive(), false);
  assert.strictEqual(await fetcher.fetchHtml('https://example.com'), null);
});

test('DORMANT: even with the flag on, no proxy => not live', () => {
  process.env.SCRAPER_ENABLED = '1';
  assert.strictEqual(fetcher.enabled(), true);
  assert.strictEqual(fetcher.proxyConfigured(), false);
  assert.strictEqual(fetcher.isLive(), false, 'flag alone must not arm it');
  delete process.env.SCRAPER_ENABLED;
});

test('DORMANT: engine reveals nothing and registers no checkers', async () => {
  engine._clearCache();
  assert.strictEqual(engine.isEnabled(), false);
  assert.deepStrictEqual(await engine.scanExposure('5551234567'), []);
  assert.deepStrictEqual(engine.buildCheckers(), {});
});

test('DORMANT: flag on but uncalibrated brokers => still nothing', async () => {
  process.env.SCRAPER_ENABLED = '1';
  process.env.SCRAPER_PROXY_URL = 'http://user:pass@proxy.example:8000';
  engine._clearCache();
  // fetcher is "live" now, but no broker is calibrated, so the engine stays off
  // and never surfaces a guess.
  assert.strictEqual(engine.isEnabled(), false);
  assert.deepStrictEqual(await engine.scanExposure('5551234567'), []);
  assert.deepStrictEqual(engine.buildCheckers(), {});
  delete process.env.SCRAPER_ENABLED;
  delete process.env.SCRAPER_PROXY_URL;
});
