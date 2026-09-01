/**
 * Spendo - sync
 *
 * The app never waits on this. Every write lands in localStorage and returns; this
 * runs behind it, drains whatever is dirty, and merges back whatever the server has
 * that this device does not. If it fails, or if there is no server at all, nothing
 * about using the app changes - the only visible difference is a line in Settings
 * saying how many entries are still waiting.
 *
 * Nothing runs until someone is signed in
 * ---------------------------------------
 * A signed-out device syncs nothing at all. The earlier version registered itself at
 * boot and started pushing, which meant an account and a person's spending landed in
 * the database before they had agreed to any of it - and the endpoint that allowed
 * it had to accept anyone who asked.
 *
 * Being signed out costs nothing, because the outbox does not care how long it waits.
 * Everything written while signed out stays dirty, and the first sync after signing
 * in drains all of it. Nothing recorded beforehand is lost.
 *
 * That is the whole design goal, so it is worth stating what it rules out: no screen
 * blocks on a request, no save shows a spinner, and no failure produces a dialog.
 * A sync problem is reported where someone can go and look at it, not thrown in
 * front of a person trying to record what they spent on lunch.
 *
 * When it runs
 * ------------
 *   at boot                     catch up on whatever happened elsewhere
 *   when a write happens        debounced, so a burst of edits is one request
 *   when the network returns    the `online` event
 *   when the tab is looked at   `visibilitychange`, the phone's version of "returned"
 *   every few minutes           only while visible; a hidden tab polling is waste
 *
 * Failures back off, and stop being retried automatically once the delay is long
 * enough that the next real trigger will come first anyway.
 */

import * as store from './store.js';
import { identity, isSignedIn, markSignedOut } from './identity.js';

const DEBOUNCE = 2_000;
const PERIOD = 5 * 60 * 1000;
const BACKOFF = [5_000, 15_000, 60_000, 5 * 60_000];
const MAX_ROUNDS = 20;          // a page is 500 records, so this is 10,000 in one go

/** idle | syncing | offline | error | signed-out */
let status = 'idle';
let lastError = null;
let failures = 0;
let inFlight = null;
let debounceTimer = null;
let periodTimer = null;
let retryTimer = null;

/*
 * Records the server has refused, by id.
 *
 * They stay dirty, because marking them clean would be losing data quietly, and they
 * are still sent on every round in case a server fix makes them acceptable. What
 * they must not do is drive the scheduler: a rejected record keeps the pending count
 * above zero, and the write-triggered sync would then schedule a sync for the sync
 * that just finished, forever. So the debounce counts only records that could still
 * succeed.
 */
const rejected = new Map();

const listeners = new Set();
const remoteListeners = new Set();

export function onSyncChange(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/**
 * Fires when a sync actually brought records down, which is the only time the
 * screen the user is looking at can have gone stale underneath them.
 *
 * Separate from onSyncChange on purpose: that one fires on every status tick, and
 * repainting a screen because a status went from "syncing" to "idle" would restart
 * its entry animation several times a minute for no reason.
 */
export function onRemoteChange(fn) {
  remoteListeners.add(fn);
  return () => remoteListeners.delete(fn);
}

function announce() {
  for (const fn of listeners) fn(syncStatus());
}

export function syncStatus() {
  const meta = store.syncMeta();
  return {
    status,
    error: lastError,
    pending: store.pendingCount(),
    // Transactions alone, for the signed-out card. `pending` counts months too,
    // and calling an opening figure a transaction is simply wrong to a reader.
    pendingEntries: store.pendingChanges().entries.length,
    lastSyncedAt: meta.lastSyncedAt,
    rejected: rejected.size,
    online: navigator.onLine,
    signedIn: isSignedIn(),
    email: identity().email,
    accountId: identity().accountId
  };
}

function setStatus(next, error = null) {
  status = next;
  lastError = error;
  announce();
}

/* -------------------------------------------------------------------- one round */

async function postSync(body) {
  // The session is an httpOnly cookie, so there is no header to attach: a same-origin
  // fetch carries it on its own. `credentials` is stated rather than left to the
  // default so that changing this to another origin later cannot silently stop
  // sending it.
  const res = await fetch('/api/sync', {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body)
  });

  if (res.status === 401) {
    // The session expired, was revoked from another device, or the database was
    // rebuilt underneath us. Signing in again is the only fix, and it is the user's
    // to make, so this is reported rather than retried.
    const err = new Error('Sign in again to keep syncing.');
    err.code = 'unauthorised';
    throw err;
  }
  if (!res.ok) {
    let message = `sync failed: ${res.status}`;
    try {
      const body = await res.json();
      if (body?.error) message = body.error;
    } catch { /* a proxy's HTML error page; the status is enough */ }
    throw new Error(message);
  }
  return res.json();
}

/* ---------------------------------------------------------------------- run */

/**
 * Push everything dirty, pull everything new, repeat while the server says there is
 * more. Only one runs at a time; a second call while one is in flight joins it
 * rather than starting a race between two writers of the same store.
 */
