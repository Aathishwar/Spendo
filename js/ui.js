/**
 * Spendo - rendering
 *
 * Every function here returns an HTML string and touches no state. app.js owns the
 * events and the store; this file owns what things look like. Keeping the split
 * strict is what lets a screen be re-rendered wholesale on any change without
 * hunting for the one node that needs updating.
 */

import {
  WEEKDAYS, daysInMonth, firstWeekdayOf, friendlyDate, longDate, money, monthLabel,
  monthLabelShort, monthShortOf, plural, signedMoney, timeAgo, todayISO, yesterdayISO
} from './format.js';
import { category, categoriesFor, seriesVar } from './categories.js';
import { dailyBarsSVG, donutSVG, monthlyBarsSVG, rowBarSVG } from './charts.js';

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => (
  { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
));

/**
 * A raster glyph, masked so it takes currentColor like everything else. Used only
 * where a specific drawing was asked for by name; the sprite is still the default.
 */
export function imgIcon(name) {
  return `<span class="icon-img icon-${name}" aria-hidden="true"></span>`;
}

/** Phosphor, from the vendored sprite. Never an inline path written by hand. */
export function icon(name, cls = '') {
  return `<svg class="icon ${cls}" aria-hidden="true" focusable="false"><use href="#i-${name}"></use></svg>`;
}

/* --------------------------------------------------------------- fragments */

/** The month stepper. Shared by Home and Insights so both behave identically. */
function monthSwitcher(ym) {
  return `
    <div class="month-switch">
      <button class="icon-btn" data-action="prev-month" type="button" aria-label="Previous month">${icon('caret-left')}</button>
      <h1 class="screen-title">${esc(monthLabel(ym))}</h1>
      <button class="icon-btn" data-action="next-month" type="button" aria-label="Next month">${icon('caret-right')}</button>
    </div>`;
}

function figure(label, value, note) {
  return `
    <div class="figure">
      <p class="stat-label">${esc(label)}</p>
      <p class="stat-value money">${esc(value)}</p>
      ${note ? `<p class="stat-note">${esc(note)}</p>` : ''}
    </div>`;
}

/**
 * One line of the ledger.
 *
 * The direction used to be spelled out on every row, "you paid" over the figure,
 * twenty-four times down the screen. It was there so colour would not be the only
 * channel carrying the meaning. The sign does that job instead, in a quarter of the
 * space and without repeating a phrase the reader learned on row one; the words
 * stay for screen readers, where repetition costs nothing and is the only channel
 * there is.
 */
/**
 * `showCategory: false` drops the second line.
 *
 * Inside an expanded category every row would otherwise repeat the name of the
 * category it is filed under, which is the one thing the reader already knows.
 */
export function entryRow(e, { showCategory = true } = {}) {
  const cat = category(e.category);
  const income = e.direction === 'in';
  const tone = income ? 'is-in' : 'is-out';
  return `
    <button class="row" data-entry="${esc(e.id)}" type="button">
      <span class="row-date">
        <span class="row-date-mon">${esc(monthShortOf(e.date))}</span>
        <span class="row-date-day">${esc(e.date.slice(8, 10))}</span>
      </span>
      <span class="row-tile" style="--tile-hue:${seriesVar(e.category)}">${icon(cat.icon)}</span>
      <span class="row-main">
        <span class="row-title">${esc(e.description || cat.label)}</span>
        ${showCategory ? `<span class="row-sub">${esc(cat.label)}</span>` : ''}
      </span>
      <span class="row-end">
        <span class="sr-only">${income ? 'you received' : 'you paid'}</span>
        <span class="row-amount money ${tone}">${esc(signedMoney(e.amount, e.direction))}</span>
      </span>
    </button>`;
}

/** A list section header: the section's mark, its name, and an optional control. */
function listHead(iconName, title, action) {
  const mark = iconName.startsWith('img:') ? imgIcon(iconName.slice(4)) : icon(iconName);
  return `
    <div class="list-head">
      <span class="list-head-icon">${mark}</span>
      <h2 class="section-title">${esc(title)}</h2>
      ${action ? `
        <button class="list-head-btn ${action.on ? 'is-on' : ''}" data-action="${esc(action.id)}"
          type="button" aria-label="${esc(action.label)}" aria-expanded="${Boolean(action.on)}">
          ${icon(action.icon)}
        </button>` : ''}
    </div>`;
}

/**
 * The search field, opened in place under the section header rather than in a sheet.
 * A sheet would cover the very list the query is filtering; here the results move
 * under the field as the user types.
 */
function searchField(query) {
  return `
    <div class="search-inline">
      <input class="input search-input" id="search-inline" type="search" autocomplete="off"
        placeholder="Search transactions" value="${esc(query)}" aria-label="Search transactions">
      <span class="search-inline-icon">${icon('magnifying-glass')}</span>
    </div>`;
}

/**
 * The ledger's bottom line: what came in and what went out across the rows above.
 *
 * It lives in the band the Add button floats in, which was otherwise 84px of empty
 * ground with a 56px button in the corner of it. A ledger has a total at the foot;
 * this is that, and it is the one reading Home did not already have - the hero gives
 * a balance and a share of the pot, the figures give averages and a count, but money
 * in against money out for the month appeared nowhere.
 *
 * It sums the rows actually listed, so a filtered list gets the filtered totals. A
 * month total under a search result would be a total of things not on screen.
 */
/** Nothing has no direction, so zero gets no sign and no colour: "-0" is not a total. */
function figureOf(amount, direction) {
  return amount === 0 ? money(0) : signedMoney(amount, direction);
}

export function ledgerFoot(entries) {
  let received = 0;
  let spent = 0;
  for (const e of entries) {
    if (e.direction === 'in') received += e.amount;
    else spent += e.amount;
  }
  return `
    <div class="ledger-foot">
      <div class="ledger-foot-cell">
        <span class="ledger-foot-label">Money in</span>
        <span class="ledger-foot-value money ${received ? 'is-in' : ''}">${esc(figureOf(received, 'in'))}</span>
      </div>
      <div class="ledger-foot-cell">
        <span class="ledger-foot-label">Money out</span>
        <span class="ledger-foot-value money ${spent ? 'is-out' : ''}">${esc(figureOf(spent, 'out'))}</span>
      </div>
    </div>`;
}

/** Just the rows, so a keystroke can replace them without disturbing the input. */
export function txnRows(entries, options) {
  return entries.map((e) => entryRow(e, options)).join('');
}

