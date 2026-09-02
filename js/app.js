/**
 * Spendo - screen logic and events
 *
 * One listener on the document handles almost everything, because every screen is
 * re-rendered wholesale on any change and per-node listeners would have to be
 * rebound each time. Buttons declare what they do in a data attribute and this file
 * reads it.
 */

import * as store from './store.js';
import * as sync from './sync.js';
import * as ui from './ui.js';
import {
  currentYM, longDate, money, monthLabel, shiftYM, todayISO, ymOf
} from './format.js';
import { categoriesFor, category, defaultCategory } from './categories.js';
import * as account from './identity.js';
import * as ai from './ai.js';
import { guess, remember } from './categorise.js';

const view = document.getElementById('view');
const fab = document.getElementById('fab');
const sheet = document.getElementById('sheet');
const sheetContent = document.getElementById('sheet-content');
const snack = document.getElementById('snack');

/*
 * How far back History looks. A year is the window in which a month can be compared
 * with the same month last year, and it is also about as many columns as 320px can
 * carry before the ticks have to be thinned to every third one.
 */
const TREND_MONTHS = 12;

let tab = 'today';
let ym = currentYM();
let pendingUndo = null;
let snackTimer = null;
let detail = { id: null, editing: null };
let search = { open: false, query: '' };
let sliceId = null;   // the category chosen on Insights, or null
// The calendar is a mode of whichever sheet is open, not a sheet of its own, so it
// knows which one to hand the date back to.
let picking = null;   // { from: 'add' | 'detail', viewYM }
let introStep = null; // which walkthrough screen is showing, or null
// The sign-in sheet's own state: which of its two steps is showing, the address
// being used, and whether a request is in flight. Kept here rather than in the DOM
// so an error can re-render the sheet without losing what was typed.
let signin = null;    // { step, email, error, busy, sending }
// Chrome hands the install prompt over once, at a moment of its choosing, and it can
// only be used once. Held here so Settings can offer it whenever the user gets there,
// rather than only in the second it happened to fire.
let installPrompt = null;
// Which month's review sheet is open, so it can be repainted when the write-up
// arrives without reopening it under the reader.
let reviewYM = null;

/* ------------------------------------------------------------------- theme */

function applyTheme(theme) {
  if (theme === 'system') document.documentElement.removeAttribute('data-theme');
  else document.documentElement.setAttribute('data-theme', theme);

  // Keep the Android status bar the same colour as the surface behind it.
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) {
    const bg = getComputedStyle(document.documentElement).getPropertyValue('--bg').trim();
    if (bg) meta.setAttribute('content', bg);
  }
}

/* ----------------------------------------------------------------- install */

function installState() {
  const standalone =
    matchMedia('(display-mode: standalone)').matches ||
    matchMedia('(display-mode: window-controls-overlay)').matches ||
    // iOS has never implemented display-mode for home-screen apps.
    navigator.standalone === true;

  return {
    standalone,
    canPrompt: Boolean(installPrompt),
    ios: /iphone|ipad|ipod/i.test(navigator.userAgent)
  };
}

/*
 * preventDefault stops Chrome's own mini-infobar, which is not a preference: left to
 * itself it appears over the ledger at a moment nobody chose. The offer moves to
 * Settings, where it can be taken when the user is looking for it.
 */
window.addEventListener('beforeinstallprompt', (e) => {
  e.preventDefault();
  installPrompt = e;
  if (tab === 'settings' && !sheet.open) render();
});

window.addEventListener('appinstalled', () => {
  installPrompt = null;
  showSnack('Spendo is on your home screen.', null, null, 'check-bold');
  if (tab === 'settings' && !sheet.open) render();
});

/* ------------------------------------------------------------------ render */

function monthSummaries() {
  return store.months().map((m) => {
    const s = store.monthStats(m);
    return { ym: m, spent: s.spent, balance: s.balance, count: s.count, closed: s.closed };
  });
}

function render({ animate = false } = {}) {
  const stats = store.monthStats(ym);
  const ctx = {
    ym,
    stats,
    entries: store.withBalances(ym).reverse(),
    months: monthSummaries(),
    totals: store.categoryTotals(ym),
    theme: store.settings().theme,
    sync: sync.syncStatus(),
    install: installState(),
    search,
    sliceId,
    // History only. Both of these walk every month in the ledger, and there is no
    // reason to pay for that while looking at Home.
    series: tab === 'history' ? store.monthlySeries(TREND_MONTHS) : [],
    tips: tab === 'history' ? tipsState() : null
  };
  ctx.searchResult = runSearch(ctx.entries, search.query);

  if (tab === 'today') view.innerHTML = ui.screenToday(ctx);
  else if (tab === 'history') view.innerHTML = ui.screenHistory(ctx);
  else if (tab === 'insights') view.innerHTML = ui.screenInsights(ctx);
  else view.innerHTML = ui.screenSettings(ctx);

  for (const btn of document.querySelectorAll('.nav-item')) {
    const active = btn.dataset.tab === tab;
    btn.classList.toggle('is-active', active);
    btn.setAttribute('aria-current', active ? 'page' : 'false');
  }

  // The next-month control stops at the present. There is nothing to see in
  // October and a disabled control says so better than an empty screen would.
  for (const next of document.querySelectorAll('[data-action="next-month"]')) {
    next.disabled = ym >= currentYM();
  }

  // Add belongs to the transaction list and nowhere else. On History it would be
  // ambiguous, since that screen is a list of months rather than one month, and on
  // Insights and Settings it is not the action of the screen.
  fab.hidden = tab !== 'today';
  view.classList.toggle('is-entering', animate);
  if (animate) {
    // Restart the animation on a node the browser has already seen.
    void view.offsetWidth;
    // Arriving on a screen means arriving at the top of it. Only on navigation: a
    // save or a delete re-renders too, and throwing the reader back to the top of
    // the month because one row changed loses their place for nothing.
    window.scrollTo(0, 0);
  }
  syncScroll();
  // And again after the browser has settled the layout. Focusing the search field
  // scrolls the page on its own, and a state read before that has happened is a
  // list locked shut at the very bottom of a page that cannot scroll any further.
  requestAnimationFrame(syncScroll);
  bindChart();
}

/*
 * Two things follow the page's scroll position, and both are read from it rather
 * than from a scroll delta, so they are correct after a re-render, a resize or a
 * jump as well as after a drag.
 */
