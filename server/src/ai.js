/**
 * Spendo - the model, and the two things it is allowed to do
 *
 * Groq speaks the OpenAI chat-completions shape, so this is a fetch and a JSON
 * body; there is no SDK to add.
 *
 * The key lives here and only here. It cannot go in the client - anything the page
 * can read, anyone reading the page can read - so both features are server routes
 * that a signed-in session may call, and the rate limits below are what stop a
 * session being used to burn the quota.
 *
 * Two rules that shape everything in this file:
 *
 * 1. **The model is never asked what a number is.** The month write-up is handed
 *    figures that were computed on the device and asked only to phrase them. A
 *    paragraph that is confidently wrong about someone's money is worse than no
 *    paragraph, and there is no way for the reader to tell the difference.
 * 2. **Its answer is validated before it is used.** Categorisation returns one id
 *    from a fixed list, and anything else - a sentence, a hallucinated id, an empty
 *    string - becomes null, which the client already handles as "no guess".
 *
 * Not configured is a supported state, exactly as it is for mail.js: without a key
 * both routes answer "no", and every local layer of the app carries on unchanged.
 */

const AI_URL = process.env.AI_URL || 'https://api.groq.com/openai/v1/chat/completions';

/*
 * Groq, and a model that can also see.
 *
 * The text features here do not need vision - a category comes from a description,
 * a write-up from figures - but the receipt-photo entry that comes later does, and
 * running one model for both means one client, one key, one set of limits. That is
 * the reason for the move off NVIDIA NIM, which had no vision model on this key.
 *
 * Two things learned on NIM that still apply to anything set here:
 *
 * - A model listed by /v1/models is not necessarily a model the key may invoke.
 *   Anything put here has to be tried before it is trusted.
 * - These models REASON before answering, so `max_completion_tokens` has to cover
 *   the thinking as well as the answer, and the reply has to be read with the
 *   thinking stripped. Qwen wraps it in <think> tags inside `content`; others use a
 *   separate `reasoning` field. Both are handled below.
 */
const MODEL = process.env.AI_MODEL || 'qwen/qwen3.8-27b';

/*
 * A model call that hangs is a request that hangs.
 *
 * Generous, because the client has its own shorter deadline anyway and gives up
 * without showing a guess. A call still running after that is not wasted: its answer
 * is cached for the next time the same description is typed.
 */
const TIMEOUT_MS = Number(process.env.AI_TIMEOUT_MS || 20000);

const apiKey = () => process.env.GROQ_API_KEY || '';

export function aiConfigured() {
  return Boolean(apiKey());
}

/*
 * The token budget has to cover the thinking, not just the answer.
 *
 * This was 8 for categorisation - one word plus slack - and it produced nothing
 * usable, because the budget was spent before the reasoning finished and `content`
 * came back empty or truncated mid-thought. The app's own validator caught it and
 * returned null, which is the right failure but looked exactly like the feature not
 * working.
 */
