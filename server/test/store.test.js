/**
 * Spendo - the ledger in localStorage, month by month
 *
 * js/store.js reads `localStorage` at import, so each case gets a fresh fake storage
 * and a fresh copy of the module (a query string defeats the module cache).
 */

import test from 'node:test';
import assert from 'node:assert/strict';

function fakeStorage(initial = {}) {
  const data = new Map(Object.entries(initial));
  return {
    data,
    writes: [],
    get length() { return data.size; },
    key(i) { return [...data.keys()][i] ?? null; },
    getItem(k) { return data.has(k) ? data.get(k) : null; },
    setItem(k, v) { this.writes.push(k); data.set(k, String(v)); },
    removeItem(k) { data.delete(k); }
  };
}

let n = 0;
async function freshStore(storage) {
  globalThis.localStorage = storage;
  n += 1;
  return import(`../../js/store.js?case=${n}`);
}

const entry = (id, date, amount = 100) => ({
  id, date, ym: date.slice(0, 7), amount, direction: 'out', description: id,
  category: 'food', createdAt: Number(id.replace(/\D/g, '')) || 1, updatedAt: 1, deletedAt: null, dirty: false
});

test('the old single-value format is read, then written out month by month', async () => {
  const old = {
    version: 1,
    entries: [entry('e1', '2026-09-03'), entry('e2', '2026-10-01'), entry('e3', '2026-10-02')],
    months: { '2026-10': { opening: 5000, closedAt: null, updatedAt: 1, dirty: false } },
    settings: { theme: 'dark', seenIntro: true, ai: true }
  };
  const ls = fakeStorage({ 'spendo.v1': JSON.stringify(old) });
  const store = await freshStore(ls);

  assert.equal(store.entriesFor('2026-10').length, 2);
  store.setSetting('theme', 'light');       // any save completes the migration

  const meta = JSON.parse(ls.getItem('spendo.v1'));
  assert.equal(meta.entries, undefined, 'the small record no longer carries the ledger');
  assert.deepEqual(meta.monthKeys, ['2026-09', '2026-10']);
  assert.equal(meta.settings.theme, 'light', 'boot-theme.js still finds the theme here');
  assert.equal(JSON.parse(ls.getItem('spendo.v1.m.2026-10')).entries.length, 2);
  assert.equal(JSON.parse(ls.getItem('spendo.v1.m.2026-10')).month.opening, 5000);

  const again = await freshStore(ls);
  assert.equal(again.entriesFor('2026-09').length, 1);
  assert.equal(again.openingOf('2026-10'), 5000);
});

test('a save rewrites only the month it touched', async () => {
  const ls = fakeStorage();
  const store = await freshStore(ls);
  store.addEntry({ amount: 10, description: 'a', category: 'food', date: '2026-08-01' });
  store.addEntry({ amount: 20, description: 'b', category: 'food', date: '2026-09-01' });

  ls.writes = [];
  store.addEntry({ amount: 30, description: 'c', category: 'food', date: '2026-09-02' });
  assert.deepEqual(ls.writes.sort(), ['spendo.v1', 'spendo.v1.m.2026-09']);

  ls.writes = [];
  store.setSetting('theme', 'dark');
  assert.deepEqual(ls.writes, ['spendo.v1'], 'a setting writes no month at all');
});

test('moving an entry to another month rewrites both, and an emptied month is removed', async () => {
  const ls = fakeStorage();
  const store = await freshStore(ls);
  const e = store.addEntry({ amount: 10, description: 'a', category: 'food', date: '2026-08-01' });
  store.updateEntry(e.id, { date: '2026-09-05' });

  assert.equal(ls.getItem('spendo.v1.m.2026-08'), null);
  assert.equal(JSON.parse(ls.getItem('spendo.v1.m.2026-09')).entries[0].date, '2026-09-05');

  const again = await freshStore(ls);
  assert.equal(again.entriesFor('2026-09').length, 1);
  assert.equal(again.entriesFor('2026-08').length, 0);
});

test('clearing the ledger removes every month key', async () => {
  const ls = fakeStorage();
  const store = await freshStore(ls);
  store.addEntry({ amount: 10, description: 'a', category: 'food', date: '2026-08-01' });
  store.setOpening('2026-09', 900);
  store.clearLedger();
  assert.deepEqual([...ls.data.keys()].filter((k) => k.includes('.m.')), []);
});