function syncScroll() {
  // The Add button drops its label the moment the page moves and takes it back at
  // the top. 24px rather than 0 so a stray pixel of overscroll does not flicker it.
  fab.classList.toggle('is-compact', window.scrollY > 24);

  const list = view.querySelector('.list-scroll');
  if (!list) return;
  const doc = document.documentElement;
  // The list starts scrolling only once the page cannot. The 2px is for the
  // fractional scroll heights a zoomed or scaled viewport produces, where the sum
  // never quite reaches scrollHeight.
  const atEnd = window.scrollY + window.innerHeight >= doc.scrollHeight - 2;
  list.classList.toggle('is-scrollable', atEnd);
}

/* ------------------------------------------------------------------ sheets */

function openSheet(html) {
  sheetContent.innerHTML = html;
  if (!sheet.open) sheet.showModal();
  const first = sheetContent.querySelector('input:not([type="date"]), button:not(.icon-btn)');
  if (first && first.tagName === 'INPUT') setTimeout(() => first.focus(), 60);
}

function closeSheet() {
  if (sheet.open) sheet.close();
  sheetContent.innerHTML = '';
}

function reopenDetail() {
  const found = store.entry(detail.id);
  if (!found) return closeSheet();
  sheetContent.innerHTML = ui.detailSheet(found, detail.editing);
  const input = sheetContent.querySelector('.field-row.is-editing input:not([type="date"])');
  if (input) {
    input.focus();
    input.select();
  }
}

function commitDetail(patch) {
  store.updateEntry(detail.id, patch);
  detail.editing = null;
  reopenDetail();
  render();
}

let draft = null;

function openAdd(direction = 'out') {
  draft = draft && draft.direction === direction ? draft : {
    direction,
    category: defaultCategory(direction),
    date: todayISO(),
    amount: '',
    description: '',
    // Set the moment a chip is tapped, and never cleared for this entry: a guess
    // must not overrule a choice.
    categoryTouched: false,
    picked: null
  };
  openSheet(ui.addSheet({ ...draft, suggestions: store.recentDescriptions() }));
}

/**
 * Show only the recent descriptions that still match what has been typed.
 *
 * Done by toggling `hidden` on chips that are already in the DOM, never by
 * re-rendering the sheet: re-rendering replaces the input, which drops focus and
 * closes the keyboard on the second character of every word.
 */
function filterSuggestions(form) {
  const wrap = form.querySelector('[data-suggest]');
  if (!wrap) return;

  const typed = form.elements.description.value.trim().toLowerCase();
  const chips = [...wrap.querySelectorAll('[data-suggest-value]')];
  let any = false;

  for (const chip of chips) {
    const value = chip.dataset.suggestValue.toLowerCase();
    // An exact match is hidden too: offering to fill in what is already there is a
    // control that does nothing.
    const show = !typed || (value.includes(typed) && value !== typed);
    chip.hidden = !show;
    any = any || show;
  }
  wrap.hidden = !any;

  /*
   * Best match first.
   *
   * Hiding the misses already brings the matches to the front, because a hidden chip
   * takes no space in the row. What it does not do is put the LIKELIEST one there:
   * typing "cof" left "Morning filter coffee" ahead of "Coffee beans refill" purely
   * because it was used more recently. Something starting with what you typed is
   * almost always the one you meant, so it goes first; everything else keeps its
   * recency order, which is what `data-rank` is for.
   *
   * With nothing typed the original order is restored, so the row does not
   * quietly stay shuffled from the last thing that was in it.
   */
  const row = wrap.querySelector('.chip-row');
  const rank = (c) => Number(c.dataset.rank || 0);
  const ordered = chips.slice().sort((a, b) => {
    if (!typed) return rank(a) - rank(b);
    const pa = a.dataset.suggestValue.toLowerCase().startsWith(typed) ? 0 : 1;
    const pb = b.dataset.suggestValue.toLowerCase().startsWith(typed) ? 0 : 1;
    return pa - pb || rank(a) - rank(b);
  });
  for (const chip of ordered) row.append(chip);

  /*
   * Back to the start of the row, because the row is a horizontal scroller and
   * reordering its children does not move it.
   *
   * This is the bug that made the whole feature look broken: type a few more
   * letters, the best match is moved to position 0 - and position 0 is off the left
   * edge of a row still scrolled to wherever the last look through the recents left
   * it. The match was being computed correctly and then parked out of sight, so the
   * only way to see the suggestion was to scroll back by hand.
   *
   * Set, not animated: the content under the finger has already changed, and
   * sliding to it would draw a scroll the user did not ask for on every keystroke.
   */
  if (row.scrollLeft !== 0) row.scrollLeft = 0;
}

/* --------------------------------------------------------- category guessing */

const GUESS_DEBOUNCE = 400;
let guessTimer = null;
let guessSeq = 0;

/**
 * Pick a category from what has been typed, unless the user has already picked one.
 *
 * `draft.categoryTouched` is the whole safety rule: one tap on a chip and this never
 * fires again for that entry. An assistant that keeps overruling a decision you have
 * made is worse than one that never helps.
 *
 * Local layers answer synchronously and apply at once. Only a miss reaches the
 * server, and only then if signed in and online - so the common path costs nothing
 * and works on a train.
 */
function guessCategory() {
  clearTimeout(guessTimer);
  if (!draft || draft.categoryTouched) return;

  const form = document.getElementById('add-form');
  if (!form) return;
  const description = form.elements.description.value.trim();

  /*
   * The note describes the LAST guess, so it has to go the moment the description it
   * described is no longer what is in the field.
   *
   * Without this it lags: type something new, and "Picked from your past entries"
   * sits under a category that was chosen for words you have since deleted. The chip
   * itself stays - there is nothing better to put there until a new guess lands - but
   * a label that is actively wrong about where it came from is worse than none.
   */
  if (draft.picked && draft.pickedFor !== description) {
    draft.picked = null;
    form.querySelector('.field-label-row .field-hint')?.remove();
  }

  // Below three characters there is nothing to go on, and a chip flickering between
  // categories on every keystroke reads as a fault.
  if (description.length < 3) return;

  const local = guess(description, draft.direction);
  if (local) return applyGuess(local.category, local.source, description);

  guessTimer = setTimeout(() => askServer(description), GUESS_DEBOUNCE);
}

async function askServer(description) {
  const seq = ++guessSeq;
  const ids = categoriesFor(draft ? draft.direction : 'out').map((c) => c.id);

  const found = await ai.suggestCategory(description, ids);
  if (!found) return;

  /*
   * Cached BEFORE the staleness checks, deliberately.
   *
   * An answer that arrives too late to use is still a correct answer that has been
   * paid for, and the same description will be typed again. Caching it here turns a
   * call that missed its moment into a permanent local hit: next time, layer 1
   * answers it in under a millisecond with no network at all.
   */
  remember(description, found);

  // A late answer is not APPLIED. The sheet may have been closed, the direction
  // changed, or the description typed further - and a category appearing under
  // someone who has moved on is the behaviour that makes people distrust this.
  if (seq !== guessSeq || !draft || draft.categoryTouched) return;
  const form = document.getElementById('add-form');
  if (!form || form.elements.description.value.trim() !== description) return;

  applyGuess(found, 'ai', description);
}

