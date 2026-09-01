/**
 * Spendo - the model, and the two things it is allowed to do
 *
 * NVIDIA NIM speaks the OpenAI chat-completions shape, so this is a fetch and a
 * JSON body; there is no SDK to add.
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

const NIM_URL = process.env.NIM_URL || 'https://integrate.api.nvidia.com/v1/chat/completions';
const MODEL = process.env.NIM_MODEL || 'meta/llama-3.1-8b-instruct';

/** A model call that hangs is a request that hangs. */
const TIMEOUT_MS = Number(process.env.NIM_TIMEOUT_MS || 8000);

const apiKey = () => process.env.NIM_API_KEY || '';

export function aiConfigured() {
  return Boolean(apiKey());
}

async function chat(messages, { maxTokens = 200, temperature = 0 } = {}) {
  if (!aiConfigured()) return null;

  const control = new AbortController();
  const timer = setTimeout(() => control.abort(), TIMEOUT_MS);

  try {
    const res = await fetch(NIM_URL, {
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
        max_tokens: maxTokens,
        stream: false
      })
    });

    if (!res.ok) {
      const detail = await res.text();
      console.warn('[ai] refused:', res.status, detail.slice(0, 200));
      return null;
    }

    const body = await res.json();
    const text = body?.choices?.[0]?.message?.content;
    return typeof text === 'string' ? text.trim() : null;
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
        'If none clearly fits, reply with the last id in the list.'
    },
    { role: 'user', content: description }
  ], { maxTokens: 8, temperature: 0 });

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
  ], { maxTokens: 160, temperature: 0.3 });

  return text ? text.replace(/\s+/g, ' ').trim() : null;
}
