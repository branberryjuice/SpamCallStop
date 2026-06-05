'use strict';

/**
 * Customer data layer (durable).
 *
 *   Production (Render): PostgreSQL via `pg`, used when DATABASE_URL is set.
 *   Local dev / tests:   SQLite via Node's built-in node:sqlite, so the app
 *                        runs and is testable without a Postgres instance.
 *
 * Same async API either way: init, saveCustomer, getCustomerByEmail,
 * listCustomers, updateStatus.
 */

const USE_PG = !!process.env.DATABASE_URL;
let pool = null; // pg pool
let sdb = null;  // sqlite database

// PII-at-rest: customer names + phone numbers are encrypted in the DB. decField
// passes legacy plaintext through unchanged, so this is backward-compatible.
const { encrypt: encField, decrypt: decField, phoneHash } = require('./crypto');

function needsSsl(url) {
  return !!url && !/localhost|127\.0\.0\.1/.test(url);
}

// Mask an email for logging so plaintext PII doesn't sit in server logs.
function maskEmail(e) {
  e = String(e == null ? '' : e).trim();
  if (!e || e.indexOf('@') < 1) return '(no email)';
  return e.replace(/^(.).*?(@.*)$/, '$1***$2');
}

async function init() {
  if (USE_PG) {
    const { Pool } = require('pg');
    pool = new Pool({
      connectionString: process.env.DATABASE_URL,
      ssl: needsSsl(process.env.DATABASE_URL) ? { rejectUnauthorized: false } : false,
    });
    await pool.query(`
      CREATE TABLE IF NOT EXISTS customers (
        id SERIAL PRIMARY KEY,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        email TEXT,
        name TEXT,
        phone TEXT,
        plan TEXT,
        billing TEXT,
        bump BOOLEAN NOT NULL DEFAULT false,
        status TEXT NOT NULL DEFAULT 'active',
        stripe_customer TEXT,
        stripe_subscription TEXT
      )
    `);
    await pool.query(`CREATE TABLE IF NOT EXISTS verify_daily (day DATE PRIMARY KEY, sends INTEGER NOT NULL DEFAULT 0)`);
    await pool.query(`CREATE TABLE IF NOT EXISTS processed_events (event_id TEXT PRIMARY KEY, created_at TIMESTAMPTZ NOT NULL DEFAULT now())`);
    await pool.query(`
      CREATE TABLE IF NOT EXISTS funnel_events (
        id SERIAL PRIMARY KEY,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        visitor_id TEXT,
        event TEXT NOT NULL,
        email TEXT,
        phone TEXT,
        plan TEXT,
        amount INTEGER,
        meta TEXT
      )
    `);
    await pool.query(`ALTER TABLE funnel_events ADD COLUMN IF NOT EXISTS phone TEXT`); // migrate older tables
    await pool.query(`CREATE INDEX IF NOT EXISTS funnel_events_created_idx ON funnel_events (created_at)`);
    await pool.query(`CREATE INDEX IF NOT EXISTS funnel_events_event_idx ON funnel_events (event)`);
    await pool.query(`
      CREATE TABLE IF NOT EXISTS protected_numbers (
        id SERIAL PRIMARY KEY,
        customer_id INTEGER NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
        phone TEXT NOT NULL,
        label TEXT,
        status TEXT NOT NULL DEFAULT 'pending',
        created_at TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `);
    await pool.query(`ALTER TABLE protected_numbers ADD COLUMN IF NOT EXISTS phone_hash TEXT`);
    await pool.query(`CREATE INDEX IF NOT EXISTS protected_numbers_phone_hash_idx ON protected_numbers (phone_hash)`);
    await pool.query(`
      CREATE TABLE IF NOT EXISTS removal_jobs (
        id SERIAL PRIMARY KEY,
        customer_id INTEGER NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
        number_id INTEGER,
        phone TEXT,
        broker_key TEXT NOT NULL,
        broker_name TEXT,
        broker_email TEXT,
        status TEXT NOT NULL DEFAULT 'pending',
        attempts INTEGER NOT NULL DEFAULT 0,
        last_error TEXT,
        sent_at TIMESTAMPTZ,
        next_eligible_at TIMESTAMPTZ,
        last_reply_at TIMESTAMPTZ,
        last_reply_kind TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `);
    await pool.query(`
      CREATE TABLE IF NOT EXISTS removal_replies (
        id SERIAL PRIMARY KEY,
        job_id INTEGER,
        customer_id INTEGER,
        broker_key TEXT,
        from_addr TEXT,
        subject TEXT,
        snippet TEXT,
        classification TEXT,
        received_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        created_at TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `);
    await pool.query(`
      CREATE TABLE IF NOT EXISTS customer_alerts (
        id SERIAL PRIMARY KEY,
        customer_id INTEGER NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
        kind TEXT NOT NULL,
        title TEXT NOT NULL,
        body TEXT,
        broker_key TEXT,
        read BOOLEAN NOT NULL DEFAULT false,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `);
    await pool.query(`CREATE INDEX IF NOT EXISTS customer_alerts_cust_idx ON customer_alerts (customer_id, created_at)`);
  } else {
    const { DatabaseSync } = require('node:sqlite');
    const path = require('path');
    const file = process.env.SQLITE_PATH || path.join(__dirname, '..', 'dev.db');
    sdb = new DatabaseSync(file);
    sdb.exec(`
      CREATE TABLE IF NOT EXISTS customers (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        email TEXT,
        name TEXT,
        phone TEXT,
        plan TEXT,
        billing TEXT,
        bump INTEGER NOT NULL DEFAULT 0,
        status TEXT NOT NULL DEFAULT 'active',
        stripe_customer TEXT,
        stripe_subscription TEXT
      )
    `);
    sdb.exec(`CREATE TABLE IF NOT EXISTS verify_daily (day TEXT PRIMARY KEY, sends INTEGER NOT NULL DEFAULT 0)`);
    sdb.exec(`CREATE TABLE IF NOT EXISTS processed_events (event_id TEXT PRIMARY KEY, created_at TEXT NOT NULL DEFAULT (datetime('now')))`);
    sdb.exec(`
      CREATE TABLE IF NOT EXISTS funnel_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        visitor_id TEXT,
        event TEXT NOT NULL,
        email TEXT,
        phone TEXT,
        plan TEXT,
        amount INTEGER,
        meta TEXT
      )
    `);
    try { sdb.exec(`ALTER TABLE funnel_events ADD COLUMN phone TEXT`); } catch (e) { /* column already exists */ }
    sdb.exec(`CREATE INDEX IF NOT EXISTS funnel_events_created_idx ON funnel_events (created_at)`);
    sdb.exec(`CREATE INDEX IF NOT EXISTS funnel_events_event_idx ON funnel_events (event)`);
    sdb.exec(`
      CREATE TABLE IF NOT EXISTS protected_numbers (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        customer_id INTEGER NOT NULL,
        phone TEXT NOT NULL,
        label TEXT,
        status TEXT NOT NULL DEFAULT 'pending',
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      )
    `);
    try { sdb.exec(`ALTER TABLE protected_numbers ADD COLUMN phone_hash TEXT`); } catch (e) { /* column already exists */ }
    sdb.exec(`CREATE INDEX IF NOT EXISTS protected_numbers_phone_hash_idx ON protected_numbers (phone_hash)`);
    sdb.exec(`
      CREATE TABLE IF NOT EXISTS removal_jobs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        customer_id INTEGER NOT NULL,
        number_id INTEGER,
        phone TEXT,
        broker_key TEXT NOT NULL,
        broker_name TEXT,
        broker_email TEXT,
        status TEXT NOT NULL DEFAULT 'pending',
        attempts INTEGER NOT NULL DEFAULT 0,
        last_error TEXT,
        sent_at TEXT,
        next_eligible_at TEXT,
        last_reply_at TEXT,
        last_reply_kind TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      )
    `);
    sdb.exec(`
      CREATE TABLE IF NOT EXISTS removal_replies (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        job_id INTEGER,
        customer_id INTEGER,
        broker_key TEXT,
        from_addr TEXT,
        subject TEXT,
        snippet TEXT,
        classification TEXT,
        received_at TEXT NOT NULL DEFAULT (datetime('now')),
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      )
    `);
    sdb.exec(`
      CREATE TABLE IF NOT EXISTS customer_alerts (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        customer_id INTEGER NOT NULL,
        kind TEXT NOT NULL,
        title TEXT NOT NULL,
        body TEXT,
        broker_key TEXT,
        read INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      )
    `);
    sdb.exec(`CREATE INDEX IF NOT EXISTS customer_alerts_cust_idx ON customer_alerts (customer_id, created_at)`);
  }
  try { await backfillPhoneHashes(); } catch (e) { console.error('[db] phone_hash backfill skipped:', e && e.message); }
  console.log('[db] ready (' + (USE_PG ? 'postgres' : 'sqlite dev') + ')');
}

