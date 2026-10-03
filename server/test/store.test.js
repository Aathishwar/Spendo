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
