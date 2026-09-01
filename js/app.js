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

const view = document.getElementById('view');
const fab = document.getElementById('fab');
const sheet = document.getElementById('sheet');
const sheetContent = document.getElementById('sheet-content');
const snack = document.getElementById('snack');

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
    search,
    sliceId
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
    description: ''
  };
  openSheet(ui.addSheet({ ...draft, suggestions: store.recentDescriptions() }));
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
      : `Signed in as ${out.email}. Sending everything up.`);
    sync.signedIn();
  } catch (err) {
    signin = { ...signin, busy: false, error: err.message };
    paintSignIn();
  }
}

async function doSignOut() {
  await account.signOut();
  render();
  showSnack('Signed out. Your transactions stay on this phone.');
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

  showSnack('Saved on this phone only. Not backed up.', 'Sign in', openSignIn);
}

/* ---------------------------------------------------------------- snackbar */

function showSnack(message, actionLabel, onAction) {
  clearTimeout(snackTimer);
  snack.innerHTML = `<span class="snack-text">${message}</span>` +
    (actionLabel ? `<button class="snack-action" type="button" data-action="snack-action">${actionLabel}</button>` : '');
  snack.hidden = false;
  pendingUndo = onAction || null;
  snackTimer = setTimeout(hideSnack, 6000);
}

function hideSnack() {
  clearTimeout(snackTimer);
  snack.hidden = true;
  pendingUndo = null;
}

/* ------------------------------------------------------------ chart tooltip */

function bindChart() {
  const wrap = view.querySelector('[data-chart="daily"]');
  if (!wrap) return;
  const tip = wrap.querySelector('.chart-tip');
  const stats = store.monthStats(ym);

  const show = (day) => {
    const value = stats.perDay[day - 1] || 0;
    const iso = `${ym}-${String(day).padStart(2, '0')}`;
    tip.innerHTML = `<b>${longDate(iso)}</b><span>${value > 0 ? money(value) : 'nothing spent'}</span>`;
    tip.hidden = false;
    const pct = (day - 0.5) / stats.daysInMonth;
    tip.style.left = `${Math.min(88, Math.max(12, pct * 100))}%`;
  };

  wrap.addEventListener('pointermove', (e) => {
    const hit = e.target.closest('.chart-hit');
    if (hit) show(Number(hit.dataset.day));
  });
  wrap.addEventListener('pointerdown', (e) => {
    const hit = e.target.closest('.chart-hit');
    if (hit) show(Number(hit.dataset.day));
  });
  wrap.addEventListener('pointerleave', () => { tip.hidden = true; });
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
  const el = e.target.closest([
    '[data-action]', '[data-tab]', '[data-entry]', '[data-month]',
    '[data-direction]', '[data-category]', '[data-theme]',
    '[data-slice]', '[data-edit-field]', '[data-set-category]',
    '[data-set-direction]', '[data-pick-day]', '[data-set-day]', '[data-cal-step]'
  ].join(', '));
  if (!el) return;

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
  if (el.dataset.month) { ym = el.dataset.month; tab = 'today'; render({ animate: true }); return; }

  // Add sheet, direction and category
  if (el.dataset.direction && draft) {
    captureDraft();
    draft.direction = el.dataset.direction;
    draft.category = defaultCategory(draft.direction);
    openAdd(draft.direction);
    return;
  }
  if (el.dataset.category && draft) {
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
    case 'export-json': exportBackup(); break;
    case 'sync-now': sync.syncNow('manual'); break;
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
        });
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