// One-time fill of phone_hash for number rows written before the column existed.
// Only touches rows still missing a hash, so it's a no-op on every boot after the
// first, and safe to run even if two instances start at once (UPDATE ... WHERE
// phone_hash IS NULL is idempotent). Never throws into boot.
async function backfillPhoneHashes() {
  let filled = 0;
  if (USE_PG) {
    const { rows } = await pool.query(`SELECT id, phone FROM protected_numbers WHERE phone_hash IS NULL`);
    for (const r of rows) {
      const h = phoneHash(decField(r.phone));
      if (!h) continue;
      await pool.query(`UPDATE protected_numbers SET phone_hash = $1 WHERE id = $2`, [h, r.id]);
      filled++;
    }
  } else {
    const rows = sdb.prepare(`SELECT id, phone FROM protected_numbers WHERE phone_hash IS NULL`).all();
    for (const r of rows) {
      const h = phoneHash(decField(r.phone));
      if (!h) continue;
      sdb.prepare(`UPDATE protected_numbers SET phone_hash = ? WHERE id = ?`).run(h, r.id);
      filled++;
    }
  }
  if (filled) console.log('[db] phone_hash backfilled for', filled, 'number(s)');
}

function normalize(c) {
  return {
    email: c.email || '',
    name: c.name || '',
    phone: c.phone || '',
    plan: c.plan || '',
    billing: c.billing || '',
    bump: !!c.bump,
    status: c.status || 'active',
    stripe_customer: c.stripeCustomer || c.stripe_customer || '',
    stripe_subscription: c.subscription || c.stripe_subscription || '',
  };
}

