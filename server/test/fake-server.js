/**
 * Spendo - a stand-in server, for testing the client without Postgres or Brevo.
 *
 *     node test/fake-server.js [port]
 *
 * This is NOT the server. It speaks the same endpoints against Maps in memory, so
 * the browser half of this - signing in, the dirty set draining, the cursor
 * advancing, offline and back - can be driven on a machine with no database on it
 * and without sending real email. The real SQL is covered by sync.test.js; this
 * covers the client.
 *
 * The sign-in code is printed to this console and also returned in the response as
 * `devCode`, so a browser test can read it without an inbox. The real server never
 * does that, obviously - see the comment on the route.
 *
 * It also serves the app, so one origin, same as production.
 */

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import crypto from 'node:crypto';
import express from 'express';
import cookieParser from 'cookie-parser';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const APP_ROOT = path.resolve(HERE, '..', '..');
const PORT = Number(process.argv[2] || 8124);
const COOKIE = 'spendo_session';

const accounts = new Map();          // email -> { id, entries: Map, months: Map }
const sessions = new Map();          // token -> email
const codes = new Map();             // email -> code
let seq = 0;

function bucket(email) {
  if (!accounts.has(email)) {
    accounts.set(email, { id: crypto.randomUUID(), entries: new Map(), months: new Map() });
  }
  return accounts.get(email);
}

function accountFor(req) {
  const token = req.cookies?.[COOKIE];
  const email = token ? sessions.get(token) : null;
  return email ? { email, store: bucket(email) } : null;
}

const app = express();
app.use(express.json({ limit: '2mb' }));
app.use(cookieParser());

/* ----------------------------------------------------------------- sign in */

app.post('/api/auth/request-code', (req, res) => {
  const email = String(req.body?.email || '').trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)) {
    return res.status(400).json({ error: 'Enter a valid email address.' });
  }
  const code = String(crypto.randomInt(0, 1_000_000)).padStart(6, '0');
  codes.set(email, code);
  console.log(`[fake] sign-in code for ${email} is ${code}`);
  // devCode exists ONLY here. The real route returns nothing but ok, because
  // returning the code would make the email step decorative.
  res.json({ ok: true, expiresInSeconds: 600, devCode: code });
});

app.post('/api/auth/verify', (req, res) => {
  const email = String(req.body?.email || '').trim().toLowerCase();
  const code = String(req.body?.code || '').trim();
  if (codes.get(email) !== code) {
    return res.status(400).json({ error: 'That code is wrong or has expired.' });
  }
  codes.delete(email);

  const account = bucket(email);
  const token = crypto.randomBytes(16).toString('hex');
  sessions.set(token, email);
  res.cookie(COOKIE, token, { httpOnly: true, sameSite: 'lax', path: '/', maxAge: 31_536_000_000 });
  res.json({ ok: true, email, accountId: account.id });
});

app.post('/api/auth/logout', (req, res) => {
  const token = req.cookies?.[COOKIE];
  if (token) sessions.delete(token);
  res.clearCookie(COOKIE, { path: '/' });
  res.json({ ok: true });
});

app.get('/api/me', (req, res) => {
  const found = accountFor(req);
  res.json({
    signedIn: Boolean(found),
    email: found?.email ?? null,
    accountId: found?.store.id ?? null
  });
});

/* -------------------------------------------------------------------- sync */

app.post('/api/sync', (req, res) => {
  const found = accountFor(req);
  if (!found) return res.status(401).json({ error: 'Sign in to sync.' });

  const store = found.store;
  const since = Number(req.body?.since || 0);

  for (const e of req.body?.entries || []) {
    const held = store.entries.get(e.id);
    if (held && held.updatedAt >= e.updatedAt) continue;   // last write wins
    store.entries.set(e.id, { ...e, seq: ++seq });
  }
  for (const m of req.body?.months || []) {
    const held = store.months.get(m.ym);
    if (held && held.updatedAt >= m.updatedAt) continue;
    store.months.set(m.ym, { ...m, seq: ++seq });
  }

  const entries = [...store.entries.values()].filter((r) => r.seq > since).sort((a, b) => a.seq - b.seq);
  const months = [...store.months.values()].filter((r) => r.seq > since).sort((a, b) => a.seq - b.seq);
  const all = [...entries, ...months].map((r) => r.seq);

  res.json({
    cursor: all.length ? Math.max(...all) : since,
    hasMore: false,
    entries,
    months,
    rejected: [],
    serverTime: Date.now()
  });
});

// A way for a test to see what the server actually holds.
app.get('/api/_dump', (_req, res) => {
  res.json([...accounts].map(([email, s]) => ({
    email,
    accountId: s.id,
    entries: [...s.entries.values()],
    months: [...s.months.values()]
  })));
});

app.use('/api', (_req, res) => res.status(404).json({ error: 'No such endpoint.' }));

app.use(express.static(APP_ROOT, {
  index: 'index.html',
  etag: false,
  setHeaders: (res) => res.setHeader('Cache-Control', 'no-store, must-revalidate')
}));

app.listen(PORT, () => console.log(`[fake] listening on http://127.0.0.1:${PORT}`));
