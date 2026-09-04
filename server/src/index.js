/**
 * Spendo - server
 *
 * Serves the PWA and the API from one origin. That is not just convenience: the app
 * is built on the rule that no runtime request leaves our own origin (fonts, icons
 * and scripts are all vendored), and putting the API somewhere else would break it,
 * bring CORS with it, and add a preflight to every sync.
 */

import 'dotenv/config';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import cookieParser from 'cookie-parser';

import { assertConfigured, pool, query } from './db.js';
import {
  attachAccount, requireAccount, requestCode, verifyCode, me, logout, logoutEverywhere, sweepExpired
} from './auth.js';
import { mailConfigured } from './mail.js';
import { aiConfigured, categorise, parseEntries, reviewMonth, spendingTips } from './ai.js';
import { sync } from './sync.js';

assertConfigured();

const HERE = path.dirname(fileURLToPath(import.meta.url));
const APP_ROOT = path.resolve(HERE, '..', '..');
const PORT = Number(process.env.PORT || 8123);

const app = express();
app.disable('x-powered-by');
app.set('trust proxy', 1);

/*
 * The headers a browser needs to be told, on every response.
 *
 * The app carries someone's whole ledger in localStorage and a session cookie for
 * their account, and it had none of these. A policy is cheap here in a way it is not
 * in most apps: one module script, no inline handlers, no third-party origin, every
 * font and icon vendored. So the policy can be strict without an allowance for
 * anything, and anything injected has nowhere to send what it reads.
 *
 * `style-src-attr 'unsafe-inline'` is the one concession, and it is not optional:
 * meter widths, category tile hues and donut fills are inline style ATTRIBUTES
 * computed per row. It permits attributes only - a stylesheet or a <style> block
 * from anywhere but this origin is still refused.
 *
 * frame-ancestors closes the clickjacking hole. A row in this app deletes an entry
 * on one tap, and until now any page anywhere could have framed it invisibly and
 * borrowed those taps.
 */
const CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "connect-src 'self'",
  "img-src 'self' data:",
  "font-src 'self'",
  "style-src 'self'",
  "style-src-attr 'unsafe-inline'",
  "manifest-src 'self'",
  "worker-src 'self'",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'",
  "object-src 'none'"
].join('; ');

app.use((req, res, next) => {
  res.setHeader('Content-Security-Policy', CSP);
  res.setHeader('X-Content-Type-Options', 'nosniff');
  // Same-origin only, so a shared URL never carries a path from inside someone's
  // ledger to another site.
  res.setHeader('Referrer-Policy', 'same-origin');
  res.setHeader('X-Frame-Options', 'DENY');
  // microphone=(self) is the one that is opened, and only since voice bulk-add
  // landed. Without it Chrome refuses SpeechRecognition outright - the same
  // policy gates it as gates getUserMedia. (self) is this origin only: a frame
  // from anywhere else still gets nothing, and frame-ancestors means there are
  // no frames anyway.
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(self), geolocation=(), payment=(), usb=()');
  res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');

  // Only over TLS, and only when it is real TLS rather than a header a caller wrote:
  // `req.secure` is resolved by Express from the proxy we trust.
  if (req.secure) {
    res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  }
  next();
});

app.use(express.json({ limit: '2mb' }));
app.use(cookieParser());

/*
 * Who a request is from, resolved for the API and nowhere else.
 *
 * This ran on EVERY request, above the static handler. A cold load is a dozen or so
 * files, so one visit with a session cookie cost a dozen session SELECTs and a dozen
 * `last_seen_at` writes - and a stranger with a junk cookie could aim that at the
 * database for free, on a Postgres plan billed by compute. Only /api ever reads
 * `req.account`, so only /api pays for it.
 */
app.use('/api', attachAccount);

/*
 * No response from the API is cacheable. /api/me carries an email address and
 * /api/sync carries the ledger; neither should sit in a proxy, a browser cache or a
 * back/forward buffer. The static files already say this for their own reasons.
 */
