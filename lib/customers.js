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

async function saveCustomer(input) {
  const r = normalize(input);
  const vals = [r.email, r.name, r.phone, r.plan, r.billing, r.bump, r.status, r.stripe_customer, r.stripe_subscription];
  if (USE_PG) {
    const { rows } = await pool.query(
      `INSERT INTO customers (${COLS}) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
      vals
    );
    console.log('[db] customer saved:', r.email || '(no email)', '-', r.plan);
    return rowOut(rows[0]);
  }
  const info = sdb.prepare(`INSERT INTO customers (${COLS}) VALUES (?,?,?,?,?,?,?,?,?)`)
    .run(r.email, r.name, r.phone, r.plan, r.billing, r.bump ? 1 : 0, r.status, r.stripe_customer, r.stripe_subscription);
  console.log('[db] customer saved (sqlite):', r.email || '(no email)', '-', r.plan);
  return rowOut(sdb.prepare('SELECT * FROM customers WHERE id = ?').get(Number(info.lastInsertRowid)));
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

async function updateStatus(id, status) {
  if (USE_PG) {
    await pool.query('UPDATE customers SET status = $1 WHERE id = $2', [status, id]);
  } else {
    sdb.prepare('UPDATE customers SET status = ? WHERE id = ?').run(status, Number(id));
  }
}

module.exports = { init, saveCustomer, getCustomerByEmail, listCustomers, updateStatus };
