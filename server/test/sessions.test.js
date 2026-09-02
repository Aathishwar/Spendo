/**
 * Spendo - session window tests
 *
 *     node --test test/
 *
 * The real schema against pg-mem, same as sync.test.js, and the same trade: what is
 * checked is the SQL, not a mock of it. The statements here are the ones auth.js
 * issues - kept in step by hand, because attachAccount takes a request and a request
 * is not a thing this suite has.
 *
 * What actually goes wrong with sessions, and so what is checked:
 *
 *   a device left alone for a month stops working
 *   a device in daily use does not
 *   a busy device still hits a ceiling eventually
 *   losing a phone can be answered from another one
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

const DAY = 24 * 60 * 60 * 1000;
const IDLE_MS = 30 * DAY;
const ABSOLUTE_MS = 182 * DAY;

function freshDb() {
  const db = newDb();
  db.public.registerFunction({
    name: 'gen_random_uuid', returns: 'uuid', impure: true,
    implementation: () => crypto.randomUUID()
  });
  db.public.none(SCHEMA.replace(/create extension if not exists "pgcrypto";/, ''));
  db.public.none(`insert into accounts (id) values ('${ACCOUNT_A}'), ('${ACCOUNT_B}')`);
  return db;
}

const iso = (ms) => new Date(ms).toISOString();

/** A session row, placed in time relative to now. */
function putSession(db, { account = ACCOUNT_A, hash, createdDaysAgo = 0, lastSeenDaysAgo = 0 }) {
  const created = Date.now() - createdDaysAgo * DAY;
  const seen = Date.now() - lastSeenDaysAgo * DAY;
  db.public.none(`
    insert into sessions (id, account_id, token_hash, device_label, created_at, last_seen_at, expires_at)
    values (gen_random_uuid(), '${account}', '${hash}', 'Android',
            '${iso(created)}', '${iso(seen)}', '${iso(seen + IDLE_MS)}')
  `);
}

/** attachAccount's lookup, with its two cutoffs. */
function lookup(db, hash) {
  const now = Date.now();
  return db.public.many(`
    select s.id as session_id, s.expires_at
      from sessions s
      join accounts a on a.id = s.account_id
     where s.token_hash = '${hash}'
       and s.revoked_at is null
       and s.expires_at > '${iso(now)}'
       and s.created_at > '${iso(now - ABSOLUTE_MS)}'
  `);
}

test('a device untouched for thirty days is signed out', () => {
  const db = freshDb();
  putSession(db, { hash: 'idle', createdDaysAgo: 40, lastSeenDaysAgo: 31 });
  assert.equal(lookup(db, 'idle').length, 0, 'an expired session still resolved');
});

test('a device used yesterday is not', () => {
  const db = freshDb();
  putSession(db, { hash: 'busy', createdDaysAgo: 40, lastSeenDaysAgo: 1 });
  assert.equal(lookup(db, 'busy').length, 1, 'a live session was refused');
});

test('a device in constant use still stops at the absolute ceiling', () => {
  const db = freshDb();
  // Used this morning, but issued last winter: expires_at has been pushed forward
  // all along, which is exactly the case the idle window cannot catch on its own.
  putSession(db, { hash: 'ancient', createdDaysAgo: 200, lastSeenDaysAgo: 0 });
  assert.equal(lookup(db, 'ancient').length, 0,
    'a session older than the ceiling resolved because expires_at kept moving');
});

test('using a session pushes its idle window forward', () => {
  const db = freshDb();
  putSession(db, { hash: 'renew', createdDaysAgo: 10, lastSeenDaysAgo: 25 });

  const before = new Date(lookup(db, 'renew')[0].expires_at).getTime();
  db.public.none(`
    update sessions set last_seen_at = now(), expires_at = '${iso(Date.now() + IDLE_MS)}'
     where token_hash = 'renew'
  `);
  const after = new Date(lookup(db, 'renew')[0].expires_at).getTime();

  assert.ok(after > before, 'the renewal did not move expires_at');
  assert.ok(after - Date.now() > 29 * DAY, 'the renewed window is not a full thirty days');
});

test('signing out everywhere ends this account and leaves the other alone', () => {
  const db = freshDb();
  putSession(db, { hash: 'phone' });
  putSession(db, { hash: 'tablet' });
  putSession(db, { hash: 'someone-else', account: ACCOUNT_B });

  db.public.none(`
    update sessions set revoked_at = now()
     where account_id = '${ACCOUNT_A}' and revoked_at is null
  `);

  assert.equal(lookup(db, 'phone').length, 0);
  assert.equal(lookup(db, 'tablet').length, 0, 'the other device on this account survived');
  assert.equal(lookup(db, 'someone-else').length, 1, 'another account was signed out too');
});

test('a revoked session cannot be used even before it expires', () => {
  const db = freshDb();
  putSession(db, { hash: 'revoked' });
  db.public.none(`update sessions set revoked_at = now() where token_hash = 'revoked'`);
  assert.equal(lookup(db, 'revoked').length, 0);
});