function rowOut(r) {
  if (!r) return r;
  return Object.assign({}, r, {
    bump: !!r.bump,
    name: r.name != null ? decField(r.name) : r.name,
    phone: r.phone != null ? decField(r.phone) : r.phone,
  });
}

// Decrypt the phone on a removal_jobs row.
function jobOut(r) {
  if (r && r.phone != null) return Object.assign({}, r, { phone: decField(r.phone) });
  return r;
}

const COLS = 'email,name,phone,plan,billing,bump,status,stripe_customer,stripe_subscription';

// Pull the phone list off a save input. Accepts { phones:[...] }, { phone },
// and/or { phone2 } (Couple). Trims, drops blanks, de-dupes, preserves order.
function phonesFrom(input) {
  let arr = [];
  if (Array.isArray(input.phones)) arr = input.phones.slice();
  else if (input.phone) arr = [input.phone];
  if (input.phone2) arr.push(input.phone2);
  const seen = new Set();
  const out = [];
  for (let p of arr) {
    p = String(p == null ? '' : p).trim();
    if (!p || seen.has(p)) continue;
    seen.add(p);
    out.push(p);
  }
  return out;
}

async function insertNumbers(customerId, phones) {
  for (let i = 0; i < phones.length; i++) {
    const label = 'Number ' + (i + 1);
    const ph = phoneHash(phones[i]);
    if (USE_PG) {
      await pool.query(
        `INSERT INTO protected_numbers (customer_id, phone, phone_hash, label, status) VALUES ($1,$2,$3,$4,'pending')`,
        [customerId, encField(phones[i]), ph, label]
      );
    } else {
      sdb.prepare(`INSERT INTO protected_numbers (customer_id, phone, phone_hash, label, status) VALUES (?,?,?,?,'pending')`)
        .run(customerId, encField(phones[i]), ph, label);
    }
  }
}

