/**
 * Spendo - the two calls that reach the model
 *
 * Both go to our own server, never to NVIDIA directly: the key cannot be in a file
 * the browser downloads. Both need a session, and both fail to `null` rather than
 * throwing, because every caller has a local answer already and a model that is
 * unreachable must not be visible as an error.
 *
 * What leaves the device:
 *
 *   categorise   the description text, and the list of category ids. Nothing else -
 *                no amount, no date, no history, no account id in the body.
 *   review       figures only. Totals, category shares, last month's total. No
 *                description, no date, no individual transaction ever.
 */

import { isSignedIn } from './identity.js';

async function post(url, body, timeoutMs) {
  // Signed out there is no session, so the request would 401. Not an error worth
  // making, and not one worth showing.
  if (!isSignedIn() || !navigator.onLine) return null;

  const control = new AbortController();
  const timer = setTimeout(() => control.abort(), timeoutMs);

  try {
    const res = await fetch(url, {
      method: 'POST',
      credentials: 'same-origin',
      signal: control.signal,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body)
    });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * A category id for a description the phone could not place, or null.
 *
 * Twelve seconds, raised from six after measuring it. In a tight loop the model
 * answers in about a second, but spaced out the way a person actually types it ran
 * 2.2s to 6.6s - so a six-second deadline was throwing away correct answers that had
 * already been paid for.
 *
 * A long deadline is safe here because lateness is handled at the other end: the
 * caller checks that the sheet is still open, the description unchanged and the
 * category still untouched before it applies anything, and caches the answer either
 * way. So the worst case is a request nobody reads, which still leaves the model
 * warm for the next one.
 */
export async function suggestCategory(description, categories) {
  const out = await post('/api/categorise', { description, categories }, 12000);
  return out?.category || null;
}

/** Two or three sentences about a month, from figures computed on this device. */
export async function writeReview(facts) {
  const out = await post('/api/review', { facts }, 20000);
  return out?.text || null;
}
