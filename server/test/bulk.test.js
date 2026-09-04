/**
 * Spendo - the free layer, and where it correctly gives up
 *
 *     node --test test/
 *
 * `js/bulk.js` is client code, tested from here because this is where the runner
 * lives and because it imports nothing but `js/format.js` - no DOM, no storage, no
 * network. It is the layer that reads most spoken lists without a model, so what it
 * gets wrong is what people see.
 *
 * Half of these cases are about `confident`, not about the entries. Getting an entry
 * wrong here is recoverable - the review sheet shows it and the person fixes it -
 * but claiming confidence about a sentence it cannot read is what stops the model
 * ever being asked, and that failure is silent.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { parseSpoken } from '../../js/bulk.js';

const at = (text) => parseSpoken(text, { date: '2026-09-04' });
const shape = (e) => `${e.direction} ${e.amount} ${e.description}`;

test('a comma-separated list is read whole', () => {
  const r = at('200 auto, 150 lunch, 900 groceries');
  assert.equal(r.confident, true);
  assert.deepEqual(r.entries.map(shape), ['out 200 Auto', 'out 150 Lunch', 'out 900 Groceries']);
});

test('the amount may come before or after the thing, and the verb is dropped', () => {
  assert.deepEqual(at('spent 200 on auto').entries.map(shape), ['out 200 Auto']);
  assert.deepEqual(at('auto 200').entries.map(shape), ['out 200 Auto']);
  assert.deepEqual(at('paid rs 1200 for electricity bill').entries.map(shape), ['out 1200 Electricity bill']);
});

test('"and" and "then" split as well as a comma, because dictation drops commas', () => {
  const r = at('200 auto and 150 lunch then 90 tea');
  assert.equal(r.entries.length, 3);
});

test('money coming in is recognised by how it is described', () => {
  assert.deepEqual(at('got 5000 salary').entries.map(shape), ['in 5000 Salary']);
  assert.deepEqual(at('received 300 refund').entries.map(shape), ['in 300 Refund']);
  assert.deepEqual(at('200 auto').entries.map(shape), ['out 200 Auto']);
});

test('thousands and lakhs written short are multiplied out', () => {
  assert.equal(at('2k rent').entries[0].amount, 2000);
  assert.equal(at('1.5k swiggy').entries[0].amount, 1500);
  assert.equal(at('3 thousand rent').entries[0].amount, 3000);
  assert.equal(at('2 lakhs car').entries[0].amount, 200000);
});

test('paise survive; a stray comma inside a figure is read as the decimal point', () => {
  assert.equal(at('99.50 tea').entries[0].amount, 99.5);
});

test('yesterday moves the date and does not end up in the description', () => {
  const r = at('450 groceries yesterday, 90 tea');
  assert.equal(r.entries[0].date, '2026-09-03');
  assert.equal(r.entries[0].description, 'Groceries');
  assert.equal(r.entries[1].date, '2026-09-04');
});

/*
 * The whole point of the layer. These are the sentences a regex has no business
 * reading, and saying so is what sends them to the model.
 */
test('amounts spoken as words are refused rather than guessed at', () => {
  const r = at('two hundred rupees for an auto and about one fifty for lunch');
  assert.equal(r.confident, false);
  assert.equal(r.entries.length, 0);
  assert.equal(r.leftover.length, 2);
});

/*
 * Dictation drops the joining word more often than it drops the comma, so this is
 * the shape a two-item list actually arrives in when it goes wrong - and reading it
 * as one entry loses half the money while reporting confidence.
 */
test('a second number left in a segment sends the whole thing to the model', () => {
  const r = at('200 petrol 500 milk');
  assert.equal(r.confident, false);
  // What it DID find is still returned - it is what gets shown when the model is
  // unavailable, and one editable row beats an error.
  assert.equal(r.entries.length, 1);
});

test('a figure inside a product name is doubt, not a split', () => {
  // Splitting at every number would read this as "Iphone" and 15 rupees of "case
  // 2000". Flagging it hands a sentence a model can actually read to the model.
  const r = at('iphone 15 case 2000');
  assert.equal(r.confident, false);
});

test('the shorthands are not mistaken for a second number', () => {
  for (const text of ['1.5k swiggy', '99.50 tea', '2 lakhs car', '2k rent, 350 petrol']) {
    assert.equal(at(text).confident, true, text);
  }
});

test('a spoken list with the joining word intact is read locally', () => {
  const r = at('200 petrol and 500 milk yesterday');
  assert.equal(r.confident, true);
  assert.deepEqual(r.entries.map(shape), ['out 200 Petrol', 'out 500 Milk']);
  assert.equal(r.entries[1].date, '2026-09-03');
});

test('a runaway transcript cannot become a runaway description', () => {
  const r = at(`200 ${'petrol '.repeat(40)}`);
  assert.equal(r.entries[0].description.length <= 80, true);
});

test('a list with one unreadable item in it is not confident either', () => {
  const r = at('200 auto, a couple of hundred for lunch');
  assert.equal(r.entries.length, 1);
  assert.equal(r.confident, false);
});

test('one stray word left over is not worth a round trip', () => {
  // "fish and chips 200" splits at "and", so "fish" is orphaned. One word is noise;
  // the entry that came out of the rest is still good enough to show.
  const r = at('fish and chips 200');
  assert.equal(r.confident, true);
  assert.deepEqual(r.leftover, ['fish']);
});

test('nothing spendable is not confident, and offers nothing', () => {
  const r = at('hello how are you');
  assert.equal(r.confident, false);
  assert.deepEqual(r.entries, []);
});

test('empty input does not throw', () => {
  for (const value of ['', '   ', null, undefined]) {
    const r = parseSpoken(value, { date: '2026-09-04' });
    assert.deepEqual(r.entries, []);
    assert.equal(r.confident, false);
  }
});

test('a zero or negative figure is not an entry', () => {
  assert.equal(at('0 auto').entries.length, 0);
});