app.use('/api', (_req, res, next) => {
  res.setHeader('Cache-Control', 'no-store, must-revalidate');
  next();
});

/*
 * A second lock on cross-site requests, behind SameSite=Lax.
 *
 * The session cookie is SameSite=Lax, so a browser does not attach it to a POST from
 * another site, and that is the real defence. This is the belt: if a request that
 * changes something arrives declaring an origin, and that origin is not us, it is
 * refused whatever the cookie policy did.
 *
 * A MISSING Origin is allowed through on purpose. Same-origin GETs do not send one,
 * nor do some older browsers on same-origin POSTs, and refusing those would break
 * sign-in on exactly the phones this app is written for - while adding nothing, since
 * SameSite already covers the case.
 */
const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

app.use('/api', (req, res, next) => {
  if (SAFE_METHODS.has(req.method)) return next();

  const origin = req.get('origin');
  if (!origin) return next();

  const host = req.get('host');
  let sameOrigin = false;
  try {
    sameOrigin = new URL(origin).host === host;
  } catch {
    sameOrigin = false;              // not a URL we can read is not our origin
  }

  if (!sameOrigin) {
    res.status(403).json({ error: 'Cross-site requests are not accepted.' });
    return;
  }
  next();
});

if (!aiConfigured()) {
  console.warn(
    '[spendo] GROQ_API_KEY is not set - the category guess falls back to the phone\'s\n' +
    '         own history and keyword table, and month write-ups are figures only.'
  );
}

if (!mailConfigured()) {
  console.warn(
    process.env.NODE_ENV === 'production'
      ? '[spendo] BREVO_API_KEY or MAIL_FROM_EMAIL is not set - sign-in is DISABLED. ' +
        'Codes are not printed to a production log, because anyone who could read ' +
        'that log could then sign in as anyone.'
      : '[spendo] BREVO_API_KEY or MAIL_FROM_EMAIL is not set - sign-in codes will be ' +
        'printed to this console instead of emailed. Refused in production.'
  );
}

/* --------------------------------------------------------------------- api */

/*
 * Liveness, and deliberately separate from /api/health below.
 *
 * This one answers "is the process up" and touches nothing. It is what Render's
 * health check and the keep-alive cron hit, and that separation matters: if the
 * health check queried Postgres, a thirty-second Neon hiccup would fail the check,
 * take the service out of rotation, and roll back a deploy that was fine. A
 * database that is briefly unreachable is a sync that retries, not a server to
 * restart.
 *
 * It also costs no query, which matters when something pings it every ten minutes
 * for the life of the service.
 */
app.get('/healthz', (_req, res) => res.type('text').send('ok'));

/** Readiness. Says whether the database is actually reachable right now. */
app.get('/api/health', async (_req, res) => {
  try {
    await pool.query('select 1');
    res.json({ ok: true });
  } catch (err) {
    // The message is logged, never returned. A driver error names the host, the
    // database and the role it failed to authenticate - "password authentication
    // failed for user spendo" is a free hint to anyone who asks this endpoint at the
    // wrong moment. The 500 handler below has always been careful about this; this
    // one was not.
    console.error('[spendo] readiness check failed:', err.message);
    res.status(503).json({ ok: false });
  }
});

/*
 * Sign in.
 *
 * These two are the only endpoints that do anything without a session, which is the
 * point: /api/register used to create an account for anyone who asked, so a stranger
 * could fill this database without proving they were anyone. Now the only way in is
 * to read mail at an address, and the rate limits in auth.js are what stop that
 * being abused in turn.
 */
app.post('/api/auth/request-code', requestCode);
app.post('/api/auth/verify', verifyCode);
app.post('/api/auth/logout', logout);
// Ending every session needs a session: this is a broom for an account you are in,
// not a recovery flow for one you are locked out of.
app.post('/api/auth/logout-all', requireAccount, logoutEverywhere);
app.get('/api/me', me);

