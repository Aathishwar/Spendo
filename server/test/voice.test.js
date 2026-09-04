/**
 * Spendo - what the microphone hands back
 *
 *     node --test test/
 *
 * `js/voice.js` is client code with no DOM in it - it reads `window.SpeechRecognition`
 * and returns strings - so it can be driven from here with a fake recogniser, which is
 * the only way to reproduce what a browser actually does with interim results.
 *
 * This suite exists because of one shipped bug. The result handler walked from
 * `event.resultIndex`, appending each final to a running string - what the API
 * documentation implies and what every example online does. Android Chrome sets
 * `resultIndex` to 0 on most events, so every event re-appended every final, and
 * "200 petrol 500 milk" reached the parser as
 *
 *   200 petrol 500 200 petrol 500 200 petrol 500 formal case study
 *
 * quadratic in the number of events. It froze the app and it made the parser find one
 * amount in a sentence that had two. The first test below is that exact event stream.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

/**
 * A recogniser that reports whatever event stream a test hands it.
 *
 * `results` is modelled the way the spec defines it - CUMULATIVE for the session, so
 * every event carries every result so far, final or not. That is the fact the fixed
 * handler relies on and the broken one ignored.
 */
function fakeRecogniser(store) {
  return class {
    constructor() {
      store.instance = this;
      this.onresult = null;
      this.onerror = null;
      this.onend = null;
    }

    start() { store.started = true; }

    stop() { store.stopped = true; }

    /** Deliver one event carrying `all` results, claiming `resultIndex`. */
    emit(all, resultIndex) {
      const results = all.map(([transcript, isFinal]) => {
        const alternatives = [{ transcript }];
        alternatives.isFinal = isFinal;
        return Object.assign(alternatives, { isFinal });
      });
      results.length = all.length;
      this.onresult({ resultIndex, results });
    }
  };
}

async function withRecogniser(fn) {
  const store = {};
  globalThis.window = { SpeechRecognition: fakeRecogniser(store) };
  const { listen, speechSupported } = await import(`../../js/voice.js?case=${Math.random()}`);
  try {
    return await fn({ listen, speechSupported, store });
  } finally {
    delete globalThis.window;
  }
}

/*
 * The regression. Every event claims resultIndex 0, which is what Android Chrome
 * does, and the results list grows as the sentence is spoken.
 */
test('an event stream that always claims resultIndex 0 is not duplicated', async () => {
  await withRecogniser(({ listen, store }) => {
    const seen = [];
    listen({ onText: (text) => seen.push(text) });

    const r = store.instance;
    r.emit([['200', false]], 0);
    r.emit([['200 petrol', true]], 0);
    r.emit([['200 petrol', true], ['500', false]], 0);
    r.emit([['200 petrol', true], ['500 milk', false]], 0);
    r.emit([['200 petrol', true], ['500 milk yesterday', true]], 0);

    assert.deepEqual(seen, [
      '200',
      '200 petrol',
      '200 petrol 500',
      '200 petrol 500 milk',
      '200 petrol 500 milk yesterday'
    ]);
  });
});

test('an honest resultIndex gives the same answer', async () => {
  await withRecogniser(({ listen, store }) => {
    const seen = [];
    listen({ onText: (text) => seen.push(text) });

    const r = store.instance;
    r.emit([['200 petrol', true]], 0);
    r.emit([['200 petrol', true], ['500 milk', true]], 1);

    assert.deepEqual(seen, ['200 petrol', '200 petrol 500 milk']);
  });
});

test('the same event delivered twice does not double the transcript', async () => {
  await withRecogniser(({ listen, store }) => {
    const seen = [];
    listen({ onText: (text) => seen.push(text) });

    const r = store.instance;
    r.emit([['200 petrol', true]], 0);
    r.emit([['200 petrol', true]], 0);
    r.emit([['200 petrol', true]], 0);

    assert.deepEqual(new Set(seen), new Set(['200 petrol']));
  });
});

test('stopping hands back the settled text, once', async () => {
  await withRecogniser(({ listen, store }) => {
    const ends = [];
    const handle = listen({ onText: () => {}, onEnd: (text) => ends.push(text) });

    store.instance.emit([['200 petrol', true], ['500 milk', false]], 0);
    handle.stop();
    handle.stop();

    // The interim half is dropped on purpose: what is handed to the parser is what
    // the recogniser committed to, not what it was still revising.
    assert.deepEqual(ends, ['200 petrol']);
    assert.equal(store.stopped, true);
  });
});

test('the browser ending on its own reports the same way stopping does', async () => {
  await withRecogniser(({ listen, store }) => {
    const ends = [];
    listen({ onText: () => {}, onEnd: (text) => ends.push(text) });

    store.instance.emit([['200 petrol', true]], 0);
    store.instance.onend();

    assert.deepEqual(ends, ['200 petrol']);
  });
});

test('a long session cannot grow past the length the server would accept', async () => {
  await withRecogniser(({ listen, store }) => {
    let last = '';
    listen({ onText: (text) => { last = text; } });

    const many = Array.from({ length: 400 }, (_, i) => [`item ${i}`, true]);
    store.instance.emit(many, 0);

    assert.equal(last.length, 600);
  });
});

test('stopping and no speech are not failures worth a message', async () => {
  await withRecogniser(({ listen, store }) => {
    const errors = [];
    listen({ onText: () => {}, onError: (m) => errors.push(m) });

    store.instance.onerror({ error: 'aborted' });
    store.instance.onerror({ error: 'no-speech' });

    assert.deepEqual(errors, []);
  });
});

test('the three real failures each say a different thing to do', async () => {
  await withRecogniser(({ listen, store }) => {
    const errors = [];
    listen({ onText: () => {}, onError: (m) => errors.push(m) });

    store.instance.onerror({ error: 'not-allowed' });
    store.instance.onerror({ error: 'network' });
    store.instance.onerror({ error: 'audio-capture' });

    assert.match(errors[0], /blocked/);
    assert.match(errors[1], /could not be reached/);
    assert.match(errors[2], /Try again/);
    assert.equal(new Set(errors).size, 3);
  });
});

test('a browser with no speech recognition says so instead of throwing', async () => {
  globalThis.window = {};
  const { listen, speechSupported } = await import(`../../js/voice.js?case=${Math.random()}`);
  try {
    assert.equal(speechSupported(), false);
    const errors = [];
    const handle = listen({ onText: () => {}, onError: (m) => errors.push(m) });
    assert.match(errors[0], /cannot listen/);
    handle.stop();       // must not throw
  } finally {
    delete globalThis.window;
  }
});