/** The line under the field that reports what the query matched. */
export function searchNote(result, monthName) {
  if (!result.query) return '';
  if (result.entries.length) {
    return `<p class="search-note">${result.entries.length} in ${esc(monthName)}
      <span class="dot-sep"></span> ${esc(money(result.spent))} spent</p>`;
  }
  if (result.elsewhere > 0) {
    return `<p class="search-note">Nothing in ${esc(monthName)}.
      <button class="link-btn" data-action="search-all" type="button">
        ${result.elsewhere} match${result.elsewhere === 1 ? '' : 'es'} in other months</button></p>`;
  }
  return `<p class="search-note">No transaction matches that.</p>`;
}

function emptyState(title, body, actionLabel, actionId) {
  return `
    <div class="empty">
      <p class="empty-title">${esc(title)}</p>
      <p class="empty-body">${esc(body)}</p>
      ${actionLabel ? `<button class="btn btn-primary" data-action="${esc(actionId)}" type="button">${esc(actionLabel)}</button>` : ''}
    </div>`;
}

/** The relief the light-mode palette owes: the same numbers, readable as text. */
function chartTable(stats) {
  const rows = stats.perDay
    .map((v, i) => ({ day: i + 1, v }))
    .filter((d) => d.v > 0)
    .map((d) => `<tr><th scope="row">${d.day}</th><td class="money">${esc(money(d.v))}</td></tr>`)
    .join('');
  if (!rows) return '';
  return `
    <details class="table-toggle">
      <summary>Show as table</summary>
      <table class="data-table">
        <caption class="sr-only">Spending per day in ${esc(monthLabel(stats.ym))}</caption>
        <thead><tr><th scope="col">Day</th><th scope="col">Spent</th></tr></thead>
        <tbody>${rows}</tbody>
      </table>
    </details>`;
}

/* ----------------------------------------------------------------- screens */

export function screenToday(ctx) {
  const { ym, stats, entries } = ctx;

  const head = `<header class="topbar">${monthSwitcher(ym)}</header>`;

  if (stats.opening === 0 && stats.count === 0) {
    return head + emptyState(
      `Nothing tracked in ${monthLabel(ym)} yet.`,
      'Set what you started the month with, then add expenses as they happen.',
      'Set opening money',
      'set-opening'
    );
  }

  // A single ratio against a limit, so: a meter, not a chart. How much of the money
  // that came in this month has gone back out.
  const pot = stats.opening + stats.received;
  const used = pot > 0 ? Math.min(1, stats.spent / pot) : 0;

  const balanceCard = `
    <section class="card hero-card">
      <p class="hero-label">Balance left</p>
      <p class="hero-figure money">${esc(money(stats.balance))}</p>
      <div class="meter" role="img"
        aria-label="${esc(money(stats.spent))} of ${esc(money(pot))} used, ${Math.round(used * 100)} percent">
        <span class="meter-fill" style="width:${(used * 100).toFixed(1)}%"></span>
      </div>
      <p class="hero-note">
        <span class="money">${esc(money(stats.spent))}</span> of
        <span class="money">${esc(money(pot))}</span> used
        ${stats.isCurrent ? `<span class="dot-sep"></span> ${esc(plural(stats.daysLeft, 'day', 'days'))} left` : ''}
      </p>
    </section>`;

  const chartCard = stats.spent > 0 ? `
    <section class="card chart-card">
      <div class="card-head">
        <h2 class="card-title">Spending per day</h2>
        <span class="card-hint">${esc(money(Math.round(stats.budgetPerDay)))} a day keeps you even</span>
      </div>
      <div class="chart-wrap" data-chart="daily">
        ${dailyBarsSVG(stats)}
        <div class="chart-tip" hidden></div>
      </div>
      ${chartTable(stats)}
    </section>` : '';

  const figures = `
    <div class="figures">
      ${figure('Avg per day', money(Math.round(stats.avgPerDay)), `over ${plural(stats.dayNow, 'day', 'days')}`)}
      ${stats.isCurrent
        ? figure('Safe per day', money(Math.round(stats.safePerDay)), `${plural(stats.daysLeft, 'day', 'days')} left`)
        : figure('Received', money(stats.received), 'this month')}
      ${figure('Entries', String(stats.count), stats.isCurrent ? 'so far' : 'in total')}
    </div>`;

  const search = ctx.search || { open: false, query: '' };
  const shown = ctx.searchResult ? ctx.searchResult.entries : entries;

  // list-scroll turns the section into a window over the month rather than a run of
  // rows down the page. See the rule of that name in app.css for the geometry.
  const list = entries.length
    ? `<section class="list list-scroll">
        ${listHead('img:bill', 'Transactions', {
          id: 'toggle-search',
          icon: 'magnifying-glass',
          label: search.open ? 'Close search' : 'Search transactions',
          on: search.open
        })}
        ${search.open ? searchField(search.query) : ''}
        ${search.open ? `<div id="search-note">${searchNote(ctx.searchResult, monthLabel(ym))}</div>` : ''}
        <div class="group-rows" id="txn-rows">${txnRows(shown)}</div>
        <div id="txn-foot">${ledgerFoot(shown)}</div>
      </section>`
    : emptyState(
      `No entries in ${monthLabel(ym)} yet.`,
      'Add the first one and the chart above starts filling in.',
      'Add expense',
      'open-add'
    );

  return head + balanceCard + chartCard + figures + list;
}

export function screenHistory(ctx) {
  const head = `
    <header class="topbar">
      <h1 class="screen-title">History</h1>
    </header>`;

  if (!ctx.months.length) {
    return head + emptyState('No months yet.', 'Months appear here once they have an opening balance or an entry.');
  }

  const rows = ctx.months.map((m) => {
    const pot = m.spent + Math.max(0, m.balance);
    const used = pot > 0 ? Math.min(1, m.spent / pot) : 0;
    return `
    <button class="row row-month" data-month="${esc(m.ym)}" type="button">
      <span class="row-tile" style="--tile-hue:var(--brand)">${icon('calendar-blank')}</span>
      <span class="row-main">
        <span class="row-title">${esc(monthLabel(m.ym))}</span>
        <span class="row-sub">${esc(plural(m.count, 'entry', 'entries'))}${m.closed ? ' · closed' : ''}</span>
        <span class="meter meter-sm"><span class="meter-fill" style="width:${(used * 100).toFixed(1)}%"></span></span>
      </span>
      <span class="row-end">
        <span class="row-amount money is-out">${esc(money(m.spent))}</span>
        <span class="row-sub">left ${esc(money(m.balance))}</span>
      </span>
    </button>`;
  }).join('');

  return head + trendCard(ctx.series) + tipsCard(ctx.tips) +
    `<section class="list">
      ${listHead('calendar-dots', 'Months')}
      <div class="group-rows">${rows}</div>
    </section>`;
}

