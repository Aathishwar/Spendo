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

import { assertConfigured, pool } from './db.js';
import {
  attachAccount, requireAccount, requestCode, verifyCode, me, logout
} from './auth.js';
import { mailConfigured } from './mail.js';
import { aiConfigured, categorise, reviewMonth } from './ai.js';
import { sync } from './sync.js';

assertConfigured();

const HERE = path.dirname(fileURLToPath(import.meta.url));
const APP_ROOT = path.resolve(HERE, '..', '..');
const PORT = Number(process.env.PORT || 8123);

const app = express();
app.disable('x-powered-by');
app.set('trust proxy', 1);

app.use(express.json({ limit: '2mb' }));
app.use(cookieParser());
// Every request learns who it is from; only some require it.
app.use(attachAccount);

if (!aiConfigured()) {
  console.warn(
    '[spendo] GROQ_API_KEY is not set - the category guess falls back to the phone\'s\n' +
    '         own history and keyword table, and month write-ups are figures only.'
  );
}

if (!mailConfigured()) {
  console.warn(
    '[spendo] BREVO_API_KEY or MAIL_FROM_EMAIL is not set - sign-in codes will be\n' +
    '         printed to this console instead of emailed.'
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
    res.status(503).json({ ok: false, error: err.message });
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
app.get('/api/me', me);

// Signed out is a supported way to use the app - the ledger lives in localStorage
// and syncing is what you opt into. So this 401 is not a failure the client has to
// recover from, it is the answer to "should I be syncing".
app.post('/api/sync', requireAccount, sync);

/* ---------------------------------------------------------------------- ai */

/*
 * A crude per-account cap, in memory.
 *
 * The point is not billing, it is that a signed-in session is a credential someone
 * could script: without this, one account can empty the quota for the app. It resets
 * on deploy, which is fine - the limit that protects a person is the one on their own
 * account, and losing it briefly costs a few calls.
 */
const AI_LIMIT = Number(process.env.AI_CALLS_PER_HOUR || 200);
const aiHits = new Map();

function aiAllowed(accountId) {
  const now = Date.now();
  const hits = (aiHits.get(accountId) || []).filter((t) => now - t < 60 * 60 * 1000);
  if (hits.length >= AI_LIMIT) {
    aiHits.set(accountId, hits);
    return false;
  }
  hits.push(now);
  aiHits.set(accountId, hits);
  if (aiHits.size > 5000) aiHits.clear();
  return true;
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
    if (!aiAllowed(req.account.id)) {
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
    if (!aiAllowed(req.account.id)) {
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

// Anything else under /api is a typo, not a page. Say so, rather than letting the
// static handler below answer it with index.html and the client parse HTML as JSON.
app.use('/api', (_req, res) => res.status(404).json({ error: 'No such endpoint.' }));

/* ------------------------------------------------------------------ the app */

/*
 * no-store on everything, for the same reason tools/serve.py sends it: a cached ES
 * module is how an edited file keeps serving last week's code, and the service
 * worker already keeps the app working offline. Freshness here, offline there.
 */
app.use(express.static(APP_ROOT, {
  index: 'index.html',
  etag: false,
  lastModified: false,
  setHeaders(res) {
    res.setHeader('Cache-Control', 'no-store, must-revalidate');
  }
}));

app.get('*', (_req, res) => {
  res.setHeader('Cache-Control', 'no-store, must-revalidate');
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
});

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    server.close(() => pool.end().then(() => process.exit(0)));
  });
}
