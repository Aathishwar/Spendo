/**
 * Spendo - sign in with an emailed code
 *
 * No password and no signup step: an address that has never been seen becomes an
 * account the first time it proves it can receive a code. That removes the usual
 * "does this email already exist?" leak as a side effect, because every address
 * behaves identically whether or not it has an account.
 *
 * What replaced what
 * ------------------
 * This file used to adopt an account id minted on the phone, which meant
 * /api/register had to accept anyone: the id was a claim with nothing behind it, so
 * three strangers could each get a working token and rows in the database without
 * proving anything. Reading mail at an address is the claim now, and there is no
 * unauthenticated way to create an account.
 *
 * The session cookie is the ONLY place an account id ever comes from. Nothing
 * downstream reads an account id out of a request body - a body is written by
 * whoever is calling.
 *
 * Being signed out is not an error state
 * --------------------------------------
 * The app is fully usable with no account at all; everything lives in localStorage
 * and syncing is the thing you opt into. So `attachAccount` never throws and never
 * blocks - an expired session degrades to "signed out", which the client already
 * knows how to be.
 */

import crypto from 'node:crypto';
import { query } from './db.js';
import { sendLoginCode, mailConfigured, CODE_TTL_MINUTES } from './mail.js';

const CODE_TTL_MS = CODE_TTL_MINUTES * 60 * 1000;
const MAX_ATTEMPTS = 3;

/*
 * Sending is free to the caller and costs us a mail quota against a verified sender.
 * Uncapped, anyone can burn the daily allowance and post sign-in codes to strangers
 * from our address. Capped per address (so one target cannot be flooded) and per
 * source (so one caller cannot spray many targets).
 */
const RESEND_COOLDOWN_MS = 60 * 1000;
const MAX_SENDS_PER_HOUR = 5;
const MAX_IP_SENDS_PER_HOUR = 20;
const HOUR_MS = 60 * 60 * 1000;

const SESSION_TTL_MS = 365 * 24 * 60 * 60 * 1000;
export const COOKIE = 'spendo_session';

/*
 * In memory, so it resets on deploy. That is the right trade for the IP cap: it is a
 * spray brake, the per-address cap in the table is the one that actually protects a
 * person, and a table write on every request to a public endpoint is its own small
 * denial-of-service.
 */
const ipHits = new Map();

/* ---------------------------------------------------------------- helpers */

const normaliseEmail = (v) => String(v || '').trim().toLowerCase();

const validEmail = (v) => /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(v) && v.length <= 254;

const sha256 = (v) => crypto.createHash('sha256').update(v).digest('hex');

/*
 * Sign-in codes are keyed, session tokens are not, and the difference is entropy.
 *
 * A session token is 32 random bytes: a plain hash of it cannot be reversed, because
 * there is nothing to search. A sign-in code is six digits - a million of them - so a
 * plain SHA-256 of one is not a hash so much as an index. Anyone who reads the
 * login_codes table can recover every live code in about a second on a laptop.
 *
 * An HMAC under a secret that is not in the database fixes that: the table alone is
 * no longer enough to test a guess. Without AUTH_SECRET set this falls back to the
 * old behaviour rather than refusing to start - the codes still expire in ten
 * minutes and are still capped at three attempts - but it says so, once, at boot.
 */
const authSecret = () => process.env.AUTH_SECRET || '';

const hashCode = (code) => (authSecret()
  ? crypto.createHmac('sha256', authSecret()).update(String(code)).digest('hex')
  : sha256(code));

if (!authSecret()) {
  console.warn(
    '[auth] AUTH_SECRET is not set - sign-in codes are stored as a plain SHA-256. ' +
    'Set it to any long random string so a leak of the codes table is not a leak ' +
    'of the codes themselves.'
  );
}

/** Six digits, from the CSPRNG. `Math.random` is predictable and this is a credential. */
const newCode = () => String(crypto.randomInt(0, 1_000_000)).padStart(6, '0');

const newToken = () => crypto.randomBytes(32).toString('base64url');

/** Comparison that does not leak, through timing, how much of the code was right. */
function safeEqual(a, b) {
  const left = Buffer.from(String(a));
  const right = Buffer.from(String(b));
  if (left.length !== right.length) return false;
  return crypto.timingSafeEqual(left, right);
}

/*
 * The address Express resolved, never the header a caller wrote.
 *
 * This used to read the leftmost value of X-Forwarded-For, which is whatever the
 * client typed: a new value on each request gave every request its own bucket, so the
 * per-source cap never applied to anyone who did not want it to. Worse, the bound
 * below clears the whole map past 5000 keys, so 5001 invented addresses also reset
 * the counters of everyone real.
 *
 * `trust proxy` is set to 1 in index.js, so req.ip is already the last hop before
 * Render - the one value in that header the client cannot choose.
 */