/*
 * Spending month by month, above the list it belongs to.
 *
 * The list already gives every month its own total; what it cannot do is show the
 * shape of them together. Two months of data is the point at which a chart says
 * anything at all, so below that this is left out rather than drawn as a single
 * column with an average line through the top of it.
 */
function trendCard(series) {
  const months = (series || []).filter((m) => m.spent > 0);
  if (months.length < 2) return '';

  const spends = months.map((m) => m.spent);
  const average = spends.reduce((a, b) => a + b, 0) / spends.length;

  return `
    <section class="card chart-card">
      <div class="card-head">
        <h2 class="card-title">Spending over time</h2>
        <span class="card-hint">${esc(money(Math.round(average)))} a month on average</span>
      </div>
      <div class="chart-wrap" data-chart="monthly">
        ${monthlyBarsSVG(series)}
        <div class="chart-tip" hidden></div>
      </div>
      ${monthTable(series)}
    </section>`;
}

/** The same relief the daily chart offers: the figures as text, for anyone the chart fails. */
function monthTable(series) {
  const rows = series
    .filter((m) => m.spent > 0)
    .map((m) => `<tr><th scope="row">${esc(monthLabelShort(m.ym))}</th><td class="money">${esc(money(m.spent))}</td></tr>`)
    .join('');
  if (!rows) return '';
  return `
    <details class="table-toggle">
      <summary>Show as table</summary>
      <table class="data-table">
        <caption class="sr-only">Spending per month</caption>
        <thead><tr><th scope="col">Month</th><th scope="col">Spent</th></tr></thead>
        <tbody>${rows}</tbody>
      </table>
    </details>`;
}

/*
 * Three suggestions, asked for rather than pushed.
 *
 * It is a button and not something that runs on load, for two reasons. Advice nobody
 * asked for is nagging, and this is the one screen where a person is already looking
 * at what they spent - so the moment they want it is a moment they can choose. It
 * also costs a model call, and a call made on every visit to a tab is a quota spent
 * on people who were only passing through.
 *
 * The figures behind it are on the device and are already on this screen. What the
 * model adds is the sentence, and if it cannot be reached the screen loses nothing
 * it had before.
 */
function tipsCard(tips) {
  const t = tips || {};

  const body = () => {
    if (t.busy) {
      return `<p class="card-note">Reading your last few months...</p>`;
    }
    if (t.items && t.items.length) {
      return `
        <ol class="tips-list">
          ${t.items.map((item) => `
            <li class="tip">
              <p class="tip-title">${esc(item.title)}</p>
              <p class="tip-detail">${esc(item.detail)}</p>
            </li>`).join('')}
        </ol>
        <div class="btn-row">
          <button class="btn btn-text" data-action="get-tips" type="button">Suggest again</button>
        </div>`;
    }
    if (!t.possible) {
      return `<p class="card-note">Sign in to have your last few months read and three changes suggested.</p>`;
    }
    return `
      <p class="card-note">${t.error
        ? esc(t.error)
        : 'Your monthly totals and category splits are read, and three specific changes come back. No description ever leaves the device.'}</p>
      <div class="btn-row">
        <button class="btn btn-primary" data-action="get-tips" type="button">Suggest where to cut</button>
      </div>`;
  };

  return `
    <section class="card tips-card">
      <div class="card-head">
        <h2 class="card-title">Where to cut</h2>
        ${t.items && t.items.length && t.ym ? `<span class="card-hint">from ${esc(monthLabelShort(t.ym))} and before</span>` : ''}
      </div>
      ${body()}
    </section>`;
}

export function screenInsights(ctx) {
  const { ym, stats, totals } = ctx;
  const selected = ctx.sliceId || null;

  const head = `<header class="topbar">${monthSwitcher(ym)}</header>`;

  if (!totals.length) {
    return head + emptyState(
      `Nothing spent in ${monthLabel(ym)}.`,
      'Categories and their shares appear once there are expenses to divide up.'
    );
  }

  const chosen = selected ? totals.find((t) => t.id === selected) : null;

  // The hole is the only part of a donut with room for a number, so it holds the
  // one the reader came for: the total, or the slice they just tapped.
  const centre = chosen
    ? `<p class="donut-centre-label">${esc(category(chosen.id).label)}</p>
       <p class="donut-centre-figure money">${esc(money(chosen.amount))}</p>
       <p class="donut-centre-sub">${(chosen.share * 100).toFixed(chosen.share < 0.1 ? 1 : 0)}% of spending</p>`
    : `<p class="donut-centre-label">Spent</p>
       <p class="donut-centre-figure money">${esc(money(stats.spent))}</p>
       <p class="donut-centre-sub">${esc(plural(totals.length, 'category', 'categories'))}</p>`;

  const list = totals.map((t) => {
    const cat = category(t.id);
    const on = selected === t.id;
    return `
      <button class="cat-row ${on ? 'is-chosen' : ''}${selected && !on ? ' is-dimmed' : ''}"
        data-slice="${esc(t.id)}" type="button" aria-pressed="${on}" aria-expanded="${on}">
        <span class="cat-dot" style="background:${seriesVar(t.id)}"></span>
        <span class="cat-main">
          <span class="cat-title">${esc(cat.label)}</span>
          ${rowBarSVG(t.share, t.id)}
        </span>
        <span class="cat-end">
          <span class="row-amount money">${esc(money(t.amount))}</span>
          <span class="row-sub">${(t.share * 100).toFixed(t.share < 0.1 ? 1 : 0)}%</span>
        </span>
        ${icon(on ? 'caret-up' : 'caret-down', 'cat-caret')}
      </button>
      ${on ? `<div class="cat-expand">${txnRows(
        ctx.entries.filter((e) => e.category === t.id && e.direction === 'out'),
        { showCategory: false }
      )}</div>` : ''}`;
  }).join('');

  return head + `
    <section class="card donut-card">
      <div class="donut-wrap">
        ${donutSVG(totals, selected)}
        <div class="donut-centre">${centre}</div>
      </div>
      <p class="card-hint donut-hint">${selected
        ? 'Tap the row again to close it'
        : 'Tap a slice or a row to see what is in it'}</p>
    </section>

    <section class="list">
      ${listHead('chart-pie', 'By category')}
      <div class="group-rows">${list}</div>
    </section>`;
}

/**
 * What sync is doing, in words rather than an icon.
 *
 * This is the only place a sync problem is ever reported. Nothing about saving an
 * expense blocks on the network, so a failure is not an interruption - it is a fact
 * to come and look at, and the number that matters is how many entries are still
 * only on this phone.
 */
