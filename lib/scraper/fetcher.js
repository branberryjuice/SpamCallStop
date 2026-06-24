'use strict';

/**
 * Scraper fetch transport — DORMANT BY DEFAULT.
 *
 * Scrape-only design: every request to a broker site goes out through a
 * residential / rotating proxy (or a managed "web unblocker" endpoint that
 * speaks the standard HTTP-proxy protocol). We NEVER hit broker sites directly
 * from Render's datacenter IPs — that gets blocked instantly and can get the
 * box's IP range flagged.
 *
 * ── DORMANCY CONTRACT ────────────────────────────────────────────────────────
 * fetchHtml() returns null (no network, no spend) unless BOTH are true:
 *     1. SCRAPER_ENABLED is on   (env: SCRAPER_ENABLED = 1 | true | on)
 *     2. a proxy is configured   (env: SCRAPER_PROXY_URL = http://user:pass@host:port)
 * With neither set — the shipped default — nothing ever leaves the process and
 * not a cent is spent. Flipping the engine on is purely a Render env change.
 *
 * When the future data provider is chosen, this is the ONLY file that has to
 * change: point SCRAPER_PROXY_URL at them (or swap the transport below). The
 * engine and parsers don't care how the bytes were fetched.
 *
 * Never throws — returns null on any problem so callers degrade to 'unknown'.
 */

const TIMEOUT_MS = parseInt(process.env.SCRAPER_TIMEOUT_MS || '12000', 10);

// A believable desktop-browser fingerprint. Datacenter UA strings get blocked;
// this plus a residential proxy is the minimum to look like a real visitor.
const DEFAULT_HEADERS = {
  'User-Agent':
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
    '(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  Accept:
    'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
  'Accept-Language': 'en-US,en;q=0.9',
  'Upgrade-Insecure-Requests': '1',
};

function flagOn(v) {
  const s = String(v == null ? '' : v).toLowerCase();
  return s === '1' || s === 'true' || s === 'on' || s === 'yes';
}

/** Master switch — read live each call so a Render restart picks it up. */
function enabled() {
  return flagOn(process.env.SCRAPER_ENABLED);
}

/** A proxy/unblocker must be configured for any request to go out. */
function proxyConfigured() {
  return !!String(process.env.SCRAPER_PROXY_URL || '').trim();
}

/** The single source of truth for "is the scraper live right now". */
function isLive() {
  return enabled() && proxyConfigured();
}

/**
 * Lazily build an undici ProxyAgent dispatcher from SCRAPER_PROXY_URL.
 * Most residential-proxy / web-unblocker vendors (Bright Data, Oxylabs,
 * Smartproxy, etc.) expose exactly this: one http://user:pass@host:port URL
 * that rotates the exit IP per request. Returns null if undici/proxy missing.
 */
let _agent;
let _agentForUrl;
function proxyDispatcher() {
  const url = String(process.env.SCRAPER_PROXY_URL || '').trim();
  if (!url) return null;
  if (_agent && _agentForUrl === url) return _agent;
  try {
    // undici ships with Node 18+. require lazily so a missing/edge build can
    // never break module load while the engine is dormant.
    const { ProxyAgent } = require('undici');
    _agent = new ProxyAgent(url);
    _agentForUrl = url;
    return _agent;
  } catch (e) {
    console.error('[scraper/fetcher] proxy agent unavailable:', e && e.message);
    return null;
  }
}

/**
 * Fetch a broker page's HTML through the proxy.
 *   fetchHtml(url, { headers })  ->  string HTML  |  null
 * null means "could not fetch" (dormant, no proxy, timeout, non-200, or error);
 * callers must treat null as 'unknown', never as 'clear'.
 */
async function fetchHtml(url, opts) {
  opts = opts || {};
  if (!isLive()) return null; // DORMANT — no network, no spend.

  const dispatcher = proxyDispatcher();
  if (!dispatcher) return null; // proxy set but unusable -> fail closed.

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const resp = await fetch(url, {
      method: opts.method || 'GET',
      headers: Object.assign({}, DEFAULT_HEADERS, opts.headers || {}),
      body: opts.body || undefined,
      redirect: 'follow',
      signal: ctrl.signal,
      dispatcher, // route through the residential proxy
    });
    if (!resp.ok) {
      console.error('[scraper/fetcher] http', resp.status, url);
      return null;
    }
    return await resp.text();
  } catch (err) {
    console.error('[scraper/fetcher] error:', err && err.message ? err.message : err);
    return null;
  } finally {
    clearTimeout(timer);
  }
}

module.exports = { fetchHtml, isLive, enabled, proxyConfigured, DEFAULT_HEADERS };
