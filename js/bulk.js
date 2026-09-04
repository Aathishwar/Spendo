/**
 * Spendo - reading several expenses out of one sentence
 *
 * This is the free layer. Someone says "200 auto, 150 lunch, 900 groceries" and
 * that is three entries with no model, no network and no quota spent - which is
 * what most spoken lists actually look like, because a person listing what they
 * spent says the number and then the thing.
 *
 * It is deliberately a regex and not a parser. The moment the sentence stops
 * looking like a list - "two hundred rupees for an auto to the office and then
 * about one fifty for lunch" - this gives up and SAYS it gave up, and the caller
 * hands the same text to the model. A local layer that guessed at those would be
 * worse than one that admits it cannot read them, because a wrong amount in a
 * ledger is not visible as wrong later.
 *
 * Nothing here writes to the store. It returns drafts; the review sheet is what
 * turns them into entries, and only after someone has looked at them.
 */

import { todayISO, yesterdayISO, ymOf } from './format.js';

/*
 * Where one entry ends and the next begins.
 *
 * A comma is the reliable one - both speech recognition and a typing thumb put one
 * between items. The words are there because dictation often drops the comma and
 * says the join out loud instead.
 *
 * " and " splits "fish and chips" too, which is wrong. It is left in anyway: that
 * mistake produces a segment with no amount in it, which is exactly the signal that
 * sends the whole text to the model, so the damage is a slower answer rather than a
 * wrong one.
 */
const SPLIT = /\s*(?:,|;|\n|\band\b|\bthen\b|\balso\b|\bplus\b)\s*/i;

/*
 * Words that carry no information once the amount has been pulled out.
 *
 * Kept short on purpose. Every word removed here is a word that cannot end up in a
 * description, and a description is what the category guess reads - so stripping
 * "coffee" to be tidy would cost more than the tidiness is worth. These are only
 * the ones that are always plumbing: the verb, the preposition, the currency.
 */
const NOISE = new Set([
  'i', 'spent', 'spend', 'paid', 'pay', 'gave', 'give',
  'got', 'get', 'received', 'receive', 'credited', 'earned',
  'for', 'on', 'to', 'at', 'of', 'the', 'a', 'an', 'my', 'some',
  'rs', 'rupee', 'rupees', 'inr', 'bucks', 'about', 'around', 'approx', 'roughly',
  'was', 'is', 'it', 'that', 'there'
]);

/** Money arriving rather than leaving, said in any of the usual ways. */
const INCOME = /\b(got|receiv\w*|credit\w*|salary|stipend|refund\w*|income|earn\w*|cashback|reimburse\w*)\b/i;

/*
 * When it happened, if the sentence says so.
 *
 * Only the two that come up in speech. Anything more - "last Tuesday", "on the
 * 14th" - is a date grammar, and the search field already has one of those; putting
 * a second, different one here would be two answers to the same question.
 */
const WHEN = [
  [/\byesterday\b/i, () => yesterdayISO()],
  [/\btoday\b/i, () => todayISO()]
];

/*
 * The amount, and the two ways people write a thousand.
 *
 * `2k` and `2.5k` are common in typed notes; "2 thousand" turns up in dictation.
 * Both multiply. A bare number is taken as written, including its paise.
 */
const AMOUNT = /(?:₹|\brs\.?\s*|\binr\s*)?(\d+(?:[.,]\d{1,2})?)\s*(k\b|thousand\b|lakh\b|lakhs\b)?/i;

const SCALE = { k: 1000, thousand: 1000, lakh: 100000, lakhs: 100000 };