// Signed out is a supported way to use the app - the ledger lives in localStorage
// and syncing is what you opt into. So this 401 is not a failure the client has to
// recover from, it is the answer to "should I be syncing".
app.post('/api/sync', requireAccount, sync);

/* ---------------------------------------------------------------------- ai */

/*
 * A per-account cap on model calls, counted in the database.
 *
 * The point is not billing, it is that a signed-in session is a credential someone
 * could script: without this, one account can empty the quota for the app.
 *
 * This used to be a Map in the process, which meant the count reset on every deploy
 * - and this service deploys often, so the cap was one restart away from being no
 * cap at all. It also cleared itself wholesale past 5000 keys, which anyone with
 * that many accounts could trigger deliberately.
 *
 * One row per account per hour, incremented on the way in and read back in the same
 * statement, so two requests racing cannot both see the last free slot. Rows older
 * than a couple of days are swept with everything else.
 */
const AI_LIMIT = Number(process.env.AI_CALLS_PER_HOUR || 200);

async function aiAllowed(accountId) {
  try {
    const { rows } = await query(
      `insert into ai_usage (account_id, window_start, calls)
       values ($1, date_trunc('hour', now()), 1)
       on conflict (account_id, window_start)
       do update set calls = ai_usage.calls + 1
       returning calls`,
      [accountId]
    );
    return rows[0].calls <= AI_LIMIT;
  } catch (e) {
    // Closed, not open. A model call is the one thing here that costs money to a
    // third party, and "the counter is unreachable" is not a reason to stop counting.
    console.warn('[spendo] ai quota check failed, refusing the call:', e.message);
    return false;
  }
}

/*
 * The list the model is allowed to answer from lives on the CLIENT and is sent with
 * the request, because the client is what renders the chips. A server-side copy would
 * be a second list to keep in step, and the day they drift the model starts returning
 * a category the app cannot display.
 *
 * It is still validated here: ids are bounded in length and count, so a caller cannot
 * use this route to send an essay to the model on our key.
 */
const cleanIds = (raw) => (Array.isArray(raw) ? raw : [])
  .filter((v) => typeof v === 'string' && /^[a-z][a-z0-9_-]{0,23}$/.test(v))
  .slice(0, 24);

app.post('/api/categorise', requireAccount, async (req, res, next) => {
  try {
    const description = String(req.body?.description || '').trim().slice(0, 200);
    const allowed = cleanIds(req.body?.categories);

    if (!description || allowed.length < 2) {
      res.json({ category: null, reason: 'nothing to work with' });
      return;
    }
    if (!aiConfigured()) {
      res.json({ category: null, reason: 'not configured' });
      return;
    }
    if (!(await aiAllowed(req.account.id))) {
      res.status(429).json({ category: null, reason: 'too many requests' });
      return;
    }

    res.json({ category: await categorise(description, allowed), source: 'ai' });
  } catch (err) {
    next(err);
  }
});

/*
 * The write-up for a month.
 *
 * The FIGURES arrive from the device already computed - this route never touches the
 * ledger and never adds anything up. That is what makes the result trustworthy: the
 * numbers on the screen and the numbers in the sentence come from the same place, so
 * they cannot disagree.
 */
app.post('/api/review', requireAccount, async (req, res, next) => {
  try {
    const f = req.body?.facts;
    if (!f || typeof f !== 'object' || typeof f.ym !== 'string') {
      res.status(400).json({ error: 'facts are required' });
      return;
    }
    if (!aiConfigured()) {
      res.json({ text: null, reason: 'not configured' });
      return;
    }
    if (!(await aiAllowed(req.account.id))) {
      res.status(429).json({ text: null, reason: 'too many requests' });
      return;
    }

    const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);
    // Rebuilt field by field rather than passed through. Whatever else the body
    // carries does not reach the model.
    const facts = {
      ym: f.ym.slice(0, 7),
      isCurrent: Boolean(f.isCurrent),
      spent: num(f.spent),
      received: num(f.received),
      opening: num(f.opening),
      balance: num(f.balance),
      count: num(f.count),
      activeDays: num(f.activeDays),
      daysInMonth: num(f.daysInMonth),
      biggestAmount: num(f.biggestAmount),
      top: (Array.isArray(f.top) ? f.top : []).slice(0, 4).map((t) => ({
        label: String(t?.label || '').slice(0, 24),
        amount: num(t?.amount),
        share: num(t?.share)
      })),
      prev: f.prev ? { spent: num(f.prev.spent), delta: num(f.prev.delta) } : null
    };

    res.json({ text: await reviewMonth(facts) });
  } catch (err) {
    next(err);
  }
});

