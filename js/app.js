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
  currentYM, daysInMonth, longDate, money, monthLabel, plural, shiftYM, todayISO,
  yesterdayISO, ymOf
} from './format.js';
import { categoriesFor, category, defaultCategory } from './categories.js';
import * as account from './identity.js';
import * as ai from './ai.js';
import { guess, remember } from './categorise.js';
import { parseSpoken } from './bulk.js';
import { listen, speechSupported } from './voice.js';
import { workbook } from './xlsx.js';
import { capture, durationOf, enter, glide, narrowTo, playChanges, revealTheme, swapDonut } from './motion.js';

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
// How Home lists the month: 'date', newest first, or 'amount', largest first. Kept for
// the session only (see rememberPlace), so the app always OPENS on the order a ledger
// is read in, and a list sorted last week never greets anyone looking as though
// entries went missing from the top.
let order = 'date';
let sliceId = null;   // the category chosen on Insights, or null
let sliceDir = 'out'; // which side Insights is dividing up: 'out' spent, 'in' received
let day = null;       // Home: the day picked on the daily chart, as YYYY-MM-DD, or null
let dailyChart = null; // the daily chart's pin, so the list can clear it too
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

function applyTheme(theme, { bar = true } = {}) {
  if (theme === 'system') document.documentElement.removeAttribute('data-theme');
  else document.documentElement.setAttribute('data-theme', theme);
  if (bar) paintStatusBar();
}

/*
 * Keep the Android status bar the same colour as the surface behind it. The first
 * value is written by js/boot-theme.js before the page paints, because by the time
 * this module runs the bar has already been drawn; this keeps it right afterwards.
 *
 * Separate from applyTheme because a theme SWITCH must not move the bar at the same
 * moment: the page changes under a growing circle and the bar is outside the page,
 * so a bar that flipped on the tap changed colour half a second before the circle
 * got anywhere near it. The switch hands this to revealTheme() instead, which calls
 * it as the circle reaches the top edge.
 */
function paintStatusBar() {
  const meta = document.querySelector('meta[name="theme-color"]');
  if (!meta) return;
  const bg = getComputedStyle(document.documentElement).getPropertyValue('--bg').trim();
  if (bg) meta.setAttribute('content', bg);
}

/*
 * On "System", the OS flipping to dark at sunset has to move the status bar with it.
 * Nothing else needs doing - the CSS is already listening to the same media query -
 * so this repaints the one thing CSS cannot reach.
 */
matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
  if (store.settings().theme === 'system') applyTheme('system');
});

/*
 * And again every time the window comes back, because the installed app's status bar
 * is not ours alone.
 *
 * Android paints the bar from the manifest's theme_color when the app is launched or
 * resumed from the home screen, and from this meta only while the page is running.
 * One value in a manifest cannot be two themes, so the two disagree by design and the
 * bar came back white over a dark app on a warm launch. Re-asserting on resume hands
 * it back to the page, which is the half that knows which theme is on.
 *
 * It also covers the cold start where Chrome answers prefers-color-scheme before the
 * system value is known: boot-theme.js then wrote the light colour, and nothing after
 * it fired a media-query change to correct the bar.
 */
document.addEventListener('visibilitychange', () => {
  if (!document.hidden) applyTheme(store.settings().theme);
});
window.addEventListener('pageshow', () => applyTheme(store.settings().theme));

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

/*
 * Which screen and month the view last showed. A repaint of the same one is the month
 * changing under the reader - a save, a delete, a sync - and its figures count to
 * their new values. A repaint of a different one is a new screen, which arrives with
 * the entry animation instead and has nothing to count from.
 */
let lastPaint = { tab: null, ym: null };

/*
 * Where the reader is - the tab, the month, the list's order - kept so a reload puts
 * them back there. Pulling down to refresh on Insights used to land on Home, and so
 * did the reload the app does on its own after an update, which is a reload nobody
 * even asked for.
 *
 * sessionStorage, not localStorage: it survives a reload and ends with the app.
 * Opened fresh from the home screen, Spendo still starts on Home, this month, newest
 * first, which is where an app should open.
 */
const PLACE_KEY = 'spendo.place';
const TABS = ['today', 'history', 'insights', 'settings'];

function rememberPlace() {
  try {
    sessionStorage.setItem(PLACE_KEY, JSON.stringify({ tab, ym, order, sliceDir }));
  } catch {
    /* storage refused: a reload starts on Home, as it always did */
  }
}

// Read back, and every field checked on its own: a value this build does not
// recognise is dropped rather than trusted, and the rest still applies.
function restorePlace() {
  let saved = null;
  try {
    saved = JSON.parse(sessionStorage.getItem(PLACE_KEY) || 'null');
  } catch {
    return;
  }
  if (!saved || typeof saved !== 'object') return;
  if (TABS.includes(saved.tab)) tab = saved.tab;
  if (/^\d{4}-\d{2}$/.test(saved.ym) && saved.ym <= currentYM()) ym = saved.ym;
  if (saved.order === 'amount' || saved.order === 'date') order = saved.order;
  if (saved.sliceDir === 'in' || saved.sliceDir === 'out') sliceDir = saved.sliceDir;
}

/*
 * `from` is the side a stepped-to month enters from: 'left' going back in time,
 * 'right' going forward, the way a calendar pages. Without it a new screen fades
 * through. Only meaningful with `animate`; see enter() in js/motion.js.
 */
