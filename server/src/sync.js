/**
 * Spendo - sync
 *
 * One endpoint, one round trip: the device sends what it has changed and the cursor
 * it last saw, and gets back everything changed since. Push and pull in the same
 * request, because two endpoints means two chances to succeed at one and fail at the
 * other, and a client that has to reason about that.
 *
 * Conflicts are last-write-wins on `updated_at`, decided by the writer's clock. That
 * is the right trade here and not laziness: this is one person's ledger on their own
 * devices, edits to the same record from two phones inside the same second are not a
 * real scenario, and the alternatives (vector clocks, a merge UI) cost more than the
 * problem. Where it matters that nothing is lost - a delete - the record is a
 * tombstone rather than a removal, so a late-arriving edit can still be seen.
 *
 * The push is applied first and then included in the pull, so the device gets its own
 * writes back with their server change_seq. That is the acknowledgement: a record is
 * only marked clean once it has come back.
 */

import { transaction } from './db.js';

/** Anything larger is a client bug, not a purchase. */
const MAX_AMOUNT = 999_999_999.99;
const PAGE = 500;

class BadRequest extends Error {
  constructor(message) {
    super(message);
    this.status = 400;
  }
}

const isYM = (v) => typeof v === 'string' && /^\d{4}-(0[1-9]|1[0-2])$/.test(v);
const isDate = (v) => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v);

/** Epoch milliseconds to a timestamptz, or null. */
function toStamp(ms, field, id) {
  if (ms === null || ms === undefined) return null;
  if (!Number.isFinite(ms) || ms < 0) throw new BadRequest(`${field} on ${id} is not a timestamp`);
  return new Date(ms).toISOString();
}

/*
 * `if (!raw.updatedAt)` was the first version of this check and it is wrong: epoch 0
 * is a real timestamp and a falsy number. A record carrying updatedAt: 0 was refused
 * as "missing", and because a refusal used to fail the whole request, that one record
 * wedged every other change on the device permanently.
 */
const hasStamp = (v) => Number.isFinite(v) && v >= 0;

const toMillis = (v) => (v ? new Date(v).getTime() : null);

function readEntry(raw) {
  if (!raw || typeof raw !== 'object') throw new BadRequest('an entry was not an object');
  const id = raw.id;
  if (typeof id !== 'string' || !id || id.length > 128) throw new BadRequest('an entry has no usable id');
  if (!isDate(raw.date)) throw new BadRequest(`date on ${id} is not YYYY-MM-DD`);
  if (!isYM(raw.ym)) throw new BadRequest(`ym on ${id} is not YYYY-MM`);

  const amount = Number(raw.amount);
  if (!Number.isFinite(amount) || amount < 0 || amount > MAX_AMOUNT) {
    throw new BadRequest(`amount on ${id} is out of range`);
  }
  if (raw.direction !== 'in' && raw.direction !== 'out') {
    throw new BadRequest(`direction on ${id} must be "in" or "out"`);
  }
  if (!hasStamp(raw.updatedAt)) throw new BadRequest(`updatedAt is missing or not a number on ${id}`);

  return {
    id,
    ym: raw.ym,
    date: raw.date,
    amount,
    direction: raw.direction,
    description: String(raw.description ?? '').slice(0, 500),
    category: String(raw.category ?? 'other').slice(0, 64),
    enteredAt: toStamp(raw.createdAt ?? raw.updatedAt, 'createdAt', id),
    updatedAt: toStamp(raw.updatedAt, 'updatedAt', id),
    deletedAt: toStamp(raw.deletedAt ?? null, 'deletedAt', id)
  };
}

function readMonth(raw) {
  if (!raw || typeof raw !== 'object') throw new BadRequest('a month was not an object');
  if (!isYM(raw.ym)) throw new BadRequest(`month ${raw.ym} is not YYYY-MM`);
  const opening = Number(raw.opening);
  if (!Number.isFinite(opening) || Math.abs(opening) > MAX_AMOUNT) {
    throw new BadRequest(`opening on ${raw.ym} is out of range`);
  }
  if (!hasStamp(raw.updatedAt)) throw new BadRequest(`updatedAt is missing or not a number on month ${raw.ym}`);
  return {
    ym: raw.ym,
    opening,
    closedAt: toStamp(raw.closedAt ?? null, 'closedAt', raw.ym),
    updatedAt: toStamp(raw.updatedAt, 'updatedAt', raw.ym)
  };
}