/**
 * Move a chip to the front of its row and open the row at the front.
 *
 * Scrolling it into view was the first attempt and it was half a fix: the chip was on
 * screen, but everything before it was now behind the left edge, so seeing the rest of
 * the categories meant swiping back. Moving the node instead means the row can sit at
 * `scrollLeft: 0` - the picked category is the first thing under the thumb and every
 * other one is a swipe RIGHT, in the direction the row already scrolls.
 *
 * The node is moved rather than the sheet re-rendered, because re-rendering the sheet
 * replaces the description input and takes the keyboard away mid-word.
 */
function frontChip(chip) {
  const row = chip.closest('.chip-row');
  if (!row) return;
  if (row.firstElementChild !== chip) row.prepend(chip);
  row.scrollLeft = 0;
}

/**
 * Select a chip without re-rendering the sheet.
 *
 * Re-rendering would replace the description input and take the keyboard away
 * mid-word, which is the same trap the suggestion chips avoid.
 */
function applyGuess(categoryId, source, description) {
  if (!draft || draft.categoryTouched) return;
  draft.category = categoryId;
  draft.picked = source;
  draft.pickedFor = description;

  const form = document.getElementById('add-form');
  if (!form) return;

  let selected = null;
  for (const chip of form.querySelectorAll('[data-category]')) {
    const on = chip.dataset.category === categoryId;
    chip.classList.toggle('is-selected', on);
    chip.setAttribute('aria-pressed', String(on));
    if (on) selected = chip;
  }

  // Thirteen categories no longer fit the width, so the guess can land on a chip that
  // is off the right edge - which reads as nothing having happened at all. It is moved
  // to the front of the row instead, which is where the sheet renders the chosen one
  // anyway, so a guess and a re-render agree about where it lives.
  if (selected) frontChip(selected);

  const note = form.querySelector('.field-label-row .field-hint');
  const text = { history: 'from your past entries', cache: 'from your past entries',
                 keyword: 'from the description', ai: 'a guess' }[source];
  if (note && text) note.textContent = `Picked ${text}`;
  else if (!note && text) {
    const row = form.querySelector('.field-label-row');
    if (row) {
      const span = document.createElement('span');
      span.className = 'field-hint';
      span.textContent = `Picked ${text}`;
      row.append(span);
    }
  }
}

/** Reads the sheet's current inputs so a direction or category tap does not wipe them. */
function captureDraft() {
  const form = document.getElementById('add-form');
  if (!form) return;
  draft.amount = form.elements.amount.value;
  draft.description = form.elements.description.value;
}

/*
 * The walkthrough is marked seen when it closes, however it closes: Start tracking,
 * Skip, Escape, or a tap on the backdrop. Marking it seen only on the button would
 * mean anyone who dismissed it any other way met it again every launch, which is
 * how an intro turns into an obstacle.
 */
function openIntro() {
  introStep = 0;
  openSheet(ui.introSheet(0));
}

function openCalendar(from) {
  const current = from === 'add' ? draft.date : (store.entry(detail.id) || {}).date || todayISO();
  picking = { from, viewYM: ymOf(current) };
  sheetContent.innerHTML = ui.calendarSheet(current, picking.viewYM);
}

function closeCalendar() {
  const from = picking && picking.from;
  picking = null;
  if (from === 'detail') reopenDetail();
  else openSheet(ui.addSheet({ ...draft, suggestions: store.recentDescriptions() }));
}

/* ------------------------------------------------------------ month review */

/**
 * Open a month, with its figures now and its write-up when it arrives.
 *
 * The figures are computed on the device and are the content; the paragraph is laid
 * on top if a model can be reached. Nothing here waits on the network - the sheet is
 * fully readable the instant it opens, offline included.
 */
function openMonth(month) {
  reviewYM = month;
  const facts = store.monthReview(month);
  const held = store.reviewText(month);

  paintMonth(facts, held ? held.text : null);
  if (held || !account.isSignedIn() || !navigator.onLine) return;

  ai.writeReview({
    ym: facts.ym,
    isCurrent: facts.isCurrent,
    spent: facts.spent,
    received: facts.received,
    opening: facts.opening,
    balance: facts.balance,
    count: facts.count,
    activeDays: facts.activeDays,
    daysInMonth: facts.daysInMonth,
    // The amount, never what it was for. No description leaves the device here.
    biggestAmount: facts.biggest ? facts.biggest.amount : 0,
    top: facts.top.map((t) => ({ label: category(t.id).label, amount: t.amount, share: t.share })),
    prev: facts.prev ? { spent: facts.prev.spent, delta: facts.prev.delta } : null
  }).then((text) => {
    if (!text) {
      // Still show the sheet, just without the paragraph. paintMonth's own fallback
      // copy would keep saying "Writing a summary..." forever otherwise.
      if (reviewYM === month) paintMonth(facts, null, true);
      return;
    }
    store.setReviewText(month, text);
    if (reviewYM === month) paintMonth(facts, text);
  });
}

function paintMonth(facts, text, gaveUp = false) {
  const withFlag = {
    ...facts,
    aiPossible: !gaveUp && account.isSignedIn() && navigator.onLine
  };
  sheetContent.innerHTML = ui.monthSheet(withFlag, text);
  if (!sheet.open) sheet.showModal();
}

/* -------------------------------------------------------------- spend tips */

/*
 * Suggestions are asked for, never pushed.
 *
 * `tips.busy` and `tips.error` live here rather than in the store because they are
 * about this visit to the screen; the suggestions themselves live in the store,
 * stamped with the figures they came from, so they survive a reload and are thrown
 * away the moment the figures move under them.
 */
let tips = { busy: false, error: '' };

function tipsState() {
  const held = store.tipsHeld();
  return {
    items: held ? held.items : null,
    ym: held ? held.ym : null,
    madeAt: held ? held.madeAt : null,
    busy: tips.busy,
    error: tips.error,
    possible: account.isSignedIn() && navigator.onLine
  };
}

