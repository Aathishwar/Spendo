/**
 * Spendo - local store
 *
 * The phone is the working copy. Every mutation is written here and returns
 * immediately; nothing in this file waits on a network. Phase 2 adds a server and
 * a background sync, and it will read from exactly this shape - which is why every
 * record already carries `updatedAt` and `dirty`.
 *
 * The central decision: **balance is computed, never stored.** The n8n workflow this
 * replaces kept a Balance column, so a backdated expense or an undo forced it to
 * rewrite every row of the spreadsheet, and three of its code nodes existed only to
 * do that rewriting. Here, entries are sorted by date and the running balance falls
 * out of a reduce. Insert anything anywhere and every figure downstream is correct
 * on the next read, because there is no stored figure to be wrong.
 */

import { currentYM, daysInMonth, dayOf, todayISO, ymOf } from './format.js';

const KEY = 'spendo.v1';

const EMPTY = {
  version: 1,
  entries: [],          // { id, date, ym, amount, direction, description, category, createdAt, updatedAt, deletedAt, dirty }
  months: {},           // ym -> { opening, closedAt, updatedAt, dirty }
  settings: { theme: 'system', seenIntro: false },
  // What the sync engine remembers between runs. `cursor` is the server's change
  // sequence, not a timestamp; see server/src/schema.sql for why.
  sync: { cursor: 0, lastSyncedAt: null }
};

let state = load();
const listeners = new Set();

/* ------------------------------------------------------------- persistence */

function load() {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return structuredClone(EMPTY);
    const parsed = JSON.parse(raw);
    // Merge rather than replace, so a key added in a later version is present on
    // data written by an earlier one.
    return {
      ...structuredClone(EMPTY),
      ...parsed,
      settings: { ...EMPTY.settings, ...(parsed.settings || {}) },
      sync: { ...EMPTY.sync, ...(parsed.sync || {}) }
    };
  } catch (e) {
    // A private window, cleared site data, or a browser refusing storage. The app
    // still runs; it just forgets when it closes.
    console.warn('[store] could not read local data, starting empty:', e.message);
    return structuredClone(EMPTY);
  }
}

function persist() {
  try {
    localStorage.setItem(KEY, JSON.stringify(state));
  } catch (e) {
    console.warn('[store] could not write local data:', e.message);
  }
}

function commit() {
  persist();
  for (const fn of listeners) fn(state);
}