const entryOut = (r) => ({
  id: r.id,
  date: typeof r.txn_date === 'string' ? r.txn_date : r.txn_date.toISOString().slice(0, 10),
  ym: r.ym,
  amount: Number(r.amount),
  direction: r.direction,
  description: r.description,
  category: r.category,
  createdAt: toMillis(r.entered_at),
  updatedAt: toMillis(r.updated_at),
  deletedAt: toMillis(r.deleted_at),
  seq: Number(r.change_seq)
});

const monthOut = (r) => ({
  ym: r.ym,
  opening: Number(r.opening_amount),
  closedAt: toMillis(r.closed_at),
  updatedAt: toMillis(r.updated_at),
  seq: Number(r.change_seq)
});

/*
 * A ceiling on what one account may store.
 *
 * There was none, and account creation is free to anyone who can receive mail, so
 * the shape of the abuse was obvious: sign up, push 2000 records a request, repeat.
 * Whoever pays the database bill pays for that.
 *
 * The numbers are chosen to be invisible to a person and hard work for a script.
 * Fifty thousand entries is a hundred a week for a decade. Twelve hundred months is
 * a century of them.
 *
 * The cap applies to NEW records only. An account at its ceiling can still edit and
 * still delete - deletes are tombstones, which are updates - because a limit that
 * traps someone at their limit with no way down is a bug wearing a policy's hat.
 */
const MAX_ENTRIES_PER_ACCOUNT = Number(process.env.MAX_ENTRIES_PER_ACCOUNT || 50_000);
const MAX_MONTHS_PER_ACCOUNT = Number(process.env.MAX_MONTHS_PER_ACCOUNT || 1200);

/**
 * Which of these ids the account already has, so an insert can be told from an edit.
 *
 * One query for the batch rather than one per record: `= any($2)` takes the whole
 * list, and the (account_id, id) primary key answers it from the index.
 */
async function existingIds(client, table, accountId, column, values) {
  if (!values.length) return new Set();
  const { rows } = await client.query(
    `select ${column} as key from ${table} where account_id = $1 and ${column} = any($2)`,
    [accountId, values]
  );
  return new Set(rows.map((r) => r.key));
}

/**
 * Trim a batch to what the account has room for, and say what was left out.
 *
 * Rejections come back in the response the same way a malformed record does, so the
 * device shows them rather than retrying forever against a wall.
 */
async function withinQuota(client, accountId, records, opts) {
  const { table, column, max, kind } = opts;
  if (!records.length) return { allowed: records, refused: [] };

  const have = await existingIds(client, table, accountId, column, records.map((r) => r[column]));
  const updates = records.filter((r) => have.has(r[column]));
  const inserts = records.filter((r) => !have.has(r[column]));
  if (!inserts.length) return { allowed: records, refused: [] };

  const { rows } = await client.query(
    `select count(*)::int as n from ${table} where account_id = $1`,
    [accountId]
  );
  const room = Math.max(0, max - rows[0].n);
  if (inserts.length <= room) return { allowed: records, refused: [] };

  return {
    allowed: [...updates, ...inserts.slice(0, room)],
    refused: inserts.slice(room).map((r) => ({
      id: r[column],
      kind,
      reason: `this account is at its limit of ${max} ${kind === 'entry' ? 'entries' : 'months'}`
    }))
  };
}

/** Exported for the test suite, which checks that one bad record cannot wedge a batch. */
export const readEntryForTest = readEntry;

/** Exported for the test suite, which checks the ceiling lets edits and deletes through. */
export const withinQuotaForTest = withinQuota;