async function askForTips() {
  if (tips.busy) return;

  const profile = store.spendingProfile();
  if (!profile || profile.spent <= 0) {
    tips.error = 'There is nothing to read yet. Add a few expenses first.';
    render();
    return;
  }

  tips.busy = true;
  tips.error = '';
  render();

  // Labels, not ids: the model writes with them, and "Personal care" reads as itself
  // where "care" comes back in a sentence as a verb.
  const items = await ai.suggestTips({
    ym: profile.ym,
    isCurrent: profile.isCurrent,
    spent: profile.spent,
    received: profile.received,
    balance: profile.balance,
    avgMonthly: profile.avgMonthly,
    monthsCovered: profile.monthsCovered,
    series: profile.series,
    categories: profile.categories.map((c) => ({
      label: category(c.id).label,
      amount: c.amount,
      share: c.share,
      usual: c.usual,
      delta: c.delta
    }))
  });

  tips.busy = false;
  if (!items) {
    tips.error = 'Could not get suggestions just now. Try again in a moment.';
  } else {
    store.setTips(items);
  }
  render();
}

/* ----------------------------------------------------------------- sign in */

function paintSignIn() {
  sheetContent.innerHTML = ui.signInSheet(signin);
  const input = sheetContent.querySelector('input:not([type="hidden"])');
  if (input) setTimeout(() => input.focus(), 60);
}

function openSignIn() {
  signin = { step: 'email', email: account.lastEmail() || '', error: '', busy: false, sending: false };
  if (!sheet.open) sheet.showModal();
  paintSignIn();
}

/**
 * Ask for a code, and move to the second step only if one was actually sent.
 *
 * Rate-limit refusals come back as the server's own wording, including how long to
 * wait, so they are shown as-is rather than translated into something vaguer here.
 */
async function sendCode(email, { resend = false } = {}) {
  signin = { ...signin, email, error: '', busy: !resend, sending: resend };
  paintSignIn();

  try {
    await account.requestCode(email);
    signin = { ...signin, step: 'code', busy: false, sending: false, error: '' };
  } catch (err) {
    const offline = !navigator.onLine;
    signin = {
      ...signin,
      // Staying on the code step after a failed resend is right: the first code is
      // still valid, and dropping the user back to the email field would suggest
      // otherwise.
      step: resend ? 'code' : signin.step,
      busy: false,
      sending: false,
      error: offline ? 'You are offline. Signing in needs a connection.' : err.message
    };
  }
  paintSignIn();
}

/**
 * Exchange the code for a session.
 *
 * The destructive part is here rather than in identity.js: if a DIFFERENT address
 * signs in on a phone that still holds someone else's ledger, that ledger is cleared
 * first. Without it the next sync would push one person's spending into the other
 * person's account, because a record carries no owner locally - the session decides
 * who owns what, and the session just changed.
 */
async function submitCode(email, code) {
  signin = { ...signin, busy: true, error: '' };
  paintSignIn();

  try {
    const out = await account.verifyCode(email, code);

    if (out.isNewPerson) store.clearLedger();
    // A device that has never seen this account has a cursor from nowhere, so the
    // whole history has to come down. Merging is last-write-wins either way, so this
    // is safe on a device that does have local data.
    else store.resetSyncCursor();

    signin = null;
    closeSheet();
    render();
    showSnack(out.isNewPerson
      ? `Signed in as ${out.email}. Loading that account.`
      : `Signed in as ${out.email}. Sending everything up.`, null, null, 'cloud-check');
    sync.signedIn();
  } catch (err) {
    signin = { ...signin, busy: false, error: err.message };
    paintSignIn();
  }
}

async function doSignOut() {
  await account.signOut();
  render();
  showSnack('Signed out. Your transactions stay on this phone.', null, null, 'sign-out');
}

/*
 * A once-a-day reminder that nothing is backed up.
 *
 * Once a DAY, not once a session: this app is opened several times a day, and a
 * nudge on every launch is how a useful message becomes something people learn to
 * dismiss without reading. It is also silent until there is something to lose -
 * telling an empty ledger it is not backed up is noise.
 */
const NUDGE_KEY = 'spendo.lastBackupNudge';

function maybeNudgeSignIn() {
  if (account.isSignedIn()) return;
  if (store.pendingCount() === 0) return;

  const today = todayISO();
  try {
    if (localStorage.getItem(NUDGE_KEY) === today) return;
    localStorage.setItem(NUDGE_KEY, today);
  } catch {
    return;   // storage refused; a nudge is not worth a broken launch
  }

  showSnack('Saved on this phone only. Not backed up.', 'Sign in', openSignIn, 'cloud-slash');
}

/* ---------------------------------------------------------------- snackbar */

const SNACK_LIFE = 3000;

/**
 * Report what just happened, and offer to reverse it if it can be reversed.
 *
 * The message is written with textContent, not into innerHTML. It used to be
 * interpolated into a template string, and one of its callers passes an entry's
 * description - text the user typed - so `<img onerror=...>` as a description was a
 * script running on every screen. Only the icon name, which this file chooses from a
 * fixed set, is ever treated as markup.
 *
 * `icon` names the glyph in the vendored sprite. `actionLabel` also switches on the
 * countdown bar, because a deadline is only worth drawing when something is waiting
 * on it.
 */
function showSnack(message, actionLabel, onAction, iconName = 'check-bold') {
  clearTimeout(snackTimer);

  snack.replaceChildren();
  snack.style.setProperty('--snack-life', `${SNACK_LIFE}ms`);

  const glyph = document.createElement('span');
  glyph.className = 'snack-icon';
  glyph.innerHTML = ui.icon(iconName);
  snack.append(glyph);

  const text = document.createElement('span');
  text.className = 'snack-text';
  text.textContent = message;
  snack.append(text);

  if (actionLabel) {
    const button = document.createElement('button');
    button.className = 'snack-action';
    button.type = 'button';
    button.dataset.action = 'snack-action';
    button.textContent = actionLabel;
    snack.append(button);

    const timer = document.createElement('span');
    timer.className = 'snack-timer';
    snack.append(timer);
  }

  snack.classList.add('is-open');
  pendingUndo = onAction || null;
  snackTimer = setTimeout(hideSnack, SNACK_LIFE);
}

/*
 * The class goes; the contents stay until the next message replaces them.
 *
 * Emptying it here would remove the text mid-fade, so the bar would spend its exit
 * animation as an empty pill. It is `visibility: hidden` once closed, so nothing is
 * readable or reachable in the meantime - including to a screen reader.
 */
function hideSnack() {
  clearTimeout(snackTimer);
  snack.classList.remove('is-open');
  pendingUndo = null;
}

/* --------------------------------------------------------- chart pin readout */

let chartDismissers = [];

/**
 * Both charts, bound the same way.
 *
 * One function because the two charts differ only in what a column MEANS - a day on
 * Home, a month on History - and that difference is a two-line `readout`. The
 * gesture, the pin, the dimming and the dismissal are the same, and a second copy of
 * them would be a second place for them to drift apart.
 */