export function subscribe(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

function id() {
  return `e_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

/* ------------------------------------------------------------------ months */

export function openingOf(ym) {
  return Number(state.months[ym]?.opening) || 0;
}

export function isClosed(ym) {
  return Boolean(state.months[ym]?.closedAt);
}

/**
 * Two separate verbs on purpose. The Telegram bot's `/start` told the user it set
 * the opening balance and its code added to it, and nothing in the interface made
 * that visible. Here the caller has to say which one it means.
 */
export function setOpening(ym, amount) {
  const m = state.months[ym] || (state.months[ym] = { opening: 0, closedAt: null });
  m.opening = Number(amount) || 0;
  m.updatedAt = Date.now();
  m.dirty = true;
  commit();
}

export function addOpening(ym, amount) {
  setOpening(ym, openingOf(ym) + (Number(amount) || 0));
}

/** Every month that has an opening balance or at least one entry, newest first. */
export function months() {
  const set = new Set(Object.keys(state.months));
  for (const e of state.entries) if (!e.deletedAt) set.add(e.ym);
  set.add(currentYM());
  return [...set].sort().reverse();
}

/* ----------------------------------------------------------------- entries */

/**
 * Sorted by transaction date, then by entry time. Backdating an expense drops it
 * into the right position rather than appending it and forcing a re-sort of the
 * whole sheet afterwards.
 */
export function entriesFor(ym) {
  return state.entries
    .filter((e) => e.ym === ym && !e.deletedAt)
    .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : a.createdAt - b.createdAt));
}

export function entry(entryId) {
  return state.entries.find((e) => e.id === entryId) || null;
}

export function addEntry({ amount, direction = 'out', description, category, date }) {
  const when = date || todayISO();
  const record = {
    id: id(),
    date: when,
    ym: ymOf(when),
    amount: Math.abs(Number(amount) || 0),
    direction: direction === 'in' ? 'in' : 'out',
    description: String(description || '').trim(),
    category: category || 'other',
    createdAt: Date.now(),
    updatedAt: Date.now(),
    deletedAt: null,
    dirty: true
  };
  state.entries.push(record);
  commit();
  return record;
}

export function updateEntry(entryId, patch) {
  const e = entry(entryId);
  if (!e) return null;
  Object.assign(e, patch);
  if (patch.date) e.ym = ymOf(patch.date);
  if (patch.amount != null) e.amount = Math.abs(Number(patch.amount) || 0);
  e.updatedAt = Date.now();
  e.dirty = true;
  commit();
  return e;
}

/**
 * Soft delete. It keeps undo trivial and, from phase 3, keeps the Google Calendar
 * event id around long enough for the server to delete the event it points at.
 */
export function removeEntry(entryId) {
  const e = entry(entryId);
  if (!e) return null;
  e.deletedAt = Date.now();
  e.updatedAt = Date.now();
  e.dirty = true;
  commit();
  return e;
}

export function restoreEntry(entryId) {
  const e = entry(entryId);
  if (!e) return null;
  e.deletedAt = null;
  e.updatedAt = Date.now();
  e.dirty = true;
  commit();
  return e;
}

/* ------------------------------------------------------------------- stats */

/**
 * Everything the Home screen needs, computed in one pass so the numbers on screen
 * cannot disagree with each other.
 */
export function monthStats(ym) {
  const list = entriesFor(ym);
  const opening = openingOf(ym);

  let spent = 0;
  let received = 0;
  for (const e of list) {
    if (e.direction === 'in') received += e.amount;
    else spent += e.amount;
  }

  const balance = opening + received - spent;
  const total = daysInMonth(ym);
  const isCurrent = ym === currentYM();
  const dayNow = isCurrent ? dayOf(todayISO()) : total;
  const daysLeft = isCurrent ? total - dayNow : 0;

  // Per-day spend for the bar chart. Income is deliberately not netted off a day:
  // the chart answers "how much went out on the 14th", and a refund arriving that
  // day does not make the spending smaller.
  const perDay = new Array(total).fill(0);
  for (const e of list) {
    if (e.direction === 'out') perDay[dayOf(e.date) - 1] += e.amount;
  }

  return {
    ym,
    opening,
    spent,
    received,
    balance,
    count: list.length,
    perDay,
    daysInMonth: total,
    dayNow,
    daysLeft,
    isCurrent,
    closed: isClosed(ym),
    // Averaged over days elapsed, not over the whole month, so the figure means
    // "what I have been spending" rather than a number that climbs all month.
    avgPerDay: dayNow > 0 ? spent / dayNow : 0,
    // What is left, spread over the days that are left. This is the number that
    // actually changes behaviour.
    safePerDay: daysLeft > 0 ? Math.max(0, balance) / daysLeft : 0,
    // The reference line on the chart: the whole month's money spread evenly.
    budgetPerDay: total > 0 ? (opening + received) / total : 0
  };
}

/** Running balance after each entry, in the same order `entriesFor` returns. */
export function withBalances(ym) {
  let balance = openingOf(ym);
  return entriesFor(ym).map((e) => {
    balance += e.direction === 'in' ? e.amount : -e.amount;
    return { ...e, balance };
  });
}

/** Expense totals per category, largest first. Income is not a spending category. */
export function categoryTotals(ym) {
  const totals = new Map();
  for (const e of entriesFor(ym)) {
    if (e.direction !== 'out') continue;
    totals.set(e.category, (totals.get(e.category) || 0) + e.amount);
  }
  const spent = [...totals.values()].reduce((a, b) => a + b, 0);
  return [...totals.entries()]
    .map(([id_, amount]) => ({ id: id_, amount, share: spent > 0 ? amount / spent : 0 }))
    .sort((a, b) => b.amount - a.amount);
}

/** Descriptions used before, most recent first, for the add sheet's suggestions. */
export function recentDescriptions(limit = 8) {
  const seen = [];
  for (let i = state.entries.length - 1; i >= 0 && seen.length < limit; i--) {
    const e = state.entries[i];
    if (e.deletedAt || !e.description) continue;
    if (!seen.some((s) => s.toLowerCase() === e.description.toLowerCase())) seen.push(e.description);
  }
  return seen;
}

/* ---------------------------------------------------------------- settings */

export function settings() {
  return { ...state.settings };
}

export function setSetting(key, value) {
  state.settings[key] = value;
  commit();
}

/* -------------------------------------------------------------------- sync */

/*
 * The store has always stamped `updatedAt` and `dirty` on every write, so the sync
 * engine needs nothing new from it beyond a way to read the dirty set and a way to
 * merge what comes back. Nothing below touches the network; js/sync.js owns that.
 */

export function syncMeta() {
  return { ...state.sync };
}

/** Everything this device has changed and not yet had confirmed by the server. */
export function pendingChanges() {
  return {
    entries: state.entries.filter((e) => e.dirty),
    // The ym is the key rather than a field, so it is put back on the way out.
    months: Object.entries(state.months)
      .filter(([, m]) => m.dirty)
      .map(([ym, m]) => ({
        ym,
        opening: Number(m.opening) || 0,
        closedAt: m.closedAt ?? null,
        updatedAt: m.updatedAt || Date.now()
      }))
  };
}

export function pendingCount() {
  const { entries, months } = pendingChanges();
  return entries.length + months.length;
}

/**
 * Merges what the server sent, and clears `dirty` on anything it confirmed.
 *
 * A record that came back unchanged from what we pushed IS the acknowledgement, so
 * this is where dirty is cleared - not when the request is sent. If the user edited
 * a record while the request was in flight its local `updatedAt` is now newer than
 * the server's copy, so it is left alone, stays dirty, and goes again next round.
 */
export function applySync({ entries = [], months = [], cursor = null }) {
  const byId = new Map(state.entries.map((e) => [e.id, e]));

  for (const incoming of entries) {
    const { seq, ...record } = incoming;
    const local = byId.get(record.id);
    if (local && (local.updatedAt || 0) > (record.updatedAt || 0)) continue;
    if (local) Object.assign(local, record, { dirty: false });
    else {
      const added = { ...record, dirty: false };
      state.entries.push(added);
      byId.set(added.id, added);
    }
  }

  for (const incoming of months) {
    const local = state.months[incoming.ym];
    if (local && (local.updatedAt || 0) > (incoming.updatedAt || 0)) continue;
    state.months[incoming.ym] = {
      opening: Number(incoming.opening) || 0,
      closedAt: incoming.closedAt ?? null,
      updatedAt: incoming.updatedAt,
      dirty: false
    };
  }

  if (cursor !== null) state.sync.cursor = cursor;
  state.sync.lastSyncedAt = Date.now();
  commit();
}

/**
 * Forget the cursor so the next sync pulls the account's whole history again.
 *
 * Used after signing in on a device that has never seen this account. Records
 * already held are merged by the same last-write-wins rule, so this is safe to run
 * on a device that does have local data.
 */
export function resetSyncCursor() {
  state.sync.cursor = 0;
  commit();
}

/**
 * Throw away every transaction and month on this device, keeping the settings.
 *
 * Called when a DIFFERENT address signs in on a phone that still holds someone
 * else's ledger. Without it that ledger would be pushed into the new account on the
 * first sync, because a record carries no owner locally - the session decides who
 * owns what, and the session just changed.
 *
 * Theme and "has seen the walkthrough" survive: they belong to the phone, not to
 * whoever is signed in on it.
 */
export function clearLedger() {
  state.entries = [];
  state.months = {};
  state.sync = { cursor: 0, lastSyncedAt: null };
  commit();
}

/* ------------------------------------------------------------------ export */

/** Everything, for the settings screen's export and for phase 2's first sync. */
export function snapshot() {
  return structuredClone(state);
}

export function replaceAll(next) {
  state = { ...structuredClone(EMPTY), ...next };
  commit();
}