export async function sync(req, res, next) {
  try {
    const accountId = req.session.account_id;
    const body = req.body || {};

    const since = Number(body.since || 0);
    if (!Number.isFinite(since) || since < 0) throw new BadRequest('since must be a number');

    /*
     * A record the server cannot read is rejected on its own, and the rest of the
     * batch still goes through.
     *
     * The first version threw on the first bad record and failed the whole request.
     * That is a trap in a sync engine rather than strictness: one malformed row -
     * left behind by an old client, a hand-edited store, a bug since fixed - means
     * the device can never sync anything again, retries forever, and shows a pending
     * count that only goes up. The rejects come back in the response so they can be
     * looked at instead of silently vanishing.
     */
    const rejected = [];
    const take = (list, read, name) => {
      const out = [];
      for (const raw of list) {
        try {
          out.push(read(raw));
        } catch (err) {
          rejected.push({ id: raw?.id ?? raw?.ym ?? '(unknown)', kind: name, reason: err.message });
        }
      }
      return out;
    };

    const entries = Array.isArray(body.entries) ? take(body.entries, readEntry, 'entry') : [];
    const months = Array.isArray(body.months) ? take(body.months, readMonth, 'month') : [];
    if (entries.length > 2000 || months.length > 500) {
      throw new BadRequest('too many records in one request; send them in batches');
    }

    const result = await transaction(async (client) => {
      const entryQuota = await withinQuota(client, accountId, entries, {
        table: 'expenses', column: 'id', max: MAX_ENTRIES_PER_ACCOUNT, kind: 'entry'
      });
      const monthQuota = await withinQuota(client, accountId, months, {
        table: 'months', column: 'ym', max: MAX_MONTHS_PER_ACCOUNT, kind: 'month'
      });
      const overQuota = [...entryQuota.refused, ...monthQuota.refused];

      for (const e of entryQuota.allowed) {
        /*
         * The `where` on the conflict clause is what makes this last-write-wins
         * rather than last-request-wins. An older copy of a record arriving from a
         * device that has been offline for a week must not overwrite an edit made
         * yesterday on another one. No match means no update and no error, which is
         * correct: the device will be sent the newer row in the pull below.
         */
        await client.query(
          `insert into expenses
             (id, account_id, ym, txn_date, amount, direction, description, category,
              entered_at, updated_at, deleted_at, change_seq)
           values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, nextval('change_seq'))
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
           where excluded.updated_at > expenses.updated_at`,
          [e.id, accountId, e.ym, e.date, e.amount, e.direction, e.description,
           e.category, e.enteredAt, e.updatedAt, e.deletedAt]
        );
      }

      for (const m of monthQuota.allowed) {
        await client.query(
          `insert into months (account_id, ym, opening_amount, closed_at, updated_at, change_seq)
           values ($1, $2, $3, $4, $5, nextval('change_seq'))
           on conflict (account_id, ym) do update set
             opening_amount = excluded.opening_amount,
             closed_at      = excluded.closed_at,
             updated_at     = excluded.updated_at,
             change_seq     = nextval('change_seq')
           where excluded.updated_at > months.updated_at`,
          [accountId, m.ym, m.opening, m.closedAt, m.updatedAt]
        );
      }

      // Read back inside the same transaction, so the cursor the device stores can
      // never name a change it was not sent.
      const pulledEntries = await client.query(
        `select * from expenses
         where account_id = $1 and change_seq > $2
         order by change_seq
         limit $3`,
        [accountId, since, PAGE]
      );
      const pulledMonths = await client.query(
        `select * from months
         where account_id = $1 and change_seq > $2
         order by change_seq
         limit $3`,
        [accountId, since, PAGE]
      );
      return { pulledEntries: pulledEntries.rows, pulledMonths: pulledMonths.rows, overQuota };
    });

    // Refused for space, alongside refused for shape. Both are things the device has
    // to be told about rather than left to retry.
    rejected.push(...result.overQuota);

    const outEntries = result.pulledEntries.map(entryOut);
    const outMonths = result.pulledMonths.map(monthOut);

    /*
     * The cursor only advances as far as it is safe to.
     *
     * Taking the highest sequence across both lists is wrong when one of them was
     * cut off by the page limit: 500 entries ending at seq 1000 alongside three
     * months at seq 5002 would move the cursor to 5002 and the entries between 1000
     * and 5002 would never be sent again. So a truncated list caps the cursor at its
     * own last row, and anything above that is simply sent again next round, which
     * is free because applying a record twice is idempotent.
     */
    const maxSeq = (rows) => (rows.length ? Math.max(...rows.map((r) => r.seq)) : since);
    const capped = [];
    if (outEntries.length === PAGE) capped.push(maxSeq(outEntries));
    if (outMonths.length === PAGE) capped.push(maxSeq(outMonths));

    const cursor = capped.length
      ? Math.min(...capped)
      : Math.max(since, maxSeq(outEntries), maxSeq(outMonths));
    const hasMore = capped.length > 0;

    res.json({
      cursor,
      hasMore,
      entries: outEntries,
      months: outMonths,
      rejected,
      serverTime: Date.now()
    });
  } catch (err) {
    next(err);
  }
}