/*
 * Signed out is shown as a state, not as a problem.
 *
 * The pending count is still worth showing while signed out - it is how much would
 * go up on signing in - but phrased as a backlog rather than a failure, because
 * nothing is failing.
 */
function syncRows(sync) {
  if (!sync) return '';

  if (!sync.signedIn) {
    // Kept to two or three words: this column is narrow on a phone, and a sentence
    // here is a sentence with an ellipsis through the middle of it.
    const waiting = sync.pendingEntries > 0
      ? plural(sync.pendingEntries, 'transaction', 'transactions')
      : 'Nothing yet';
    return `
      <div class="field-rows">
        <div class="field-row">
          <span class="field-row-label">Account</span>
          <span class="field-row-value is-warn">Not signed in</span>
        </div>
        <div class="field-row">
          <span class="field-row-label">Waiting to back up</span>
          <span class="field-row-value">${esc(waiting)}</span>
        </div>
        <div class="field-row field-row-actions">
          <button class="btn btn-primary btn-sm" data-action="sign-in" type="button">
            ${icon('cloud-check')} Sign in
          </button>
        </div>
      </div>`;
  }

  const line = () => {
    if (!sync.online) return 'Offline. Everything is saved on this phone.';
    if (sync.status === 'syncing') return 'Syncing now';
    if (sync.status === 'error') return sync.error || 'Could not reach the server';
    if (sync.rejected > 0 && sync.pending === sync.rejected) {
      return `${plural(sync.rejected, 'change', 'changes')} the server would not accept`;
    }
    if (sync.pending > 0) return `${plural(sync.pending, 'change', 'changes')} waiting to send`;
    return 'Everything is synced';
  };

  const tone = !sync.online || sync.status === 'error'
    ? 'is-warn'
    : sync.pending > 0 ? '' : 'is-ok';

  return `
    <div class="field-rows">
      <div class="field-row">
        <span class="field-row-label">Signed in as</span>
        <span class="field-row-value">${esc(sync.email || '')}</span>
      </div>
      <div class="field-row">
        <span class="field-row-label">Status</span>
        <span class="field-row-value ${tone}">${esc(line())}</span>
      </div>
      <div class="field-row">
        <span class="field-row-label">Last sync</span>
        <span class="field-row-value">${esc(timeAgo(sync.lastSyncedAt))}</span>
      </div>
      <div class="field-row">
        <span class="field-row-label">Account</span>
        <span class="field-row-value mono-id">${esc((sync.accountId || '').slice(0, 8))}</span>
      </div>
      <div class="field-row field-row-actions">
        <button class="btn btn-text btn-sm" data-action="sync-now" type="button"
          ${sync.status === 'syncing' ? 'disabled' : ''}>
          ${icon('cloud-check')} Sync now
        </button>
        <button class="btn btn-text btn-sm" data-action="sign-out" type="button">Sign out</button>
      </div>
      <div class="field-row field-row-actions">
        <button class="btn btn-danger btn-sm" data-action="sign-out-all" type="button">
          ${icon('sign-out')} Sign out all devices
        </button>
      </div>
      <p class="card-note">
        Signing out leaves your transactions on this phone. Signing out of all devices
        ends every session on this account, including this one - for a phone you have lost.
      </p>
    </div>`;
}

/*
 * Installing, from inside the app.
 *
 * There was no way to do this before, and the browser's own route is not a reliable
 * fallback: once Chrome believes a site is installed it replaces Install with Open in
 * its menu, and it goes on believing that after the app has been removed from the
 * launcher. Someone in that state has no way back at all.
 *
 * Three states, and none of them is a button that silently does nothing:
 *   already installed   say so, offer nothing
 *   prompt available    the real button
 *   no prompt           the manual route for this browser, spelled out
 */
function installRows(install) {
  if (!install) return '';

  if (install.standalone) {
    return `
      <div class="field-rows">
        <div class="field-row">
          <span class="field-row-label">This device</span>
          <span class="field-row-value is-ok">Installed</span>
        </div>
      </div>
      <p class="card-note note-under">You are running the installed app. It opens without
        the browser bars and works with no signal.</p>`;
  }

  if (install.canPrompt) {
    return `
      <div class="field-rows">
        <div class="field-row">
          <span class="field-row-label">This device</span>
          <span class="field-row-value">In the browser</span>
        </div>
        <div class="field-row field-row-actions">
          <button class="btn btn-primary btn-sm" data-action="install-app" type="button">
            ${icon('download-simple')} Add to home screen
          </button>
        </div>
      </div>
      <p class="card-note note-under">Opens without the browser bars, and starts faster.
        Nothing is uploaded by installing; it is the same app.</p>`;
  }

  // No prompt. On iOS there never is one - Safari has no beforeinstallprompt at all -
  // and on Android it usually means Chrome still has an older install registered.
  const how = install.ios
    ? 'Tap Share, then <strong>Add to Home Screen</strong>.'
    : 'Open the browser menu and choose <strong>Install app</strong> or ' +
      '<strong>Add to Home screen</strong>.';

  return `
    <div class="field-rows">
      <div class="field-row">
        <span class="field-row-label">This device</span>
        <span class="field-row-value">In the browser</span>
      </div>
    </div>
    <p class="card-note note-under">${how}
      ${install.ios ? '' : ' If the menu offers only <strong>Open Spendo</strong>, ' +
        'the browser still has an older copy registered: clear this site\'s data in ' +
        'Android Settings &rarr; Apps &rarr; Chrome &rarr; Storage, then reload.'}</p>`;
}

