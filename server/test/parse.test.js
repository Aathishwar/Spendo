/**
 * Spendo - what the bulk reader will and will not accept back
 *
 *     node --test test/
 *
 * `parseEntries` is the one place in this app where a model is asked what a NUMBER
 * is. Everywhere else it phrases figures the device computed; here the figure only
 * exists as words someone said. That makes the validator below the safety rail for
 * the whole feature, and the reason it is worth a suite of its own.
 *
 * A real chat endpoint is stood up on localhost and pointed at with AI_URL, rather
 * than the module's fetch being stubbed: the thing being tested is what survives the
 * round trip - the <think> strip, the fence, the JSON cut out of surrounding prose -
 * and a stub that hands back a clean object tests none of that.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';

const CATEGORIES = ['food', 'transport', 'groceries', 'bills', 'other'];
const TODAY = '2026-09-04';

/** A chat-completions server that replies with whatever the test hands it. */
function fakeModel(reply) {
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({
        choices: [{ message: { content: typeof reply === 'function' ? reply(JSON.parse(body)) : reply } }]
      }));
    });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve({
      url: `http://127.0.0.1:${server.address().port}/v1/chat/completions`,
      close: () => new Promise((done) => server.close(done))
    }));
  });
}

/**
 * ai.js reads its configuration at call time, so the environment is set and the
 * module is imported fresh for each case. A cache-busting query is the only way to
 * re-import an ES module in the same process.
 */
async function run(reply, { text = '200 auto' } = {}) {
  const model = await fakeModel(reply);
  process.env.AI_URL = model.url;
  process.env.GROQ_API_KEY = 'test-key';
  const { parseEntries } = await import(`../src/ai.js?case=${Math.random()}`);
  try {
    return await parseEntries(text, { today: TODAY, categories: CATEGORIES });
  } finally {
    await model.close();
  }
}

test('a clean answer comes back as records', async () => {
  const rows = await run(JSON.stringify([
    { amount: 200, description: 'Auto to office', direction: 'out', category: 'transport', date: TODAY },
    { amount: 5000, description: 'Salary', direction: 'in', category: 'other', date: TODAY }
  ]));

  assert.equal(rows.length, 2);
  assert.deepEqual(rows[0], {
    amount: 200, description: 'Auto to office', direction: 'out', category: 'transport', date: TODAY
  });
  assert.equal(rows[1].direction, 'in');
});

test('the array is cut out of a fenced or chatty reply', async () => {
  const rows = await run('Here you go:\n```json\n' +
    '[{"amount": 150, "description": "Lunch", "direction": "out", "category": "food", "date": "2026-09-04"}]' +
    '\n```\nHope that helps.');

  assert.equal(rows.length, 1);
  assert.equal(rows[0].description, 'Lunch');
});

test('reasoning left in the reply is stripped before the JSON is looked for', async () => {
  const rows = await run('<think>They said two hundred for an auto, so 200.</think>' +
    '[{"amount": 200, "description": "Auto", "direction": "out", "category": "transport", "date": "2026-09-04"}]');

  assert.equal(rows.length, 1);
  assert.equal(rows[0].amount, 200);
});

/*
 * The one that matters most. Told "200 auto and lunch", a model will happily price
 * the lunch at a plausible 150 - and a plausible wrong number in a ledger is the
 * error nobody catches later. The prompt forbids it; this is what happens when the
 * prompt is ignored anyway.
 */
test('a row with no usable amount is dropped, not repaired', async () => {
  const rows = await run(JSON.stringify([
    { amount: 200, description: 'Auto', direction: 'out', category: 'transport', date: TODAY },
    { amount: null, description: 'Lunch', direction: 'out', category: 'food', date: TODAY },
    { amount: 'about 150', description: 'Tea', direction: 'out', category: 'food', date: TODAY },
    { amount: 0, description: 'Bus', direction: 'out', category: 'transport', date: TODAY },
    { amount: 90, description: '', direction: 'out', category: 'food', date: TODAY }
  ]));

  assert.deepEqual(rows.map((r) => r.description), ['Auto']);
});

test('a negative amount becomes positive - direction is the only thing that carries sign', async () => {
  const rows = await run(JSON.stringify([
    { amount: -200, description: 'Auto', direction: 'out', category: 'transport', date: TODAY }
  ]));

  assert.equal(rows[0].amount, 200);
});

test('a category that is not on the list becomes null for the device to fill in', async () => {
  const rows = await run(JSON.stringify([
    { amount: 200, description: 'Auto', direction: 'out', category: 'travel', date: TODAY },
    { amount: 90, description: 'Tea', direction: 'out', category: 'food', date: TODAY }
  ]));

  assert.equal(rows[0].category, null);
  assert.equal(rows[1].category, 'food');
});

test('a date that is not a date falls back to today, never to a guess', async () => {
  const rows = await run(JSON.stringify([
    { amount: 200, description: 'Auto', direction: 'out', category: 'transport', date: 'yesterday' },
    { amount: 90, description: 'Tea', direction: 'out', category: 'food', date: '2026-09-03' }
  ]));

  assert.equal(rows[0].date, TODAY);
  assert.equal(rows[1].date, '2026-09-03');
});

test('anything but "in" is an expense', async () => {
  const rows = await run(JSON.stringify([
    { amount: 1, description: 'A', direction: 'in', category: 'other', date: TODAY },
    { amount: 2, description: 'B', direction: 'income', category: 'other', date: TODAY },
    { amount: 3, description: 'C', direction: null, category: 'other', date: TODAY }
  ]));

  assert.deepEqual(rows.map((r) => r.direction), ['in', 'out', 'out']);
});

test('a long answer is capped at twenty rows', async () => {
  const many = Array.from({ length: 40 }, (_, i) => ({
    amount: i + 1, description: `Item ${i}`, direction: 'out', category: 'other', date: TODAY
  }));
  const rows = await run(JSON.stringify(many));

  assert.equal(rows.length, 20);
});

test('a reply that is not an array at all is null, not an empty sheet', async () => {
  assert.equal(await run('I could not work that out, sorry.'), null);
  assert.equal(await run('{"amount": 200}'), null);
  assert.equal(await run('[not json]'), null);
});

test('nothing spendable in the text is an empty list, which is not the same as null', async () => {
  const rows = await run('[]', { text: 'hello how are you' });
  assert.deepEqual(rows, []);
});

/*
 * The payload is the argument for the whole feature being safe to enable: a leak at
 * the far end is a sentence someone said, with no amount, date or account attached
 * to anything that identifies them.
 */
test('only the text, the ids and today are sent to the model', async () => {
  let seen = null;
  await run((body) => {
    seen = body;
    return '[]';
  }, { text: '200 auto' });

  // Two messages: the fixed instructions, and the sentence. Nothing else is a
  // channel through which anything could travel.
  assert.equal(seen.messages.length, 2);
  assert.equal(seen.messages[0].role, 'system');
  assert.equal(seen.messages[1].content, '200 auto');

  // The instructions carry the id list and today's date, and are otherwise a
  // constant - they are checked as one rather than by scanning for forbidden words,
  // which is how "no symbol" once failed a test looking for "ym".
  assert.match(seen.messages[0].content, /food, transport, groceries, bills, other/);
  assert.match(seen.messages[0].content, /Today is 2026-09-04/);
});
