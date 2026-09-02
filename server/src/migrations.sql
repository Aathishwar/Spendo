-- Spendo - migrations
--
-- Applied by `npm run migrate`, immediately after schema.sql.
--
-- schema.sql uses `create table if not exists`, which is a no-op on a database that
-- already has the table. So anything added to a definition AFTER the first deploy
-- never reaches a live database from there, and has to be applied again here. Every
-- statement is idempotent and safe to re-run.
--
-- This is a separate file rather than a section of schema.sql because the test suite
-- loads schema.sql into pg-mem, and a fresh database already has the final shape -
-- the alters below would be re-describing columns that were just created.

-- Email login: an account is created by verifying an address, so its id can no
-- longer come from the device that happened to ask first.
alter table accounts alter column id set default gen_random_uuid();

-- Sessions expire. Without this a token taken off a phone sold two years ago still
-- works.
alter table sessions add column if not exists expires_at timestamptz;
update sessions set expires_at = created_at + interval '365 days' where expires_at is null;
alter table sessions alter column expires_at set default now() + interval '365 days';

-- Rate limiting for sign-in codes, and at most one live code per address.
alter table login_codes add column if not exists sent_at    timestamptz not null default now();
alter table login_codes add column if not exists sent_count integer     not null default 1;

-- The unique index cannot be created while duplicates exist. There is one row per
-- address from here on; anything older collapses to the newest.
delete from login_codes a using login_codes b where a.email = b.email and a.ctid < b.ctid;
create unique index if not exists login_codes_email_key on login_codes (email);

-- Sessions last thirty days of disuse, not a year.
--
-- A year was a token off a sold phone still working next summer. Thirty days is the
-- idle window; auth.js pushes expires_at forward while a device is actually in use,
-- so this signs out only what has been sitting untouched - and every existing
-- session, which is a one-off sign-in on each device and the point of the change.
alter table sessions alter column expires_at set default now() + interval '30 days';
update sessions
   set expires_at = least(expires_at, greatest(last_seen_at, created_at) + interval '30 days')
 where revoked_at is null;

-- Rows nobody can use again. Revoked or long expired sessions are kept for a month
-- to explain a device that stopped working, and swept after that.
delete from sessions
 where (revoked_at is not null and revoked_at < now() - interval '30 days')
    or expires_at < now() - interval '30 days';

-- Codes that were never used and are long dead.
delete from login_codes where expires_at < now() - interval '1 day';

-- The model-call quota, moved out of process memory. See schema.sql for why.
create table if not exists ai_usage (
  account_id   uuid not null references accounts(id) on delete cascade,
  window_start timestamptz not null,
  calls        integer not null default 0,
  primary key (account_id, window_start)
);