/*
 * Where spending could come down.
 *
 * Several months of figures instead of one, and the same contract as /api/review:
 * the device has already added everything up, this route never touches the ledger,
 * and the body is rebuilt field by field so nothing else reaches the model.
 *
 * Category LABELS are sent, not ids, because the model writes with them - "Personal
 * care" reads as itself where "care" would come back in a sentence as a verb.
 */
app.post('/api/tips', requireAccount, async (req, res, next) => {
  try {
    const f = req.body?.facts;
    if (!f || typeof f !== 'object' || typeof f.ym !== 'string') {
      res.status(400).json({ error: 'facts are required' });
      return;
    }
    if (!aiConfigured()) {
      res.json({ tips: null, reason: 'not configured' });
      return;
    }
    if (!(await aiAllowed(req.account.id))) {
      res.status(429).json({ tips: null, reason: 'too many requests' });
      return;
    }

    const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);
    const facts = {
      ym: f.ym.slice(0, 7),
      isCurrent: Boolean(f.isCurrent),
      spent: num(f.spent),
      received: num(f.received),
      balance: num(f.balance),
      avgMonthly: num(f.avgMonthly),
      monthsCovered: num(f.monthsCovered),
      series: (Array.isArray(f.series) ? f.series : []).slice(0, 12).map((m) => ({
        ym: String(m?.ym || '').slice(0, 7),
        spent: num(m?.spent)
      })),
      categories: (Array.isArray(f.categories) ? f.categories : []).slice(0, 8).map((c) => ({
        label: String(c?.label || '').slice(0, 24),
        amount: num(c?.amount),
        share: num(c?.share),
        usual: num(c?.usual),
        delta: num(c?.delta)
      }))
    };

    res.json({ tips: await spendingTips(facts) });
  } catch (err) {
    next(err);
  }
});

/*
 * A spoken list of expenses, read into records.
 *
 * The last of the three model routes and the only one where the model is asked what
 * a NUMBER is - see the note above parseEntries() in ai.js for why that is allowed
 * here and nowhere else. The short version: nothing it returns is saved. Every row
 * arrives in a review sheet with an editable amount, and a person taps Add.
 *
 * The device tries first and only calls this when its own parser cannot read the
 * text, so the easy majority - "200 auto, 150 lunch" - never reaches here at all.
 *
 * The TEXT is the whole payload. No ledger, no totals, no history. `today` comes
 * from the device rather than from this server's clock, because "yesterday" means
 * yesterday where the phone is, and this process runs in UTC.
 */
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

app.post('/api/parse-entries', requireAccount, async (req, res, next) => {
  try {
    // 600 characters is about a minute of talking. Longer than that is a paste, and
    // a paste belongs in the import path rather than in a review sheet of 20 rows.
    const text = String(req.body?.text || '').trim().slice(0, 600);
    const categories = cleanIds(req.body?.categories);
    const today = ISO_DATE.test(String(req.body?.today)) ? String(req.body.today) : null;

    if (!text || categories.length < 2 || !today) {
      res.status(400).json({ entries: null, reason: 'nothing to work with' });
      return;
    }
    if (!aiConfigured()) {
      res.json({ entries: null, reason: 'not configured' });
      return;
    }
    if (!(await aiAllowed(req.account.id))) {
      res.status(429).json({ entries: null, reason: 'too many requests' });
      return;
    }

    res.json({ entries: await parseEntries(text, { today, categories }) });
  } catch (err) {
    next(err);
  }
});

