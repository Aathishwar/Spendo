/**
 * Spendo - what the microphone hands back
 *
 *     node --test test/
 *
 * `js/voice.js` is client code with no DOM in it - it reads `window.SpeechRecognition`
 * and returns strings - so it can be driven from here with a fake recogniser, which is
 * the only way to reproduce what a browser actually does with interim results.
 *
 * This suite exists because of two shipped bugs, and they are the same bug twice. The result handler walked from
 * `event.resultIndex`, appending each final to a running string - what the API
 * documentation implies and what every example online does. Android Chrome sets
 * `resultIndex` to 0 on most events, so every event re-appended every final, and
 * "200 petrol 500 milk" reached the parser as
 *
 *   200 petrol 500 200 petrol 500 200 petrol 500 formal case study
 *
 * quadratic in the number of events. It froze the app and it made the parser find one
 * amount in a sentence that had two.
 *
 * Reading all of `event.results` fixed that and left the duplication in place, because
 * Android's results are SNAPSHOTS of the whole utterance rather than the new words
 * alone, and concatenating snapshots duplicates just as thoroughly. Someone saying
 * "milk 500, 200 petrol yesterday" got
 *
 *   200 200 200 petrol 200 petrol 500 200 petrol 500 formal case study
 *
 * The first two tests below are those exact event streams.
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
 * Long enough for the delayed restart in voice.js to have run. The delay is there so a
 * session is never started from inside the event that ended the last one; a test that
 * wants to see the next session has to wait it out.
 */
function restart() {
  return new Promise((resolve) => { setTimeout(resolve, 320); });
}

/*
 * The first regression. Every event claims resultIndex 0, which is what Android Chrome
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

/*
 * The second, and the one that was actually reported. Each result carries the whole
 * utterance so far rather than its own new words, so a handler that concatenates them
 * repeats everything it has already said - which is what reached the parser.
 */
test('results that are cumulative snapshots are merged, not concatenated', async () => {
  await withRecogniser(({ listen, store }) => {
    let last = '';
    listen({ onText: (text) => { last = text; } });

    const r = store.instance;
    r.emit([['200', true]], 0);
    r.emit([['200', true], ['200 petrol', true]], 0);
    r.emit([['200', true], ['200 petrol', true], ['200 petrol 500', true]], 0);
    r.emit([
      ['200', true],
      ['200 petrol', true],
      ['200 petrol 500', true],
      ['200 petrol 500 formal case study', true]
    ], 0);

    assert.equal(last, '200 petrol 500 formal case study');
  });
});

/*
 * A snapshot stream where the recogniser revises the tail of what it already settled -
 * the overlap is real but partial, and only the new words belong on the end.
 */
test('a snapshot that overlaps the previous one only in part still merges', async () => {
  await withRecogniser(({ listen, store }) => {
    let last = '';
    listen({ onText: (text) => { last = text; } });

    store.instance.emit([
      ['500 milk', true],
      ['milk 200 petrol', true]
    ], 0);

    assert.equal(last, '500 milk 200 petrol');
  });
});

/* Two items that merely start with the same amount are two items, not one. */
test('a repeated amount across different items is kept', async () => {
  await withRecogniser(({ listen, store }) => {
    let last = '';
    listen({ onText: (text) => { last = text; } });

    store.instance.emit([['20 auto', true], ['20 bus', true]], 0);

    assert.equal(last, '20 auto 20 bus');
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

/*
 * The sheet says "Listening. Tap to stop", and this is the test that makes that true.
 *
 * Android ends a session after a few seconds of silence whatever `continuous` says, so
 * a pause in the middle of a list used to end the list. Now it starts another session
 * and carries what was already settled - which matters because `event.results` is
 * empty again in the new one.
 */
test('the browser ending on its own is a pause, not the end of the list', async () => {
  await withRecogniser(async ({ listen, store }) => {
    const ends = [];
    const handle = listen({ onText: () => {}, onEnd: (text) => ends.push(text) });

    store.instance.emit([['500 milk', true]], 0);
    store.instance.onend();
    await restart();

    assert.deepEqual(ends, [], 'a pause must not hand anything over');

    store.instance.emit([['200 petrol yesterday', true]], 0);
    handle.stop();

    assert.deepEqual(ends, ['500 milk 200 petrol yesterday']);
  });
});

/*
 * The other half of that bargain: a phone that is listening to nothing has to give up
 * on its own, or the mic is live until the battery says otherwise.
 */
test('restarts that hear nothing eventually end the sitting', async () => {
  await withRecogniser(async ({ listen, store }) => {
    const ends = [];
    listen({ onText: () => {}, onEnd: (text) => ends.push(text) });

    store.instance.emit([['500 milk', true]], 0);

    for (let i = 0; i < 8 && ends.length === 0; i += 1) {
      store.instance.onend();
      await restart();
    }

    assert.deepEqual(ends, ['500 milk']);
  });
});

test('stopping and no speech are not failures worth a message', async () => {
  await withRecogniser(async ({ listen, store }) => {
    const errors = [];
    const ends = [];
    listen({ onText: () => {}, onError: (m) => errors.push(m), onEnd: (t) => ends.push(t) });

    // Someone who tapped the mic and then thought about it for a moment. The session
    // ends, nothing was heard, and the next one is already listening.
    store.instance.onerror({ error: 'no-speech' });
    store.instance.onend();
    await restart();
    store.instance.emit([['500 milk', true]], 0);

    assert.deepEqual(errors, []);
    assert.deepEqual(ends, []);
  });
});

test('the three real failures each say a different thing to do', async () => {
  const errors = [];
  for (const error of ['not-allowed', 'network', 'audio-capture']) {
    // A session each, because a real failure ends the sitting rather than being
    // collected alongside the next one.
    await withRecogniser(({ listen, store }) => {
      listen({ onText: () => {}, onError: (m) => errors.push(m) });
      store.instance.onerror({ error });
    });
  }

  assert.match(errors[0], /blocked/);
  assert.match(errors[1], /could not be reached/);
  assert.match(errors[2], /Try again/);
  assert.equal(new Set(errors).size, 3);
});

/* A failure that means something is a failure to report, not a session to restart. */
test('a real failure stops the mic instead of starting it again', async () => {
  await withRecogniser(async ({ listen, store }) => {
    const errors = [];
    const ends = [];
    listen({ onText: () => {}, onError: (m) => errors.push(m), onEnd: (t) => ends.push(t) });

    const first = store.instance;
    first.onerror({ error: 'not-allowed' });
    first.onend();
    await restart();

    assert.equal(errors.length, 1);
    assert.deepEqual(ends, []);
    assert.equal(store.instance, first, 'nothing new may be started after that');
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