export function screenSettings(ctx) {
  const { ym, stats, theme } = ctx;

  const themeRow = `
    <div class="field-row">
      <span class="field-row-label">Theme</span>
      <div class="field-row-control">
        <div class="seg seg-3" role="group" aria-label="Theme">
          ${['system', 'light', 'dark'].map((t) => `
            <button type="button" class="seg-btn ${theme === t ? 'is-selected' : ''}"
              data-theme="${t}" aria-pressed="${theme === t}">${t[0].toUpperCase()}${t.slice(1)}</button>`).join('')}
        </div>
      </div>
    </div>`;

  return `
    <header class="topbar">
      <h1 class="screen-title">Settings</h1>
    </header>

    <section class="list">
      ${listHead('wallet', 'Opening money')}
      <div class="field-rows">
        <div class="field-row">
          <span class="field-row-label">Month</span>
          <span class="field-row-value">${esc(monthLabel(ym))}</span>
        </div>
        <div class="field-row">
          <span class="field-row-label">Amount</span>
          <span class="field-row-value money">${esc(money(stats.opening))}</span>
        </div>
        <div class="field-row field-row-actions">
          <button class="btn btn-primary btn-sm" data-action="set-opening" type="button">Set amount</button>
          <button class="btn btn-text btn-sm" data-action="add-opening" type="button">Add to it</button>
        </div>
      </div>
      <p class="card-note note-under">What you started the month with, before any expense.
        Set replaces it; Add tops it up when more money arrives mid month.</p>
    </section>

    <section class="list">
      ${listHead('download-simple', 'Install')}
      ${installRows(ctx.install)}
    </section>

    <section class="list">
      ${listHead('sun', 'Appearance')}
      <div class="field-rows">${themeRow}</div>
    </section>

    <section class="list">
      ${listHead('cloud-check', 'Sync')}
      ${syncRows(ctx.sync)}
      <p class="card-note note-under">Entries are saved on this phone the moment you add
        them, whether or not you are signed in. Signing in is what also keeps a copy in your
        database, so a lost phone is not a lost year. Anything recorded while signed out is
        sent the moment you sign in.</p>
    </section>

    <section class="list">
      ${listHead('cloud-slash', 'Your data')}
      <div class="field-rows">
        <div class="field-row">
          <span class="field-row-label">Stored</span>
          <span class="field-row-value">${ctx.sync && ctx.sync.signedIn
            ? 'This phone and your database'
            : 'This phone only'}</span>
        </div>
        <div class="field-row">
          <span class="field-row-label">Entries</span>
          <span class="field-row-value money">${esc(String(ctx.totalEntries ?? 0))}</span>
        </div>
        <div class="field-row field-row-actions">
          <button class="btn btn-text btn-sm" data-action="export-json" type="button">
            ${icon('download-simple')} Export to Excel
          </button>
          <button class="btn btn-text btn-sm" data-action="show-intro" type="button">
            ${icon('info')} Walkthrough
          </button>
        </div>
      </div>
      <p class="card-note note-under">The Google Sheet mirror and the calendar events arrive
        in phase 3.</p>
    </section>`;
}



/* -------------------------------------------------------------- walkthrough */

/*
 * Three screens on first run, and nothing more.
 *
 * They exist because two things about this app are not guessable from looking at
 * it: that the Add button records money arriving as well as money leaving, and that
 * the balance counts down from an opening figure you have to set. Everything else
 * the interface explains by being used, so it is not explained here. Skippable from
 * the first screen, and replayable from Settings, because an intro you cannot get
 * back is a one-time chance to have read carefully enough.
 */
const INTRO = [
  {
    icon: 'img:rupee',
    title: 'One button for both',
    body: 'Add records money going out and money coming in. Pick which at the top of the sheet; everything else is the same two fields.'
  },
  {
    icon: 'calendar-blank',
    title: 'A month at a time',
    body: 'Home is one month. The arrows beside the title step back through earlier ones, and History lists every month you have tracked.'
  },
  {
    icon: 'wallet',
    title: 'Start the month with a figure',
    body: 'Set your opening money in Settings and the balance counts down from it as you spend. Top it up with Add to it whenever more arrives mid month.'
  }
];

/*
 * A yes-or-no, in the app's own sheet rather than the browser's dialog.
 *
 * `window.confirm` was doing this job and doing it badly: it renders as "spendo.
 * aathi.online says", in the system's font, with OK and Cancel in an order the app
 * does not control - a browser artefact sitting on top of an installed app. It also
 * blocks the main thread, which on a phone shows as the app freezing for a moment
 * before the box appears.
 *
 * This is the same bottom sheet everything else uses, so it inherits the type, the
 * safe-area padding and the close-on-backdrop behaviour. The confirming button
 * carries the action; there is no callback to keep alive, and no way for the sheet
 * to be dismissed leaving something half-done.
 */
export function confirmSheet({ title, body, confirmLabel, confirmAction, tone = 'danger' }) {
  return `
    <div class="sheet-body">
      <div class="sheet-head">
        <button class="icon-btn" data-action="close-sheet" type="button" aria-label="Close">${icon('x')}</button>
        <h2 class="sheet-title">${esc(title)}</h2>
      </div>

      <p class="confirm-body">${esc(body)}</p>

      <div class="confirm-actions">
        <button class="btn btn-text" data-action="close-sheet" type="button">Cancel</button>
        <button class="btn ${tone === 'danger' ? 'btn-danger' : 'btn-primary'}"
          data-action="${esc(confirmAction)}" type="button">${esc(confirmLabel)}</button>
      </div>
    </div>`;
}

export function introSheet(step) {
  const s = INTRO[step];
  const last = step === INTRO.length - 1;
  const mark = s.icon.startsWith('img:') ? imgIcon(s.icon.slice(4)) : icon(s.icon);

  return `
    <div class="sheet-body intro">
      <div class="intro-mark">${mark}</div>
      <h2 class="intro-title">${esc(s.title)}</h2>
      <p class="intro-body">${esc(s.body)}</p>

      <div class="intro-dots" role="img" aria-label="Step ${step + 1} of ${INTRO.length}">
        ${INTRO.map((_, i) => `<span class="intro-dot${i === step ? ' is-on' : ''}"></span>`).join('')}
      </div>

      <div class="intro-actions">
        ${step > 0
          ? `<button class="btn btn-text" data-action="intro-back" type="button">Back</button>`
          : `<button class="btn btn-text" data-action="intro-done" type="button">Skip</button>`}
        <button class="btn btn-primary intro-next" data-action="${last ? 'intro-done' : 'intro-next'}" type="button">
          ${last ? 'Start tracking' : 'Next'}
        </button>
      </div>
    </div>`;
}

/* ---------------------------------------------------------------- calendar */

/**
 * Our own calendar, because the native one cannot be styled: it arrives in the
 * browser's own blue, in the browser's own shape, and reads as a different product
 * dropped into the middle of the sheet.
 *
 * Days after today are disabled. An expense is something that already happened;
 * offering to file one next Tuesday is offering a mistake.
 */