test('storage that cannot be read is never written over', async () => {
  const ls = fakeStorage({ 'spendo.v1': '{not json', 'spendo.v1.m.2026-10': '{"entries":[],"month":null}' });
  const store = await freshStore(ls);
  store.addEntry({ amount: 10, description: 'a', category: 'food', date: '2026-10-01' });
  assert.equal(ls.getItem('spendo.v1'), '{not json');
});

test('one damaged month is skipped, and the rest of the ledger still loads', async () => {
  const ls = fakeStorage();
  const store = await freshStore(ls);
  store.addEntry({ amount: 10, description: 'a', category: 'food', date: '2026-08-01' });
  store.addEntry({ amount: 20, description: 'b', category: 'food', date: '2026-09-01' });
  ls.data.set('spendo.v1.m.2026-08', '{broken');
  const again = await freshStore(ls);
  assert.equal(again.entriesFor('2026-09').length, 1);
  assert.equal(again.entriesFor('2026-08').length, 0);
});

/* ------------------------------------------------------------------ autopay */

test('a rule is due from its day, once per month, and done by its occurrence id', async () => {
  const store = await freshStore(fakeStorage());
  const id = store.saveRecurring({ description: 'Rent', amount: 4000, direction: 'out', category: 'rent', day: 5, startYM: '2026-09' });

  assert.equal(store.dueRecurring('2026-10-04').filter((d) => d.ym === '2026-10').length, 0, 'not before the 5th');
  const due = store.dueRecurring('2026-10-05');
  assert.deepEqual(due.map((d) => d.ym), ['2026-09', '2026-10'], 'September was missed, so it is still offered');

  store.addOccurrence(id, '2026-10');
  store.addOccurrence(id, '2026-10');            // a second tap, or a second device
  assert.equal(store.entriesFor('2026-10').length, 1);
  assert.equal(store.entriesFor('2026-10')[0].id, `rec-${id}-2026-10`);

  store.skipRecurring(id, '2026-09');
  assert.deepEqual(store.dueRecurring('2026-10-05'), []);
});

test('the 31st falls on the last day of a short month, and paused rules are never due', async () => {
  const store = await freshStore(fakeStorage());
  const id = store.saveRecurring({ description: 'EMI', amount: 999, direction: 'out', category: 'bills', day: 31, startYM: '2026-09' });
  assert.equal(store.dueDateOf(store.recurringRule(id), '2026-09'), '2026-09-30');
  assert.equal(store.dueRecurring('2026-09-30').length, 1);
  store.saveRecurring({ id, paused: true });
  assert.equal(store.dueRecurring('2026-09-30').length, 0);
});

test('an amount that varies is never added on its own, and catch-up stops at two months back', async () => {
  const store = await freshStore(fakeStorage());
  const id = store.saveRecurring({ description: 'Power', amount: null, direction: 'out', category: 'bills', day: 1, auto: true, startYM: '2026-01' });
  assert.equal(store.recurringRule(id).auto, false);
  assert.equal(store.addOccurrence(id, '2026-10'), null, 'no amount to add');
  assert.deepEqual(store.dueRecurring('2026-10-05').map((d) => d.ym), ['2026-08', '2026-09', '2026-10']);
});

test('budgets and rules are sent once and come back clean', async () => {
  const store = await freshStore(fakeStorage());
  store.setBudget('food', 6000);
  const id = store.saveRecurring({ description: 'Rent', amount: 4000, direction: 'out', category: 'rent', day: 1 });
  const out = store.pendingChanges();
  assert.equal(out.budgets.length, 1);
  assert.equal(out.recurring.length, 1);
  store.applySync({
    budgets: [{ category: 'food', amount: 6000, updatedAt: out.budgets[0].updatedAt }],
    recurring: [{ ...out.recurring[0], id }],
    cursor: 9
  });
  const after = store.pendingChanges();
  assert.equal(after.budgets.length + after.recurring.length, 0);
  assert.equal(store.budgetOf('food'), 6000);
});

test('a budget saved by an older build as a bare number still reads, and goes up', async () => {
  const ls = fakeStorage({ 'spendo.v1': JSON.stringify({ version: 1, entries: [], months: {}, budgets: { food: 5000 } }) });
  const store = await freshStore(ls);
  assert.equal(store.budgetOf('food'), 5000);
  assert.equal(store.pendingChanges().budgets[0].amount, 5000);
});
