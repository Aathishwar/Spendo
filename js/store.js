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
  sync: { cursor: 0, lastSyncedAt: null },
  // ym -> { text, stamp, madeAt }. The written summary of a month, kept because it
  // costs a model call to produce and never changes once the month is over. `stamp`
  // is a fingerprint of the figures it was written from, so an edit to an old month
  // invalidates it rather than leaving a paragraph that quietly disagrees with the
  // numbers beside it.
  reviews: {},
  // { items, stamp, madeAt }. The last set of spending suggestions. One set, not one
  // per month: they are advice about a habit, and the habit is not a calendar month.
  tips: null
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
      sync: { ...EMPTY.sync, ...(parsed.sync || {}) },
      reviews: { ...(parsed.reviews || {}) }
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

/**
 * Every entry, every month, oldest first.
 *
 * For the category guesser, which learns from the whole history rather than from one
 * month. Returns the live array rather than a copy: it is read on every keystroke of
 * a description, and cloning several hundred records for that would be the slowest
 * thing in the app.
 */
export function snapshotEntries() {
  return state.entries;
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

/* ------------------------------------------------------------ over time */

/**
 * Spending per month, oldest first, for the History chart.
 *
 * Months with no entries are still returned when they fall inside the window: a gap
 * in a run of months is a fact about the months, and a chart that silently closes the
 * gap makes two Januaries look adjacent.
 *
 * `limit` counts back from the newest month that exists, not from today, so an old
 * export still draws its own history rather than a year of empty columns.
 */
export function monthlySeries(limit = 12) {
  const known = months();                       // newest first
  if (!known.length) return [];

  const newest = known[0];
  const oldest = known[known.length - 1];
  const out = [];

  let ym = newest;
  for (let i = 0; i < limit; i++) {
    const stats = monthStats(ym);
    out.push({
      ym,
      spent: stats.spent,
      received: stats.received,
      count: stats.count,
      isCurrent: stats.isCurrent,
      closed: stats.closed
    });
    if (ym === oldest) break;
    ym = shiftYMBack(ym);
  }
  return out.reverse();
}

/**
 * The figures a model is given to suggest where spending could come down.
 *
 * Figures only, exactly as with the month write-up: monthly totals, category totals
 * over the window, and how each category moved against its own average. No
 * description, no date, no single transaction ever leaves the device here - the
 * advice is about categories and amounts, and it does not need to know that Tuesday's
 * Rs 240 was a haircut.
 *
 * `recent` is the newest complete-enough month to reason about: the current month is
 * used when it is, itself, the thing the reader is trying to change.
 */
export function spendingProfile(window = 6) {
  const series = monthlySeries(window);
  if (!series.length) return null;

  const recent = series[series.length - 1];
  const past = series.slice(0, -1);
  const monthsWithSpending = series.filter((m) => m.spent > 0);
  const avgMonthly = monthsWithSpending.length
    ? monthsWithSpending.reduce((n, m) => n + m.spent, 0) / monthsWithSpending.length
    : 0;

  // Per category: this month, and the average of the months before it. The pair is
  // what makes a suggestion specific - "Food is Rs 2,000 above its own usual" says
  // something that "Food is your biggest category" does not.
  const recentByCat = new Map(categoryTotals(recent.ym).map((t) => [t.id, t.amount]));
  const historyByCat = new Map();
  for (const m of past) {
    for (const t of categoryTotals(m.ym)) {
      historyByCat.set(t.id, (historyByCat.get(t.id) || 0) + t.amount);
    }
  }

  const ids = new Set([...recentByCat.keys(), ...historyByCat.keys()]);
  const categories = [...ids].map((id) => {
    const now = recentByCat.get(id) || 0;
    const usual = past.length ? (historyByCat.get(id) || 0) / past.length : 0;
    return {
      id,
      amount: now,
      share: recent.spent > 0 ? now / recent.spent : 0,
      usual,
      delta: now - usual
    };
  }).sort((a, b) => b.amount - a.amount);

  const stats = monthStats(recent.ym);

  return {
    ym: recent.ym,
    isCurrent: recent.isCurrent,
    spent: recent.spent,
    received: recent.received,
    balance: stats.balance,
    avgMonthly,
    monthsCovered: series.length,
    series: series.map((m) => ({ ym: m.ym, spent: m.spent })),
    categories: categories.slice(0, 8)
  };
}

/**
 * A fingerprint of what advice was given for, so it is thrown away when the figures
 * it was based on move. Same idea as reviewStamp, and for the same reason: advice
 * that quietly disagrees with the numbers under it is worse than no advice.
 */
function tipsStamp(profile) {
  if (!profile) return 'none';
  return [
    profile.ym,
    Math.round(profile.spent),
    ...profile.categories.map((c) => `${c.id}:${Math.round(c.amount)}`)
  ].join('|');
}

/** The stored suggestions, or null if there are none or they are out of date. */
export function tipsHeld() {
  const held = state.tips;
  if (!held || !Array.isArray(held.items) || !held.items.length) return null;
  return held.stamp === tipsStamp(spendingProfile()) ? held : null;
}

export function setTips(items) {
  const profile = spendingProfile();
  // The month the advice was read from is kept with it, so the card can say what it
  // was looking at. Advice with no date on it is advice you cannot judge.
  state.tips = { items, ym: profile ? profile.ym : null, stamp: tipsStamp(profile), madeAt: Date.now() };
  commit();
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

/* ------------------------------------------------------------------ review */

/**
 * The figures behind a month, ready to be read or written up.
 *
 * Every number here is computed locally and is therefore always available, always
 * right, and free. That split is deliberate: when a model is involved later it is
 * given these figures and asked only to write a sentence about them. It is never
 * asked what the numbers are, because a paragraph that is confidently wrong about
 * your money is worse than no paragraph.
 */
export function monthReview(ym) {
  const list = entriesFor(ym);
  const stats = monthStats(ym);

  const out = list.filter((e) => e.direction === 'out');

  const byCategory = new Map();
  for (const e of out) byCategory.set(e.category, (byCategory.get(e.category) || 0) + e.amount);
  const top = [...byCategory]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3)
    .map(([id, amount]) => ({
      id,
      amount,
      share: stats.spent > 0 ? amount / stats.spent : 0
    }));

  const biggest = out.reduce((best, e) => (!best || e.amount > best.amount ? e : best), null);

  // Days with any spending, not days in the month: "you spent on 18 of 30 days" is
  // a different and more useful fact than the average.
  const perDay = new Map();
  for (const e of out) perDay.set(e.date, (perDay.get(e.date) || 0) + e.amount);
  const busiest = [...perDay].sort((a, b) => b[1] - a[1])[0] || null;

  const previousYM = shiftYMBack(ym);
  const prevList = entriesFor(previousYM).filter((e) => e.direction === 'out');
  const prevSpent = prevList.reduce((n, e) => n + e.amount, 0);
  const prev = prevList.length || months().includes(previousYM)
    ? {
        ym: previousYM,
        spent: prevSpent,
        delta: stats.spent - prevSpent,
        deltaPct: prevSpent > 0 ? (stats.spent - prevSpent) / prevSpent : null
      }
    : null;

  return {
    ym,
    spent: stats.spent,
    received: stats.received,
    opening: stats.opening,
    balance: stats.balance,
    count: list.length,
    isCurrent: stats.isCurrent,
    daysInMonth: stats.daysInMonth,
    activeDays: perDay.size,
    avgPerActiveDay: perDay.size > 0 ? stats.spent / perDay.size : 0,
    top,
    prev,
    biggest: biggest ? { amount: biggest.amount, date: biggest.date, category: biggest.category,
                         description: biggest.description } : null,
    busiest: busiest ? { date: busiest[0], amount: busiest[1] } : null
  };
}

/** The month before `ym`, as YYYY-MM. */
function shiftYMBack(ym) {
  const [y, m] = ym.split('-').map(Number);
  const d = new Date(Date.UTC(y, m - 2, 1));
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}

/**
 * A fingerprint of the figures a written summary was based on.
 *
 * Only the numbers a reader would notice changing. Adding an entry to a closed month
 * moves `spent` and the category split, so the summary is thrown away and rewritten;
 * renaming a description does not, so it is kept.
 */
function reviewStamp(facts) {
  return [
    facts.spent, facts.received, facts.count, facts.activeDays,
    ...facts.top.map((t) => `${t.id}:${t.amount}`),
    facts.prev ? facts.prev.spent : 'x'
  ].join('|');
}

/** The stored write-up for a month, or null if there is none or it is out of date. */
export function reviewText(ym) {
  const held = state.reviews[ym];
  if (!held) return null;
  return held.stamp === reviewStamp(monthReview(ym)) ? held : null;
}

export function setReviewText(ym, text) {
  state.reviews[ym] = { text, stamp: reviewStamp(monthReview(ym)), madeAt: Date.now() };
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