function bindChart() {
  // These run on every render and the chart nodes are replaced each time, so the
  // document-level listeners have to come back down or they stack up one per render,
  // each keeping its own dead `wrap` alive.
  for (const off of chartDismissers) document.removeEventListener('pointerdown', off);
  chartDismissers = [];

  const daily = view.querySelector('[data-chart="daily"]');
  if (daily) {
    const stats = store.monthStats(ym);
    bindPinnableChart(daily, stats.daysInMonth, (day) => {
      const value = stats.perDay[day - 1] || 0;
      const iso = `${ym}-${String(day).padStart(2, '0')}`;
      return { title: longDate(iso), value: value > 0 ? money(value) : 'nothing spent' };
    });
  }

  const monthly = view.querySelector('[data-chart="monthly"]');
  if (monthly) {
    // The same series the chart was drawn from, so a column and its readout cannot
    // disagree about which month they are.
    const series = store.monthlySeries(TREND_MONTHS);
    bindPinnableChart(monthly, series.length, (i) => {
      const m = series[i - 1];
      if (!m) return null;
      return {
        title: monthLabel(m.ym),
        value: m.spent > 0 ? money(m.spent) : 'nothing spent'
      };
    });
  }
}

/**
 * Tap a column to pin its figure; tap it again, or anywhere off the chart, to clear.
 *
 * The old version showed the figure on `pointermove` and hid it on `pointerleave`,
 * which is a hover, and hover does not exist on a phone. A touch synthesises both:
 * the tip appeared under the finger and was gone before the finger was out of the
 * way, so on the device most of this app is used on, the chart had no readout at all.
 *
 * So the column is PINNED - the same grammar as selecting a row. Hover is kept, but
 * only where a real pointer exists and only while nothing is pinned, so a mouse still
 * gets the quick read and never fights the tap.
 *
 * A pin is not carried across a re-render. It is a reading of a chart, not a setting,
 * and a figure that outlives the thing it was read from is worse than one that has to
 * be tapped again.
 */
function bindPinnableChart(wrap, columns, readout) {
  const tip = wrap.querySelector('.chart-tip');
  const svg = wrap.querySelector('svg');
  if (!tip || !svg || columns < 1) return;

  // A device with a real pointer. Not `hover: hover` alone: a stylus and some
  // Android browsers report hover while still delivering touch-shaped events.
  const fine = window.matchMedia('(hover: hover) and (pointer: fine)').matches;
  let pinned = null;

  const show = (n) => {
    const read = readout(n);
    if (!read) return;
    // Built as nodes rather than as a string of HTML: the readout is the only place
    // a figure and a date reach the DOM without going through a template, and
    // `textContent` cannot be talked into markup by a description or a locale.
    const title = document.createElement('b');
    title.textContent = read.title;
    const value = document.createElement('span');
    value.textContent = read.value;
    tip.replaceChildren(title, value);
    tip.hidden = false;
    const pct = (n - 0.5) / columns;
    tip.style.left = `${Math.min(88, Math.max(12, pct * 100))}%`;

    // Everything else steps back so the chosen column is the one being read. The bar
    // is not recoloured: a second hue would say this column is a different KIND of
    // column rather than the one currently being looked at.
    svg.classList.toggle('has-pin', pinned === n);
    for (const bar of svg.querySelectorAll('.chart-bar')) {
      bar.classList.toggle('is-active', Number(bar.dataset.day) === n);
    }
    // The hit target is tinted as well as the bar, because a column with nothing in
    // it is a 2px stub: dimming the others would leave the pin nothing to point at.
    for (const hit of svg.querySelectorAll('.chart-hit')) {
      hit.classList.toggle('is-active', Number(hit.dataset.day) === n);
    }
  };

  const clear = () => {
    pinned = null;
    tip.hidden = true;
    svg.classList.remove('has-pin');
    for (const el of svg.querySelectorAll('.is-active')) el.classList.remove('is-active');
  };

  // `click` rather than `pointerdown`, so a drag that started on the chart while
  // scrolling the page does not leave a column pinned behind it.
  wrap.addEventListener('click', (e) => {
    const hit = e.target.closest('.chart-hit');
    if (!hit) return;
    const n = Number(hit.dataset.day);
    if (pinned === n) return clear();
    pinned = n;
    show(n);
  });

  if (fine) {
    wrap.addEventListener('pointermove', (e) => {
      if (pinned !== null) return;
      const hit = e.target.closest('.chart-hit');
      if (hit) show(Number(hit.dataset.day));
    });
    wrap.addEventListener('pointerleave', () => { if (pinned === null) tip.hidden = true; });
  }

  const dismiss = (e) => { if (pinned !== null && !wrap.contains(e.target)) clear(); };
  document.addEventListener('pointerdown', dismiss);
  chartDismissers.push(dismiss);
}

/* ------------------------------------------------------------------ search */

/**
 * The operators the Telegram bot understood, minus the date ones, which arrive with
 * the rest of search in phase 5. Anything that is not an operator is a keyword and
 * all keywords must match, which is how the old `/search coffee zomato` behaved.
 */
function parseQuery(query) {
  const tokens = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  const f = { keywords: [], min: null, max: null, exact: null };

  for (const t of tokens) {
    let m;
    if ((m = t.match(/^(>=|<=|>|<)(\d+(?:\.\d{1,2})?)$/))) {
      const v = parseFloat(m[2]);
      if (m[1] === '>') f.min = v + 0.01;
      else if (m[1] === '>=') f.min = v;
      else if (m[1] === '<') f.max = v - 0.01;
      else f.max = v;
    } else if ((m = t.match(/^(\d+(?:\.\d{1,2})?)-(\d+(?:\.\d{1,2})?)$/))) {
      f.min = parseFloat(m[1]);
      f.max = parseFloat(m[2]);
    } else if (/^\d+(?:\.\d{1,2})?$/.test(t)) {
      f.exact = parseFloat(t);
    } else {
      f.keywords.push(t);
    }
  }
  return f;
}

function matches(e, f) {
  const hay = `${e.description} ${category(e.category).label}`.toLowerCase();
  if (!f.keywords.every((k) => hay.includes(k))) return false;
  if (f.exact !== null && e.amount !== f.exact) return false;
  if (f.min !== null && e.amount < f.min) return false;
  if (f.max !== null && e.amount > f.max) return false;
  return true;
}

/**
 * Search is scoped to the month on screen, because that is the list the field sits
 * on top of and filtering a list into results from a month you are not looking at
 * is a lie about what you are seeing. When there is nothing here but something
 * elsewhere, the note under the field says so and offers to widen.
 */
