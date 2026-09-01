/**
 * Spendo - database
 *
 * One pool for the process. `DATABASE_URL` is read from server/.env; see
 * .env.example for the shape.
 */

import pg from 'pg';

const { Pool, types } = pg;

/*
 * numeric comes back from pg as a string, because a 64-bit numeric does not fit a
 * JavaScript number without loss. Every numeric in this schema is money capped at
 * 14 digits with 2 decimal places, which is inside Number's exact integer range once
 * scaled, so parsing to a number here is safe and saves every caller from remembering
 * that "0.00" is truthy.
 */
types.setTypeParser(types.builtins.NUMERIC, (v) => (v === null ? null : Number(v)));

/*
 * A `date` column comes back as a JS Date at midnight LOCAL time, so a row stored as
 * 2026-08-31 becomes 2026-08-30T18:30:00Z on a machine in IST, and reading the day
 * back out of it gives the 30th. The app's rule is that a date is the string
 * YYYY-MM-DD from end to end; this keeps it that way rather than converting twice
 * and hoping the offsets cancel.
 */
types.setTypeParser(types.builtins.DATE, (v) => v);

function sslConfig() {
  const mode = (process.env.PGSSL || '').toLowerCase();
  if (mode === 'disable') return false;
  if (mode === 'verify') return { rejectUnauthorized: true };
  if (mode === 'no-verify') return { rejectUnauthorized: false };

  // Unset: local Postgres almost never has TLS configured, and every hosted one
  // requires it. Guess from the host rather than making the user set a flag to run
  // the thing locally.
  const url = process.env.DATABASE_URL || '';
  const local = /@(localhost|127\.0\.0\.1|\[::1\])[:/]/.test(url);
  return local ? false : { rejectUnauthorized: false };
}

/**
 * Checked by the entry points, not here.
 *
 * This used to `process.exit(1)` at import time, which made every module that
 * imports db.js impossible to load in a test: importing sync.js to check its
 * validator killed the test runner before a single assertion ran. A library module
 * should not be able to end the process it is loaded into.
 */
export function assertConfigured() {
  if (process.env.DATABASE_URL) return;
  console.error(
    '[spendo] DATABASE_URL is not set.\n' +
    '         Put your connection string in server/.env:\n' +
    '           DATABASE_URL=postgres://user:password@host:5432/spendo\n'
  );
  process.exit(1);
}

/*
 * sslmode is stripped from the URL before the pool sees it.
 *
 * sslConfig() above already decides TLS explicitly, and node-postgres warns that it
 * is going to change what `sslmode=require` means (today: encrypt, do not verify;
 * planned: verify-full). Leaving both in place means the connection's behaviour
 * depends on which library version is installed. One decision, made here.
 */
function connectionString() {
  const raw = process.env.DATABASE_URL || '';
  try {
    const url = new URL(raw);
    url.searchParams.delete('sslmode');
    url.searchParams.delete('ssl');
    return url.toString();
  } catch {
    return raw;   // not a URL we can parse; hand it over untouched
  }
}

export const pool = new Pool({
  connectionString: connectionString(),
  ssl: sslConfig(),
  max: Number(process.env.PGPOOL_MAX || 10),
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 10_000
});

pool.on('error', (err) => {
  // An idle client dying is normal on hosted Postgres; the pool replaces it. Logging
  // it and carrying on is correct, crashing the server is not.
  console.warn('[spendo] idle database client error:', err.message);
});

export function query(text, params) {
  return pool.query(text, params);
}

/** Runs `fn` inside a transaction, rolling back on any throw. */
export async function transaction(fn) {
  const client = await pool.connect();
  try {
    await client.query('begin');
    const result = await fn(client);
    await client.query('commit');
    return result;
  } catch (err) {
    await client.query('rollback').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}
