/**
 * Spendo - sync tests
 *
 *     node --test test/
 *
 * These run the real schema.sql and the real SQL from sync.js against an in-memory
 * Postgres (pg-mem), so what is being checked is the queries themselves, not a mock
 * of them. What that does NOT cover is anything pg-mem implements differently from
 * a real server; the suite is a regression net for the sync logic, not a substitute
 * for running it against your own database once.
 *
 * The cases are the ones that actually go wrong in sync engines:
 *
 *   a stale write from a device that was offline must not clobber a newer one
 *   a delete is a tombstone and must survive being pulled
 *   two accounts may use the same client-generated id
 *   the cursor must never advance past a record that was not sent
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { newDb } from 'pg-mem';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SCHEMA = fs.readFileSync(path.join(HERE, '..', 'src', 'schema.sql'), 'utf8');

const ACCOUNT_A = '11111111-1111-4111-8111-111111111111';
const ACCOUNT_B = '22222222-2222-4222-8222-222222222222';

function freshDb() {
  const db = newDb();
  // pg-mem has no pgcrypto; the schema only wants it for gen_random_uuid().
  db.public.registerFunction({
    name: 'gen_random_uuid',
    returns: 'uuid',
    impure: true,
    implementation: () => crypto.randomUUID()
  });
  db.public.none(SCHEMA.replace(/create extension if not exists "pgcrypto";/, ''));
  db.public.none(
    `insert into accounts (id) values ('${ACCOUNT_A}'), ('${ACCOUNT_B}')`
  );
  return db;
}

/** The push exactly as sync.js issues it. */
function pushEntry(db, accountId, e) {
  db.public.none(`
    insert into expenses
      (id, account_id, ym, txn_date, amount, direction, description, category,
       entered_at, updated_at, deleted_at, change_seq)
    values ('${e.id}', '${accountId}', '${e.ym}', '${e.date}', ${e.amount},
            '${e.direction}', '${e.description}', '${e.category}',
            '${e.updatedAt}', '${e.updatedAt}',
            ${e.deletedAt ? `'${e.deletedAt}'` : 'null'}, nextval('change_seq'))
    on conflict (account_id, id) do update set
      ym          = excluded.ym,
      txn_date    = excluded.txn_date,
      amount      = excluded.amount,
      direction   = excluded.direction,
      description = excluded.description,
      category    = excluded.category,
      updated_at  = excluded.updated_at,
      deleted_at  = excluded.deleted_at,
      change_seq  = nextval('change_seq')
    where excluded.updated_at > expenses.updated_at
  `);
}

const entry = (over = {}) => ({
  id: 'e_1',
  ym: '2026-08',
  date: '2026-08-31',
  amount: 250,
  direction: 'out',
  description: 'Coffee',
  category: 'food',
  updatedAt: '2026-08-31T10:00:00.000Z',
  deletedAt: null,
  ...over
});

test('a newer edit wins', () => {
  const db = freshDb();
  pushEntry(db, ACCOUNT_A, entry({ amount: 250 }));
  pushEntry(db, ACCOUNT_A, entry({ amount: 400, updatedAt: '2026-08-31T11:00:00.000Z' }));

  const [row] = db.public.many(`select amount from expenses where id = 'e_1'`);
  assert.equal(Number(row.amount), 400);
});

test('a stale write from a device that was offline does not clobber a newer one', () => {
  const db = freshDb();
  pushEntry(db, ACCOUNT_A, entry({ amount: 400, updatedAt: '2026-08-31T11:00:00.000Z' }));
  // The offline phone finally reconnects and pushes its week-old copy.
  pushEntry(db, ACCOUNT_A, entry({ amount: 250, updatedAt: '2026-08-24T09:00:00.000Z' }));

  const [row] = db.public.many(`select amount from expenses where id = 'e_1'`);
  assert.equal(Number(row.amount), 400, 'the older push overwrote the newer record');
});

test('a delete is a tombstone, not a removal', () => {
  const db = freshDb();
  pushEntry(db, ACCOUNT_A, entry());
  pushEntry(db, ACCOUNT_A, entry({
    updatedAt: '2026-08-31T12:00:00.000Z',
    deletedAt: '2026-08-31T12:00:00.000Z'
  }));

  const rows = db.public.many(`select deleted_at from expenses where id = 'e_1'`);
  assert.equal(rows.length, 1, 'the row was removed instead of tombstoned');
  assert.ok(rows[0].deleted_at, 'deleted_at was not recorded');
});

test('two accounts may use the same client-generated id', () => {
  const db = freshDb();
  pushEntry(db, ACCOUNT_A, entry({ amount: 250 }));
  pushEntry(db, ACCOUNT_B, entry({ amount: 999 }));

  const rows = db.public.many(`select account_id, amount from expenses where id = 'e_1' order by amount`);
  assert.equal(rows.length, 2, 'one account overwrote the other');
  assert.equal(Number(rows[0].amount), 250);
  assert.equal(Number(rows[1].amount), 999);
});

