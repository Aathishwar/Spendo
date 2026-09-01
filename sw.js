/**
 * Spendo - service worker
 *
 * The app is offline first, so the shell is precached and served from the cache
 * so the app opens and works with no network at all.
 *
 * Requests go to the network first and fall back to that cache, rather than the
 * other way round. See the fetch handler for why. Bump CACHE when any precached
 * file changes; the old cache is deleted on activate, which is what stops a phone
 * running last week's JavaScript against this week's markup.
 *
 * There is no API here yet. Phase 2 adds /api/sync, and that route must stay
 * network-only: a cached sync response would hand the phone stale balances.
 */

const CACHE = 'spendo-v39';

const SHELL = [
  './',
  'index.html',
  'styles/tokens.css',
  'styles/app.css',
  'js/app.js',
  'js/ui.js',
  'js/store.js',
  'js/charts.js',
  'js/format.js',
  'js/categories.js',
  'js/sync.js',
  'js/identity.js',
  'js/ai.js',
  'js/categorise.js',
  // The tab icon and the one iOS uses. The 512 and the maskable are read by the OS
  // at install time and never by the running app, so they are left to the network
  // handler rather than adding 350KB to what every phone downloads to work offline.
  'icons/favicon-32.png',
  'icons/icon-192.png',
  'icons/apple-touch-icon.png',
  'icons/rupee.png',
  'icons/bill.png',
  'icons/paid.png',
  'icons/received.png',
  'fonts/geist-latin-variable.woff2',
  'manifest.webmanifest'
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE)
      // addAll is atomic: one bad path and nothing is cached, which is the correct
      // failure. A half-cached shell is worse than none.
      .then((cache) => cache.addAll(SHELL))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const { request } = event;

  if (request.method !== 'GET') return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;

  // Reserved for phase 2. Never serve a sync response from cache.
  if (url.pathname.startsWith('/api/')) return;

  // A navigation gets the cached shell when the network is gone, so opening the app
  // in flight mode shows the app rather than the browser's dinosaur.
  if (request.mode === 'navigate') {
    event.respondWith(
      fetch(request).catch(() => caches.match('index.html', { ignoreSearch: true }))
    );
    return;
  }

  /*
   * Network first, cache as the fallback.
   *
   * This was cache-first with a background refresh, which is faster on paper and
   * wrong in practice: it serves the PREVIOUS version's JavaScript on every load and
   * only catches up on the load after that. A user who reloads once to see a fix
   * sees the old code and reasonably concludes the fix did not ship. That cost real
   * time three separate times during phase 1.
   *
   * The shell is a few tens of kilobytes on one origin, so the round trip is cheap,
   * and the moment the network is gone the cache answers exactly as before. Offline
   * behaviour is unchanged; only the online staleness is gone.
   */
  event.respondWith(
    fetch(request)
      .then((res) => {
        if (res.ok) {
          const copy = res.clone();
          event.waitUntil(caches.open(CACHE).then((c) => c.put(request, copy)));
        }
        return res;
      })
      .catch(() => caches.match(request).then((hit) => hit || Response.error()))
  );
});