function render({ animate = false, from = null } = {}) {
  const stats = store.monthStats(ym);
  const ctx = {
    ym,
    stats,
    entries: store.withBalances(ym).reverse(),
    months: monthSummaries(),
    totals: store.categoryTotals(ym, sliceDir),
    carry: tab === 'today' ? carryFrom(ym, stats) : null,
    budgets: tab === 'insights' ? budgetsFor(ym) : null,
    otherTotals: store.categoryTotals(ym, sliceDir === 'out' ? 'in' : 'out'),
    sliceDir,
    theme: store.settings().theme,
    sync: sync.syncStatus(),
    install: installState(),
    search,
    order,
    sliceId,
    // History only. Both of these walk every month in the ledger, and there is no
    // reason to pay for that while looking at Home.
    series: tab === 'history' ? store.monthlySeries(TREND_MONTHS) : [],
    tips: tab === 'history' ? tipsState() : null,
    // Everything on the device, not the month being looked at. Settings is the one
    // screen that is not scoped to a month.
    totalEntries: store.totalEntries(),
    ai: store.aiOn()
  };
  // Ordered here and not in ctx.entries: Insights lists a category's entries from
  // that array too, and a sort chosen on Home should not reach into another screen.
  // A picked day belongs to the month it was picked in. Any of the several routes
  // that change the month leaves it behind rather than filtering a month to a date
  // it does not contain.
  if (day && ymOf(day) !== ym) day = null;
  ctx.day = day ? dayInfo(ctx.entries) : null;
  ctx.listWhere = listWhere();
  ctx.searchResult = runSearch(inOrder(onDay(ctx.entries)), search.query);

  // Whatever was parked open belongs to the DOM that is about to be replaced.
  openTrack = null;

  const same = !animate && lastPaint.tab === tab && lastPaint.ym === ym;
  const before = same ? capture(view) : null;

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
  if (before) playChanges(before, view);
  lastPaint = { tab, ym };
  rememberPlace();
  if (animate) {
    // Restart the animation on a node the browser has already seen.
    void view.offsetWidth;
    // Arriving on a screen means arriving at the top of it. Only on navigation: a
    // save or a delete re-renders too, and throwing the reader back to the top of
    // the month because one row changed loses their place for nothing.
    window.scrollTo(0, 0);
    enter(view, from || 'through');
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

// The timer of a sheet playing out its exit, or null. See closeSheet().
let closing = null;

function openSheet(html) {
  sheetContent.innerHTML = html;
  showSheet();
  const first = sheetContent.querySelector('input:not([type="date"]), button:not(.icon-btn)');
  if (first && first.tagName === 'INPUT') setTimeout(() => first.focus(), 60);
}

/*
 * Open the dialog, or keep it open. A sheet asked for while the last one is still
 * leaving takes the same dialog over rather than waiting for it to go - and must not
 * let it go at all, because closing a dialog queues a close event that would arrive
 * afterwards and empty the new sheet.
 */
function showSheet() {
  if (closing) {
    clearTimeout(closing);
    closing = null;
    sheet.classList.remove('is-closing');
    sheet.inert = false;
  }
  if (!sheet.open) sheet.showModal();
}

/*
 * Close by playing the sheet out: it drops and fades while the backdrop lifts, and
 * only then does the dialog close. It used to vanish in a frame, which is the one
 * moment of the sheet's life nobody was shown.
 *
 * What the sheet holds is let go at the START, not when it is gone. A write-up or a
 * sign-in reply landing during the exit would otherwise repaint, and a sheet
 * repainted by code that still thinks it is wanted is a sheet that comes back. It is
 * inert for the same stretch, so a second tap on Save cannot save twice from a sheet
 * that is already leaving.
 */
function closeSheet() {
  if (!sheet.open) {
    sheetContent.innerHTML = '';
    return;
  }
  if (closing) return;
  const exit = durationOf('--dur-state');
  if (!exit) {
    sheet.close();
    sheetContent.innerHTML = '';
    return;
  }
  letGoOfSheet();
  sheet.inert = true;
  sheet.classList.add('is-closing');
  closing = setTimeout(finishClosing, exit);
}

function finishClosing() {
  clearTimeout(closing);
  closing = null;
  sheet.classList.remove('is-closing');
  sheet.inert = false;
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
  openSheet(ui.addSheet({ ...draft, suggestions: store.descriptionHistory(draft.direction), budget: draftBudget() }));
}

/**
 * Offer the past descriptions that match what has been typed, from the whole history.
 *
 * Only the chip row is rebuilt, never the sheet: re-rendering the sheet replaces the
 * input, which drops focus and closes the keyboard on the second character of every
 * word. The row is a sibling of the input, so replacing its children leaves the caret
 * alone. Ranking lives in `ui.matchDescriptions`, shared with the first paint.
 */
function filterSuggestions(form) {
  const wrap = form.querySelector('[data-suggest]');
  if (!wrap) return;

  const typed = form.elements.description.value;
  const chips = ui.matchDescriptions(store.descriptionHistory(draft ? draft.direction : 'out'), typed);
  const row = wrap.querySelector('.chip-row');
  row.innerHTML = ui.suggestChips(chips);
  wrap.hidden = !chips.length;

  const label = wrap.querySelector('[data-suggest-label]');
  if (label) label.textContent = typed.trim() ? 'Matches' : 'Recent';

  /*
   * Back to the start of the row, because the row is a horizontal scroller and
   * replacing its children does not move it. Left where it was, the best match lands
   * off the left edge and the feature looks broken.
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
  paintBudgetHint();

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
/**
 * Where the draft's category stands against its budget, counting the amount typed.
 * Spending only, and in the month of the draft's date - a backdated expense spends
 * last month's budget, not this one's.
 */
function draftBudget(form = document.getElementById('add-form')) {
  if (!draft || draft.direction !== 'out') return null;
  const typed = form ? Number(form.elements.amount.value) : Number(draft.amount);
  return store.budgetStatus(draft.category, ymOf(draft.date || todayISO()),
    Number.isFinite(typed) && typed > 0 ? typed : 0);
}

/** Repaint the budget line in place - never the sheet, which would drop the keyboard. */
function paintBudgetHint() {
  const form = document.getElementById('add-form');
  const slot = form && form.querySelector('[data-budget-hint]');
  if (!slot) return;
  slot.innerHTML = ui.budgetHint(draftBudget(form), category(draft.category).label);
}

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
  else openSheet(ui.addSheet({ ...draft, suggestions: store.descriptionHistory(draft.direction), budget: draftBudget() }));
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
  showSheet();
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
let tips = { busy: false, error: '', elapsed: 0 };

function tipsState() {
  const held = store.tipsHeld();
  return {
    items: held ? held.items : null,
    ym: held ? held.ym : null,
    madeAt: held ? held.madeAt : null,
    busy: tips.busy,
    error: tips.error,
    elapsed: tips.elapsed,
    // One question, asked in one place. `ai.available()` is what the request itself
    // checks, so a button can never be offered for a call that would be refused.
    possible: ai.available(),
    // Which of the three reasons it is, because "sign in" is useless advice to
    // somebody who is signed in and has simply turned the feature off.
    off: !store.aiOn()
  };
}

/*
 * A wait that says the same thing for thirty seconds reads as a hang.
 *
 * The line is rewritten in place rather than by re-rendering: this card sits inside
 * the History screen, and re-rendering a screen once a second to change three words
 * would restart every entry animation on it.
 */
let tipsTicker = null;

function stopTipsTicker() {
  clearInterval(tipsTicker);
  tipsTicker = null;
}

function startTipsTicker() {
  stopTipsTicker();
  const began = Date.now();
  tipsTicker = setInterval(() => {
    if (!tips.busy) return stopTipsTicker();
    tips.elapsed = Date.now() - began;
    const line = document.querySelector('.tips-card .voice-status [aria-live]');
    if (line) line.textContent = ui.readingCopy(tips.elapsed, { what: 'your last few months', seconds: 30 });
    return undefined;
  }, 1000);
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
  tips.elapsed = 0;
  render();
  startTipsTicker();

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
  stopTipsTicker();
  if (!items) {
    tips.error = 'Could not get suggestions just now. Try again in a moment.';
  } else {
    store.setTips(items);
  }
  render();
}

/* ------------------------------------------------------- several at once */

/*
 * Adding five things one at a time is five sheets, five keyboards and five taps on
 * Save, and the reason people stop logging expenses at all. This is one sentence
 * instead - spoken or typed - read into drafts, checked once, saved together.
 *
 * The whole state of that flow, or null when the sheet is not open:
 *
 *   stage      'ask' | 'listening' | 'reading' | 'review'
 *   text       what is being read - the transcript, or what was typed
 *   heard      the live transcript while listening, revised word by word
 *   rows       the drafts, each with its own checkbox and editable fields
 *   editing    the one row whose category picker is open, or null
 *   elapsed    how long the model has been thinking, so the copy can move
 *   usedModel  whether this phone read it or the server did
 *
 * Nothing here is in the store, and that is the point: a draft is not an entry, and
 * a flow abandoned halfway must leave nothing behind.
 */
let bulk = null;
let bulkTicker = null;
let listener = null;

function paintBulk() {
  if (!bulk) return;
  sheetContent.innerHTML = ui.bulkSheet(bulk);
  showSheet();
}

/*
 * Read the fields back before any repaint that would replace them.
 *
 * The same rule as `captureDraft()` on the add sheet. Amount is kept as the STRING
 * that is in the box rather than a number, so a half-typed "12." survives a repaint
 * instead of being rounded into something the person did not type. It is turned
 * into a number once, at save.
 */
function captureBulk() {
  const form = document.getElementById('bulk-form');
  if (!form || !bulk) return;
  for (const row of bulk.rows) {
    const description = form.elements[`desc-${row.key}`];
    const amount = form.elements[`amt-${row.key}`];
    if (description) row.description = description.value;
    if (amount) row.amount = amount.value;
  }
}

function captureAsk() {
  const form = document.getElementById('bulk-ask-form');
  if (form && bulk) bulk.text = form.elements.text.value;
}

function openBulk() {
  bulk = {
    stage: 'ask',
    text: '',
    heard: '',
    rows: [],
    editing: null,
    error: '',
    elapsed: 0,
    supported: speechSupported(),
    usedModel: false
  };
  paintBulk();
}

function stopBulkTicker() {
  clearInterval(bulkTicker);
  bulkTicker = null;
}

/*
 * The progress line, rewritten in place once a second.
 *
 * In place rather than by repainting the sheet, for the same reason the tips line
 * is: a repaint would restart the skeleton shimmer from its first frame every
 * second, which reads as a stutter rather than as progress.
 */
function startBulkTicker() {
  stopBulkTicker();
  const began = Date.now();
  bulkTicker = setInterval(() => {
    if (!bulk || bulk.stage !== 'reading') return stopBulkTicker();
    bulk.elapsed = Date.now() - began;
    const line = sheetContent.querySelector('.voice-status [aria-live]');
    if (line) line.textContent = ui.readingCopy(bulk.elapsed);
    return undefined;
  }, 1000);
}

/* ------------------------------------------------------------- the microphone */

function startListening() {
  captureAsk();
  bulk.stage = 'listening';
  bulk.heard = '';
  bulk.error = '';
  paintBulk();

  listener = listen({
    onText: (text) => {
      if (!bulk || bulk.stage !== 'listening') return;
      bulk.heard = text;
      // Only the one node. Repainting on every revised word would rebuild the sheet
      // several times a second while somebody is mid-sentence.
      const slot = sheetContent.querySelector('.voice-heard');
      if (slot) slot.textContent = text;
    },
    onEnd: (final) => {
      listener = null;
      finishListening(final);
    },
    onError: (message) => {
      listener = null;
      if (!bulk) return;
      bulk.stage = 'ask';
      bulk.error = message;
      paintBulk();
    }
  });
}

function stopListening() {
  const active = listener;
  listener = null;
  if (active) active.stop();
}

function finishListening(final) {
  // The browser ends a session on its own after a few seconds of silence, whatever
  // `continuous` says, so this can arrive when the sheet has already moved on.
  if (!bulk || bulk.stage !== 'listening') return;

  const text = String(final || bulk.heard || '').trim();
  if (!text) {
    bulk.stage = 'ask';
    bulk.error = 'Nothing was heard. Try again, or type the list.';
    paintBulk();
    return;
  }
  bulk.text = text;
  readText(text);
}

/* --------------------------------------------------------------- reading it */

/**
 * Turn a sentence into drafts, on this phone if it can and on the server if it cannot.
 *
 * The local parser gets first refusal and usually takes it: "200 auto, 150 lunch"
 * is three lines of regex, offline, instant and free. The model is for the sentence
 * that parser honestly cannot read - "two hundred rupees for an auto" - and it is
 * asked only after the cheap layer has said so itself.
 *
 * With the model unavailable, whatever the local pass DID find is still shown. Two
 * entries out of three is a better answer than an error, and the third is one the
 * person can type.
 */
async function readText(text) {
  const local = parseSpoken(text);

  if (local.confident) {
    showReview(local.entries, false);
    return;
  }

  if (!ai.available()) {
    if (local.entries.length) {
      showReview(local.entries, false);
      return;
    }
    bulk.stage = 'ask';
    bulk.error = store.aiOn()
      ? 'This phone could not read that on its own. Try it as a list - 200 auto, 150 lunch.'
      : 'AI is off, so this is read on the phone only. Try it as a list - 200 auto, 150 lunch.';
    paintBulk();
    return;
  }

  bulk.stage = 'reading';
  bulk.elapsed = 0;
  bulk.error = '';
  paintBulk();
  startBulkTicker();

  /*
   * The EXPENSE list is what the model chooses from, even for a row it decides is
   * income. Merging both lists would offer it two categories called the same thing
   * in different directions; an income row's category is fixed up below instead,
   * where the direction is already known.
   */
  const ids = categoriesFor('out').map((c) => c.id);
  const rows = await ai.parseEntries(text, todayISO(), ids);

  stopBulkTicker();
  // The sheet may have been closed, or restarted, while that was in flight.
  if (!bulk || bulk.stage !== 'reading') return;

  if (!rows) {
    bulk.stage = 'ask';
    bulk.error = local.entries.length
      ? 'Only part of that could be read. Check what came back.'
      : 'Could not read that just now. Try again, or type it as a list.';
    if (local.entries.length) showReview(local.entries, false);
    else paintBulk();
    return;
  }

  showReview(rows, true);
}

/*
 * The category for one draft, from whichever layer can answer.
 *
 * `guessed` is carried alongside it and is the reason this is not just a fallback
 * chain: a row that only got a DEFAULT is a row worth spending a model call on
 * afterwards, and a row that got a real answer must not have it overwritten by one
 * that arrives later.
 */
function pickCategory(draftRow) {
  const allowed = categoriesFor(draftRow.direction);
  if (draftRow.category && allowed.some((c) => c.id === draftRow.category)) {
    return { category: draftRow.category, guessed: true };
  }
  const local = guess(draftRow.description, draftRow.direction);
  if (local) return { category: local.category, guessed: true };
  return { category: defaultCategory(draftRow.direction), guessed: false };
}

function showReview(entries, usedModel) {
  stopBulkTicker();
  if (!bulk) return;

  if (!entries || !entries.length) {
    bulk.stage = 'ask';
    bulk.error = 'No expenses in that. Try "200 auto, 150 lunch".';
    paintBulk();
    return;
  }

  bulk.rows = entries.map((e, i) => {
    const picked = pickCategory(e);
    return {
      key: `r${i}`,
      on: true,
      amount: e.amount,
      description: e.description,
      direction: e.direction,
      date: e.date || todayISO(),
      category: picked.category,
      guessed: picked.guessed
    };
  });
  bulk.stage = 'review';
  bulk.usedModel = usedModel;
  bulk.editing = null;
  bulk.error = '';
  paintBulk();
  fillCategories();
}

/**
 * Ask the model about the rows that fell through to a default category.
 *
 * Only those, and only five of them: the rest already have an answer from the
 * person's own history or from the word list, and re-asking about those would spend
 * quota to confirm something already known.
 *
 * The chip is rewritten in place, never by repainting. Somebody is reading this
 * sheet and quite possibly typing in it while these land, and replacing the form
 * under them would drop the caret out of a half-corrected amount - the same trap the
 * add sheet's own guess avoids.
 */
async function fillCategories() {
  if (!ai.available() || !bulk) return;

  const open = bulk;
  const wanted = open.rows.filter((r) => !r.guessed).slice(0, 5);
  if (!wanted.length) return;

  await Promise.all(wanted.map(async (row) => {
    const ids = categoriesFor(row.direction).map((c) => c.id);
    const found = await ai.suggestCategory(row.description, ids);
    // A late answer is dropped, exactly as it is on the add sheet: the sheet may be
    // gone, restarted, or the row may have been given a category by hand since.
    if (!found || bulk !== open || bulk.stage !== 'review' || row.guessed) return;

    row.category = found;
    row.guessed = true;
    remember(row.description, found);

    const chip = sheetContent.querySelector(`[data-action="bulk-category"][data-row="${row.key}"]`);
    if (!chip) return;
    const cat = category(found);
    chip.innerHTML = ui.icon(cat.icon);
    chip.append(` ${cat.label}`);
  }));
}

/* ----------------------------------------------------------------- saving */

function saveBulk() {
  captureBulk();
  const wanted = bulk.rows.filter((r) => r.on);

  if (!wanted.length) return;

  /*
   * Checked here rather than per field, because the failure is a row and not a
   * character. `Number` on the whole string, never a salvage - the same rule the
   * single amount field follows, and for the same reason: "89e" must be refused,
   * not quietly saved as 89.
   */
  const bad = wanted.find((r) => !(Number(String(r.amount).trim()) > 0) || !String(r.description).trim());
  if (bad) {
    bulk.error = 'Every ticked row needs an amount above zero and something it was for.';
    paintBulk();
    return;
  }

  const saved = wanted.map((r) => store.addEntry({
    amount: Number(String(r.amount).trim()),
    description: String(r.description).trim(),
    date: r.date,
    direction: r.direction,
    category: r.category
  }));

  // What was corrected by hand is worth more than what was guessed: it is the
  // person's own answer, and layer 1 of the category guess reads it next time.
  for (const r of wanted) remember(String(r.description).trim(), r.category);

  bulk = null;
  closeSheet();
  // Land on the month the entries went into. They are almost always today's, but a
  // "yesterday" on the 1st puts them in the previous one, and saving into a month
  // the screen is not showing looks exactly like saving nothing.
  ym = saved[saved.length - 1].ym;
  render();

  showSnack(`Added ${plural(saved.length, 'entry', 'entries')}`, 'Undo', () => {
    for (const e of saved) store.removeEntry(e.id);
    render();
  });
}

/* ----------------------------------------------------------------- sign in */

function paintSignIn() {
  sheetContent.innerHTML = ui.signInSheet(signin);
  const input = sheetContent.querySelector('input:not([type="hidden"])');
  if (input) setTimeout(() => input.focus(), 60);
}

function openSignIn() {
  signin = { step: 'email', email: account.lastEmail() || '', error: '', busy: false, sending: false };
  showSheet();
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
    const address = String(out.email || email).trim().toLowerCase();
    const samePerson = Boolean(out.previousEmail) && out.previousEmail === address;

    // Entries no account has confirmed are the person's to decide about, not ours -
    // unless they are signing back in as the very person who wrote them.
    if (!samePerson && store.unsyncedSummary().count > 0) {
      sync.pause(true);
      merge = {
        email: address,
        previousEmail: out.isNewPerson ? out.previousEmail : null,
        // What the phone remembered before this sign-in, for a cancel to put back.
        remembered: out.previousEmail || null
      };
      rememberMerge(merge);
      signin = null;
      openSheet(ui.mergeSheet({ ...merge, ...store.unsyncedSummary() }));
      return;
    }

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

/* ------------------------------------------------- entries with no account */

/*
 * The question asked after signing in when the phone holds entries no account has
 * confirmed (see mergeSheet in ui.js). Sync is paused until it is answered, and the
 * question is written to localStorage, so closing the app half way through asks it
 * again on the next launch rather than letting the first sync answer it.
 *
 * Closing the sheet without choosing cancels the sign-in: it is the one answer that
 * changes nothing, which is what a dismissal should mean.
 */
let merge = null;     // { email, previousEmail } while the question is open
const MERGE_KEY = 'spendo.mergePending';

function rememberMerge(value) {
  try {
    if (value) localStorage.setItem(MERGE_KEY, JSON.stringify(value));
    else localStorage.removeItem(MERGE_KEY);
  } catch { /* storage refused: the question just is not asked again after a restart */ }
}

function pendingMerge() {
  try {
    const v = JSON.parse(localStorage.getItem(MERGE_KEY) || 'null');
    return v && typeof v.email === 'string' ? v : null;
  } catch {
    return null;
  }
}

function settleMerge(choice) {
  const was = merge || pendingMerge();
  merge = null;
  rememberMerge(null);
  if (!was) return;

  let snack = `Signed in as ${was.email}. Adding them to your account.`;
  let undo = null;
  if (choice === 'keep') {
    // Somebody else's opening money is not this account's business; one's own is.
    store.keepUnsyncedOnly({ months: !was.previousEmail });
  } else {
    const saved = store.takeUnsynced();
    store.clearLedger();
    snack = `Discarded ${plural(saved.entries.length, 'entry', 'entries')}. Loading ${was.email}.`;
    undo = () => {
      store.adoptUnsynced(saved);
      render();
      showSnack(`Put back ${plural(saved.entries.length, 'entry', 'entries')}. Adding them to your account.`, null, null, 'cloud-check');
      sync.syncSoon();
    };
  }
  closeSheet();
  render();
  showSnack(snack, undo ? 'Undo' : null, undo, 'cloud-check');
  sync.pause(false);
  sync.signedIn();
}

async function cancelMerge() {
  const was = merge;
  merge = null;
  rememberMerge(null);
  try {
    if (was) account.restoreLastEmail(was.remembered);
    await account.signOut();
  } finally {
    sync.pause(false);
    render();
    showSnack('Sign-in cancelled. Nothing on this phone was changed.', null, null, 'sign-out');
  }
}

async function doSignOut() {
  await account.signOut();
  render();
  showSnack('Signed out. Your transactions stay on this phone.', null, null, 'sign-out');
}

/*
 * Sign out of every device, from this one.
 *
 * Confirmed first, because it is the one control here that reaches other people's
 * phones: doing it by accident means walking to a drawer to find the tablet it also
 * signed out. `confirm` rather than a sheet - this is a yes or no on a destructive
 * thing, which is exactly what the browser's own dialog is for, and a bespoke sheet
 * would be a second thing to get wrong.
 *
 * A failure is SHOWN. Reporting "signed out everywhere" when the request never
 * landed would tell someone their lost phone is locked out while it is still syncing.
 */
function askSignOutEverywhere() {
  openSheet(ui.confirmSheet({
    title: 'Sign out all devices',
    body: 'Every device signed in to this account is signed out, including this one. '
      + 'Your transactions stay on this phone, and each device has to sign in again.',
    confirmLabel: 'Sign out everywhere',
    confirmAction: 'confirm-sign-out-all'
  }));
}

async function doSignOutEverywhere() {
  closeSheet();

  try {
    const out = await account.signOutEverywhere();
    render();
    const n = Number(out?.endedSessions || 0);
    showSnack(n > 1 ? `Signed out on ${n} devices.` : 'Signed out everywhere.', null, null, 'sign-out');
  } catch (err) {
    showSnack(err.message || 'Could not reach the server. Nothing was signed out.',
      null, null, 'warning-circle');
  }
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

/*
 * Six seconds, which is what the CSS countdown and the documentation have both said
 * all along while the code said three. Long enough to notice a row leave and change
 * your mind, short enough that a delete does not feel provisional.
 */
const SNACK_LIFE = 6000;

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
  // The offer is off the screen, so the deletes behind it are final and may sync.
  settleDeletes();
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

  dailyChart = null;
  const daily = view.querySelector('[data-chart="daily"]');
  if (daily) {
    const stats = store.monthStats(ym);
    const isoOf = (n) => `${ym}-${String(n).padStart(2, '0')}`;
    // The daily chart's pin is also the list's filter, so it is sticky: a tap
    // elsewhere on the page - on a row of that very day, say - must not undo it.
    dailyChart = bindPinnableChart(daily, stats.daysInMonth, (n) => {
      const value = stats.perDay[n - 1] || 0;
      return { title: longDate(isoOf(n)), value: value > 0 ? money(value) : 'nothing spent' };
    }, {
      pinned: day ? Number(day.slice(8, 10)) : null,
      onPick: (n) => pickDay(n === null ? null : isoOf(n))
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
function bindPinnableChart(wrap, columns, readout, { pinned: initial = null, onPick = null } = {}) {
  const tip = wrap.querySelector('.chart-tip');
  const svg = wrap.querySelector('svg');
  if (!tip || !svg || columns < 1) return null;

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
    if (pinned === n) clear();
    else {
      pinned = n;
      show(n);
    }
    if (onPick) onPick(pinned);
  });

  if (fine) {
    wrap.addEventListener('pointermove', (e) => {
      if (pinned !== null) return;
      const hit = e.target.closest('.chart-hit');
      if (hit) show(Number(hit.dataset.day));
    });
    wrap.addEventListener('pointerleave', () => { if (pinned === null) tip.hidden = true; });
  }

  if (initial !== null) {
    pinned = initial;
    show(initial);
  }

  // A chart whose pin drives something else keeps it until it is undone on purpose.
  if (!onPick) {
    const dismiss = (e) => { if (pinned !== null && !wrap.contains(e.target)) clear(); };
    document.addEventListener('pointerdown', dismiss);
    chartDismissers.push(dismiss);
  }

  return { clear };
}

/* ------------------------------------------------------------------ delete */

/*
 * One delete path, whether it came from a swipe or from the detail sheet.
 *
 * Deletes BATCH. Swiping is fast enough that three rows go in under six seconds, and
 * three stacked snackbars each with their own countdown is not an offer to undo, it
 * is a pile of things to dismiss. They collapse into one bar - "3 deleted" - with
 * one Undo that puts all three back, and the timer restarts on each so the last one
 * still gets its full six seconds.
 *
 * Nothing reaches the server until that timer runs out. See holdBack in sync.js.
 */
let undoBatch = [];

function deleteEntry(id) {
  const removed = store.removeEntry(id);
  if (!removed) return;

  undoBatch.push({ id, label: removed.description || category(removed.category).label });
  sync.holdBack(undoBatch.map((d) => d.id), SNACK_LIFE + 500);

  render();

  const message = undoBatch.length === 1
    ? `Deleted ${undoBatch[0].label}`
    : `${undoBatch.length} deleted`;

  showSnack(message, 'Undo', undoDeletes, 'trash-simple');
}

/*
 * Put them all back, and let the restored rows arrive with an animation so the list
 * does not simply blink and be different.
 */
function undoDeletes() {
  const batch = undoBatch;
  undoBatch = [];
  if (!batch.length) return;

  for (const { id } of batch) store.restoreEntry(id);
  sync.release(batch.map((d) => d.id));
  render();

  for (const { id } of batch) {
    const track = view.querySelector(`[data-swipe-entry="${CSS.escape(id)}"]`);
    if (track) track.classList.add('is-restored');
  }
}

/*
 * The window closed with no undo taken, so the deletes are real: let them travel.
 *
 * Called when the snackbar goes, however it goes - timed out, replaced by another
 * message, or dismissed - because in every one of those cases the offer is gone from
 * the screen and holding the records back any longer would just be a delay nobody
 * can see.
 */
function settleDeletes() {
  if (!undoBatch.length) return;
  const ids = undoBatch.map((d) => d.id);
  undoBatch = [];
  sync.release(ids);
}

/* ------------------------------------------------------------------- swipe */

/*
 * Swipe a row left to delete it.
 *
 * Three numbers decide everything. Below SLOP the gesture has not started, which is
 * what keeps a tap a tap and a scroll a scroll. Past COMMIT a release deletes. Past
 * THROW it deletes on the spot, because a hard flick is a decision already made and
 * making someone hold on to finish it feels like the app doubting them.
 *
 * Left only. Right is where Android's back gesture lives and that is not a fight
 * worth picking on the edge of the screen.
 */
/*
 * Every decision is made on the RAW distance the finger travelled. Only the drawing
 * uses the damped one.
 *
 * Mixing the two is a bug that has already happened once here: the row rubber-bands
 * past the resting point, so painted travel tops out well short of raw travel, and a
 * threshold compared against the wrong one of the two is unreachable. The gesture is
 * about what the thumb did; the rubber band is only about what the row looks like
 * while it does it.
 */
const SLOP = 14;          // below this it is a tap or a scroll
const OPEN_AT = 46;       // past this a release parks the row open
const COMMIT = 150;       // past this a release deletes outright
const THROW = 210;        // past this it deletes without waiting for a release
const PARK = 104;         // where an opened row rests, and how wide the button is
const MAX_PULL = 190;     // the row itself never travels further than this

let swipe = null;
let openTrack = null;     // the one row currently parked open, if any

/**
 * Rubber band past the point of no return, so the row cannot be dragged off screen.
 *
 * The resistance starts where the row would rest if released - so a swipe feels free
 * up to "open", and heavier from there to "delete". The change in weight is the
 * gesture telling a thumb which of the two it is about to do.
 */
function pull(raw) {
  const distance = Math.min(raw, MAX_PULL);
  return distance <= PARK ? distance : PARK + (distance - PARK) * 0.55;
}

function paintSwipe(track, raw) {
  const painted = pull(raw);
  track.style.setProperty('--swipe-x', `${-painted}px`);
  // Full strength by the time the row would park, so the label is readable at the
  // point where letting go leaves it on screen.
  track.style.setProperty('--swipe-reveal', String(Math.min(1, raw / PARK)));
  const armed = raw >= COMMIT;
  // The point past which letting go deletes is felt as well as seen: one tick, once,
  // on the way in. A thumb is on the row and the eye may not be.
  if (armed && !track.classList.contains('is-armed')) tick();
  track.classList.toggle('is-armed', armed);
}

/*
 * The lightest pulse the phone can give, where the page may use its motor. Android
 * Chrome can; Safari on iOS has no vibration API, so there this does nothing and the
 * row's own change of weight still says it. Ten milliseconds is a detent under the
 * thumb - much longer and it is a phone buzzing in the hand.
 */
function tick() {
  try {
    navigator.vibrate?.(10);
  } catch {
    /* no motor, or not allowed yet - the gesture is still drawn */
  }
}

function endSwipe(track) {
  track.classList.remove('is-dragging', 'is-armed');
  track.style.removeProperty('--swipe-x');
  track.style.removeProperty('--swipe-reveal');
}

/** Rest the row open, with its delete button exposed and tappable. */
function parkSwipe(track) {
  closeOpenSwipe();
  track.classList.remove('is-dragging', 'is-armed');
  track.classList.add('is-open');
  track.style.setProperty('--swipe-x', `-${PARK}px`);
  track.style.setProperty('--swipe-reveal', '1');
  openTrack = track;
}

/**
 * Close whatever is open. Returns whether anything was.
 *
 * The caller needs to know, because the tap that closes a parked row must not also
 * open that row's detail sheet - dismissing something is a complete action on its own.
 */
function closeOpenSwipe() {
  if (!openTrack) return false;
  const track = openTrack;
  openTrack = null;
  track.classList.remove('is-open');
  endSwipe(track);
  return true;
}

view.addEventListener('pointerdown', (e) => {
  // Mouse right-clicks and stylus barrels are not swipes, and a second finger during
  // a swipe is not a second swipe.
  if (e.button !== 0 || swipe) return;
  const track = e.target.closest('[data-swipe]');

  // A press anywhere other than the open row closes it - including on another row,
  // which is what makes swiping down a list feel like one thing rather than a series
  // of little menus left behind.
  if (openTrack && track !== openTrack) closeOpenSwipe();

  if (!track || track.classList.contains('is-removing')) return;
  // The exposed button handles its own taps; dragging the row it belongs to would
  // fight it.
  if (e.target.closest('.row-swipe-action')) return;

  swipe = {
    track,
    id: track.dataset.swipeEntry,
    pointerId: e.pointerId,
    startX: e.clientX,
    startY: e.clientY,
    axis: null,               // undecided until the finger has moved enough to say
    distance: 0
  };
});

view.addEventListener('pointermove', (e) => {
  if (!swipe || e.pointerId !== swipe.pointerId) return;

  const dx = e.clientX - swipe.startX;
  const dy = e.clientY - swipe.startY;

  /*
   * The axis is decided ONCE, on the first movement past the slop, and never
   * revisited. Deciding continuously is what makes a list feel like it is arguing
   * with the thumb: a diagonal drag would flip between scrolling and swiping.
   */
  if (!swipe.axis) {
    if (Math.abs(dx) < SLOP && Math.abs(dy) < SLOP) return;
    if (Math.abs(dy) > Math.abs(dx) || dx > 0) {
      swipe = null;           // vertical, or rightwards: it belongs to the page
      return;
    }
    swipe.axis = 'x';
    swipe.track.classList.add('is-dragging');
    // From here the row follows this pointer even if the finger leaves the row,
    // which it does on any swipe that starts near the bottom edge of one.
    //
    // Guarded, because capture throws if the browser no longer considers the pointer
    // active - a touch that ended between two frames, or a synthetic event. Losing
    // capture makes the drag less forgiving; letting the throw escape would abandon
    // the gesture halfway with the row still translated.
    try {
      swipe.track.setPointerCapture(e.pointerId);
    } catch {
      /* no capture, but the drag still works while the finger is over the row */
    }
  }

  swipe.distance = -dx;
  paintSwipe(swipe.track, swipe.distance);

  if (swipe.distance >= THROW) {
    const { track, id } = swipe;
    swipe = null;
    removeRow(track, id);
  }
});

for (const event of ['pointerup', 'pointercancel']) {
  view.addEventListener(event, (e) => {
    if (!swipe || e.pointerId !== swipe.pointerId) return;
    const { track, id, distance, axis } = swipe;
    swipe = null;

    if (axis !== 'x') return;

    // Three outcomes, and only the longest of them destroys anything.
    if (distance >= COMMIT) removeRow(track, id);
    else if (distance >= OPEN_AT) parkSwipe(track);
    else endSwipe(track);     // springs back on its own transition
  });
}

/*
 * A drag that ends on the row would otherwise also be a click, and the click opens
 * the detail sheet. Captured, so it is stopped before the delegated handler below
 * ever sees it.
 */
view.addEventListener('click', (e) => {
  const track = e.target.closest('[data-swipe]');

  if (track && (track.classList.contains('is-dragging') || track.classList.contains('is-removing'))) {
    e.preventDefault();
    e.stopPropagation();
    return;
  }

  // A tap on the row that is parked open closes it, and does nothing else. Opening
  // the detail sheet from the same tap would mean the way out of the gesture is also
  // a way into a screen nobody asked for.
  if (track && track === openTrack && !e.target.closest('.row-swipe-action')) {
    closeOpenSwipe();
    e.preventDefault();
    e.stopPropagation();
  }
}, true);

/*
 * Scrolling closes it too. A row left hanging open above the fold is a control the
 * reader has forgotten about and will meet again by accident.
 */
window.addEventListener('scroll', () => closeOpenSwipe(), { passive: true });

/**
 * Play the row out, then delete it.
 *
 * The height is pinned to a number first because a height transition needs something
 * to count down from, and `auto` is not a number. The store is not touched until the
 * animation has finished, so a re-render cannot pull the row out from under it.
 */
function removeRow(track, id) {
  if (track === openTrack) openTrack = null;
  track.classList.remove('is-dragging', 'is-armed', 'is-open');
  track.style.height = `${track.offsetHeight}px`;
  void track.offsetHeight;                 // let the browser see that height first
  track.classList.add('is-removing');

  const done = () => {
    track.removeEventListener('transitionend', onEnd);
    clearTimeout(fallback);
    deleteEntry(id);
  };
  const onEnd = (e) => { if (e.propertyName === 'height') done(); };
  track.addEventListener('transitionend', onEnd);
  // transitionend does not fire if the element is hidden mid-animation - a tab
  // change, or reduced motion collapsing the duration. The delete must not depend
  // on an event that may never arrive.
  const fallback = setTimeout(done, 500);
}

/* ------------------------------------------------------------------ search */

/**
 * Keywords and the amount operators the Telegram bot understood. The date operators
 * (`d:21`, `m:2025-05` and the rest) were built and then taken out at the owner's
 * request: a day is picked by tapping its bar in the daily chart, which needs no
 * syntax remembered. See `pickDay`. Anything that is not an operator is a keyword and
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

/**
 * Home's list in the order the reader chose.
 *
 * Largest first puts spending ahead of money received. The button answers "where did
 * my money go", and a salary sitting at the top of that answer is an answer to a
 * different question. Received entries still follow, largest first, rather than
 * dropping out: a sort that hides rows is a filter, and the totals under the list
 * would stop adding up to what is on screen.
 *
 * Ties keep the newest-first order they arrive in, because sort() is stable.
 */
function inOrder(entries) {
  if (order !== 'amount') return entries;
  return entries.slice().sort((a, b) =>
    (a.direction === 'in') - (b.direction === 'in') || b.amount - a.amount);
}

/**
 * Repaint only the rows, the note and the total. A search keystroke keeps the field's
 * focus and caret this way, and a re-sort keeps the rest of the screen still while
 * the rows glide.
 */
function paintList() {
  const rows = document.getElementById('txn-rows');
  const note = document.getElementById('search-note');
  const foot = document.getElementById('txn-foot');
  if (!rows) return;
  // The row parked open belongs to the nodes about to be replaced.
  openTrack = null;
  const all = store.withBalances(ym).reverse();
  const result = runSearch(inOrder(onDay(all)), search.query);
  rows.innerHTML = ui.txnRows(result.entries);
  if (note) note.innerHTML = ui.searchNote(result, listWhere());
  const banner = document.getElementById('day-filter');
  if (banner) banner.innerHTML = ui.dayBanner(day ? dayInfo(all) : null);
  // The total is of what is listed, so it has to move with the list on every
  // keystroke. Leaving it behind would show a month's total under a filtered list.
  if (foot) foot.innerHTML = ui.ledgerFoot(result.entries);
}

/* ----------------------------------------------------------------- budgets */

/** Every spending category's standing against its budget in a month, by id. */
function budgetsFor(month) {
  const out = {};
  for (const c of categoriesFor('out')) {
    const s = store.budgetStatus(c.id, month);
    if (s) out[c.id] = s;
  }
  return out;
}

function openBudget(categoryId) {
  const label = category(categoryId).label;
  const current = store.budgetOf(categoryId);
  openSheet(ui.amountSheet({
    title: `${label} budget`,
    note: `How much you mean to spend on ${label.toLowerCase()} in a month. It applies to every month; set 0 to remove it.`,
    label: 'Each month',
    confirm: current ? 'Change budget' : 'Set budget'
  }));
  const form = document.getElementById('amount-form');
  form.dataset.mode = 'budget';
  form.dataset.category = categoryId;
  if (current) form.elements.amount.value = String(current);
}

/* -------------------------------------------------------------- carry over */

/**
 * What a new month could start with: the previous month's balance, if it had any
 * activity and ended above zero. Null when there is nothing honest to offer - a
 * month already begun, a previous month that was empty, or one that ended in debt.
 */
function carryFrom(month, stats) {
  if (stats.opening !== 0 || stats.count !== 0) return null;
  const from = shiftYM(month, -1);
  const before = store.monthStats(from);
  if (before.count === 0 && before.opening === 0) return null;
  const amount = Math.round(before.balance * 100) / 100;
  return amount > 0 ? { from, amount } : null;
}

function carryOver() {
  const offer = carryFrom(ym, store.monthStats(ym));
  if (!offer) return;
  const month = ym;
  store.setOpening(month, offer.amount);
  render({ animate: true });
  showSnack(`${monthLabel(month)} starts with ${money(offer.amount)} from ${monthLabel(offer.from)}.`, 'Undo', () => {
    store.setOpening(month, 0);
    render();
  }, 'wallet');
}

/* ---------------------------------------------------------------- one day */

/** The month's entries, narrowed to the picked day when there is one. */
function onDay(entries) {
  return day ? entries.filter((e) => e.date === day) : entries;
}

/** Where the list is looking, in words, for the search note. */
function listWhere() {
  return day ? longDate(day) : monthLabel(ym);
}

/** What the banner over a one-day list says: the day, and what moved on it. */
function dayInfo(entries) {
  let spent = 0;
  let received = 0;
  let count = 0;
  for (const e of entries) {
    if (e.date !== day) continue;
    count += 1;
    if (e.direction === 'in') received += e.amount;
    else spent += e.amount;
  }
  return { iso: day, spent, received, count };
}

/**
 * A bar on the daily chart, tapped: the list below becomes that day's list.
 *
 * This replaced the date half of the search grammar. `d:21` had to be known to be
 * used; a bar is already on screen and already says which day it is.
 *
 * The rows are not re-rendered with the screen. Rows leaving fade out first, then the
 * survivors glide up into their new places and any that were not there before rise
 * in - so the reader sees the list narrow to the day rather than being swapped for a
 * different list. The totals under it count to their new values the same way.
 */
function pickDay(next) {
  day = next;
  const rows = document.getElementById('txn-rows');
  const section = rows && rows.closest('.list');
  if (!rows || !section) return;

  openTrack = null;
  const all = store.withBalances(ym).reverse();
  const keep = new Set(runSearch(onDay(all), search.query).entries.map((e) => e.id));
  const key = (node) => node.dataset.swipeEntry;

  narrowTo(rows, (node) => keep.has(key(node)), () => {
    const before = capture(section);
    glide(rows, () => {
      paintList();
      rows.scrollTop = 0;
    }, key);
    playChanges(before, section);
    requestAnimationFrame(syncScroll);
  });

  // The chart sits above the list, so on a phone the list can be entirely below the
  // fold when a bar is tapped - and a filter applied where nobody can see it reads as
  // a tap that did nothing. Only as far as needed to bring the banner into view.
  const banner = document.getElementById('day-filter');
  if (next && banner) {
    const r = banner.getBoundingClientRect();
    if (r.top > window.innerHeight - 120) {
      banner.scrollIntoView({ block: 'center', behavior: durationOf('--dur-move') ? 'smooth' : 'auto' });
    }
  }
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

/**
 * The backup, as a spreadsheet.
 *
 * It used to be `JSON.stringify(store.snapshot())`, which is a faithful copy of the
 * data and no use to the person holding it: nobody opens a year of their own spending
 * in a text editor, and there is nothing in the app that reads one back. A workbook is
 * the same information in the form it actually gets used in - sorted, filtered, summed
 * in a column - and it opens on the phone that produced it.
 *
 * Three sheets, because they answer three different questions: what did I spend on,
 * how did the months compare, and where does it all go.
 */
function exportBackup() {
  const entries = store.snapshotEntries()
    .filter((e) => !e.deletedAt)
    .slice()
    .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : a.createdAt - b.createdAt));

  const transactions = {
    name: 'Transactions',
    columns: [
      { key: 'date', label: 'Date', type: 'date', width: 12 },
      { key: 'month', label: 'Month', width: 10 },
      { key: 'direction', label: 'In or out', width: 11 },
      { key: 'amount', label: 'Amount', type: 'money', width: 12 },
      { key: 'category', label: 'Category', width: 16 },
      { key: 'description', label: 'Description', width: 40 }
    ],
    rows: entries.map((e) => ({
      date: e.date,
      month: e.ym,
      direction: e.direction === 'in' ? 'Received' : 'Paid',
      // Signed, so a column of them sums to the net movement rather than to the
      // total of everything that ever happened.
      amount: e.direction === 'in' ? e.amount : -e.amount,
      category: category(e.category).label,
      description: e.description || ''
    }))
  };

  const months = {
    name: 'Months',
    columns: [
      { key: 'ym', label: 'Month', width: 10 },
      { key: 'opening', label: 'Opening', type: 'money', width: 12 },
      { key: 'received', label: 'Received', type: 'money', width: 12 },
      { key: 'spent', label: 'Spent', type: 'money', width: 12 },
      { key: 'balance', label: 'Left', type: 'money', width: 12 },
      { key: 'count', label: 'Entries', type: 'number', width: 9 },
      { key: 'closed', label: 'Closed', width: 9 }
    ],
    // Oldest first, so the sheet reads the way the year happened.
    rows: store.months().slice().reverse().map((ym) => {
      const stats = store.monthStats(ym);
      return {
        ym,
        opening: stats.opening,
        received: stats.received,
        spent: stats.spent,
        balance: stats.balance,
        count: stats.count,
        closed: stats.closed ? 'Yes' : ''
      };
    })
  };

  // Every month's categories added up, which is the one figure Insights can only show
  // one month at a time.
  const byCategory = new Map();
  for (const e of entries) {
    if (e.direction === 'in') continue;
    byCategory.set(e.category, (byCategory.get(e.category) || 0) + e.amount);
  }
  const totalSpent = [...byCategory.values()].reduce((a, b) => a + b, 0);

  const categories = {
    name: 'By category',
    columns: [
      { key: 'label', label: 'Category', width: 18 },
      { key: 'amount', label: 'Spent', type: 'money', width: 14 },
      { key: 'share', label: 'Share', width: 9 }
    ],
    rows: [...byCategory]
      .sort((a, b) => b[1] - a[1])
      .map(([id, amount]) => ({
        label: category(id).label,
        amount,
        share: totalSpent > 0 ? `${Math.round((amount / totalSpent) * 100)}%` : ''
      }))
  };

  const blob = workbook([transactions, months, categories]);
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `spendo-${todayISO()}.xlsx`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);

  showSnack(`Exported ${plural(entries.length, 'transaction', 'transactions')}.`,
    null, null, 'download-simple');
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
    '[data-suggest-value]', '[data-open-month]', 'button[data-ai]'
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
    openSheet(ui.addSheet({ ...draft, suggestions: store.descriptionHistory(draft.direction), budget: draftBudget() }));
    return;
  }

  if (el.dataset.theme) {
    const theme = el.dataset.theme;
    store.setSetting('theme', theme);
    // Every surface changes colour in the same frame, and a hard cut from light to
    // dark reads as a flash. It spreads out from the button instead. A tap carries its
    // own coordinates; a keyboard press reports 0,0, so that uses the button's centre.
    const box = el.getBoundingClientRect();
    const tapped = e.clientX || e.clientY;
    revealTheme(() => {
      applyTheme(theme, { bar: false });
      render();
    }, {
      x: tapped ? e.clientX : box.left + box.width / 2,
      y: tapped ? e.clientY : box.top + box.height / 2
    }, paintStatusBar);
    return;
  }

  // The one switch behind every model-backed feature. `js/ai.js` reads it before
  // each request, so this writes the setting and nothing else has to be told.
  if (el.dataset.ai) {
    store.setSetting('ai', el.dataset.ai === 'on');
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
      openSheet(ui.addSheet({ ...draft, suggestions: store.descriptionHistory(draft.direction), budget: draftBudget() }));
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

    case 'toggle-sort': {
      order = order === 'amount' ? 'date' : 'amount';
      const on = order === 'amount';
      // The button is flipped in place rather than by a render. A render would
      // replace the rows before glide() could measure where they were.
      el.classList.toggle('is-on', on);
      el.setAttribute('aria-pressed', String(on));
      rememberPlace();
      const rows = document.getElementById('txn-rows');
      glide(rows, () => {
        paintList();
        // Either order is read from its top, so that is where the list goes back to.
        if (rows) rows.scrollTop = 0;
      }, (node) => node.dataset.swipeEntry);
      break;
    }

    case 'search-all': searchAllMonths(); break;
    case 'clear-day':
      if (dailyChart) dailyChart.clear();
      pickDay(null);
      break;
    // Insights: spent or received. From the switch above the donut, or a tap on its
    // centre, which flips to the other side.
    case 'slice-dir': {
      const next = el.dataset.dir || (sliceDir === 'out' ? 'in' : 'out');
      if (next === sliceDir) break;
      sliceDir = next;
      sliceId = null;
      render();
      swapDonut(view, next);
      break;
    }
    case 'prev-month': ym = shiftYM(ym, -1); sliceId = null; render({ animate: true, from: 'left' }); break;
    case 'next-month':
      if (ym < currentYM()) { ym = shiftYM(ym, 1); sliceId = null; render({ animate: true, from: 'right' }); }
      break;
    case 'swipe-delete': {
      // The row is parked open, so it is already sitting where the exit animation
      // starts. Play it out from there rather than having it jump back first.
      const track = el.closest('[data-swipe]');
      closeOpenSwipe();
      if (track) removeRow(track, el.dataset.entry);
      else deleteEntry(el.dataset.entry);
      break;
    }
    case 'open-bulk':
      /*
       * The half-typed add sheet is read back before it is replaced.
       *
       * Closing the bulk sheet closes the dialog rather than stepping back to the
       * add sheet - it is one way in, not a stack - but `draft` survives in memory,
       * so the next tap on Add reopens what was typed instead of an empty form.
       */
      if (document.getElementById('add-form')) captureDraft();
      openBulk();
      break;
    case 'voice-start': startListening(); break;
    case 'voice-stop': stopListening(); break;
    case 'bulk-restart':
      bulk.stage = 'ask';
      bulk.rows = [];
      bulk.error = '';
      bulk.editing = null;
      paintBulk();
      break;
    case 'bulk-toggle': {
      const row = bulk.rows.find((r) => r.key === el.dataset.row);
      if (!row) break;
      captureBulk();
      row.on = !row.on;
      paintBulk();
      break;
    }
    case 'bulk-direction': {
      const row = bulk.rows.find((r) => r.key === el.dataset.row);
      if (!row) break;
      captureBulk();
      row.direction = row.direction === 'in' ? 'out' : 'in';
      // An expense category means nothing on an income row, so the category moves
      // with the direction rather than staying behind mislabelled. Same rule as the
      // detail sheet.
      if (!categoriesFor(row.direction).some((c) => c.id === row.category)) {
        row.category = defaultCategory(row.direction);
        row.guessed = false;
      }
      paintBulk();
      break;
    }
    case 'bulk-category': {
      captureBulk();
      // One picker open at a time: thirteen chips per row, times five rows, is a
      // sheet nobody can read.
      bulk.editing = bulk.editing === el.dataset.row ? null : el.dataset.row;
      paintBulk();
      break;
    }
    case 'bulk-set-category': {
      const row = bulk.rows.find((r) => r.key === el.dataset.row);
      if (!row) break;
      captureBulk();
      row.category = el.dataset.cat;
      // Chosen by hand, so no late answer from the model may move it.
      row.guessed = true;
      bulk.editing = null;
      paintBulk();
      break;
    }

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
    case 'merge-keep': settleMerge('keep'); break;
    case 'merge-discard': settleMerge('discard'); break;
    case 'sign-out': doSignOut(); break;
    case 'sign-out-all': askSignOutEverywhere(); break;
    case 'confirm-sign-out-all': doSignOutEverywhere(); break;
    case 'signin-back':
      signin = { ...signin, step: 'email', error: '', busy: false, sending: false };
      paintSignIn();
      break;
    case 'signin-resend': sendCode(signin.email, { resend: true }); break;

    case 'delete-entry':
      closeSheet();
      deleteEntry(el.dataset.entry);
      break;

    case 'snack-action':
      if (pendingUndo) pendingUndo();
      hideSnack();
      break;

    case 'carry-over': carryOver(); break;
    case 'set-budget': openBudget(el.dataset.budgetCat); break;

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
    paintList();
    return;
  }

  // By class, not by name. The review sheet has one amount field per row, each
  // named for its row, and a check on the name alone let junk through in every
  // one of them.
  if (el.classList.contains('input-amount')) filterAmountInput(el);
  if (el.name === 'amount' && el.form && el.form.id === 'add-form') paintBudgetHint();

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

  if (form.id === 'bulk-ask-form') {
    const text = form.elements.text.value.trim();
    if (!text) {
      form.elements.text.focus();
      return;
    }
    bulk.text = text;
    readText(text);
    return;
  }

  if (form.id === 'bulk-form') {
    saveBulk();
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
    if (form.dataset.mode === 'budget') {
      const id = form.dataset.category;
      store.setBudget(id, amount);
      closeSheet();
      render();
      showSnack(amount > 0
        ? `${category(id).label} budget set to ${money(amount)} a month.`
        : `${category(id).label} budget removed.`, null, null, 'check-bold');
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

/*
 * Escape, and the back gesture on Android, ask the dialog to cancel. That plays out
 * the same way a tap on the backdrop does. Where the browser will not let the cancel
 * be prevented, it closes the dialog itself and the close event below still tidies.
 */
sheet.addEventListener('cancel', (e) => {
  e.preventDefault();
  closeSheet();
});

sheet.addEventListener('close', () => {
  sheetContent.innerHTML = '';
  letGoOfSheet();
});

/*
 * What a sheet holds that must not outlive it. Called when a close begins, and again
 * when the dialog has actually closed; everything in here is safe to do twice.
 */
function letGoOfSheet() {
  signin = null;
  // Dismissed without an answer. The answers clear `merge` before they close.
  if (merge) cancelMerge();
  reviewYM = null;
  /*
   * Dropped BEFORE the recogniser is stopped, not after.
   *
   * stop() delivers a final transcript through the same path a natural end does, and
   * that path reads the flow onwards into the review sheet. Clearing the state first
   * is what makes the late callback a no-op instead of reopening a sheet the person
   * has just closed.
   */
  bulk = null;
  stopBulkTicker();
  stopListening();
  if (introStep !== null) {
    introStep = null;
    if (!store.settings().seenIntro) {
      store.setSetting('seenIntro', true);
      render();
    }
  }
}

fab.addEventListener('click', () => openAdd('out'));

window.addEventListener('scroll', syncScroll, { passive: true });
// A rotation or a keyboard opening changes where the page's end is, and with it
// which of the two scrollers is in charge.
window.addEventListener('resize', syncScroll);

/* -------------------------------------------------------------------- boot */

applyTheme(store.settings().theme);

// The manifest declares an "Add expense" shortcut, read here and honoured below.
const launch = new URLSearchParams(location.search).get('add');
const addLaunch = launch === 'out' || launch === 'in';

restorePlace();
// Adding belongs to Home, where the new row will show. A shortcut launch lands there
// whatever screen the last session was on.
if (addLaunch) tab = 'today';
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
  // A sign-in left half way through its question - the app closed on the sheet.
  // Ask again, still paused, rather than let the first sync answer it.
  const asked = pendingMerge();
  if (asked && account.isSignedIn() && store.unsyncedSummary().count > 0) {
    sync.pause(true);
    merge = asked;
    openSheet(ui.mergeSheet({ ...asked, ...store.unsyncedSummary() }));
  } else if (asked) {
    rememberMerge(null);
  }
  sync.startSync();
  maybeNudgeSignIn();
});

// The "Add expense" shortcut. Honour it, or it is a menu item on the user's home
// screen that does nothing.
if (addLaunch) {
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