export function calendarSheet(selectedISO, viewYM) {
  const today = todayISO();
  const total = daysInMonth(viewYM);
  const lead = firstWeekdayOf(viewYM);

  const cells = [];
  for (let i = 0; i < lead; i++) cells.push('<span class="cal-cell is-blank"></span>');

  for (let day = 1; day <= total; day++) {
    const iso = `${viewYM}-${String(day).padStart(2, '0')}`;
    const future = iso > today;
    const chosen = iso === selectedISO;
    const isToday = iso === today;
    cells.push(`
      <button type="button" class="cal-cell${chosen ? ' is-chosen' : ''}${isToday ? ' is-today' : ''}"
        data-pick-day="${esc(iso)}" ${future ? 'disabled' : ''}
        aria-label="${esc(longDate(iso))}" ${chosen ? 'aria-current="date"' : ''}>${day}</button>`);
  }

  const canGoNext = `${viewYM}-01` < today.slice(0, 7) + '-01' || viewYM < today.slice(0, 7);

  return `
    <div class="sheet-body">
      <div class="sheet-head">
        <button class="icon-btn" data-action="cancel-pick" type="button" aria-label="Back">${icon('caret-left')}</button>
        <h2 class="sheet-title">Pick a date</h2>
      </div>

      <div class="cal-head">
        <button class="icon-btn" data-cal-step="-1" type="button" aria-label="Previous month">${icon('caret-left')}</button>
        <span class="cal-month">${esc(monthLabel(viewYM))}</span>
        <button class="icon-btn" data-cal-step="1" type="button" aria-label="Next month"
          ${canGoNext ? '' : 'disabled'}>${icon('caret-right')}</button>
      </div>

      <div class="cal-grid" role="grid">
        ${WEEKDAYS.map((d) => `<span class="cal-weekday">${d}</span>`).join('')}
        ${cells.join('')}
      </div>

      <button class="btn btn-text btn-block" data-pick-day="${esc(today)}" type="button">Today</button>
    </div>`;
}

/** Two taps for the two dates almost every expense has, and a calendar for the rest. */
function dateField(dateISO) {
  const today = todayISO();
  const yesterday = yesterdayISO();
  const other = dateISO !== today && dateISO !== yesterday;
  return `
    <div class="field">
      <span class="field-label">Date</span>
      <div class="chip-row" role="group" aria-label="Date">
        <button type="button" class="chip ${dateISO === today ? 'is-selected' : ''}"
          data-pick-day="${esc(today)}" aria-pressed="${dateISO === today}">Today</button>
        <button type="button" class="chip ${dateISO === yesterday ? 'is-selected' : ''}"
          data-pick-day="${esc(yesterday)}" aria-pressed="${dateISO === yesterday}">Yesterday</button>
        <button type="button" class="chip ${other ? 'is-selected' : ''}"
          data-action="open-calendar" aria-pressed="${other}">
          ${icon('calendar-dots')} ${esc(other ? friendlyDate(dateISO) : 'Pick a date')}
        </button>
      </div>
    </div>`;
}

/* ------------------------------------------------------------------ sheets */

/*
 * Recent descriptions, as tappable chips rather than a <datalist>.
 *
 * The datalist never opened on Android. It is the standard answer on a desktop and
 * close to useless on a phone: its popup has to compete with the on-screen keyboard,
 * Safari has never supported it on iOS at all, and inside a <dialog> - which every
 * sheet in this app is - Chrome frequently does not render it. A control whose entire
 * job is to be discoverable cannot be one that has to be guessed at.
 *
 * These are visible without tapping anything, are thumb-sized, and work everywhere.
 * `hidden` is set here rather than the list being re-rendered as the user types,
 * because re-rendering the sheet would take the focus - and with it the keyboard -
 * away mid-word.
 */
function suggestRow(suggestions, current) {
  const list = suggestions || [];
  if (!list.length) return '';

  const typed = String(current || '').trim().toLowerCase();
  const shown = (s) => !typed || (s.toLowerCase().includes(typed) && s.toLowerCase() !== typed);

  return `
    <div class="suggest" data-suggest ${list.some(shown) ? '' : 'hidden'}>
      <span class="suggest-label">Recent</span>
      <div class="chip-row">
        ${list.map((s, i) => `
          <button type="button" class="chip chip-sm" data-suggest-value="${esc(s)}"
            data-rank="${i}" ${shown(s) ? '' : 'hidden'}>${esc(s)}</button>`).join('')}
      </div>
    </div>`;
}

/*
 * Where an auto-picked category came from, said quietly.
 *
 * It is a label, not a badge or a banner: the guess is usually right and usually
 * uninteresting, so it should be legible when looked for and invisible otherwise.
 * It names the source because "why did it pick that" is the first question anyone
 * asks the first time it gets one wrong, and "from what you typed before" and "a
 * guess" deserve different amounts of trust.
 */
function pickedNote(picked) {
  if (!picked) return '';
  const from = {
    history: 'from your past entries',
    cache: 'from your past entries',
    keyword: 'from the description',
    ai: 'a guess'
  }[picked] || '';
  return from ? `<span class="field-hint">Picked ${esc(from)}</span>` : '';
}

/*
 * The chosen category first, then the rest in their declared order.
 *
 * There are thirteen of these and a phone shows four. Left in fixed order, a pick of
 * "Personal care" sat off the right edge of a scroller that opens at the left, so the
 * one chip that matters was the one chip not on screen - and scrolling it into view
 * only moved the problem, leaving everything before it behind the left edge to be
 * swiped back to. Putting it at the front means the row can always open at position
 * zero: the answer is under the thumb and nothing is hidden to the left of it.
 *
 * Only the FRONT moves. The rest keep the order in categories.js, so the row is not
 * reshuffled by frequency or by rank and a category stays where it was learnt.
 */
function orderedCats(cats, chosen) {
  const pick = cats.find((c) => c.id === chosen);
  return pick ? [pick, ...cats.filter((c) => c.id !== chosen)] : cats;
}

export function addSheet({ direction, category: catId, date, amount, description, suggestions, picked }) {
  const all = categoriesFor(direction);
  const chosen = catId || all[0].id;
  const cats = orderedCats(all, chosen);

  return `
    <form class="sheet-body" id="add-form" novalidate>
      <div class="sheet-head">
        <button class="icon-btn" data-action="close-sheet" type="button" aria-label="Close">${icon('x')}</button>
        <h2 class="sheet-title">${direction === 'in' ? 'Add income' : 'Add expense'}</h2>
      </div>

      <div class="seg" role="group" aria-label="Direction">
        <button type="button" class="seg-btn ${direction === 'out' ? 'is-selected' : ''}"
          data-direction="out" aria-pressed="${direction === 'out'}">${imgIcon('paid')} I paid</button>
        <button type="button" class="seg-btn ${direction === 'in' ? 'is-selected' : ''}"
          data-direction="in" aria-pressed="${direction === 'in'}">${imgIcon('received')} I received</button>
      </div>

      <label class="field">
        <span class="field-label">Amount</span>
        <span class="field-money">
          <span class="field-prefix">${icon('currency-inr')}</span>
          <input class="input input-amount money" name="amount" type="text" inputmode="decimal"
            autocomplete="off" placeholder="0" value="${esc(amount || '')}" required>
        </span>
        <span class="field-error" data-error="amount" hidden></span>
      </label>

      <label class="field">
        <span class="field-label">Description</span>
        <input class="input" name="description" type="text" autocomplete="off"
          placeholder="What was it for" value="${esc(description || '')}" required>
        <span class="field-error" data-error="description" hidden></span>
      </label>
      ${suggestRow(suggestions, description)}

      <div class="field">
        <span class="field-label-row">
          <span class="field-label">Category</span>
          ${pickedNote(picked)}
        </span>
        <div class="chip-row" role="group" aria-label="Category">
          ${cats.map((c) => `
            <button type="button" class="chip ${c.id === chosen ? 'is-selected' : ''}"
              data-category="${esc(c.id)}" aria-pressed="${c.id === chosen}">
              ${icon(c.icon)} ${esc(c.label)}
            </button>`).join('')}
        </div>
      </div>

      ${dateField(date)}

      <button class="btn btn-primary btn-block" type="submit">Save</button>
    </form>`;
}