function clean(segment) {
  return segment
    .replace(/[^\p{L}\p{N}\s.'-]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Title-case the first letter and nothing else.
 *
 * Speech recognition returns everything lower case mid-sentence, and a ledger of
 * lower-case descriptions reads as a transcript rather than as records. Only the
 * first letter, because "Auto To Office" reads as a heading.
 */
function sentence(text) {
  return text ? text[0].toUpperCase() + text.slice(1) : text;
}

/**
 * One segment to one draft entry, or null if there is no amount in it.
 *
 * The amount is cut out of the string rather than merely read, so the description
 * is whatever is left over. That is why "auto 200" and "200 auto" both come out as
 * "Auto": position never mattered, only what remains once the number is gone.
 */
function readSegment(raw, fallbackDate) {
  const text = clean(raw);
  if (!text) return null;

  const hit = AMOUNT.exec(text);
  if (!hit) return null;

  const value = Number(String(hit[1]).replace(',', '.'));
  if (!Number.isFinite(value) || value <= 0) return null;

  const scale = hit[2] ? SCALE[hit[2].toLowerCase().replace(/s$/, '')] || 1 : 1;
  const amount = Math.round(value * scale * 100) / 100;

  let date = fallbackDate;
  let rest = text.slice(0, hit.index) + ' ' + text.slice(hit.index + hit[0].length);

  for (const [pattern, resolve] of WHEN) {
    if (pattern.test(rest)) {
      date = resolve();
      rest = rest.replace(pattern, ' ');
    }
  }

  const direction = INCOME.test(text) ? 'in' : 'out';

  /*
   * Capped at the same 80 the server caps at.
   *
   * A segment with one amount in it and forty words after it is not a description,
   * it is a transcript that went wrong - which is exactly what a duplicated speech
   * result produced. Cutting it keeps the review row readable and keeps the two ends
   * of this feature agreeing about what a description is.
   */
  const description = sentence(
    clean(rest)
      .split(' ')
      .filter((w) => w && !NOISE.has(w.toLowerCase()))
      .join(' ')
      .slice(0, 80)
      .trim()
  );

  /*
   * A second number left over means this segment is probably two entries.
   *
   * Dictation drops the joining word more often than it drops the comma, so "200
   * petrol and 500 milk" arrives as "200 petrol 500 milk" - one segment, and this
   * parser reads it as two hundred rupees of "Petrol 500 milk". One entry with the
   * wrong description and half the money missing, reported confidently.
   *
   * It is NOT split here. Splitting at every number breaks "iPhone 15 case 2000" and
   * "Room 2 rent 5000" into nonsense, and a wrong entry is worse than a slow one.
   * The segment is flagged instead, which sends the whole sentence to the model -
   * which is what the model is for.
   */
  return { amount, description, direction, date, ym: ymOf(date), doubtful: /\d/.test(rest) };
}

/**
 * Read a whole spoken or typed line into drafts.
 *
 * Returns the entries it found AND the segments it could not read, because the
 * second list is the decision the caller has to make. `confident` is the same
 * decision expressed once, so no two callers can disagree about it. Three ways of
 * not being sure:
 *
 *   - nothing found at all
 *   - a leftover segment with real words in it - "two hundred rupees for an auto"
 *     is two words of noise to this parser and a whole entry to a model
 *   - a segment with a SECOND number still in it after the amount came out, which is
 *     what "200 petrol 500 milk" looks like when dictation drops the "and"
 *
 * Any of those means hand it over. A leftover of one stray word is not worth a round
 * trip; that is usually "ok" or "um" or half of a split "fish and chips".
 */
export function parseSpoken(text, { date } = {}) {
  const fallback = date || todayISO();
  const segments = String(text || '').split(SPLIT).map(clean).filter(Boolean);

  const entries = [];
  const leftover = [];
  let doubtful = 0;

  for (const segment of segments) {
    const entry = readSegment(segment, fallback);
    if (!entry) {
      leftover.push(segment);
      continue;
    }
    if (entry.doubtful) doubtful += 1;
    delete entry.doubtful;
    entries.push(entry);
  }

  const wordy = leftover.filter((s) => s.split(' ').filter((w) => w.length > 1).length >= 2);
  const confident = entries.length > 0 && wordy.length === 0 && doubtful === 0;

  return { entries, leftover, confident };
}