function clientIp(req) {
  return req.ip || 'unknown';
}

function ipAllowed(ip) {
  const now = Date.now();
  const hits = (ipHits.get(ip) || []).filter((t) => now - t < HOUR_MS);
  if (hits.length >= MAX_IP_SENDS_PER_HOUR) {
    ipHits.set(ip, hits);
    return false;
  }
  hits.push(now);
  ipHits.set(ip, hits);
  if (ipHits.size > 5000) ipHits.clear();   // a crude bound; this is not a cache
  return true;
}

function setSessionCookie(req, res, token) {
  res.cookie(COOKIE, token, {
    httpOnly: true,
    secure: req.secure || req.headers['x-forwarded-proto'] === 'https',
    sameSite: 'lax',
    maxAge: SESSION_TTL_MS,
    path: '/'
  });
}

/* ------------------------------------------------------------- middleware */

/**
 * Resolve the session cookie to an account, or leave the request anonymous.
 *
 * `last_seen_at` is updated without awaiting: it is a diagnostic, and making every
 * sync wait on a second round trip to record that a sync happened is a poor trade.
 */
export async function attachAccount(req, _res, next) {
  req.account = null;

  const token = req.cookies?.[COOKIE];
  if (!token) return next();

  try {
    const { rows } = await query(
      `select s.id as session_id, s.account_id, a.email
         from sessions s
         join accounts a on a.id = s.account_id
        where s.token_hash = $1
          and s.revoked_at is null
          and s.expires_at > now()`,
      [sha256(token)]
    );
    if (rows.length) {
      req.account = { id: rows[0].account_id, email: rows[0].email, sessionId: rows[0].session_id };
      query('update sessions set last_seen_at = now() where id = $1', [rows[0].session_id])
        .catch(() => { /* not worth failing a request over */ });
    }
  } catch (e) {
    console.warn('[auth] session lookup failed:', e.message);
  }
  next();
}

/** For endpoints that write to the database. Sync is the only one today. */
export function requireAccount(req, res, next) {
  if (!req.account) {
    res.status(401).json({ error: 'Sign in to sync.' });
    return;
  }
  // Kept for sync.js, which reads req.session.account_id.
  req.session = { id: req.account.sessionId, account_id: req.account.id };
  next();
}

/* ---------------------------------------------------------- issue / consume */

/**
 * Issue and send a code for an address, with the rate limits applied.
 *
 * Shared by signing in and by changing an account's email, because both ask the same
 * question: can you receive mail here. Returns a status and body for the caller to
 * send on rather than writing the response itself.
 */
async function issueCode(req, email) {
  /*
   * With no mail key, mail.js prints the code to the log and reports success. That is
   * a good local default and a hole in production: the endpoint answers 200, no email
   * is sent, and the code sits in a log where anyone with access to it can sign in as
   * the address they asked for. It stays available for development and is refused
   * where it would be a credential leak.
   */
  if (!mailConfigured() && process.env.NODE_ENV === 'production') {
    console.error('[auth] refusing to issue a code: mail is not configured');
    return { status: 503, body: { error: 'Sign-in is unavailable right now. Try again later.' } };
  }

  if (!ipAllowed(clientIp(req))) {
    return { status: 429, body: { error: 'Too many requests. Try again later.' } };
  }

  const { rows } = await query('select * from login_codes where email = $1', [email]);
  const existing = rows[0];

  if (existing) {
    const sinceSent = Date.now() - new Date(existing.sent_at).getTime();
    if (sinceSent < RESEND_COOLDOWN_MS) {
      return {
        status: 429,
        body: {
          error: 'A code was just sent. Check your inbox.',
          retryInSeconds: Math.ceil((RESEND_COOLDOWN_MS - sinceSent) / 1000)
        }
      };
    }
    if (sinceSent < HOUR_MS && existing.sent_count >= MAX_SENDS_PER_HOUR) {
      return { status: 429, body: { error: 'Too many codes requested. Try again in an hour.' } };
    }
  }

  const code = newCode();
  const expiresAt = new Date(Date.now() + CODE_TTL_MS);
  const resetCount = !existing || Date.now() - new Date(existing.sent_at).getTime() >= HOUR_MS;

  /*
   * One row per address, replaced on each send. Keeping every code issued would mean
   * several live at once for one address, which multiplies the guess surface and
   * makes "3 attempts" quietly mean fifteen.
   */
  await query(
    `insert into login_codes (email, code_hash, expires_at, attempts, sent_at, sent_count)
     values ($1, $2, $3, 0, now(), 1)
     on conflict (email) do update
        set code_hash  = excluded.code_hash,
            expires_at = excluded.expires_at,
            attempts   = 0,
            sent_at    = now(),
            sent_count = case when $4 then 1 else login_codes.sent_count + 1 end`,
    [email, hashCode(code), expiresAt, resetCount]
  );

  const sent = await sendLoginCode(email, code);
  if (!sent.ok) {
    return { status: 502, body: { error: 'Could not send the email. Try again in a moment.' } };
  }

  return { status: 200, body: { ok: true, expiresInSeconds: CODE_TTL_MS / 1000 } };
}