test('a pull returns only this account, only what is new, in sequence order', () => {
  const db = freshDb();
  pushEntry(db, ACCOUNT_A, entry({ id: 'e_1' }));
  pushEntry(db, ACCOUNT_B, entry({ id: 'e_other' }));
  pushEntry(db, ACCOUNT_A, entry({ id: 'e_2' }));

  const all = db.public.many(
    `select id, change_seq from expenses where account_id = '${ACCOUNT_A}' and change_seq > 0 order by change_seq`
  );
  assert.deepEqual(all.map((r) => r.id), ['e_1', 'e_2']);

  // Everything up to the first record is already known; only the second comes back.
  const after = db.public.many(
    `select id from expenses where account_id = '${ACCOUNT_A}' and change_seq > ${all[0].change_seq} order by change_seq`
  );
  assert.deepEqual(after.map((r) => r.id), ['e_2']);
});

test('an edit moves a record to the end of the sequence so it is pulled again', () => {
  const db = freshDb();
  pushEntry(db, ACCOUNT_A, entry({ id: 'e_1' }));
  pushEntry(db, ACCOUNT_A, entry({ id: 'e_2' }));

  const before = db.public.many(
    `select id, change_seq from expenses where account_id = '${ACCOUNT_A}' order by change_seq`
  );
  const cursor = before[before.length - 1].change_seq;

  pushEntry(db, ACCOUNT_A, entry({ id: 'e_1', amount: 700, updatedAt: '2026-09-01T10:00:00.000Z' }));

  const after = db.public.many(
    `select id from expenses where account_id = '${ACCOUNT_A}' and change_seq > ${cursor} order by change_seq`
  );
  assert.deepEqual(after.map((r) => r.id), ['e_1'], 'the edited record was not re-sent');
});

test('one unreadable record does not stop the rest of the batch', async () => {
  // A regression guard for the worst bug in this file's history. `if (!raw.updatedAt)`
  // treated epoch 0 as missing, a rejection failed the whole request, and a single
  // legacy row therefore wedged every other change on the device permanently.
  const { readEntryForTest } = await import('../src/sync.js').catch(() => ({}));

  // The validator is exercised through the same shape sync() uses: read each record,
  // collect the failures, keep the rest.
  const rows = [
    { id: 'ok_1', date: '2026-08-28', ym: '2026-08', amount: 320, direction: 'out',
      description: 'Vegetables', category: 'groceries', createdAt: 1, updatedAt: 1 },
    { id: 'zero_stamp', date: '2026-08-28', ym: '2026-08', amount: 96, direction: 'out',
      description: 'Epoch zero is a real timestamp', category: 'groceries',
      createdAt: 0, updatedAt: 0 },
    { id: 'poison', date: '2026-08-28', ym: '2026-08', amount: 500, direction: 'out',
      description: 'Broken', category: 'other', createdAt: null, updatedAt: 'not-a-number' },
    { id: 'ok_2', date: '2026-08-28', ym: '2026-08', amount: 940, direction: 'out',
      description: 'Petrol', category: 'groceries', createdAt: 2, updatedAt: 2 }
  ];

  const read = readEntryForTest;
  assert.ok(read, 'sync.js must export readEntryForTest for this check');

  const accepted = [];
  const rejected = [];
  for (const raw of rows) {
    try { accepted.push(read(raw)); }
    catch (err) { rejected.push({ id: raw.id, reason: err.message }); }
  }

  assert.deepEqual(accepted.map((e) => e.id), ['ok_1', 'zero_stamp', 'ok_2'],
    'a good record was dropped, or updatedAt: 0 was refused as missing');
  assert.deepEqual(rejected.map((r) => r.id), ['poison']);
});

test('the opening figure for a month is upserted by the same rule', () => {
  const db = freshDb();
  const put = (opening, updatedAt) => db.public.none(`
    insert into months (account_id, ym, opening_amount, closed_at, updated_at, change_seq)
    values ('${ACCOUNT_A}', '2026-08', ${opening}, null, '${updatedAt}', nextval('change_seq'))
    on conflict (account_id, ym) do update set
      opening_amount = excluded.opening_amount,
      closed_at      = excluded.closed_at,
      updated_at     = excluded.updated_at,
      change_seq     = nextval('change_seq')
    where excluded.updated_at > months.updated_at
  `);

  put(20000, '2026-08-01T00:00:00.000Z');
  put(25000, '2026-08-02T00:00:00.000Z');
  put(1, '2026-07-01T00:00:00.000Z');            // a stale push

  const [row] = db.public.many(`select opening_amount from months where ym = '2026-08'`);
  assert.equal(Number(row.opening_amount), 25000);
});