/**
 * The detail sheet, and the only place an entry is edited.
 *
 * Every field carries its own pencil and opens in place, rather than the whole
 * record dropping into a form. Correcting one wrong digit should not make the user
 * re-confirm four fields that were already right, and an edit that opens where the
 * value already sits keeps the reader's eye on the thing being changed.
 *
 * `editing` names the one field currently open, or is null.
 */
export function detailSheet(e, editing) {
  const cat = category(e.category);
  const income = e.direction === 'in';
  // The row this entry already sits in opens with its own category first, for the
  // same reason the add sheet does: the chip you are most likely to want is the one
  // you can see without scrolling.
  const cats = orderedCats(categoriesFor(e.direction), e.category);

  const readRow = (key, label, valueHtml) => `
    <div class="field-row">
      <span class="field-row-label">${esc(label)}</span>
      <span class="field-row-value">${valueHtml}</span>
      <button class="field-row-edit" data-edit-field="${esc(key)}" type="button"
        aria-label="Edit ${esc(label.toLowerCase())}">${icon('pencil-simple')}</button>
    </div>`;

  const editRow = (key, label, controlHtml, inline) => `
    <form class="field-row is-editing" id="edit-form" data-field="${esc(key)}" novalidate>
      <span class="field-row-label">${esc(label)}</span>
      <div class="field-row-control">${controlHtml}</div>
      ${inline ? '' : `<button class="field-row-save" type="submit" aria-label="Save ${esc(label.toLowerCase())}">${icon('check-bold')}</button>`}
    </form>`;

  const rows = [];

  rows.push(editing === 'amount'
    ? editRow('amount', 'Amount', `
        <span class="field-money">
          <span class="field-prefix">${icon('currency-inr')}</span>
          <input class="input input-amount money" name="amount" type="text" inputmode="decimal"
            autocomplete="off" value="${esc(e.amount)}" required>
        </span>`)
    : readRow('amount', 'Amount', `<span class="money ${income ? 'is-in' : 'is-out'}">${esc(money(e.amount))}</span>`));

  rows.push(editing === 'description'
    ? editRow('description', 'Description', `
        <input class="input" name="description" type="text" autocomplete="off"
          value="${esc(e.description)}" required>`)
    : readRow('description', 'Description', esc(e.description || cat.label)));

  rows.push(editing === 'category'
    ? editRow('category', 'Category', `
        <div class="chip-row" role="group" aria-label="Category">
          ${cats.map((c) => `
            <button type="button" class="chip ${c.id === e.category ? 'is-selected' : ''}"
              data-set-category="${esc(c.id)}" aria-pressed="${c.id === e.category}">
              ${icon(c.icon)} ${esc(c.label)}
            </button>`).join('')}
        </div>`, true)
    : readRow('category', 'Category', `
        <span class="value-with-dot"><span class="cat-dot" style="background:${seriesVar(e.category)}"></span>${esc(cat.label)}</span>`));

  rows.push(editing === 'date'
    ? editRow('date', 'Date', `
        <div class="chip-row" role="group" aria-label="Date">
          <button type="button" class="chip ${e.date === todayISO() ? 'is-selected' : ''}"
            data-set-day="${esc(todayISO())}">Today</button>
          <button type="button" class="chip ${e.date === yesterdayISO() ? 'is-selected' : ''}"
            data-set-day="${esc(yesterdayISO())}">Yesterday</button>
          <button type="button" class="chip" data-action="open-calendar">
            ${icon('calendar-dots')} Pick a date
          </button>
        </div>`, true)
    : readRow('date', 'Date', esc(longDate(e.date))));

  rows.push(editing === 'direction'
    ? editRow('direction', 'Direction', `
        <div class="seg">
          <button type="button" class="seg-btn ${!income ? 'is-selected' : ''}"
            data-set-direction="out" aria-pressed="${!income}">${imgIcon('paid')} I paid</button>
          <button type="button" class="seg-btn ${income ? 'is-selected' : ''}"
            data-set-direction="in" aria-pressed="${income}">${imgIcon('received')} I received</button>
        </div>`, true)
    : readRow('direction', 'Direction', `<span class="${income ? 'is-in' : 'is-out'}">${esc(income ? 'You received' : 'You paid')}</span>`));

  return `
    <div class="sheet-body">
      <div class="sheet-head">
        <button class="icon-btn" data-action="close-sheet" type="button" aria-label="Close">${icon('x')}</button>
        <h2 class="sheet-title">${esc(e.description || cat.label)}</h2>
      </div>

      <div class="field-rows">${rows.join('')}</div>

      <button class="btn btn-danger btn-block" data-action="delete-entry" data-entry="${esc(e.id)}" type="button">
        ${icon('trash-simple')} Delete
      </button>
    </div>`;
}

export function amountSheet({ title, note, label, confirm }) {
  return `
    <form class="sheet-body" id="amount-form" novalidate>
      <div class="sheet-head">
        <button class="icon-btn" data-action="close-sheet" type="button" aria-label="Close">${icon('x')}</button>
        <h2 class="sheet-title">${esc(title)}</h2>
      </div>
      ${note ? `<p class="card-note">${esc(note)}</p>` : ''}
      <label class="field">
        <span class="field-label">${esc(label)}</span>
        <span class="field-money">
          <span class="field-prefix">${icon('currency-inr')}</span>
          <input class="input input-amount money" name="amount" type="text" inputmode="decimal"
            autocomplete="off" placeholder="0" required>
        </span>
        <span class="field-error" data-error="amount" hidden></span>
      </label>
      <button class="btn btn-primary btn-block" type="submit">${esc(confirm)}</button>
    </form>`;
}

