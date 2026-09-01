/**
 * Spendo - migrate
 *
 *     npm run migrate
 *
 * Applies schema.sql, then migrations.sql. Every statement in both is idempotent, so
 * this is safe to run against a live database and is how a column gets added later.
 *
 * They are two files because `create table if not exists` does nothing to a table
 * that already exists: a column added to schema.sql after the first deploy reaches a
 * fresh database only. migrations.sql is where it reaches a live one.
 */

import 'dotenv/config';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertConfigured, pool } from './db.js';

assertConfigured();

const HERE = path.dirname(fileURLToPath(import.meta.url));

const read = (name) => fs.readFile(path.join(HERE, name), 'utf8');
const [schema, migrations] = await Promise.all([read('schema.sql'), read('migrations.sql')]);

try {
  // One transaction for both: a half-applied schema is worse than none.
  await pool.query('begin');
  await pool.query(schema);
  await pool.query(migrations);
  await pool.query('commit');
  console.log('[spendo] schema and migrations applied');
} catch (err) {
  await pool.query('rollback').catch(() => {});
  console.error('[spendo] migration failed:', err.message);
  process.exitCode = 1;
} finally {
  await pool.end();
}
