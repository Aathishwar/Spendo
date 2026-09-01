/**
 * Spendo - formatting
 *
 * Dates are ISO (`YYYY-MM-DD`) everywhere inside the app, and are converted to a
 * display or sheet format only at the edge. The n8n workflow this replaces carried
 * three date formats through its nodes and guessed between them in two places; the
 * bug that produced is the reason for the single-format rule.
 */

const MONTHS = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December'
];
const MONTHS_SHORT = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

const pad = (n) => String(n).padStart(2, '0');

/** Today in the device's own timezone, never UTC: a 1 am expense belongs to today. */
export function todayISO() {
  const d = new Date();
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

export function ymOf(iso) {
  return iso.slice(0, 7);
}

export function currentYM() {
  return ymOf(todayISO());
}

export function dayOf(iso) {
  return Number(iso.slice(8, 10));
}

/** Number of days in the month a `YYYY-MM` string names. */
export function daysInMonth(ym) {
  const [y, m] = ym.split('-').map(Number);
  return new Date(y, m, 0).getDate();
}

/** "2026-08" to "August 2026". */
export function monthLabel(ym) {
  const [y, m] = ym.split('-').map(Number);
  return `${MONTHS[m - 1]} ${y}`;
}

/** "2026-08" to "Aug 2026", for lists where the long name would wrap. */
export function monthLabelShort(ym) {
  const [y, m] = ym.split('-').map(Number);
  return `${MONTHS_SHORT[m - 1]} ${y}`;
}

/** Step a `YYYY-MM` string by whole months, forwards or backwards. */
export function shiftYM(ym, delta) {
  const [y, m] = ym.split('-').map(Number);
  const d = new Date(y, m - 1 + delta, 1);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}`;
}

export function monthShortOf(iso) {
  return MONTHS_SHORT[Number(iso.slice(5, 7)) - 1];
}

/** "2026-08-31" to "31 August 2026". */
export function longDate(iso) {
  const [y, m, d] = iso.split('-').map(Number);
  return `${d} ${MONTHS[m - 1]} ${y}`;
}

/** Today and yesterday are named, because that is how the user thinks about them. */
export function friendlyDate(iso) {
  const today = todayISO();
  if (iso === today) return 'Today';
  const d = new Date(today);
  d.setDate(d.getDate() - 1);
  const yesterday = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  if (iso === yesterday) return 'Yesterday';
  return longDate(iso);
}

/** The format the Google Sheet mirror expects. Used at that boundary only. */
export function toSheetDate(iso) {
  const [y, m, d] = iso.split('-');
  return `${d}-${m}-${y}`;
}

const inr = new Intl.NumberFormat('en-IN', { maximumFractionDigits: 0 });
const inrPaise = new Intl.NumberFormat('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

/**
 * Whole rupees unless there are paise to show. A ledger of round numbers should
 * not be padded with ".00" on every line.
 */
export function money(n) {
  const v = Number(n) || 0;
  const body = Number.isInteger(v) ? inr.format(v) : inrPaise.format(v);
  return `₹${body}`;
}

/** Same, with an explicit sign, for anything that has a direction. */
export function signedMoney(n, direction) {
  return `${direction === 'in' ? '+' : '-'}${money(Math.abs(Number(n) || 0))}`;
}

/** Yesterday in the device's own timezone. */
export function yesterdayISO() {
  const d = new Date(todayISO());
  d.setDate(d.getDate() - 1);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** Weekday index of the first of a month, 0 = Sunday. */
export function firstWeekdayOf(ym) {
  const [y, m] = ym.split('-').map(Number);
  return new Date(y, m - 1, 1).getDay();
}

export const WEEKDAYS = ['Su', 'Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa'];

/** "just now", "4 minutes ago", "yesterday". For sync status, not for the ledger. */
export function timeAgo(ms) {
  if (!ms) return 'never';
  const secs = Math.round((Date.now() - ms) / 1000);
  if (secs < 45) return 'just now';
  const mins = Math.round(secs / 60);
  if (mins < 60) return `${plural(mins, 'minute', 'minutes')} ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${plural(hours, 'hour', 'hours')} ago`;
  const days = Math.round(hours / 24);
  if (days === 1) return 'yesterday';
  if (days < 30) return `${plural(days, 'day', 'days')} ago`;
  return longDate(new Date(ms).toISOString().slice(0, 10));
}

export function plural(n, one, many) {
  return `${n} ${n === 1 ? one : many}`;
}
