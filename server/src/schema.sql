-- Spendo - schema
--
-- Run with `npm run migrate`. Every statement is idempotent, so running it against
-- a live database is safe and is how a column gets added later.
--
-- Naming follows the decision recorded in CLAUDE.md: accounts, sessions and
-- login_codes for identity, months and expenses for the ledger.

create extension if not exists "pgcrypto";

-- One sequence for the whole database, and every write takes a number from it.
--
-- This is the pull cursor. The obvious alternative is "give me everything changed
-- since timestamp X", which is wrong on real phones: a device whose clock is a few
-- seconds fast writes a row stamped in the future, the next pull asks for changes
-- after a cursor that has already passed it, and that row is never sent again. A
-- sequence is assigned by the server, is monotonic by construction, and cannot skip.
create sequence if not exists change_seq;

-- ----------------------------------------------------------------- identity

create table if not exists accounts (
  -- Server-assigned. The first correct sign-in code for an address creates the row,
  -- so the id is minted here rather than on the device. An earlier version had the
  -- phone generate it and the server adopt it, which meant /api/register had to be
  -- open to anyone: the id was a claim nobody had to back up. Proving you can read
  -- mail at an address is the claim now.
  id                uuid primary key default gen_random_uuid(),
  -- The address that owns this account. Not null in practice - an account only comes
  -- into existence by verifying one - but left nullable so the column can be widened
  -- later (a second factor, a linked provider) without a rewrite.
  email             text unique,
  email_verified_at timestamptz,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);

-- One row per device that has been given a token. Revoking a device is one update.
create table if not exists sessions (
  id           uuid primary key,
  account_id   uuid not null references accounts(id) on delete cascade,
  -- The token itself is never stored. A leaked database should not hand out
  -- working credentials.
  token_hash   text not null unique,
  device_label text,
  created_at   timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  -- A session that is never used still stops working. Without this a token leaked
  -- from a phone sold two years ago is valid forever.
  expires_at   timestamptz not null default now() + interval '365 days',
  revoked_at   timestamptz
);

create index if not exists sessions_account_idx on sessions (account_id);

-- Ready for email login, unused until then. A code is stored hashed for the same
-- reason a token is, and expires whether or not it is used.
-- One row per address with a code outstanding, not one per code sent.
--
-- Keyed by email so that asking for a second code REPLACES the first rather than
-- leaving both valid: two live codes for one address doubles the guess surface for
-- no benefit, and makes "3 attempts" mean six. sent_at and sent_count are what the
-- rate limits are read from, and they live here rather than in memory so a restart
-- does not reset someone's quota.
create table if not exists login_codes (
  id          uuid primary key default gen_random_uuid(),
  email       text not null unique,
  code_hash   text not null,
  expires_at  timestamptz not null,
  attempts    integer not null default 0,
  sent_at     timestamptz not null default now(),
  sent_count  integer not null default 1,
  created_at  timestamptz not null default now()
);

-- ------------------------------------------------------------------- ledger

create table if not exists months (
  account_id     uuid not null references accounts(id) on delete cascade,
  ym             text not null,
  opening_amount numeric(14, 2) not null default 0,
  -- Phase 3, the Google Sheet mirror. Present now so the mirror does not need a
  -- migration on a live database.
  sheet_name     text,
  closed_at      timestamptz,
  updated_at     timestamptz not null,
  change_seq     bigint not null,
  primary key (account_id, ym)
);

create index if not exists months_pull_idx on months (account_id, change_seq);

create table if not exists expenses (
  -- Client-generated. The device has to be able to create a record with a real id
  -- while offline; a server-assigned id would mean every offline entry carries a
  -- temporary id that has to be rewritten on first sync, and every reference to it
  -- rewritten with it.
  --
  -- The key is (account_id, id), not id alone. A client id is only ever unique
  -- within the device that made it, so two accounts are entitled to collide, and a
  -- global primary key would silently drop one of them on insert.
  id                text not null,
  account_id        uuid not null references accounts(id) on delete cascade,
  ym                text not null,
  txn_date          date not null,
  amount            numeric(14, 2) not null check (amount >= 0),
  -- The n8n workflow only tracked money out. This app tracks both.
  direction         text not null check (direction in ('in', 'out')),
  description       text not null default '',
  category          text not null,
  -- Phase 3. Kept on soft-deleted rows too, which is the reason deletes are soft:
  -- the calendar event still has to be deleted after the expense is.
  calendar_event_id text,
  entered_at        timestamptz not null,
  updated_at        timestamptz not null,
  deleted_at        timestamptz,
  change_seq        bigint not null,
  primary key (account_id, id)
);

create index if not exists expenses_pull_idx on expenses (account_id, change_seq);
create index if not exists expenses_month_idx on expenses (account_id, ym);

-- There is deliberately no balance column anywhere in this file. Balance is
-- computed from opening_amount and the entries ordered by (txn_date, id). Storing
-- it is what made the n8n workflow rewrite every row on any backdated change, and
-- three of its nodes existed only to do that rewriting.
