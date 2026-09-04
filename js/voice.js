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

/**
 * Listen until told to stop, or until the browser gives up on its own.
 *
 * `onText` is called with the whole transcript so far - settled text plus whatever
 * is still being revised - because that is what the sheet shows while someone is
 * talking, and a caller that wanted only the final would have to accumulate it
 * itself. `final` says which of the two it is.
 *
 * Returns a handle with `stop()`. Calling it twice is safe; so is calling it after
 * the browser has already ended the session, which it does after a few seconds of
 * silence on some platforms whatever `continuous` says.
 */
export function listen({ onText, onEnd, onError }) {
  if (!Recognition) {
    onError?.('This browser cannot listen. Type the list instead.');
    return { stop() {} };
  }

  const recogniser = new Recognition();
  recogniser.lang = LANG;
  // Several sentences, not one phrase: the whole point is a list, and a recogniser
  // that stops at the first pause turns "200 auto, 150 lunch" into one entry.
  recogniser.continuous = true;
  // Show the words as they are said. Without this the sheet is blank for the whole
  // time someone is talking, which reads as a microphone that is not working.
  recogniser.interimResults = true;
  recogniser.maxAlternatives = 1;

  let settled = '';
  let stopped = false;

  recogniser.onresult = (event) => {
    let pending = '';
    for (let i = event.resultIndex; i < event.results.length; i += 1) {
      const result = event.results[i];
      if (result.isFinal) settled += `${result[0].transcript} `;
      else pending += result[0].transcript;
    }
    onText?.(`${settled}${pending}`.replace(/\s+/g, ' ').trim(), false);
  };

  recogniser.onerror = (event) => {
    // `aborted` is what stop() produces, and `no-speech` is someone who tapped and
    // then said nothing. Neither is a failure worth a message.
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
    onError?.(said[event.error] || 'The microphone stopped. Try again, or type the list.');
  };

  recogniser.onend = () => {
    if (stopped) return;
    stopped = true;
    onEnd?.(settled.replace(/\s+/g, ' ').trim());
  };

  try {
    recogniser.start();
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
      try { recogniser.stop(); } catch { /* already ended */ }
      onEnd?.(settled.replace(/\s+/g, ' ').trim());
    }
  };
}
