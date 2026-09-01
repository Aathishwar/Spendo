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

/*
 * Chosen by measurement, not by recognising the name. Ten Indian expense descriptions
 * that the phone's own layers would miss, scored for accuracy and latency:
 *
 *   openai/gpt-oss-120b                   10/10   median 1135ms   worst  1416ms
 *   openai/gpt-oss-20b                     9/10   median 2645ms   worst  6021ms
 *   nvidia/nemotron-3.5-lightning-30b-a3b  5/10   median 10315ms  worst 36174ms
 *
 * The 120b being both more accurate AND twice as fast as the 20b is not what anyone
 * would predict; it is presumably better provisioned. Which is the point of running
 * the test.
 *
 * Two things worth knowing before changing this:
 *
 * - /v1/models lists 82 models and is a catalogue, not an entitlement. Most of them
 *   return 404 on the first chat call. Anything set here has to be tried.
 * - The models that do answer REASON first. gpt-oss puts that in `reasoning_content`
 *   and leaves `content` clean; nemotron-lightning puts it in `content`, which is
 *   why it scores 5/10 - half its answers are the start of a thinking-out-loud that
 *   the token budget cut off.
 */
const MODEL = process.env.NIM_MODEL || 'openai/gpt-oss-120b';

/*
 * A model call that hangs is a request that hangs.
 *
 * Generous, because a NIM function that has gone cold takes far longer on the first
 * call than on the tenth, and the client has its own shorter deadline anyway - it
 * gives up in six seconds and shows no guess. A call still running after that is not
 * wasted: it warms the function for the next one.
 */
const TIMEOUT_MS = Number(process.env.NIM_TIMEOUT_MS || 20000);

const apiKey = () => process.env.NIM_API_KEY || '';

export function aiConfigured() {
  return Boolean(apiKey());
}

/*
 * `max_tokens` has to cover the thinking, not just the answer.
 *
 * This was 8 for categorisation - one word plus slack - and it produced nothing
 * usable from any model on this endpoint, because the budget was spent before the
 * reasoning finished and `content` came back empty or truncated mid-thought. The
 * app's own validator caught it and returned null, which is the right failure but
 * looked exactly like the feature not working.
 */
async function chat(messages, { maxTokens = 512, temperature = 0 } = {}) {
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
