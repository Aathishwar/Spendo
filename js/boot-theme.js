/**
 * Spendo - the theme, before the first pixel
 *
 * This runs BLOCKING in the head, not as a module, and that is the whole point.
 *
 * The status bar of the installed app takes its colour from `<meta name="theme-color">`
 * as the page first paints. app.js sets that meta correctly - but app.js is a module,
 * so it runs after the document has been parsed and, on a phone, after the system has
 * already decided what colour to paint the bar. The result was an app in dark mode
 * under a white status bar, which looks like a bug in the app because it is one.
 *
 * A separate file rather than an inline script: the page's Content-Security-Policy is
 * `script-src 'self'` with no hashes and no 'unsafe-inline', and a policy with a hole
 * in it for one convenient script is a policy that grows holes. It costs one request
 * for a few hundred bytes, on the same origin, precached by the service worker.
 *
 * It also removes the flash: `data-theme` is on <html> before any CSS is applied, so
 * a dark-theme user never sees a white card appear and then repaint.
 *
 * Everything here is defensive. This file must never be the reason the app fails to
 * start, so a private window with storage disabled, a corrupt value, or a missing
 * meta all end the same way: leave the markup as it is and let app.js sort it out.
 */
(function () {
  var LIGHT = '#f0f1ef';
  var DARK = '#0c0e0d';

  var theme = 'system';
  try {
    var raw = localStorage.getItem('spendo.v1');
    if (raw) {
      var saved = JSON.parse(raw);
      if (saved && saved.settings && typeof saved.settings.theme === 'string') {
        theme = saved.settings.theme;
      }
    }
  } catch (e) {
    /* storage refused, or the value is not JSON. System it is. */
  }

  var root = document.documentElement;
  if (theme === 'dark' || theme === 'light') root.setAttribute('data-theme', theme);
  else root.removeAttribute('data-theme');

  // "system" has to be resolved here rather than left to the media query, because the
  // meta tag holds one value and the browser reads it now.
  var dark = theme === 'dark'
    || (theme === 'system'
        && window.matchMedia
        && window.matchMedia('(prefers-color-scheme: dark)').matches);

  var meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.setAttribute('content', dark ? DARK : LIGHT);
})();
