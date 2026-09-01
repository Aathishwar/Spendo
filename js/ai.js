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
 * Six seconds, which is shorter than the server's own timeout on purpose: this runs
 * while someone is filling in a form, and a guess that arrives after they have
 * already picked a category is worse than no guess. The caller drops a late answer
 * anyway; this stops the request outliving the sheet.
 */
export async function suggestCategory(description, categories) {
  const out = await post('/api/categorise', { description, categories }, 6000);
  return out?.category || null;
}

/** Two or three sentences about a month, from figures computed on this device. */
export async function writeReview(facts) {
  const out = await post('/api/review', { facts }, 20000);
  return out?.text || null;
}