export function syncNow(reason = 'manual') {
  if (inFlight) return inFlight;
  inFlight = run(reason).finally(() => { inFlight = null; });
  return inFlight;
}

async function run(reason) {
  clearTimeout(retryTimer);

  /*
   * Signed out is a resting state, not a failure: there is nothing to retry, because
   * only the user can change it. So no backoff timer is armed here - signing in
   * calls syncNow directly.
   */
  if (!isSignedIn()) {
    setStatus('signed-out');
    return { skipped: 'signed-out' };
  }

  if (!navigator.onLine) {
    setStatus('offline');
    return { skipped: 'offline' };
  }

  setStatus('syncing');
  let delivered = false;

  try {
    for (let round = 0; round < MAX_ROUNDS; round++) {
      const { entries, months } = store.pendingChanges();
      const { cursor } = store.syncMeta();

      const out = await postSync({ since: cursor, entries, months });

      for (const r of out.rejected || []) {
        if (!rejected.has(r.id)) {
          console.warn(`[sync] the server would not accept ${r.kind} ${r.id}: ${r.reason}`);
        }
        rejected.set(r.id, r.reason);
      }

      store.applySync({ entries: out.entries, months: out.months, cursor: out.cursor });
      if (out.entries.length || out.months.length) delivered = true;

      // Keep going while the server has more pages, or while this device still has
      // something to send - an edit made mid-request leaves the set non-empty.
      // Rejected records do not count: they will never drain, and treating them as
      // work left to do would spin this loop to its round limit on every sync.
      const stillDirty = sendableCount() > 0;
      if (!out.hasMore && !stillDirty) break;

      // Nothing moved and nothing left to send: stop rather than spin.
      if (!out.hasMore && stillDirty && entries.length === 0 && months.length === 0) break;
    }

    failures = 0;
    setStatus('idle');
    // After the status, so a listener that reads syncStatus() sees the finished one.
    if (delivered) for (const fn of remoteListeners) fn();
    return { ok: true, reason };
  } catch (err) {
    if (err.code === 'unauthorised') {
      // Retrying a dead session forever would burn requests and keep showing an
      // error nobody can act on from the status line.
      markSignedOut();
      setStatus('signed-out', err.message);
      return { ok: false, error: err.message };
    }
    setStatus('error', err.message);
    scheduleRetry();
    return { ok: false, error: err.message };
  }
}

function scheduleRetry() {
  const delay = BACKOFF[Math.min(failures, BACKOFF.length - 1)];
  failures += 1;
  clearTimeout(retryTimer);
  // Past the last step the periodic run and the next real trigger arrive sooner than
  // another retry would, so stop adding timers nobody asked for.
  if (failures > BACKOFF.length) return;
  retryTimer = setTimeout(() => syncNow('retry'), delay);
}

/* ----------------------------------------------------------------- triggers */

/** How much of the dirty set the server has not already refused. */
function sendableCount() {
  const { entries, months } = store.pendingChanges();
  return entries.filter((e) => !rejected.has(e.id)).length
       + months.filter((m) => !rejected.has(m.ym)).length;
}

/** Called after any local write. Debounced, so a burst of edits is one request. */
export function syncSoon() {
  announce();                       // the pending count changed, show it now
  // Signed out, the dirty set is just a backlog waiting for a sign-in. Counting it
  // is useful; scheduling a request for it is not.
  if (!isSignedIn()) return;
  // Applying what the server sent is itself a write, so without this the store's
  // change notification would schedule a sync for the sync that just finished, and
  // the two would keep each other awake forever.
  if (sendableCount() === 0) return;
  clearTimeout(debounceTimer);
  debounceTimer = setTimeout(() => syncNow('write'), DEBOUNCE);
}

function startPeriodic() {
  clearInterval(periodTimer);
  periodTimer = setInterval(() => {
    if (document.visibilityState === 'visible') syncNow('period');
  }, PERIOD);
}

export function startSync() {
  window.addEventListener('online', () => {
    failures = 0;                   // the network coming back is not a retry
    syncNow('online');
  });
  window.addEventListener('offline', () => setStatus('offline'));

  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') syncNow('visible');
  });

  // A last go while the tab is being closed. keepalive lets the request outlive the
  // page, which a normal fetch would not.
  window.addEventListener('pagehide', () => {
    const { entries, months } = store.pendingChanges();
    if (!entries.length && !months.length) return;
    if (!isSignedIn() || !navigator.onLine) return;
    try {
      fetch('/api/sync', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ since: store.syncMeta().cursor, entries, months }),
        keepalive: true
      }).catch(() => {});
    } catch { /* the browser is going away; there is nothing to recover to */ }
  });

  startPeriodic();
  syncNow('boot');
}

/**
 * Called right after a successful sign-in.
 *
 * `failures` is reset because a backoff earned while signed out or unauthorised
 * says nothing about a fresh session, and waiting five minutes to send a backlog
 * the user just asked for would look broken.
 */
export function signedIn() {
  failures = 0;
  return syncNow('signin');
}