function runSearch(entries, query) {
  if (!query.trim()) {
    return { query: '', entries, spent: 0, elsewhere: 0 };
  }
  const f = parseQuery(query);
  const found = entries.filter((e) => matches(e, f));
  let elsewhere = 0;
  if (!found.length) {
    for (const m of store.months()) {
      if (m === ym) continue;
      elsewhere += store.entriesFor(m).filter((e) => matches(e, f)).length;
    }
  }
  return {
    query,
    entries: found,
    spent: found.reduce((a, e) => a + (e.direction === 'out' ? e.amount : 0), 0),
    elsewhere
  };
}

/** Repaint only the rows, the note and the total, so the field keeps focus and the caret. */
function updateSearchResults() {
  const rows = document.getElementById('txn-rows');
  const note = document.getElementById('search-note');
  const foot = document.getElementById('txn-foot');
  if (!rows) return;
  const entries = store.withBalances(ym).reverse();
  const result = runSearch(entries, search.query);
  rows.innerHTML = ui.txnRows(result.entries);
  if (note) note.innerHTML = ui.searchNote(result, monthLabel(ym));
  // The total is of what is listed, so it has to move with the list on every
  // keystroke. Leaving it behind would show a month's total under a filtered list.
  if (foot) foot.innerHTML = ui.ledgerFoot(result.entries);
}

/** Jump to the most recent month that has a match for the current query. */
function searchAllMonths() {
  const f = parseQuery(search.query);
  for (const m of store.months()) {
    if (store.entriesFor(m).some((e) => matches(e, f))) {
      ym = m;
      render();
      focusSearch();
      return;
    }
  }
}

function focusSearch() {
  const input = document.getElementById('search-inline');
  if (!input) return;
  input.focus();
  const v = input.value;
  input.value = '';
  input.value = v;
}

/* ------------------------------------------------------------ amount field */

/*
 * The amount field is `type="text"` with `inputmode="decimal"`, because `type=number`
 * brings a spinner, a browser-shaped error bubble and no caret control. The cost of
 * that choice is that nothing stops a letter going in, and it showed: an amount of
 * `8979erte` was accepted, because the submit handler stripped the value down to
 * digits and saved 8979. The user never typed 8979. A field that quietly invents a
 * different figure from the one on screen is worse than one that refuses.
 *
 * So the field now refuses as you type, and the submit check reads the value
 * literally instead of salvaging a number out of it.
 */

/** Digits, at most one dot, at most two places after it. */
function cleanAmount(raw) {
  let v = String(raw).replace(/[^0-9.]/g, '');
  /*
   * Dots before the first digit are thrown away rather than kept as the decimal
   * point. Pasting "Rs. 1,299.994" otherwise leaves ".1299.994", whose first dot is
   * the one from "Rs.", and the field ends up reading .12 for a twelve hundred rupee
   * expense. The cost is that typing ".5" gives 5 rather than 0.5, which is a slip
   * the user can see on screen; .12 for 1,299 is not.
   */
  v = v.replace(/^\.+/, '');
  const dot = v.indexOf('.');
  if (dot !== -1) v = v.slice(0, dot + 1) + v.slice(dot + 1).replace(/\./g, '');
  const [whole, frac] = v.split('.');
  return frac === undefined ? whole : `${whole}.${frac.slice(0, 2)}`;
}

function filterAmountInput(el) {
  const raw = el.value;
  const cleaned = cleanAmount(raw);
  if (cleaned === raw) return;
  // Put the caret back where the user's own characters are. Assigning .value alone
  // sends it to the end, so typing a stray letter in the middle of a figure would
  // throw the caret to the far side of the number.
  const caret = el.selectionStart == null ? raw.length : el.selectionStart;
  const kept = cleanAmount(raw.slice(0, caret)).length;
  el.value = cleaned;
  const pos = Math.min(kept, cleaned.length);
  el.setSelectionRange(pos, pos);
}

/**
 * The value as a number, or NaN. Never a salvage: `Number` refuses the whole string
 * rather than picking the digits out of it, which is the point.
 */
function readAmount(form) {
  const raw = String(form.elements.amount.value).trim();
  return raw === '' ? NaN : Number(raw);
}

/* ------------------------------------------------------------------ export */

