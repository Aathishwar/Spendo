/**
 * Spendo - the microphone, wrapped thinly
 *
 * One honest caveat, and it is the reason this file is small and separate: speech
 * recognition in a browser is NOT local. Chrome streams the audio to Google's
 * servers and hands back text. That is the one place in this app where something
 * about the user leaves our origin, and it is done by the browser rather than by
 * the page - our CSP cannot see it and could not stop it.
 *
 * So: it is behind an explicit tap, never listening on its own, the sheet says
 * where the audio goes, and the same sheet has a text box that does the identical
 * job with nothing leaving the device. Someone who does not want that trade has a
 * complete route without it.
 *
 * Nothing here parses. It returns words; js/bulk.js decides what they mean.
 */

const Recognition = window.SpeechRecognition || window.webkitSpeechRecognition || null;

export function speechSupported() {
  return Boolean(Recognition);
}

/*
 * Indian English, and the reason is money.
 *
 * en-US hears "two thousand" where en-IN hears "2000", and it mishears rupee
 * amounts spoken the Indian way - "fifteen hundred" - more often. It also gets the
 * shop and food words that make up half of these descriptions.
 */
const LANG = 'en-IN';

/*
 * A spoken list is short. This is the ceiling anyway, and it is the same 600 the
 * server caps at, so nothing that reaches here can be longer than what would be
 * accepted at the other end.
 */
const MAX_CHARS = 600;

/*
 * The mic is kept alive across the browser's own endings, so these are the two things
 * that end a sitting other than the person tapping stop: a ceiling on the whole
 * sitting, and a run of restarts that heard nothing new. Without the second, a phone
 * left face down on a table restarts a recogniser forever.
 */
const MAX_LISTEN_MS = 120000;
const MAX_QUIET_RESTARTS = 4;
const RESTART_DELAY_MS = 250;

/** Words, and the same word stripped to what a comparison should care about. */
function words(text) {
  return String(text || '').split(/\s+/).filter(Boolean);
}

function key(word) {
  return word.toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');
}

/*
 * Join two pieces of transcript by their overlap rather than end to end.
 *
 * This is the second version of a bug that has now been fixed twice, and the first
 * fix is why the second was hard to see. The original loop started at
 * `event.resultIndex`, which Android reports as 0 on most events, so every event
 * re-appended every final. Reading all of `event.results` each time cured that - and
 * left the real problem standing, because on Android each result's transcript is a
 * SNAPSHOT of the whole utterance so far, not the new words alone. Concatenating the
 * snapshots gives
 *
 *   200 / 200 200 / 200 petrol / 200 petrol 500 / 200 petrol 500 200 petrol 500 / ...
 *
 * which is what someone saying "milk 500, 200 petrol yesterday" actually got. The
 * parser downstream then found one amount in a sentence that had three, and reported
 * it confidently.
 *
 * So: find the longest run of words where the tail of what we have is the head of
 * what arrived, and keep only what is genuinely new. A snapshot that extends the last
 * one overlaps it completely and contributes its new words; a snapshot that repeats
 * one already passed is swallowed whole; two unrelated phrases share no overlap and
 * are joined, which is the ordinary case of a list.
 *
 * It costs one thing and it is worth naming: a phrase said twice in a row - "auto 20
 * auto 20" - merges into one. That is a rare sentence, and the alternative is a
 * common one that arrives as gibberish.
 */
function merge(before, after) {
  const head = words(before);
  const tail = words(after);
  if (!head.length) return tail.join(' ');
  if (!tail.length) return head.join(' ');

  const a = head.map(key);
  const b = tail.map(key);

  for (let k = Math.min(a.length, b.length); k > 0; k -= 1) {
    if (a.slice(a.length - k).join(' ') === b.slice(0, k).join(' ')) {
      return head.concat(tail.slice(k)).join(' ');
    }
  }

  // An older snapshot arriving after a longer one: nothing in it is new.
  if (b.length <= a.length && a.slice(0, b.length).join(' ') === b.join(' ')) {
    return head.join(' ');
  }

  return head.concat(tail).join(' ');
}

function tidy(text) {
  return text.replace(/\s+/g, ' ').trim().slice(0, MAX_CHARS);
}

