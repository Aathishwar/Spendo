/**
 * Spendo - who is signed in
 *
 * Signing in is how a ledger gets off this phone, and it is optional. The app works
 * completely without it: everything is written to localStorage and read back from
 * there, and an account only decides whether any of it is also kept on the server.
 *
 * What this replaced
 * ------------------
 * This file used to mint a UUID on the device and hand it to /api/register, which
 * adopted it and issued a token. That made the account id a claim with nothing
 * behind it: /api/register had to accept anyone, so a stranger could create accounts
 * and rows in the database without proving they were anybody. Proving you can read
 * mail at an address is the claim now. The account id comes back from the server
 * after that proof, and is held here only so the Settings screen can show it.
 *
 * Why the token is not in here
 * ----------------------------
 * The session token lives in an httpOnly cookie, which this file cannot read - and
 * neither can anything else running on the page. Same-origin `fetch` sends it
 * automatically, so nothing has to carry it around. What is cached here is only the
 * ANSWER to "am I signed in", so a phone that boots offline can show the right
 * screen without waiting on a request that is not going to arrive.
 *
 * That cache is a display convenience, never an authorisation. The server decides;
 * a 401 is how this file finds out it was wrong.
 */

const KEY = 'spendo.account';

/** Set by refresh(); the cached copy is what boots the UI before it answers. */
let account = read();

const listeners = new Set();

function read() {
  try {
    const raw = localStorage.getItem(KEY);
    const parsed = raw ? JSON.parse(raw) : null;
    if (parsed && typeof parsed === 'object') {
      return {
        signedIn: Boolean(parsed.signedIn),
        email: parsed.email ?? null,
        accountId: parsed.accountId ?? null
      };
    }
  } catch {
    /* a private window, or storage refused; signed out is the safe assumption */
  }
  return { signedIn: false, email: null, accountId: null };
}

function write(next) {
  account = {
    signedIn: Boolean(next.signedIn),
    email: next.email ?? null,
    accountId: next.accountId ?? null
  };
  try {
    localStorage.setItem(KEY, JSON.stringify(account));
  } catch (e) {
    console.warn('[account] could not save:', e.message);
  }
  for (const fn of listeners) fn(account);
  return account;
}

export function onAccountChange(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/** Never null, never touches the network. */
export function identity() {
  return account;
}

export function isSignedIn() {
  return account.signedIn;
}

/**
 * The address that was last signed in on this phone, signed in or not.
 *
 * Kept after signing out on purpose: it is what tells us, at the NEXT sign-in,
 * whether the ledger sitting in localStorage belongs to the person arriving.
 */
const LAST_EMAIL_KEY = 'spendo.lastEmail';

export function lastEmail() {
  try {
    return localStorage.getItem(LAST_EMAIL_KEY);
  } catch {
    return null;
  }
}

function rememberEmail(email) {
  try {
    localStorage.setItem(LAST_EMAIL_KEY, email);
  } catch { /* nothing to recover to */ }
}

/* --------------------------------------------------------------- requests */

async function post(url, body) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body ?? {})
  });

  let payload = null;
  try {
    payload = await res.json();
  } catch {
    // A proxy's HTML error page, or no body at all. The status is enough.
  }

  if (!res.ok) {
    const err = new Error(payload?.error || `Request failed (${res.status}).`);
    err.status = res.status;
    err.retryInSeconds = payload?.retryInSeconds ?? null;
    throw err;
  }
  return payload || {};
}

/**
 * Ask the server who this browser is.
 *
 * Returns the cached answer unchanged when the request cannot be made, which is the
 * offline case and is not an error: being unable to check is not evidence of being
 * signed out, and forgetting the account every time the train goes into a tunnel
 * would be worse than briefly being wrong.
 */
export async function refresh() {
  try {
    const res = await fetch('/api/me', { headers: { accept: 'application/json' } });
    if (!res.ok) return account;
    const out = await res.json();
    return write(out);
  } catch {
    return account;
  }
}

/** Send a sign-in code. Throws with the server's own wording, which is user-facing. */
export function requestCode(email) {
  return post('/api/auth/request-code', { email: String(email || '').trim().toLowerCase() });
}

/**
 * Exchange a code for a session.
 *
 * Reports whether the address differs from the one last signed in here, so the
 * caller can decide what happens to the ledger already on the phone. This function
 * does not touch the ledger itself - that is the caller's call to make, and it is
 * destructive.
 */
export async function verifyCode(email, code) {
  const address = String(email || '').trim().toLowerCase();
  const out = await post('/api/auth/verify', { email: address, code: String(code).trim() });

  const previous = lastEmail();
  const isNewPerson = Boolean(previous) && previous !== address;

  rememberEmail(address);
  write({ signedIn: true, email: out.email || address, accountId: out.accountId ?? null });

  return { ...out, isNewPerson, previousEmail: previous };
}

/**
 * End the session on the server and forget it here.
 *
 * The ledger stays on the phone. That is deliberate: signing out is not deleting,
 * and the whole app works signed out. What protects the data is that signing in as
 * someone else clears it first - see verifyCode's `isNewPerson`.
 */
export async function signOut() {
  try {
    await post('/api/auth/logout');
  } catch {
    // The session may already be dead, or there may be no network. Either way this
    // device is signing out; the cookie is cleared server-side or expires on its own.
  }
  return write({ signedIn: false, email: null, accountId: null });
}

/** Called by the sync engine on a 401: the server disagrees with what is cached. */
export function markSignedOut() {
  if (!account.signedIn) return account;
  return write({ signedIn: false, email: null, accountId: null });
}
