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

function needsSsl(url) {
  return !!url && !/localhost|127\.0\.0\.1/.test(url);
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
  }
  console.log('[db] ready (' + (USE_PG ? 'postgres' : 'sqlite dev') + ')');
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
  return Object.assign({}, r, { bump: !!r.bump });
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
    if (USE_PG) {
      await pool.query(
        `INSERT INTO protected_numbers (customer_id, phone, label, status) VALUES ($1,$2,$3,'pending')`,
        [customerId, phones[i], label]
      );
    } else {
      sdb.prepare(`INSERT INTO protected_numbers (customer_id, phone, label, status) VALUES (?,?,?,'pending')`)
        .run(customerId, phones[i], label);
    }
  }
}

async function saveCustomer(input) {
  const r = normalize(input);
  const phones = phonesFrom(input);
  if (phones.length) r.phone = phones[0]; // keep customers.phone = primary, for compat
  const vals = [r.email, r.name, r.phone, r.plan, r.billing, r.bump, r.status, r.stripe_customer, r.stripe_subscription];
  if (USE_PG) {
    const { rows } = await pool.query(
      `INSERT INTO customers (${COLS}) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
      vals
    );
    await insertNumbers(rows[0].id, phones);
    console.log('[db] customer saved:', r.email || '(no email)', '-', r.plan, '-', phones.length, 'number(s)');
    return rowOut(rows[0]);
  }
  const info = sdb.prepare(`INSERT INTO customers (${COLS}) VALUES (?,?,?,?,?,?,?,?,?)`)
    .run(r.email, r.name, r.phone, r.plan, r.billing, r.bump ? 1 : 0, r.status, r.stripe_customer, r.stripe_subscription);
  const id = Number(info.lastInsertRowid);
  await insertNumbers(id, phones);
  console.log('[db] customer saved (sqlite):', r.email || '(no email)', '-', r.plan, '-', phones.length, 'number(s)');
  return rowOut(sdb.prepare('SELECT * FROM customers WHERE id = ?').get(id));
}

async function getCustomerByEmail(email) {
  if (USE_PG) {
    const { rows } = await pool.query('SELECT * FROM customers WHERE email = $1 ORDER BY id DESC LIMIT 1', [email]);
    return rowOut(rows[0]);
  }
  return rowOut(sdb.prepare('SELECT * FROM customers WHERE email = ? ORDER BY id DESC LIMIT 1').get(email));
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
      id: n.id, phone: n.phone, label: n.label, status: n.status,
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

// --- removal jobs (autonomous email opt-out engine) ----------------------
async function getCustomerById(id) {
  if (USE_PG) { const { rows } = await pool.query('SELECT * FROM customers WHERE id = $1', [id]); return rowOut(rows[0]); }
  return rowOut(sdb.prepare('SELECT * FROM customers WHERE id = ?').get(Number(id)));
}

async function getNumbersForCustomer(customerId) {
  if (USE_PG) { const { rows } = await pool.query('SELECT id, phone, label, status FROM protected_numbers WHERE customer_id = $1 ORDER BY id ASC', [customerId]); return rows; }
  return sdb.prepare('SELECT id, phone, label, status FROM protected_numbers WHERE customer_id = ? ORDER BY id ASC').all(customerId);
}

async function getRemovalJob(numberId, brokerKey) {
  if (USE_PG) { const { rows } = await pool.query('SELECT * FROM removal_jobs WHERE number_id = $1 AND broker_key = $2 ORDER BY id DESC LIMIT 1', [numberId, brokerKey]); return rows[0] || null; }
  return sdb.prepare('SELECT * FROM removal_jobs WHERE number_id = ? AND broker_key = ? ORDER BY id DESC LIMIT 1').get(numberId, brokerKey) || null;
}

async function insertRemovalJob(j) {
  const cols = 'customer_id,number_id,phone,broker_key,broker_name,broker_email,status';
  if (USE_PG) {
    const { rows } = await pool.query(
      `INSERT INTO removal_jobs (${cols}) VALUES ($1,$2,$3,$4,$5,$6,'pending') RETURNING *`,
      [j.customerId, j.numberId, j.phone, j.brokerKey, j.brokerName, j.brokerEmail]);
    return rows[0];
  }
  const info = sdb.prepare(`INSERT INTO removal_jobs (${cols}) VALUES (?,?,?,?,?,?,'pending')`)
    .run(j.customerId, j.numberId, j.phone, j.brokerKey, j.brokerName, j.brokerEmail);
  return sdb.prepare('SELECT * FROM removal_jobs WHERE id = ?').get(Number(info.lastInsertRowid));
}

async function listRemovalJobs() {
  if (USE_PG) { const { rows } = await pool.query('SELECT * FROM removal_jobs ORDER BY id ASC'); return rows; }
  return sdb.prepare('SELECT * FROM removal_jobs ORDER BY id ASC').all();
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
  if (USE_PG) { const { rows } = await pool.query('SELECT * FROM removal_jobs WHERE id = $1', [id]); return rows[0] || null; }
  return sdb.prepare('SELECT * FROM removal_jobs WHERE id = ?').get(Number(id)) || null;
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

module.exports = {
  init, saveCustomer, getCustomerByEmail, getCustomerById, listCustomers, updateStatus,
  incrementVerifySends, listCustomersWithNumbers, updateNumberStatus,
  getNumbersForCustomer, getRemovalJob, getRemovalJobById, insertRemovalJob, listRemovalJobs, updateRemovalJob,
  insertReply, listRepliesSince,
};
