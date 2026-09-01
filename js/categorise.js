/**
 * Spendo - guessing the category from the description
 *
 * Three layers, cheapest first, and the model is the LAST of them.
 *
 *   1. your own history      exact, then a vote across shared words
 *   2. a keyword table       for the first weeks, before there is any history
 *   3. the server, and NIM   only when 1 and 2 both miss
 *
 * The ordering is the whole design. A model is the obvious thing to reach for and
 * the wrong thing to reach for first: it costs a round trip on the hottest path in
 * the app, it does nothing with no signal, and it does not know that your "MRF" is a
 * tyre shop. Your own history does. After a few weeks most descriptions repeat, so
 * layer 1 answers most of them in under a millisecond.
 *
 * Layer 3's answer is written back into layer 1's cache, so any one description is
 * only ever sent once.
 *
 * Nothing here blocks. `guess()` is synchronous and local; the caller decides
 * separately whether to ask the server about a miss.
 */

import * as store from './store.js';
import { categoriesFor } from './categories.js';

const CACHE_KEY = 'spendo.aiCategories';
const CACHE_MAX = 300;

/*
 * Words that carry no signal about what something was. "bill" is deliberately NOT
 * here - it is one of the strongest signals in the table below.
 */
const STOP = new Set([
  'for', 'the', 'a', 'an', 'at', 'in', 'on', 'to', 'of', 'and', 'my', 'with',
  'some', 'from', 'rs', 'inr', 'paid', 'pay', 'this', 'that', 'it', 'is', 'was'
]);

/**
 * The cold-start table, for before there is any history to learn from.
 *
 * Weighted to what actually gets typed here rather than to a generic English list:
 * the delivery apps, the fuel brands, the chains, and the Tamil/Hindi words that get
 * mixed into an English description.
 */
const KEYWORDS = {
  food: [
    'swiggy', 'zomato', 'restaurant', 'hotel', 'cafe', 'coffee', 'tea', 'chai',
    'breakfast', 'lunch', 'dinner', 'snack', 'snacks', 'tiffin', 'meals', 'mess',
    'biryani', 'dosa', 'idli', 'pizza', 'burger', 'juice', 'bakery', 'canteen',
    'starbucks', 'dominos', 'mcdonalds', 'kfc', 'subway', 'icecream', 'sweets'
  ],
  transport: [
    'petrol', 'diesel', 'fuel', 'gas', 'uber', 'ola', 'rapido', 'auto', 'cab',
    'taxi', 'bus', 'train', 'metro', 'irctc', 'flight', 'ticket', 'toll', 'parking',
    'service', 'puncture', 'tyre', 'bike', 'car', 'scooter', 'hp', 'iocl', 'bpcl',
    'indianoil', 'shell', 'fastag'
  ],
  groceries: [
    'grocery', 'groceries', 'vegetables', 'veggies', 'fruits', 'milk', 'eggs',
    'rice', 'dal', 'oil', 'atta', 'provision', 'kirana', 'supermarket', 'market',
    'bigbasket', 'blinkit', 'zepto', 'instamart', 'dmart', 'reliancefresh',
    'more', 'spencers', 'nilgiris', 'freshtomeat', 'butcher', 'meat', 'fish'
  ],
  bills: [
    'bill', 'electricity', 'eb', 'current', 'water', 'gas', 'cylinder', 'lpg',
    'recharge', 'mobile', 'phone', 'jio', 'airtel', 'vi', 'vodafone', 'bsnl',
    'broadband', 'wifi', 'internet', 'act', 'hathway', 'dth', 'tata', 'sky',
    'insurance', 'premium', 'emi', 'loan', 'maintenance', 'society', 'tax'
  ],
  shopping: [
    'amazon', 'flipkart', 'myntra', 'ajio', 'meesho', 'nykaa', 'shirt', 'tshirt',
    'jeans', 'shoes', 'chappal', 'dress', 'saree', 'clothes', 'bag', 'watch',
    'headphones', 'charger', 'cable', 'mobile', 'laptop', 'decathlon', 'ikea',
    'furniture', 'gift'
  ],
  health: [
    'medicine', 'medicines', 'pharmacy', 'chemist', 'apollo', 'medplus', 'netmeds',
    'pharmeasy', 'doctor', 'clinic', 'hospital', 'consultation', 'scan', 'xray',
    'test', 'lab', 'dental', 'dentist', 'gym', 'physio', 'tablets'
  ],
  rent: ['rent', 'lease', 'deposit', 'advance', 'landlord', 'pg', 'hostel'],
  fun: [
    'movie', 'cinema', 'pvr', 'inox', 'netflix', 'prime', 'hotstar', 'spotify',
    'youtube', 'game', 'games', 'steam', 'concert', 'trip', 'outing', 'party',
    'bar', 'pub', 'beer', 'club', 'zoo', 'museum', 'park'
  ],
  salary: ['salary', 'stipend', 'wages', 'payroll', 'credited', 'incentive', 'bonus'],
  refund: ['refund', 'refunded', 'return', 'returned', 'cashback', 'reversal', 'settled'],
  gift: ['gift', 'gifted', 'birthday', 'shagun', 'present']
};