async function chat(messages, { maxTokens = 512, temperature = 0 } = {}) {
  if (!aiConfigured()) return null;

  const control = new AbortController();
  const timer = setTimeout(() => control.abort(), TIMEOUT_MS);

  try {
    const res = await fetch(AI_URL, {
      method: 'POST',
      signal: control.signal,
      headers: {
        authorization: `Bearer ${apiKey()}`,
        'content-type': 'application/json',
        accept: 'application/json'
      },
      body: JSON.stringify({
        model: MODEL,
        messages,
        temperature,
        max_completion_tokens: maxTokens,
        // Keep the thinking out of the reply. Where the model honours this the
        // answer arrives clean; where it does not, the <think> strip below catches
        // it. Belt and braces, because a leaked thought is not a category id.
        reasoning_format: 'hidden',
        stream: false
      })
    });

    if (!res.ok) {
      const detail = await res.text();
      console.warn('[ai] refused:', res.status, detail.slice(0, 200));
      return null;
    }

    const body = await res.json();
    const raw = body?.choices?.[0]?.message?.content;
    if (typeof raw !== 'string') return null;
    // A model that reasons inside `content` opens <think> and may never close it if
    // the budget ran out. Drop from the tag onwards either way.
    const text = raw.replace(/<think>[\s\S]*?<\/think>/g, '').replace(/<think>[\s\S]*$/, '').trim();
    return text || null;
  } catch (err) {
    // An aborted or failed call is a miss, never an error the user sees: every
    // caller has a local answer to fall back to.
    console.warn('[ai] call failed:', err.name === 'AbortError' ? `timed out after ${TIMEOUT_MS}ms` : err.message);
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/* --------------------------------------------------------------- categorise */

/**
 * One category id for one description, or null.
 *
 * The description is the ONLY thing sent - no amount, no date, no account, no
 * history. That is the whole payload, and it is what makes this safe to enable: a
 * leak at the far end reveals a few words with nothing attached to them.
 */
export async function categorise(description, allowed) {
  const text = await chat([
    {
      role: 'system',
      content:
        'You label a personal expense from its description. ' +
        `Reply with exactly one id from this list and nothing else: ${allowed.join(', ')}. ` +
        'The descriptions are Indian and often mix English with Tamil or Hindi words, ' +
        'and often name a shop, app or brand rather than the thing bought. ' +
        // Without this a bare personal name gets forced into whatever category is
        // nearest - "thari" came back as shopping. Money handed to a person is not
        // a purchase, and guessing what they spent it on is inventing information.
        //
        // The second half matters as much as the first. An earlier version stopped
        // at "a name is not a purchase" and the model started answering `other` for
        // anything it found unfamiliar - "gobi", "maavu", "router", "book" - trading
        // a wrong category for a useless one. Naming a thing is always enough.
        'A description that is ONLY a person\'s name, with no thing bought, is not a ' +
        'purchase: answer with the last id in the list. Do the same for money given ' +
        'to or received from a person, for savings and investments, and for bank ' +
        'charges. But if the description names anything that was actually bought, ' +
        'categorise it by that thing, however unfamiliar the word - many are Tamil ' +
        'names for food and household goods. ' +
        'If none clearly fits, reply with the last id in the list.'
    },
    { role: 'user', content: description }
  ], { maxTokens: 512, temperature: 0 });

  if (!text) return null;

  // Validated, not trusted. A model asked for one word will sometimes send a
  // sentence, so this looks for a known id inside whatever came back rather than
  // demanding an exact match - and returns null if there is not exactly one.
  const lower = text.toLowerCase();
  const found = allowed.filter((id) => new RegExp(`\\b${id}\\b`).test(lower));
  return found.length === 1 ? found[0] : null;
}

/* ------------------------------------------------------------------ review */

const money = (n) => `Rs ${Math.round(Number(n) || 0).toLocaleString('en-IN')}`;

/**
 * Two or three sentences about a month, from figures the device computed.
 *
 * What is sent: totals, the top category shares, and last month's total. What is
 * NOT sent: any description, any date, any individual transaction. The prose can
 * say "your biggest single expense was Rs 3,400" without ever being told what it
 * was for.
 */
export async function reviewMonth(facts) {
  const lines = [
    `Month: ${facts.ym}${facts.isCurrent ? ' (still running)' : ''}`,
    `Total spent: ${money(facts.spent)}`,
    `Money received: ${money(facts.received)}`,
    `Started with: ${money(facts.opening)}`,
    `Left at the end: ${money(facts.balance)}`,
    `Transactions: ${facts.count}, on ${facts.activeDays} of ${facts.daysInMonth} days`,
    `Biggest single expense: ${money(facts.biggestAmount)}`
  ];

  if (facts.top?.length) {
    lines.push('Where it went: ' + facts.top
      .map((t) => `${t.label} ${money(t.amount)} (${Math.round(t.share * 100)}%)`)
      .join(', '));
  }
  if (facts.prev) {
    const dir = facts.prev.delta >= 0 ? 'more than' : 'less than';
    lines.push(`Last month: ${money(facts.prev.spent)} - so ${money(Math.abs(facts.prev.delta))} ${dir} last month`);
  }

  const text = await chat([
    {
      role: 'system',
      content:
        'You write a short plain-language summary of one month of personal spending, ' +
        'for the person who spent it. Two or three sentences, under 60 words. ' +
        'Use only the figures you are given and never invent one. ' +
        'Amounts in rupees, written like Rs 12,300. ' +
        'Say what stands out and what changed. ' +
        'No greeting, no sign-off, no bullet points, no advice unless the figures ' +
        'plainly support it. Do not moralise about the spending.'
    },
    { role: 'user', content: lines.join('\n') }
  ], { maxTokens: 1024, temperature: 0.3 });

  return text ? text.replace(/\s+/g, ' ').trim() : null;
}

/* -------------------------------------------------------------------- tips */

/**
 * Three suggested changes, from several months of figures.
 *
 * The same rule as the write-up, one step further: the model is given totals and is
 * asked what to DO about them, never what they are. It is told the average for each
 * category as well as this month's figure, because "Food is Rs 1,800 above its own
 * usual" is a suggestion someone can act on and "Food is your biggest category" is
 * an observation they already had.
 *
 * Answers come back as JSON. A model asked for prose returns three paragraphs that
 * each have to be split and trimmed by hand, and the split is what breaks first when
 * the wording changes; asking for a small object per suggestion means the failure is
 * a parse error - loud, catchable, and answered with null - rather than a card with
 * half a sentence in it.
 */
export async function spendingTips(facts) {
  const lines = [
    `Latest month: ${facts.ym}${facts.isCurrent ? ' (still running)' : ''}`,
    `Spent this month: ${money(facts.spent)}`,
    `Received this month: ${money(facts.received)}`,
    `Left right now: ${money(facts.balance)}`,
    `Average month over the last ${facts.monthsCovered}: ${money(facts.avgMonthly)}`
  ];

  if (facts.series?.length) {
    lines.push('Month by month: ' + facts.series.map((m) => `${m.ym} ${money(m.spent)}`).join(', '));
  }
  if (facts.categories?.length) {
    lines.push('This month by category, against what that category usually costs:');
    for (const c of facts.categories) {
      const move = c.usual > 0
        ? `${money(Math.abs(c.delta))} ${c.delta >= 0 ? 'above' : 'below'} its usual ${money(c.usual)}`
        : 'no earlier months to compare with';
      lines.push(`- ${c.label}: ${money(c.amount)} (${Math.round(c.share * 100)}% of the month), ${move}`);
    }
  }

  const text = await chat([
    {
      role: 'system',
      content:
        'You suggest where someone could spend less, from their own monthly figures. ' +
        'Reply with JSON only: an array of exactly 3 objects, each {"title","detail"}. ' +
        'No markdown, no code fence, no text outside the array. ' +
        'title: under 6 words, names the change, not the category. ' +
        'detail: one sentence under 30 words, quoting the figure it is based on. ' +
        'Amounts in rupees, written like Rs 12,300, and only figures you were given. ' +
        // Without this it produces the same three sentences for everybody - eat out
        // less, cancel subscriptions, make a budget - which is advice about spending
        // in general rather than about this person's spending.
        'Base every suggestion on a category that is actually large or actually rose, ' +
        'and say roughly what it would save a month. ' +
        'Rank them: biggest realistic saving first. ' +
        'Rent, Bills and Health are hard to cut - do not lead with them, and never ' +
        'suggest skipping medical care. ' +
        'Write to the person, plainly. No greeting, no moralising, no shame.'
    },
    { role: 'user', content: lines.join('\n') }
  ], { maxTokens: 1400, temperature: 0.4 });

  if (!text) return null;

  /*
   * Validated, not trusted, exactly as the category id is.
   *
   * A model told "JSON only" still occasionally wraps it in a fence or writes a line
   * before it, so the array is cut out of whatever came back rather than the whole
   * reply being handed to JSON.parse.
   */
  const start = text.indexOf('[');
  const end = text.lastIndexOf(']');
  if (start === -1 || end <= start) return null;

  let parsed;
  try {
    parsed = JSON.parse(text.slice(start, end + 1));
  } catch {
    return null;
  }
  if (!Array.isArray(parsed)) return null;

  const tips = parsed
    .filter((t) => t && typeof t === 'object')
    .map((t) => ({
      title: String(t.title || '').replace(/\s+/g, ' ').trim().slice(0, 60),
      detail: String(t.detail || '').replace(/\s+/g, ' ').trim().slice(0, 240)
    }))
    .filter((t) => t.title && t.detail)
    .slice(0, 3);

  return tips.length ? tips : null;
}

/* ------------------------------------------------------------------- bulk */

/**
 * A spoken or typed list of expenses, turned into records. Or null.
 *
 * This is the SECOND reader, never the first. `js/bulk.js` on the device handles
 * "200 auto, 150 lunch" with a regex, offline and free, and only hands over when it
 * cannot - "two hundred rupees for an auto and about one fifty for lunch". Sending
 * everything here would be a round trip and a quota slot for the easy majority.
 *
 * Rule 1 from the top of this file is bent here and nowhere else: the model IS
 * asked what a number is, because the number only exists as words. That is why
 * nothing it returns is saved. Every row lands in a review sheet with the amount in
 * an editable field and a checkbox that starts ticked, and the person taps Add. The
 * model proposes; the person is still the one recording it.
 *
 * The text is the ONLY thing sent. No history, no totals, no account, no dates from
 * the ledger - the model is told today's date so it can resolve "yesterday", and
 * that is the whole context it gets.
 */
export async function parseEntries(text, { today, categories }) {
  const raw = await chat([
    {
      role: 'system',
      content:
        'You turn a spoken list of personal expenses into records. ' +
        'Reply with JSON only: an array of objects, each ' +
        '{"amount","description","direction","category","date"}. ' +
        'No markdown, no code fence, no text outside the array. ' +
        'amount: a positive number in rupees, digits only, no symbol and no commas. ' +
        'Amounts may be spoken as words - "two hundred" is 200, "one fifty" is 150, ' +
        '"two and a half thousand" is 2500, "1.5k" is 1500, "two lakh" is 200000. ' +
        'description: the thing bought, 1 to 5 words, capitalised like a sentence. ' +
        'Never put the amount in the description. ' +
        'direction: "in" if the money was received, earned, refunded or credited, ' +
        'otherwise "out". ' +
        `category: exactly one id from this list: ${categories.join(', ')}. ` +
        'Use the last id when nothing fits. ' +
        `date: YYYY-MM-DD. Today is ${today}. Use today unless the text says ` +
        'otherwise - "yesterday", "on the 3rd", "last Monday". ' +
        // Without this it invents. Asked to read "200 auto and lunch", a model will
        // happily price the lunch at a plausible-looking 150, and a plausible wrong
        // number in a ledger is the one kind of error nobody catches later.
        'Only include an item whose amount is actually stated. Never estimate, ' +
        'never guess a typical price, never add an item that was not said. ' +
        'The text is Indian English and often mixes in Tamil or Hindi words. ' +
        'If nothing in it is an expense, reply with an empty array.'
    },
    { role: 'user', content: text }
  ], { maxTokens: 2000, temperature: 0 });

  if (!raw) return null;

  const start = raw.indexOf('[');
  const end = raw.lastIndexOf(']');
  if (start === -1 || end <= start) return null;

  let parsed;
  try {
    parsed = JSON.parse(raw.slice(start, end + 1));
  } catch {
    return null;
  }
  if (!Array.isArray(parsed)) return null;

  /*
   * Validated the same way a category id is: shaped, bounded, and dropped rather
   * than repaired. A row with no usable amount is not a row - it is the model
   * having answered a question it was told not to answer.
   *
   * Twenty is the ceiling. Nobody dictates more than that in one breath, and the
   * cap is what stops a long paste turning into a review sheet nobody can check.
   */
  const allowed = new Set(categories);
  const iso = /^\d{4}-\d{2}-\d{2}$/;

  const rows = parsed
    .filter((r) => r && typeof r === 'object')
    .map((r) => {
      const amount = Number(r.amount);
      return {
        amount: Number.isFinite(amount) ? Math.round(Math.abs(amount) * 100) / 100 : 0,
        description: String(r.description || '').replace(/\s+/g, ' ').trim().slice(0, 80),
        direction: r.direction === 'in' ? 'in' : 'out',
        category: allowed.has(r.category) ? r.category : null,
        date: iso.test(String(r.date)) ? String(r.date) : today
      };
    })
    .filter((r) => r.amount > 0 && r.description)
    .slice(0, 20);

  return rows;
}