function exportBackup() {
  const blob = new Blob([JSON.stringify(store.snapshot(), null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `spendo-backup-${todayISO()}.json`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/* ------------------------------------------------------------------ events */

document.addEventListener('click', (e) => {
  // Every clickable thing declares itself with one of these attributes. Adding a new
  // one to the markup without adding it here is a control that silently does nothing.
  //
  // `button[data-theme]`, not `[data-theme]`: an explicit theme is stamped on <html>
  // as `data-theme`, so the bare selector matched the ROOT ELEMENT and every click
  // that hit nothing else - the background, a card, a bar of the chart - walked up to
  // it, re-saved the theme and re-rendered the screen. Invisible on the default
  // "system" theme, because then the attribute is removed rather than set; on Light or
  // Dark it re-rendered the page under every stray tap, which is what was throwing the
  // chart's pinned day away the instant it was set.
  const el = e.target.closest([
    '[data-action]', '[data-tab]', '[data-entry]', '[data-month]',
    '[data-direction]', '[data-category]', 'button[data-theme]',
    '[data-slice]', '[data-edit-field]', '[data-set-category]',
    '[data-set-direction]', '[data-pick-day]', '[data-set-day]', '[data-cal-step]',
    '[data-suggest-value]', '[data-open-month]'
  ].join(', '));
  if (!el) return;

  // A recent description, tapped. Fills the field and hands focus back, so the next
  // thing typed continues in the sheet rather than nowhere.
  if (el.dataset.suggestValue !== undefined) {
    const form = el.closest('form');
    if (form) {
      form.elements.description.value = el.dataset.suggestValue;
      if (draft) draft.description = el.dataset.suggestValue;
      const slot = form.querySelector('[data-error="description"]');
      if (slot) slot.hidden = true;
      filterSuggestions(form);
      guessCategory();
      form.elements.description.focus();
    }
    return;
  }

  // Tabs
  if (el.dataset.tab) {
    if (el.dataset.tab === tab) return;
    tab = el.dataset.tab;
    search = { open: false, query: '' };
    sliceId = null;
    render({ animate: true });
    return;
  }

  // Month chips on Insights, and rows on History
  if (el.dataset.month) { openMonth(el.dataset.month); return; }
  if (el.dataset.openMonth) {
    ym = el.dataset.openMonth;
    tab = 'today';
    closeSheet();
    render({ animate: true });
    return;
  }

  // Add sheet, direction and category
  if (el.dataset.direction && draft) {
    captureDraft();
    draft.direction = el.dataset.direction;
    draft.category = defaultCategory(draft.direction);
    openAdd(draft.direction);
    return;
  }
  if (el.dataset.category && draft) {
    // From here on this entry's category is the user's, and no guess may move it.
    draft.categoryTouched = true;
    draft.picked = null;
    captureDraft();
    draft.category = el.dataset.category;
    openSheet(ui.addSheet({ ...draft, suggestions: store.recentDescriptions() }));
    return;
  }

  if (el.dataset.theme) {
    store.setSetting('theme', el.dataset.theme);
    applyTheme(el.dataset.theme);
    render();
    return;
  }

  // A row anywhere opens its detail sheet
  if (el.dataset.entry && !el.dataset.action) {
    const found = store.entry(el.dataset.entry);
    if (found) {
      detail = { id: found.id, editing: null };
      openSheet(ui.detailSheet(found, null));
    }
    return;
  }

  // Detail sheet: open one field for editing, or commit a tap-to-choose control.
  if (el.dataset.editField) {
    detail.editing = el.dataset.editField;
    reopenDetail();
    return;
  }
  if (el.dataset.setCategory) { commitDetail({ category: el.dataset.setCategory }); return; }
  if (el.dataset.setDirection) {
    const direction = el.dataset.setDirection;
    const current = store.entry(detail.id);
    // An expense category means nothing on an income row, so switching direction
    // moves the entry to that direction's default rather than leaving it mislabelled.
    const patch = { direction };
    if (current && !categoriesFor(direction).some((c) => c.id === current.category)) {
      patch.category = defaultCategory(direction);
    }
    commitDetail(patch);
    return;
  }

  if (el.dataset.slice) {
    sliceId = sliceId === el.dataset.slice ? null : el.dataset.slice;
    render();
    return;
  }

  // Date picking, from either sheet.
  if (el.dataset.pickDay) {
    const iso = el.dataset.pickDay;
    if (picking && picking.from === 'detail') {
      picking = null;
      commitDetail({ date: iso });
    } else if (picking) {
      draft.date = iso;
      closeCalendar();
    } else {
      captureDraft();
      draft.date = iso;
      openSheet(ui.addSheet({ ...draft, suggestions: store.recentDescriptions() }));
    }
    return;
  }
  if (el.dataset.setDay) { commitDetail({ date: el.dataset.setDay }); return; }
  if (el.dataset.calStep) {
    picking.viewYM = shiftYM(picking.viewYM, Number(el.dataset.calStep));
    const current = picking.from === 'add' ? draft.date : (store.entry(detail.id) || {}).date;
    sheetContent.innerHTML = ui.calendarSheet(current, picking.viewYM);
    return;
  }

  switch (el.dataset.action) {
    case 'open-add': openAdd('out'); break;

    case 'intro-next': introStep += 1; sheetContent.innerHTML = ui.introSheet(introStep); break;
    case 'intro-back': introStep -= 1; sheetContent.innerHTML = ui.introSheet(introStep); break;
    case 'intro-done': closeSheet(); break;
    case 'show-intro': openIntro(); break;
    case 'open-calendar':
      if (document.getElementById('add-form')) captureDraft();
      openCalendar(document.getElementById('add-form') ? 'add' : 'detail');
      break;
    case 'cancel-pick': closeCalendar(); break;
    case 'close-sheet': closeSheet(); break;

    case 'toggle-search':
      search.open = !search.open;
      // Closing clears the query, so reopening never shows a filtered list the user
      // does not remember filtering.
      if (!search.open) search.query = '';
      render();
      if (search.open) focusSearch();
      break;

    case 'search-all': searchAllMonths(); break;
    case 'prev-month': ym = shiftYM(ym, -1); sliceId = null; render({ animate: true }); break;
    case 'next-month':
      if (ym < currentYM()) { ym = shiftYM(ym, 1); sliceId = null; render({ animate: true }); }
      break;
    case 'get-tips': askForTips(); break;
    case 'export-json': exportBackup(); break;
    case 'sync-now': sync.syncNow('manual'); break;
    case 'install-app': {
      const prompt = installPrompt;
      // Single use: the event is spent whether or not the person accepts, and calling
      // prompt() twice throws. Chrome fires a fresh one if they change their mind.
      installPrompt = null;
      if (!prompt || typeof prompt.prompt !== 'function') { render(); break; }
      prompt.prompt();
      Promise.resolve(prompt.userChoice).catch(() => null).finally(() => render());
      break;
    }
    case 'sign-in': openSignIn(); break;
    case 'sign-out': doSignOut(); break;
    case 'signin-back':
      signin = { ...signin, step: 'email', error: '', busy: false, sending: false };
      paintSignIn();
      break;
    case 'signin-resend': sendCode(signin.email, { resend: true }); break;

    case 'delete-entry': {
      const id = el.dataset.entry;
      const removed = store.removeEntry(id);
      closeSheet();
      render();
      if (removed) {
        showSnack(`Deleted ${removed.description || category(removed.category).label}`, 'Undo', () => {
          store.restoreEntry(id);
          render();
        }, 'trash-simple');
      }
      break;
    }

    case 'snack-action':
      if (pendingUndo) pendingUndo();
      hideSnack();
      break;

    case 'set-opening':
      openSheet(ui.amountSheet({
        title: `Opening money for ${monthLabel(ym)}`,
        note: 'Replaces whatever is there now. Every balance for the month is recalculated from it.',
        label: 'Amount',
        confirm: 'Set amount'
      }));
      document.getElementById('amount-form').dataset.mode = 'set';
      break;

    case 'add-opening':
      openSheet(ui.amountSheet({
        title: `Add to ${monthLabel(ym)}`,
        note: 'Adds to the opening money rather than replacing it. Use this when more money arrives mid month.',
        label: 'Amount to add',
        confirm: 'Add amount'
      }));
      document.getElementById('amount-form').dataset.mode = 'add';
      break;

    default: break;
  }
});

document.addEventListener('input', (e) => {
  const el = e.target;

  if (el.id === 'search-inline') {
    search.query = el.value;
    updateSearchResults();
    return;
  }

  if (el.name === 'amount') filterAmountInput(el);

  if (el.name === 'description' && el.form) {
    filterSuggestions(el.form);
    guessCategory();
  }

  // A sign-in code is six digits. An autofilled SMS or a pasted "code: 123456" both
  // arrive with characters around them, and none of them belong in the field.
  if (el.name === 'code') {
    const cleaned = el.value.replace(/\D/g, '').slice(0, 6);
    if (cleaned !== el.value) el.value = cleaned;
  }

  /*
   * An error belongs to the state of a field, not to the last time Save was pressed.
   * "Say what it was for." was still sitting under a description with text in it,
   * because the message was only ever cleared by the next submit. Typing is the user
   * answering the message, so the message goes then.
   */
  if (el.form && el.name) {
    const slot = el.form.querySelector(`[data-error="${el.name}"]`);
    if (slot) slot.hidden = true;
  }
});

// Escape closes the field rather than only clearing it, which is what a search that
// lives inside the page is expected to do.
document.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape' || e.target.id !== 'search-inline') return;
  search.open = false;
  search.query = '';
  render();
});

document.addEventListener('submit', (e) => {
  const form = e.target;
  e.preventDefault();

  if (form.id === 'add-form') {
    const amount = readAmount(form);
    const description = form.elements.description.value.trim();
    const date = draft.date || todayISO();

    const fail = (name, message) => {
      const slot = form.querySelector(`[data-error="${name}"]`);
      slot.textContent = message;
      slot.hidden = false;
      form.elements[name].focus();
    };
    for (const slot of form.querySelectorAll('.field-error')) slot.hidden = true;

    if (!(amount > 0)) return fail('amount', 'Enter an amount greater than zero.');
    if (!description) return fail('description', 'Say what it was for.');

    const saved = store.addEntry({ amount, description, date, direction: draft.direction, category: draft.category });
    draft = null;
    ym = saved.ym;
    closeSheet();
    render();
    // Point at the row that just appeared, so a save in a long list is findable
    // without re-reading it.
    const row = view.querySelector(`.row[data-entry="${saved.id}"]`);
    if (row) {
      row.classList.add('is-new');
      row.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    }
    showSnack(`Saved ${money(saved.amount)}`, 'Undo', () => {
      store.removeEntry(saved.id);
      render();
    });
    return;
  }

  if (form.id === 'edit-form') {
    const field = form.dataset.field;
    if (field === 'amount') {
      const amount = readAmount(form);
      if (!(amount > 0)) return form.elements.amount.focus();
      commitDetail({ amount });
    } else if (field === 'description') {
      const description = form.elements.description.value.trim();
      if (!description) return form.elements.description.focus();
      commitDetail({ description });
    }
    return;
  }

  if (form.id === 'signin-email-form') {
    const email = form.elements.email.value.trim().toLowerCase();
    // The same shape the server checks against, so a typo is caught before it costs
    // a round trip and a slot in the hourly send quota.
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)) {
      signin = { ...signin, email, error: 'Enter a valid email address.' };
      paintSignIn();
      return;
    }
    sendCode(email);
    return;
  }

  if (form.id === 'signin-code-form') {
    const code = form.elements.code.value.replace(/\D/g, '');
    if (code.length !== 6) {
      signin = { ...signin, error: 'The code is 6 digits.' };
      paintSignIn();
      return;
    }
    submitCode(form.elements.email.value, code);
    return;
  }

  if (form.id === 'amount-form') {
    const amount = readAmount(form);
    const slot = form.querySelector('[data-error="amount"]');
    if (!(amount >= 0) || Number.isNaN(amount)) {
      slot.textContent = 'Enter an amount.';
      slot.hidden = false;
      return;
    }
    if (form.dataset.mode === 'add') store.addOpening(ym, amount);
    else store.setOpening(ym, amount);
    closeSheet();
    render();
  }
});