// Anything else under /api is a typo, not a page. Say so, rather than letting the
// static handler below answer it with index.html and the client parse HTML as JSON.
app.use('/api', (_req, res) => res.status(404).json({ error: 'No such endpoint.' }));

/* ------------------------------------------------------------------ the app */

/*
 * What the browser is allowed to ask for, named one directory at a time.
 *
 * This used to be `express.static(APP_ROOT)`, and APP_ROOT is the repository. That
 * served the whole repository: server/src/auth.js, package-lock.json, render.yaml,
 * the docs, tools/ - and, because serve-static's default dotfile handling covers dot
 * FILES but not files inside dot DIRECTORIES, /.git/HEAD and /.git/index too, which
 * is the whole history one object at a time. None of it held a secret, which is luck
 * rather than design: the next config file added next to server/.env without a
 * leading dot would have been public the moment it landed.
 *
 * An allowlist cannot have that accident. A new directory is not reachable until it
 * is named here, which is the failure everybody wants: the file 404s and someone
 * notices, rather than the file being served and nobody noticing.
 *
 * `dotfiles: 'deny'` is belt and braces on top of it.
 */
const PUBLIC_DIRS = ['js', 'styles', 'icons', 'fonts'];
const PUBLIC_FILES = ['index.html', 'manifest.webmanifest', 'sw.js'];

/*
 * no-store on everything, for the same reason tools/serve.py sends it: a cached ES
 * module is how an edited file keeps serving last week's code, and the service
 * worker already keeps the app working offline. Freshness here, offline there.
 */
function staticHeaders(res) {
  res.setHeader('Cache-Control', 'no-store, must-revalidate');
}

for (const dir of PUBLIC_DIRS) {
  app.use(`/${dir}`, express.static(path.join(APP_ROOT, dir), {
    index: false,
    etag: false,
    lastModified: false,
    dotfiles: 'deny',
    fallthrough: false,
    setHeaders: staticHeaders
  }));
}

for (const file of PUBLIC_FILES) {
  const send = (_req, res) => {
    staticHeaders(res);
    res.sendFile(path.join(APP_ROOT, file));
  };
  app.get(`/${file}`, send);
  // The service worker's scope is the origin, so it has to answer at the root path
  // it was registered from; index.html is what "/" means.
  if (file === 'index.html') app.get('/', send);
}

/*
 * Every other path is a route inside the app, so it gets the shell and the client
 * router works out what it means. Only GET: a POST to an unknown path is a caller
 * doing something odd, not a person opening a page.
 */
app.get('*', (_req, res) => {
  staticHeaders(res);
  res.sendFile(path.join(APP_ROOT, 'index.html'));
});

/* ---------------------------------------------------------------- failures */

app.use((err, _req, res, _next) => {
  const status = err.status || 500;
  if (status >= 500) console.error('[spendo]', err);
  // A 500 says nothing about its cause: an error string from Postgres can carry
  // column names and connection details.
  res.status(status).json({
    error: status >= 500 ? 'Something went wrong on the server.' : err.message
  });
});

const server = app.listen(PORT, () => {
  console.log(`[spendo] listening on http://localhost:${PORT}`);
  /*
   * Dead sessions, dead codes and yesterday's quota counters, swept on boot and then
   * once a day. `unref` so a sleeping timer never holds the process open through a
   * shutdown, and the boot sweep is deliberately not awaited: the service is already
   * listening, and tidying a table is not a reason to make anyone wait.
   */
  sweepExpired();
  const daily = setInterval(sweepExpired, 24 * 60 * 60 * 1000);
  daily.unref();
});

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    server.close(() => pool.end().then(() => process.exit(0)));
  });
}