/** keyword -> category id, built once. */
const KEYWORD_INDEX = (() => {
  const index = new Map();
  for (const [id, words] of Object.entries(KEYWORDS)) {
    for (const w of words) {
      // First writer wins, so the order of KEYWORDS above resolves a word that
      // appears twice ("gas" is a bill more often than it is fuel here).
      if (!index.has(w)) index.set(w, id);
    }
  }
  return index;
})();

/* ------------------------------------------------------------------ text */

export function normalise(text) {
  return String(text || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

function words(text) {
  return normalise(text)
    .split(' ')
    .filter((w) => w.length > 1 && !STOP.has(w) && !/^\d+$/.test(w));
}

/* --------------------------------------------------- layer 3's local cache */

function readCache() {
  try {
    const raw = localStorage.getItem(CACHE_KEY);
    const parsed = raw ? JSON.parse(raw) : null;
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

/**
 * Remember what the server said, so the same description is never sent twice.
 *
 * Deliberately NOT in the synced store: this is a local convenience that can be
 * rebuilt from nothing, and putting it in the store would push it to the server and
 * back down to every other device for no gain.
 */
export function remember(description, categoryId) {
  const key = normalise(description);
  if (!key || !categoryId) return;
  try {
    const cache = readCache();
    delete cache[key];              // re-insert so it is the newest key
    cache[key] = categoryId;
    const keys = Object.keys(cache);
    // Oldest first, because object key order is insertion order for string keys.
    for (const stale of keys.slice(0, Math.max(0, keys.length - CACHE_MAX))) delete cache[stale];
    localStorage.setItem(CACHE_KEY, JSON.stringify(cache));
  } catch (e) {
    console.warn('[categorise] could not cache:', e.message);
  }
}

/* ------------------------------------------------------------- layer one */

/**
 * An index of what this person has actually done, rebuilt on demand.
 *
 * Two maps: the whole description, and a vote per word. The first catches "Petrol"
 * typed for the ninth time; the second catches "petrol bunk near office" when only
 * "Petrol" has been typed before.
 */
function historyIndex(direction) {
  const exact = new Map();
  const votes = new Map();
  const allowed = new Set(categoriesFor(direction).map((c) => c.id));

  // Newest last, so a later choice overwrites an earlier one in `exact`: changing
  // your mind about a description should stick.
  for (const e of store.snapshotEntries()) {
    if (e.deletedAt || !e.description || !allowed.has(e.category)) continue;

    exact.set(normalise(e.description), e.category);
    for (const w of words(e.description)) {
      if (!votes.has(w)) votes.set(w, new Map());
      const tally = votes.get(w);
      tally.set(e.category, (tally.get(e.category) || 0) + 1);
    }
  }
  return { exact, votes, allowed };
}

/* ------------------------------------------------------------------ guess */

/**
 * The best local guess, or null.
 *
 * Returns the source too, because the caller needs to know whether a miss is worth
 * a network request - and because "where did that come from" is the first question
 * anyone asks when it gets one wrong.
 */
export function guess(description, direction = 'out') {
  const key = normalise(description);
  if (!key) return null;

  const { exact, votes, allowed } = historyIndex(direction);

  // 1a. This exact description, before.
  if (exact.has(key)) return { category: exact.get(key), source: 'history' };

  // 1b. What the server said about this exact description, before.
  const cached = readCache()[key];
  if (cached && allowed.has(cached)) return { category: cached, source: 'cache' };

  const ws = words(description);
  if (!ws.length) return null;

  // 1c. A vote across the words, weighted by how often each has been seen. Needs a
  // clear winner: a word used for two categories equally says nothing.
  const tally = new Map();
  let total = 0;
  for (const w of ws) {
    const seen = votes.get(w);
    if (!seen) continue;
    for (const [id, n] of seen) {
      tally.set(id, (tally.get(id) || 0) + n);
      total += n;
    }
  }
  if (total > 0) {
    const [best, n] = [...tally].sort((a, b) => b[1] - a[1])[0];
    if (n / total >= 0.6) return { category: best, source: 'history' };
  }

  // 2. The cold-start table.
  for (const w of ws) {
    const id = KEYWORD_INDEX.get(w);
    if (id && allowed.has(id)) return { category: id, source: 'keyword' };
  }

  return null;
}