/**
 * Listen until told to stop, or until the browser gives up for good.
 *
 * `onText` is called with the whole transcript so far - settled text plus whatever
 * is still being revised - because that is what the sheet shows while someone is
 * talking, and a caller that wanted only the final would have to accumulate it
 * itself.
 *
 * Returns a handle with `stop()`. Calling it twice is safe; so is calling it after
 * the browser has already ended the session.
 */
export function listen({ onText, onEnd, onError }) {
  if (!Recognition) {
    onError?.('This browser cannot listen. Type the list instead.');
    return { stop() {} };
  }

  // What earlier sessions of this sitting settled on, and that plus whatever the
  // current session has settled. `event.results` starts empty again after a restart,
  // so the older text has to be carried here or a pause erases the first half of the
  // list.
  let carried = '';
  let settled = '';
  let quiet = 0;
  let stopped = false;
  let current = null;
  let restarting = null;
  const began = Date.now();

  function finish() {
    if (stopped) return;
    stopped = true;
    clearTimeout(restarting);
    onEnd?.(settled);
  }

  function fail(message) {
    if (stopped) return;
    stopped = true;
    clearTimeout(restarting);
    onError?.(message);
  }

  /*
   * One recogniser, and there will be several.
   *
   * `continuous` is a request, not a promise: Android ends a session after a few
   * seconds of silence whatever it is set to. The sheet says "Listening. Tap to
   * stop", so a pause to think has to be a pause and not the end of the list - which
   * means starting a fresh session each time the browser closes one, and ending only
   * when the person says so, the ceiling is reached, or the restarts stop hearing
   * anything.
   */
  function session() {
    const recogniser = new Recognition();
    current = recogniser;
    recogniser.lang = LANG;
    recogniser.continuous = true;
    // Show the words as they are said. Without this the sheet is blank for the whole
    // time someone is talking, which reads as a microphone that is not working.
    recogniser.interimResults = true;
    recogniser.maxAlternatives = 1;

    recogniser.onresult = (event) => {
      let done = '';
      let pending = '';
      for (let i = 0; i < event.results.length; i += 1) {
        const result = event.results[i];
        if (result.isFinal) done = merge(done, result[0].transcript);
        else pending = merge(pending, result[0].transcript);
      }
      settled = tidy(merge(carried, done));
      onText?.(tidy(merge(settled, pending)), false);
    };

    recogniser.onerror = (event) => {
      /*
       * `aborted` is what stop() produces and `no-speech` is a pause before anyone
       * has said anything. Neither ends the sitting: `onend` follows either way and
       * decides there, where the restart bookkeeping lives.
       */
      if (event.error === 'aborted' || event.error === 'no-speech') return;
      /*
       * Named separately because they are three different things for the person to do.
       * A blocked microphone is a permission to change, an unreachable speech service
       * is a reason to type it, and everything else is a retry.
       */
      const said = {
        'not-allowed': 'The microphone is blocked. Allow it for this site, or type the list instead.',
        'service-not-allowed': 'This browser will not do speech recognition here. Type the list instead.',
        network: 'The speech service could not be reached. Type the list instead - that stays on the phone.'
      };
      fail(said[event.error] || 'The microphone stopped. Try again, or type the list.');
    };

    recogniser.onend = () => {
      if (stopped) return;
      current = null;

      quiet = settled === carried ? quiet + 1 : 0;
      carried = settled;

      if (quiet > MAX_QUIET_RESTARTS || Date.now() - began > MAX_LISTEN_MS) {
        finish();
        return;
      }

      // A beat before the next one. Restarting inside the event that ended the last
      // session throws on some builds, and a tight loop of them is a hot radio.
      restarting = setTimeout(() => {
        if (stopped) return;
        try {
          session();
        } catch {
          finish();
        }
      }, RESTART_DELAY_MS);
    };

    recogniser.start();
  }

  try {
    session();
  } catch {
    // start() throws if one is already running. Treated as the same failure as any
    // other, because from the sheet's point of view it is: nothing is listening.
    onError?.('Could not start listening. Try again.');
    return { stop() {} };
  }

  return {
    stop() {
      if (stopped) return;
      stopped = true;
      clearTimeout(restarting);
      const recogniser = current;
      current = null;
      try { recogniser?.stop(); } catch { /* already ended */ }
      onEnd?.(settled);
    }
  };
}