/**
 * Sign in, in two steps inside one sheet.
 *
 * There is no signup: an address that has never been seen becomes an account the
 * first time it proves it can receive a code. So the copy never says "create an
 * account" and never asks anyone to choose between signing in and registering - the
 * distinction exists in neither the server nor the user's head.
 *
 * `step` is 'email' or 'code'. The address is carried through the second step as a
 * hidden field rather than held in a module variable, so re-rendering the sheet for
 * an error cannot lose it.
 */
export function signInSheet({ step = 'email', email = '', error = '', busy = false, sending = false } = {}) {
  const head = `
    <div class="sheet-head">
      <button class="icon-btn" data-action="close-sheet" type="button" aria-label="Close">${icon('x')}</button>
      <h2 class="sheet-title">${step === 'code' ? 'Enter the code' : 'Sign in'}</h2>
    </div>`;

  const problem = error ? `<p class="field-error is-shown" role="alert">${esc(error)}</p>` : '';

  if (step === 'code') {
    return `
      <form class="sheet-body" id="signin-code-form" novalidate>
        ${head}
        <p class="card-note">A 6-digit code is on its way to <strong>${esc(email)}</strong>.
          It works for 10 minutes.</p>
        <input type="hidden" name="email" value="${esc(email)}">
        <label class="field">
          <span class="field-label">Code</span>
          <input class="input input-amount money" name="code" type="text" inputmode="numeric"
            autocomplete="one-time-code" maxlength="6" placeholder="000000" required
            aria-label="Six digit sign-in code">
        </label>
        ${problem}
        <button class="btn btn-primary btn-block" type="submit" ${busy ? 'disabled' : ''}>
          ${busy ? 'Checking...' : 'Sign in'}
        </button>
        <div class="sheet-actions-row">
          <button class="btn btn-text btn-sm" data-action="signin-back" type="button">Use a different email</button>
          <button class="btn btn-text btn-sm" data-action="signin-resend" type="button" ${sending ? 'disabled' : ''}>
            ${sending ? 'Sending...' : 'Send it again'}
          </button>
        </div>
      </form>`;
  }

  return `
    <form class="sheet-body" id="signin-email-form" novalidate>
      ${head}
      <p class="card-note">Your transactions stay on this phone either way. Signing in also
        keeps a copy in your database, so you still have them on a new phone.</p>
      <label class="field">
        <span class="field-label">Email</span>
        <input class="input" name="email" type="email" inputmode="email" autocomplete="email"
          autocapitalize="off" spellcheck="false" placeholder="you@example.com"
          value="${esc(email)}" required>
      </label>
      ${problem}
      <button class="btn btn-primary btn-block" type="submit" ${busy ? 'disabled' : ''}>
        ${busy ? 'Sending...' : 'Send me a code'}
      </button>
      <p class="card-note">No password. A code is emailed each time you sign in on a new device.</p>
    </form>`;
}

/**
 * One month, opened from History.
 *
 * Tapping a month used to silently change which month Home was showing and drop you
 * on Home to notice - an action with no visible cause. It opens this instead, which
 * is the same pattern a transaction row already uses, and the jump is now a button
 * that says what it does.
 *
 * The figures are always here. The paragraph is not: it needs the model, and the
 * model needs a session, a signal and a key. So the numbers are the content and the
 * writing is a bonus laid on top - never the other way round, or the screen would be
 * empty on a train.
 */
export function monthSheet(facts, review) {
  const line = (label, value, cls = '') => `
    <div class="field-row">
      <span class="field-row-label">${esc(label)}</span>
      <span class="field-row-value money ${cls}">${esc(value)}</span>
    </div>`;

  // The same row Insights uses, minus the tap: identical shape means the reader has
  // already learnt to read it, and it costs no new CSS.
  const bars = facts.top.length ? `
    <div class="group-rows">
      ${facts.top.map((t) => `
        <div class="cat-row">
          <span class="cat-dot" style="background:${seriesVar(t.id)}"></span>
          <span class="cat-main">
            <span class="cat-title">${esc(category(t.id).label)}</span>
            ${rowBarSVG(t.share, t.id)}
          </span>
          <span class="cat-end">
            <span class="row-amount money">${esc(money(t.amount))}</span>
            <span class="row-sub">${(t.share * 100).toFixed(t.share < 0.1 ? 1 : 0)}%</span>
          </span>
        </div>`).join('')}
    </div>` : '';

  const change = facts.prev
    ? `<p class="card-note">${facts.prev.delta === 0
        ? `Exactly what you spent in ${esc(monthLabel(facts.prev.ym))}.`
        : `${esc(money(Math.abs(facts.prev.delta)))} ${facts.prev.delta > 0 ? 'more' : 'less'} than
           ${esc(monthLabel(facts.prev.ym))}${facts.prev.deltaPct === null ? ''
             : ` (${facts.prev.delta > 0 ? '+' : ''}${Math.round(facts.prev.deltaPct * 100)}%)`}.`}</p>`
    : '';

  const written = review
    ? `<p class="review-text">${esc(review)}</p>`
    : `<p class="card-note">${facts.aiPossible
        ? 'Writing a summary...'
        : 'Sign in to get this month written up in a sentence.'}</p>`;

  return `
    <div class="sheet-body">
      <div class="sheet-head">
        <button class="icon-btn" data-action="close-sheet" type="button" aria-label="Close">${icon('x')}</button>
        <h2 class="sheet-title">${esc(monthLabel(facts.ym))}${facts.isCurrent ? ' so far' : ''}</h2>
      </div>

      <section class="review">${written}</section>

      <div class="field-rows">
        ${line('Spent', money(facts.spent), 'is-out')}
        ${facts.received > 0 ? line('Received', money(facts.received), 'is-in') : ''}
        ${line('Left', money(facts.balance))}
      </div>
      ${change}

      ${bars}

      <div class="field-rows">
        <div class="field-row">
          <span class="field-row-label">Entries</span>
          <span class="field-row-value">${esc(plural(facts.count, 'entry', 'entries'))} on
            ${esc(plural(facts.activeDays, 'day', 'days'))}</span>
        </div>
        ${facts.biggest ? `
        <div class="field-row">
          <span class="field-row-label">Biggest</span>
          <span class="field-row-value"><span class="money is-out">${esc(money(facts.biggest.amount))}</span>
            ${esc(facts.biggest.description || category(facts.biggest.category).label)}</span>
        </div>` : ''}
      </div>

      <button class="btn btn-primary btn-block" data-action="open-month" data-open-month="${esc(facts.ym)}"
        type="button">Open ${esc(monthLabel(facts.ym))}</button>
    </div>`;
}

export function monthShort(iso) {
  return monthShortOf(iso);
}