// Tapping the backdrop closes the sheet. <dialog> gives Escape and the focus trap.
sheet.addEventListener('click', (e) => {
  if (e.target === sheet) closeSheet();
});
sheet.addEventListener('close', () => {
  sheetContent.innerHTML = '';
  signin = null;
  reviewYM = null;
  if (introStep !== null) {
    introStep = null;
    if (!store.settings().seenIntro) {
      store.setSetting('seenIntro', true);
      render();
    }
  }
});

fab.addEventListener('click', () => openAdd('out'));

window.addEventListener('scroll', syncScroll, { passive: true });
// A rotation or a keyboard opening changes where the page's end is, and with it
// which of the two scrollers is in charge.
window.addEventListener('resize', syncScroll);

/* -------------------------------------------------------------------- boot */

applyTheme(store.settings().theme);
render({ animate: true });

/*
 * Sync is wired to the store rather than to each call site, so a write added later
 * cannot forget to trigger it. syncSoon debounces and does nothing when there is
 * nothing dirty, which is what stops applying the server's response from scheduling
 * a sync for the sync that just finished.
 */
store.subscribe(() => sync.syncSoon());

// Settings is the only screen that shows sync state, so it is the only one that has
// to be repainted when that state changes. Repainting Home on every status tick
// would restart its entry animation for nothing.
sync.onSyncChange(() => {
  if (tab === 'settings' && !sheet.open) render();
});

/*
 * A sync that brought records down has changed the screen's data underneath the
 * reader, so the screen is repainted. Without this the app pulled a month of
 * entries from the server and went on showing an empty list until the user happened
 * to change tab, which reads as the sync having done nothing.
 *
 * Not animated: this is the same screen catching up, not a new one arriving.
 */
sync.onRemoteChange(() => render());

// Settings shows the address, so it repaints when the account changes. Signing in
// and out both re-render directly too; this covers the third case, a session the
// server has revoked underneath us.
account.onAccountChange(() => {
  if (tab === 'settings' && !sheet.open) render();
});

/*
 * Ask the server who this browser is BEFORE the first sync attempt.
 *
 * The cookie is httpOnly, so the page cannot read it: what is in localStorage is a
 * cached answer that may be a year stale. Syncing on the strength of it would mean a
 * guaranteed 401 on every launch after a session expired, which marks the device
 * signed out and would then need a second pass to recover from.
 *
 * Failing - offline, no server - leaves the cached answer in place, which is the
 * whole point of caching it.
 */
account.refresh().then(() => {
  sync.startSync();
  maybeNudgeSignIn();
});

// The manifest declares an "Add expense" shortcut. Honour it, or it is a menu item
// on the user's home screen that does nothing.
const launch = new URLSearchParams(location.search).get('add');
if (launch === 'out' || launch === 'in') {
  openAdd(launch);
  history.replaceState(null, '', location.pathname);
} else if (!store.settings().seenIntro) {
  // First run. Never over the Add sheet a shortcut just opened.
  openIntro();
}

if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    // updateViaCache 'none' stops the browser serving sw.js itself from its HTTP
    // cache, which it will otherwise do for up to a day and which is how an old
    // worker survives a deploy.
    navigator.serviceWorker.register('sw.js', { updateViaCache: 'none' })
      .then((reg) => reg.update())
      .catch((err) => console.warn('[spendo] service worker did not register:', err.message));
  });

  // A new worker taking over means the page is now half old code and half new. One
  // reload, once, puts it back in one piece.
  let reloading = false;
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (reloading) return;
    reloading = true;
    location.reload();
  });
}