/**
 * Check a code for an address and consume it.
 *
 * Every rejection reads the same, so nothing can be learned by probing which of
 * "never asked", "expired", "used up" or "wrong" applies.
 */
async function consumeCode(email, code) {
  const { rows } = await query('select * from login_codes where email = $1', [email]);
  const record = rows[0];
  if (!record) return false;

  if (new Date(record.expires_at).getTime() < Date.now() || record.attempts >= MAX_ATTEMPTS) {
    await query('delete from login_codes where email = $1', [email]);
    return false;
  }

  if (!safeEqual(hashCode(code), record.code_hash)) {
    if (record.attempts + 1 >= MAX_ATTEMPTS) {
      await query('delete from login_codes where email = $1', [email]);
    } else {
      await query('update login_codes set attempts = attempts + 1 where email = $1', [email]);
    }
    return false;
  }

  await query('delete from login_codes where email = $1', [email]);
  return true;
}

/** A name for this device in the sessions table, so one can be revoked later. */
function deviceLabel(req) {
  const ua = req.get('user-agent') || '';
  const platform = /android/i.test(ua) ? 'Android'
    : /iphone|ipad/i.test(ua) ? 'iOS'
    : /windows/i.test(ua) ? 'Windows'
    : /mac os/i.test(ua) ? 'Mac'
    : 'Browser';
  return platform;
}

/* ----------------------------------------------------------------- routes */

export async function requestCode(req, res, next) {
  const email = normaliseEmail(req.body?.email);
  if (!validEmail(email)) {
    res.status(400).json({ error: 'Enter a valid email address.' });
    return;
  }
  try {
    const result = await issueCode(req, email);
    res.status(result.status).json(result.body);
  } catch (err) {
    next(err);
  }
}

export async function verifyCode(req, res, next) {
  const email = normaliseEmail(req.body?.email);
  const code = String(req.body?.code || '').trim();

  if (!validEmail(email) || !/^\d{6}$/.test(code)) {
    res.status(400).json({ error: 'Enter the 6-digit code.' });
    return;
  }

  try {
    const accepted = await consumeCode(email, code);
    if (!accepted) {
      res.status(400).json({ error: 'That code is wrong or has expired.' });
      return;
    }

    // The first correct code for an address creates the account. There is no
    // separate signup step to get wrong or to leave half finished.
    const account = await query(
      `insert into accounts (email, email_verified_at) values ($1, now())
       on conflict (email) do update set email_verified_at = now()
       returning id, email`,
      [email]
    );
    const accountId = account.rows[0].id;

    const token = newToken();
    await query(
      `insert into sessions (id, account_id, token_hash, device_label, expires_at)
       values (gen_random_uuid(), $1, $2, $3, $4)`,
      [accountId, sha256(token), deviceLabel(req), new Date(Date.now() + SESSION_TTL_MS)]
    );

    setSessionCookie(req, res, token);
    res.json({ ok: true, email, accountId });
  } catch (err) {
    next(err);
  }
}

/**
 * Who this browser is, if anyone.
 *
 * The client calls this at boot and after any 401. It is the only source of truth
 * for "signed in": the cookie is httpOnly, so the page cannot read it and must ask.
 */
export function me(req, res) {
  res.json({
    signedIn: Boolean(req.account),
    email: req.account?.email ?? null,
    accountId: req.account?.id ?? null
  });
}

export async function logout(req, res, next) {
  const token = req.cookies?.[COOKIE];
  try {
    if (token) {
      // Revoked rather than deleted, so the row is still there to explain a device
      // that stopped working.
      await query('update sessions set revoked_at = now() where token_hash = $1', [sha256(token)]);
    }
    // Cleared with the attributes it was set with: a browser matches a removal
    // against name, path, domain and sameSite, and a mismatch leaves the cookie in
    // place on a session the server has already revoked.
    res.clearCookie(COOKIE, {
      path: '/',
      httpOnly: true,
      sameSite: 'lax',
      secure: req.secure || req.headers['x-forwarded-proto'] === 'https'
    });
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
}

/* ------------------------------------------------------- exported for tests */

export const _internals = { normaliseEmail, validEmail, sha256, hashCode, newCode, safeEqual };