async function saveCustomer(input) {
  const r = normalize(input);
  const phones = phonesFrom(input);
  if (phones.length) r.phone = phones[0]; // keep customers.phone = primary, for compat
  const vals = [r.email, encField(r.name), encField(r.phone), r.plan, r.billing, r.bump, r.status, r.stripe_customer, r.stripe_subscription];
  if (USE_PG) {
    const { rows } = await pool.query(
      `INSERT INTO customers (${COLS}) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
      vals
    );
    await insertNumbers(rows[0].id, phones);
    console.log('[db] customer saved:', maskEmail(r.email), '-', r.plan, '-', phones.length, 'number(s)');
    return rowOut(rows[0]);
  }
  const info = sdb.prepare(`INSERT INTO customers (${COLS}) VALUES (?,?,?,?,?,?,?,?,?)`)
    .run(r.email, encField(r.name), encField(r.phone), r.plan, r.billing, r.bump ? 1 : 0, r.status, r.stripe_customer, r.stripe_subscription);
  const id = Number(info.lastInsertRowid);
  await insertNumbers(id, phones);
  console.log('[db] customer saved (sqlite):', maskEmail(r.email), '-', r.plan, '-', phones.length, 'number(s)');
  return rowOut(sdb.prepare('SELECT * FROM customers WHERE id = ?').get(id));
}

async function getCustomerByEmail(email) {
  if (USE_PG) {
    const { rows } = await pool.query('SELECT * FROM customers WHERE email = $1 ORDER BY id DESC LIMIT 1', [email]);
    return rowOut(rows[0]);
  }
  return rowOut(sdb.prepare('SELECT * FROM customers WHERE email = ? ORDER BY id DESC LIMIT 1').get(email));
}

// Look up a customer by their Stripe subscription id — used to dedupe provisioning
// across the webhook and the dashboard-session backstop (a subscription is unique
// per purchase, so this guarantees we never create two customers for one checkout).
async function getCustomerBySubscription(sub) {
  if (!sub) return null;
  if (USE_PG) {
    const { rows } = await pool.query('SELECT * FROM customers WHERE stripe_subscription = $1 ORDER BY id DESC LIMIT 1', [sub]);
    return rowOut(rows[0]);
  }
  return rowOut(sdb.prepare('SELECT * FROM customers WHERE stripe_subscription = ? ORDER BY id DESC LIMIT 1').get(sub));
}

// Find the active customer who owns this phone, matched by the deterministic
// hash (the stored number is encrypted, so it can't be matched directly). Used
// by phone-OTP login so a verified member lands in their dashboard instead of the
// signup funnel. Only an active membership matches; canceling/none -> null.
async function getCustomerByPhoneHash(hash) {
  if (!hash) return null;
  if (USE_PG) {
    const { rows } = await pool.query(
      `SELECT c.* FROM protected_numbers pn JOIN customers c ON c.id = pn.customer_id
       WHERE pn.phone_hash = $1 AND c.status = 'active' ORDER BY c.id DESC LIMIT 1`,
      [hash]
    );
    return rowOut(rows[0]);
  }
  return rowOut(sdb.prepare(
    `SELECT c.* FROM protected_numbers pn JOIN customers c ON c.id = pn.customer_id
     WHERE pn.phone_hash = ? AND c.status = 'active' ORDER BY c.id DESC LIMIT 1`
  ).get(hash));
}

// Find every customer tied to a phone number (matched via the encrypted-safe
// phone hash, since the number itself is encrypted at rest). Returns light rows
// for review — used by the delete-customer tool and future deletion requests.
async function findCustomersByPhone(phone) {
  const hash = phoneHash(phone);
  if (!hash) return [];
  const sql = `SELECT DISTINCT c.id, c.email, c.plan, c.status, c.created_at
                 FROM protected_numbers pn JOIN customers c ON c.id = pn.customer_id
                WHERE pn.phone_hash = $1 ORDER BY c.id`;
  if (USE_PG) { const { rows } = await pool.query(sql, [hash]); return rows; }
  return sdb.prepare(sql.replace('$1', '?')).all(hash);
}

// Hard-delete the given customers and all their related rows. Children are
// removed explicitly (not relying on cascade) so it works on Postgres and SQLite.
async function deleteCustomersByIds(ids) {
  if (!ids || !ids.length) return 0;
  const children = ['removal_jobs', 'protected_numbers', 'customer_alerts', 'removal_replies'];
  if (USE_PG) {
    for (const t of children) { try { await pool.query('DELETE FROM ' + t + ' WHERE customer_id = ANY($1::int[])', [ids]); } catch (e) {} }
    const d = await pool.query('DELETE FROM customers WHERE id = ANY($1::int[])', [ids]);
    return d.rowCount;
  }
  let n = 0;
  for (const id of ids) {
    for (const t of children) { try { sdb.prepare('DELETE FROM ' + t + ' WHERE customer_id = ?').run(id); } catch (e) {} }
    n += (sdb.prepare('DELETE FROM customers WHERE id = ?').run(id).changes || 0);
  }
  return n;
}

async function listCustomers() {
  if (USE_PG) {
    const { rows } = await pool.query('SELECT * FROM customers ORDER BY id DESC');
    return rows.map(rowOut);
  }
  return sdb.prepare('SELECT * FROM customers ORDER BY id DESC').all().map(rowOut);
}

function attachNumbers(customers, numberRows) {
  const byCust = {};
  for (const n of numberRows) {
    (byCust[n.customer_id] = byCust[n.customer_id] || []).push({
      id: n.id, phone: decField(n.phone), label: n.label, status: n.status,
    });
  }
  // Fall back to the legacy single `phone` column for customers saved before
  // protected_numbers existed, so the dashboard still shows their number.
  return customers.map((c) =>
    Object.assign({}, c, {
      numbers: byCust[c.id] || (c.phone ? [{ phone: c.phone, label: 'Number 1', status: 'pending' }] : []),
    })
  );
}

// Customers with their protected phone numbers attached — powers the dashboard.
async function listCustomersWithNumbers() {
  const customers = await listCustomers();
  if (USE_PG) {
    const { rows } = await pool.query('SELECT id, customer_id, phone, label, status FROM protected_numbers ORDER BY id ASC');
    return attachNumbers(customers, rows);
  }
  const rows = sdb.prepare('SELECT id, customer_id, phone, label, status FROM protected_numbers ORDER BY id ASC').all();
  return attachNumbers(customers, rows);
}

// Per-number removal status — the future removal engine flips these.
async function updateNumberStatus(id, status) {
  if (USE_PG) await pool.query('UPDATE protected_numbers SET status = $1 WHERE id = $2', [status, id]);
  else sdb.prepare('UPDATE protected_numbers SET status = ? WHERE id = ?').run(status, Number(id));
}

async function updateStatus(id, status) {
  if (USE_PG) {
    await pool.query('UPDATE customers SET status = $1 WHERE id = $2', [status, id]);
  } else {
    sdb.prepare('UPDATE customers SET status = ? WHERE id = ?').run(status, Number(id));
  }
}

// App-wide daily verification counter (durable cost ceiling). Returns today's
// running total after incrementing.
async function incrementVerifySends() {
  if (USE_PG) {
    const { rows } = await pool.query(
      `INSERT INTO verify_daily (day, sends) VALUES (CURRENT_DATE, 1)
       ON CONFLICT (day) DO UPDATE SET sends = verify_daily.sends + 1 RETURNING sends`
    );
    return rows[0].sends;
  }
  const day = new Date().toISOString().slice(0, 10);
  sdb.prepare(`INSERT INTO verify_daily (day, sends) VALUES (?, 1) ON CONFLICT(day) DO UPDATE SET sends = sends + 1`).run(day);
  return sdb.prepare('SELECT sends FROM verify_daily WHERE day = ?').get(day).sends;
}

// Read-only: how many verification codes we've sent today (0 if none). Lets the
// verify route check the daily cost cap WITHOUT counting an attempt that may fail.
async function getVerifySendsToday() {
  if (USE_PG) {
    const { rows } = await pool.query('SELECT sends FROM verify_daily WHERE day = CURRENT_DATE');
    return rows[0] ? rows[0].sends : 0;
  }
  const day = new Date().toISOString().slice(0, 10);
  const row = sdb.prepare('SELECT sends FROM verify_daily WHERE day = ?').get(day);
  return row ? row.sends : 0;
}

// Webhook idempotency: atomically record a Stripe event id. Returns true only
// the first time we see it, false on any later (retried) delivery — so we never
// double-create a customer or double-send. unmark lets a failed handler retry.
async function markEventProcessed(eventId) {
  const id = String(eventId || '');
  if (!id) return true;
  if (USE_PG) {
    const { rows } = await pool.query(
      `INSERT INTO processed_events (event_id) VALUES ($1) ON CONFLICT (event_id) DO NOTHING RETURNING event_id`,
      [id]
    );
    return rows.length > 0;
  }
  const info = sdb.prepare(`INSERT OR IGNORE INTO processed_events (event_id) VALUES (?)`).run(id);
  return info.changes > 0;
}

async function unmarkEventProcessed(eventId) {
  const id = String(eventId || '');
  if (!id) return;
  if (USE_PG) await pool.query('DELETE FROM processed_events WHERE event_id = $1', [id]);
  else sdb.prepare('DELETE FROM processed_events WHERE event_id = ?').run(id);
}

// --- removal jobs (autonomous email opt-out engine) ----------------------
async function getCustomerById(id) {
  if (USE_PG) { const { rows } = await pool.query('SELECT * FROM customers WHERE id = $1', [id]); return rowOut(rows[0]); }
  return rowOut(sdb.prepare('SELECT * FROM customers WHERE id = ?').get(Number(id)));
}

async function getNumbersForCustomer(customerId) {
  let rows;
  if (USE_PG) { const r = await pool.query('SELECT id, phone, label, status FROM protected_numbers WHERE customer_id = $1 ORDER BY id ASC', [customerId]); rows = r.rows; }
  else { rows = sdb.prepare('SELECT id, phone, label, status FROM protected_numbers WHERE customer_id = ? ORDER BY id ASC').all(customerId); }
  return rows.map((n) => Object.assign({}, n, { phone: decField(n.phone) }));
}

async function getRemovalJob(numberId, brokerKey) {
  if (USE_PG) { const { rows } = await pool.query('SELECT * FROM removal_jobs WHERE number_id = $1 AND broker_key = $2 ORDER BY id DESC LIMIT 1', [numberId, brokerKey]); return jobOut(rows[0] || null); }
  return jobOut(sdb.prepare('SELECT * FROM removal_jobs WHERE number_id = ? AND broker_key = ? ORDER BY id DESC LIMIT 1').get(numberId, brokerKey) || null);
}

async function insertRemovalJob(j) {
  const cols = 'customer_id,number_id,phone,broker_key,broker_name,broker_email,status';
  const encPhone = encField(j.phone);
  if (USE_PG) {
    const { rows } = await pool.query(
      `INSERT INTO removal_jobs (${cols}) VALUES ($1,$2,$3,$4,$5,$6,'pending') RETURNING *`,
      [j.customerId, j.numberId, encPhone, j.brokerKey, j.brokerName, j.brokerEmail]);
    return jobOut(rows[0]);
  }
  const info = sdb.prepare(`INSERT INTO removal_jobs (${cols}) VALUES (?,?,?,?,?,?,'pending')`)
    .run(j.customerId, j.numberId, encPhone, j.brokerKey, j.brokerName, j.brokerEmail);
  return jobOut(sdb.prepare('SELECT * FROM removal_jobs WHERE id = ?').get(Number(info.lastInsertRowid)));
}

async function listRemovalJobs() {
  if (USE_PG) { const { rows } = await pool.query('SELECT * FROM removal_jobs ORDER BY id ASC'); return rows.map(jobOut); }
  return sdb.prepare('SELECT * FROM removal_jobs ORDER BY id ASC').all().map(jobOut);
}

const JOB_FIELDS = ['status', 'attempts', 'last_error', 'sent_at', 'next_eligible_at', 'last_reply_at', 'last_reply_kind'];
async function updateRemovalJob(id, fields) {
  const keys = JOB_FIELDS.filter((k) => k in fields);
  if (!keys.length) return;
  const vals = keys.map((k) => fields[k]);
  if (USE_PG) {
    const assigns = keys.map((k, i) => `${k} = $${i + 1}`).join(', ');
    await pool.query(`UPDATE removal_jobs SET ${assigns}, updated_at = now() WHERE id = $${keys.length + 1}`, [...vals, id]);
  } else {
    const assigns = keys.map((k) => `${k} = ?`).join(', ');
    sdb.prepare(`UPDATE removal_jobs SET ${assigns}, updated_at = datetime('now') WHERE id = ?`).run(...vals, Number(id));
  }
}

// --- broker replies (reply tracking) -------------------------------------
function toSqliteTs(iso) { return String(iso).replace('T', ' ').replace(/\.\d+/, '').replace('Z', ''); }

async function getRemovalJobById(id) {
  if (USE_PG) { const { rows } = await pool.query('SELECT * FROM removal_jobs WHERE id = $1', [id]); return jobOut(rows[0] || null); }
  return jobOut(sdb.prepare('SELECT * FROM removal_jobs WHERE id = ?').get(Number(id)) || null);
}

async function insertReply(r) {
  const cols = 'job_id,customer_id,broker_key,from_addr,subject,snippet,classification';
  const vals = [r.jobId || null, r.customerId || null, r.brokerKey || null, r.fromAddr || null, r.subject || null, r.snippet || null, r.classification || null];
  if (USE_PG) {
    const { rows } = await pool.query(`INSERT INTO removal_replies (${cols}) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`, vals);
    return rows[0];
  }
  const info = sdb.prepare(`INSERT INTO removal_replies (${cols}) VALUES (?,?,?,?,?,?,?)`).run(...vals);
  return sdb.prepare('SELECT * FROM removal_replies WHERE id = ?').get(Number(info.lastInsertRowid));
}

async function listRepliesSince(iso) {
  if (USE_PG) { const { rows } = await pool.query('SELECT * FROM removal_replies WHERE received_at >= $1 ORDER BY id ASC', [iso]); return rows; }
  return sdb.prepare('SELECT * FROM removal_replies WHERE received_at >= ? ORDER BY id ASC').all(toSqliteTs(iso));
}

// Roll-up counts for one customer's dashboard (cleared = confirmed removed or
// no record; in progress = everything not yet terminal). No broker names.
async function getRemovalStats(customerId) {
  let rows;
  if (USE_PG) { const r = await pool.query('SELECT status, attempts FROM removal_jobs WHERE customer_id = $1', [customerId]); rows = r.rows; }
  else { rows = sdb.prepare('SELECT status, attempts FROM removal_jobs WHERE customer_id = ?').all(customerId); }
  let cleared = 0, inProgress = 0, requestsSent = 0, exposure = 0;
  for (const j of rows) {
    const terminal = (j.status === 'removed' || j.status === 'no_record');
    if (terminal) cleared++; else inProgress++;
    const sent = (j.attempts || 0) > 0 || j.status === 'sent' || j.status === 'needs_followup';
    if (sent || terminal) requestsSent++;
    // Residual exposure per broker list: not contacted yet = full, request in
    // flight = partial, confirmed gone = none. Drives the dashboard threat bar.
    exposure += terminal ? 0 : (sent ? 0.55 : 1);
  }
  const total = rows.length;
  const threatPct = total ? Math.round((exposure / total) * 100) : 100;
  // cleared/inProgress kept for back-compat; the rest feed the tiles + threat bar.
  return { cleared, inProgress, total, requestsSent, confirmedRemoved: cleared, active: inProgress, threatPct };
}

// --- in-app customer alerts (dashboard notifications, not email) -----------
async function insertAlert(a) {
  a = a || {};
  const cid = a.customerId;
  if (!cid) return;
  const kind = String(a.kind || 'info').slice(0, 40);
  const title = String(a.title || '').slice(0, 160);
  const body = a.body == null ? null : String(a.body).slice(0, 500);
  const brokerKey = a.brokerKey ? String(a.brokerKey).slice(0, 60) : null;
  if (USE_PG) {
    await pool.query(`INSERT INTO customer_alerts (customer_id, kind, title, body, broker_key) VALUES ($1,$2,$3,$4,$5)`, [cid, kind, title, body, brokerKey]);
  } else {
    sdb.prepare(`INSERT INTO customer_alerts (customer_id, kind, title, body, broker_key) VALUES (?,?,?,?,?)`).run(cid, kind, title, body, brokerKey);
  }
}

async function listAlertsForCustomer(customerId, limit) {
  limit = Math.min(Math.max(parseInt(limit || 50, 10), 1), 200);
  if (USE_PG) {
    const { rows } = await pool.query(`SELECT id, kind, title, body, broker_key, read, created_at FROM customer_alerts WHERE customer_id = $1 ORDER BY id DESC LIMIT $2`, [customerId, limit]);
    return rows.map((r) => Object.assign({}, r, { read: !!r.read }));
  }
  return sdb.prepare(`SELECT id, kind, title, body, broker_key, read, created_at FROM customer_alerts WHERE customer_id = ? ORDER BY id DESC LIMIT ?`).all(customerId, limit).map((r) => Object.assign({}, r, { read: !!r.read }));
}

async function countUnreadAlerts(customerId) {
  if (USE_PG) {
    const { rows } = await pool.query(`SELECT COUNT(*)::int AS c FROM customer_alerts WHERE customer_id = $1 AND read = false`, [customerId]);
    return rows[0] ? rows[0].c : 0;
  }
  const r = sdb.prepare(`SELECT COUNT(*) AS c FROM customer_alerts WHERE customer_id = ? AND read = 0`).get(customerId);
  return r ? r.c : 0;
}

async function markAlertsRead(customerId) {
  if (USE_PG) {
    await pool.query(`UPDATE customer_alerts SET read = true WHERE customer_id = $1 AND read = false`, [customerId]);
  } else {
    sdb.prepare(`UPDATE customer_alerts SET read = 1 WHERE customer_id = ? AND read = 0`).run(customerId);
  }
}

// --- funnel analytics (private dashboard) --------------------------------
async function recordFunnelEvent(e) {
  e = e || {};
  const event = String(e.event || '').slice(0, 40);
  if (!event) return;
  const visitor = (e.visitorId ? String(e.visitorId).slice(0, 64) : '') || null;
  const email = e.email ? String(e.email).trim().toLowerCase().slice(0, 200) : null;
  const phone = e.phone ? (String(e.phone).replace(/\D/g, '').slice(-10) || null) : null;
  const plan = e.plan ? String(e.plan).slice(0, 20) : null;
  const amount = Number.isFinite(e.amount) ? Math.round(e.amount) : null;
  const meta = e.meta == null ? null : String(typeof e.meta === 'string' ? e.meta : JSON.stringify(e.meta)).slice(0, 500);
  if (USE_PG) {
    await pool.query(
      `INSERT INTO funnel_events (visitor_id, event, email, phone, plan, amount, meta) VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [visitor, event, email, phone, plan, amount, meta]
    );
  } else {
    sdb.prepare(`INSERT INTO funnel_events (visitor_id, event, email, phone, plan, amount, meta) VALUES (?,?,?,?,?,?,?)`)
      .run(visitor, event, email, phone, plan, amount, meta);
  }
}

async function getFunnelEventsSince(iso) {
  if (USE_PG) {
    const { rows } = await pool.query('SELECT id, visitor_id, event, email, phone, plan, amount, created_at FROM funnel_events WHERE created_at >= $1 ORDER BY id ASC', [iso]);
    return rows;
  }
  return sdb.prepare('SELECT id, visitor_id, event, email, phone, plan, amount, created_at FROM funnel_events WHERE created_at >= ? ORDER BY id ASC').all(toSqliteTs(iso));
}

module.exports = {
  init, saveCustomer, getCustomerByEmail, getCustomerBySubscription, getCustomerByPhoneHash, findCustomersByPhone, deleteCustomersByIds, getCustomerById, listCustomers, updateStatus,
  incrementVerifySends, getVerifySendsToday, maskEmail, markEventProcessed, unmarkEventProcessed, listCustomersWithNumbers, updateNumberStatus,
  getNumbersForCustomer, getRemovalJob, getRemovalJobById, insertRemovalJob, listRemovalJobs, updateRemovalJob,
  insertReply, listRepliesSince, getRemovalStats, insertAlert, listAlertsForCustomer, countUnreadAlerts, markAlertsRead,
  recordFunnelEvent, getFunnelEventsSince,
};
