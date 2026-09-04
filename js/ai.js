/**
 * Spendo - the calls that reach the model
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
 *   tips         figures only, over several months: monthly totals, and per category
 *                what was spent against what is usual. Same rule - no description,
 *                no date, no single transaction.
 *   parseEntries the sentence someone spoke or typed, the category ids, and today's
 *                date so "yesterday" can be resolved. Nothing from the ledger. It is
 *                the only one of the four that carries words the user just said
 *                rather than words they had already saved.
 *
 * All four are behind the single switch in Settings. `available()` is the one place
 * that reads it, so turning it off means nothing is sent - not less, none.
 */

import { isSignedIn } from './identity.js';
import { aiOn } from './store.js';

/**
 * Whether a model call may be made right now.
 *
 * Three conditions, and the switch is first because it is the only one the person
 * chose. Exported so a screen can ask the same question this file asks - a button
 * offering to fetch suggestions that cannot be fetched is worse than no button.
 */
export function available() {
  return aiOn() && isSignedIn() && navigator.onLine;
}

async function post(url, body, timeoutMs) {
  /*
   * One gate for every route.
   *
   * Deliberately here rather than at each call site: the Settings switch has to be
   * a promise that nothing is sent, and a promise kept in four places is a promise
   * that gets broken in the fifth. Signed out there is no session either, so the
   * request would 401 - not an error worth making, and not one worth showing.
   */
  if (!available()) return null;

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

/**
 * Three suggested changes, from several months of figures, or null.
 *
 * Longer deadline than the write-up because there is more to read and three answers
 * to give, and because nothing is waiting on it: the button says what it is doing and
 * the rest of the screen is already usable.
 *
 * Shape-checked here as well as on the server. The screen renders whatever comes back,
 * so a malformed item is a broken card, and a broken card is worse than no card.
 */
export async function suggestTips(facts) {
  const out = await post('/api/tips', { facts }, 30000);
  const items = Array.isArray(out?.tips) ? out.tips : [];
  const clean = items
    .filter((t) => t && typeof t.title === 'string' && typeof t.detail === 'string')
    .map((t) => ({ title: t.title.trim(), detail: t.detail.trim() }))
    .filter((t) => t.title && t.detail)
    .slice(0, 3);
  return clean.length ? clean : null;
}

/**
 * A spoken list read into draft entries, or null.
 *
 * Only called when the device's own parser could not read the text - see js/bulk.js.
 * Twenty-five seconds because this is the longest of the prompts and there is a
 * progress state on screen counting it out; the sheet says what it is doing rather
 * than sitting blank, so a slow answer is a slow answer and not a broken button.
 *
 * Shape-checked here as well as on the server, for the same reason the tips are:
 * the review sheet renders whatever arrives, and a row with no amount in it is a
 * field the person cannot fix and cannot dismiss.
 */
export async function parseEntries(text, today, categories) {
  const out = await post('/api/parse-entries', { text, today, categories }, 25000);
  if (!Array.isArray(out?.entries)) return null;

  const allowed = new Set(categories);
  return out.entries
    .filter((r) => r && typeof r === 'object')
    .map((r) => ({
      amount: Number(r.amount),
      description: String(r.description || '').trim(),
      direction: r.direction === 'in' ? 'in' : 'out',
      category: allowed.has(r.category) ? r.category : null,
      date: /^\d{4}-\d{2}-\d{2}$/.test(String(r.date)) ? String(r.date) : today
    }))
    .filter((r) => Number.isFinite(r.amount) && r.amount > 0 && r.description)
    .slice(0, 20);
}
