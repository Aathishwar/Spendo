/**
 * Spendo - charts
 *
 * Inline SVG, built as strings, no chart library. Two forms only:
 *
 *   dailyBarsSVG   one series over time, so: columns, one hue, no legend. The title
 *                  above it names the series, which is what a legend would have said.
 *   monthlyBarsSVG the same form one step coarser, for History: one column a month
 *                  with the average across the window as the reference line.
 *   donutSVG       part-to-whole across categories, with the ranked list below it
 *                  doing the work a legend would do.
 *
 * Mark rules followed here: 4px rounded ends anchored to the baseline, a 2px gap in
 * the surface colour between adjacent fills, 2px reference lines, recessive axes,
 * and labels only where they carry information rather than on every mark.
 *
 * Colour is never the only channel: the daily chart is a single hue, and every
 * segment of the share bar is printed with its name and amount in the list below it.
 */

import { money, monthLabelShort } from './format.js';
import { seriesVar } from './categories.js';

const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

/** A bar with its top corners rounded and its bottom edge flat on the baseline. */
function columnPath(x, y, w, h, r) {
  const radius = Math.max(0, Math.min(r, w / 2, h));
  if (h <= 0) return '';
  return [
    `M${x} ${y + h}`,
    `L${x} ${y + radius}`,
    `Q${x} ${y} ${x + radius} ${y}`,
    `L${x + w - radius} ${y}`,
    `Q${x + w} ${y} ${x + w} ${y + radius}`,
    `L${x + w} ${y + h}`,
    'Z'
  ].join(' ');
}

/**
 * Daily spend across one month, with the even-spread budget as a reference line.
 *
 * The reference line is the honest version of "am I on track": the month's whole
 * pot divided by its days. A bar over the line is a day that borrowed from another
 * day, which is a fact worth seeing rather than a failure worth colouring red.
 */
export function dailyBarsSVG(stats) {
  const W = 320;
  const PLOT_TOP = 14;
  const PLOT_BOTTOM = 96;
  const AXIS_Y = 112;
  const H = 120;

  const days = stats.daysInMonth;
  const gap = 2;
  const slot = W / days;
  const barW = Math.max(3, slot - gap);

  const peak = Math.max(...stats.perDay, 0);
  const scaleMax = Math.max(peak, stats.budgetPerDay, 1) * 1.15;
  const y = (v) => PLOT_BOTTOM - (v / scaleMax) * (PLOT_BOTTOM - PLOT_TOP);

  const peakDay = stats.perDay.indexOf(peak);
  const parts = [];
  // The bars live in their own group so they can grow from the baseline together on
  // entry. The transform is on the group, so no path data is animated.
  const bars = [];

  // The budget line sits under the bars so a bar reads as crossing it, not as
  // being cut by it.
  if (stats.budgetPerDay > 0) {
    const by = y(stats.budgetPerDay);
    parts.push(
      `<line x1="0" y1="${by.toFixed(1)}" x2="${W}" y2="${by.toFixed(1)}" ` +
      `stroke="var(--ink-3)" stroke-width="2" stroke-dasharray="2 4" opacity="0.55"/>`
    );
  }

  for (let i = 0; i < days; i++) {
    const day = i + 1;
    const value = stats.perDay[i];
    const x = i * slot + gap / 2;
    const future = stats.isCurrent && day > stats.dayNow;

    // data-day on the mark itself, not only on the hit target: picking a day dims
    // every other bar, and the dimming is done by finding this attribute.
    if (value > 0) {
      const top = y(value);
      bars.push(
        `<path class="chart-bar" data-day="${day}" ` +
        `d="${columnPath(x, top, barW, PLOT_BOTTOM - top, 4)}" fill="var(--brand)"/>`
      );
    } else {
      // A day with no spending still exists. A 2px stub says "nothing here" where a
      // missing bar would have said "no such day".
      bars.push(
        `<rect class="chart-bar" data-day="${day}" x="${x.toFixed(1)}" y="${PLOT_BOTTOM - 2}" ` +
        `width="${barW.toFixed(1)}" height="2" rx="1" ` +
        `fill="var(--line)" opacity="${future ? 0.5 : 1}"/>`
      );
    }
  }

  parts.push(`<g class="chart-bars">${bars.join('')}</g>`);

  // One direct label: the biggest day. Numbers on every bar would be unreadable at
  // this width and would say nothing the bar heights do not already say.
  if (peak > 0) {
    const x = peakDay * slot + slot / 2;
    const anchor = x < 40 ? 'start' : x > W - 40 ? 'end' : 'middle';
    const tx = anchor === 'start' ? 2 : anchor === 'end' ? W - 2 : x;
    parts.push(
      `<text x="${tx.toFixed(1)}" y="${(y(peak) - 5).toFixed(1)}" text-anchor="${anchor}" ` +
      `class="chart-peak">${esc(money(peak))}</text>`
    );
  }

  // Four date ticks, not thirty-one.
  const ticks = [1, 8, 15, 22, days].filter((d, i, a) => a.indexOf(d) === i && d <= days);
  for (const day of ticks) {
    const x = (day - 1) * slot + slot / 2;
    const anchor = day === 1 ? 'start' : day === days ? 'end' : 'middle';
    const tx = day === 1 ? 0 : day === days ? W : x;
    parts.push(`<text x="${tx.toFixed(1)}" y="${AXIS_Y}" text-anchor="${anchor}" class="chart-tick">${day}</text>`);
  }

  // Today's marker, so the chart says where "now" is without a second colour.
  if (stats.isCurrent) {
    const x = (stats.dayNow - 1) * slot + slot / 2;
    parts.push(
      `<line x1="${x.toFixed(1)}" y1="${PLOT_BOTTOM + 2}" x2="${x.toFixed(1)}" y2="${PLOT_BOTTOM + 6}" ` +
      `stroke="var(--brand)" stroke-width="2" stroke-linecap="round"/>`
    );
  }

  // Hit targets are the full column height, always at least the slot width, so a
  // thumb can reach a 3px bar. They are tapped, not only hovered: see bindChart in
  // app.js, where a tap pins the day's figure until it is dismissed.
  for (let i = 0; i < days; i++) {
    parts.push(
      `<rect class="chart-hit" data-day="${i + 1}" x="${(i * slot).toFixed(1)}" y="0" ` +
      `width="${slot.toFixed(1)}" height="${PLOT_BOTTOM}" fill="transparent"/>`
    );
  }

  return `<svg class="chart-daily" viewBox="0 0 ${W} ${H}" role="img" ` +
    `aria-label="Daily spending for the month, with the even daily budget marked">${parts.join('')}</svg>`;
}

/**
 * Spending per month, for History.
 *
 * The same marks as the daily chart, one step coarser, because it answers the same
 * question over a longer run: is this month like the others. Deliberately NOT a line
 * chart - a line reads as a continuous quantity sampled over time, and a month's
 * spending is a total that exists only once the month is over. Columns say "these are
 * twelve separate sums" where a line would draw a slope between two of them and
 * invite the reader to believe in the middle of it.
 *
 * The reference line is the average of the months that had any spending, so a run of
 * empty months at the start of a ledger does not drag it to nothing.
 */
export function monthlyBarsSVG(series) {
  const W = 320;
  const PLOT_TOP = 16;
  const PLOT_BOTTOM = 96;
  const AXIS_Y = 112;
  const H = 120;

  if (!series.length) return '';

  const n = series.length;
  const slot = W / n;
  const gap = Math.min(8, Math.max(3, slot * 0.28));
  const barW = Math.max(4, slot - gap);

  const spends = series.map((m) => m.spent);
  const peak = Math.max(...spends, 0);
  const withSpending = spends.filter((v) => v > 0);
  const average = withSpending.length ? withSpending.reduce((a, b) => a + b, 0) / withSpending.length : 0;
  const scaleMax = Math.max(peak, average, 1) * 1.15;
  const y = (v) => PLOT_BOTTOM - (v / scaleMax) * (PLOT_BOTTOM - PLOT_TOP);

  const parts = [];
  const bars = [];

  if (average > 0) {
    const ay = y(average);
    parts.push(
      `<line x1="0" y1="${ay.toFixed(1)}" x2="${W}" y2="${ay.toFixed(1)}" ` +
      `stroke="var(--ink-3)" stroke-width="2" stroke-dasharray="2 4" opacity="0.55"/>`
    );
  }

  series.forEach((m, i) => {
    const x = i * slot + gap / 2;
    if (m.spent > 0) {
      const top = y(m.spent);
      bars.push(
        `<path class="chart-bar" data-day="${i + 1}" ` +
        `d="${columnPath(x, top, barW, PLOT_BOTTOM - top, 4)}" fill="var(--brand)"/>`
      );
    } else {
      // A month that exists and holds nothing is not the same as a month that is not
      // in the ledger, and both are in this series. The stub is the difference.
      bars.push(
        `<rect class="chart-bar" data-day="${i + 1}" x="${x.toFixed(1)}" y="${PLOT_BOTTOM - 2}" ` +
        `width="${barW.toFixed(1)}" height="2" rx="1" fill="var(--line)"/>`
      );
    }
  });

  parts.push(`<g class="chart-bars">${bars.join('')}</g>`);

  // One direct label, on the biggest month, for the same reason the daily chart has
  // one: a number on every column at this width is a wall of digits.
  const peakIndex = spends.indexOf(peak);
  if (peak > 0) {
    const x = peakIndex * slot + slot / 2;
    const anchor = x < 40 ? 'start' : x > W - 40 ? 'end' : 'middle';
    const tx = anchor === 'start' ? 2 : anchor === 'end' ? W - 2 : x;
    parts.push(
      `<text x="${tx.toFixed(1)}" y="${(y(peak) - 5).toFixed(1)}" text-anchor="${anchor}" ` +
      `class="chart-peak">${esc(money(peak))}</text>`
    );
  }

  /*
   * Month initials, thinned until they fit rather than rotated. A tick under every
   * month is unreadable at 26px of slot, and turning the labels on their side to make
   * room asks the reader to turn their head to read an axis.
   */
  const every = slot >= 34 ? 1 : slot >= 24 ? 2 : 3;
  series.forEach((m, i) => {
    if (i % every !== 0 && i !== n - 1) return;
    const x = i * slot + slot / 2;
    const anchor = i === 0 && n > 1 ? 'start' : i === n - 1 && n > 1 ? 'end' : 'middle';
    const tx = anchor === 'start' ? 0 : anchor === 'end' ? W : x;
    parts.push(
      `<text x="${tx.toFixed(1)}" y="${AXIS_Y}" text-anchor="${anchor}" class="chart-tick">` +
      `${esc(monthLabelShort(m.ym).split(' ')[0])}</text>`
    );
  });

  // Full-height hit targets, so a thumb reaches a month whatever its bar is doing.
  // `data-day` is the index, not a date: app.js pins by position and looks the month
  // up in the same series it was drawn from.
  series.forEach((m, i) => {
    parts.push(
      `<rect class="chart-hit" data-day="${i + 1}" x="${(i * slot).toFixed(1)}" y="0" ` +
      `width="${slot.toFixed(1)}" height="${PLOT_BOTTOM}" fill="transparent"/>`
    );
  });

  return `<svg class="chart-daily chart-monthly" viewBox="0 0 ${W} ${H}" role="img" ` +
    `aria-label="Spending per month over the last ${n} months, with the average marked">` +
    `${parts.join('')}</svg>`;
}

/**
 * Part-to-whole across categories, as a donut.
 *
 * A donut asks the reader to compare angles, which people do less well than
 * comparing lengths, so it does not carry the reading on its own: the ranked list
 * underneath is the legend and gives every category a name, an amount, a share and
 * a bar of its own. What the donut adds is the whole - one shape you can see the
 * month in - and a hole to put the total in.
 *
 * Segments are separated by a 2px gap in the surface colour so two adjacent fills
 * never merge into one shape. A slice too thin to survive the gap keeps its full
 * angle instead of vanishing: a small category should read as small, not as absent.
 */
export function donutSVG(totals, selectedId) {
  const SIZE = 240;
  const C = SIZE / 2;
  const R_OUT = 104;
  const R_IN = 66;
  const R_MID = (R_OUT + R_IN) / 2;
  const GAP_PX = 2;
  const POP = 7;               // how far a chosen slice steps out of the ring

  const total = totals.reduce((a, t) => a + t.amount, 0);
  if (total <= 0) return '';

  const gapDeg = (GAP_PX / (2 * Math.PI * R_MID)) * 360;

  const point = (cx, cy, r, deg) => {
    const rad = ((deg - 90) * Math.PI) / 180;
    return [cx + r * Math.cos(rad), cy + r * Math.sin(rad)];
  };

  const ring = (cx, cy, from, to) => {
    const large = to - from > 180 ? 1 : 0;
    const [x1, y1] = point(cx, cy, R_OUT, from);
    const [x2, y2] = point(cx, cy, R_OUT, to);
    const [x3, y3] = point(cx, cy, R_IN, to);
    const [x4, y4] = point(cx, cy, R_IN, from);
    return `M${x1.toFixed(2)} ${y1.toFixed(2)} ` +
      `A${R_OUT} ${R_OUT} 0 ${large} 1 ${x2.toFixed(2)} ${y2.toFixed(2)} ` +
      `L${x3.toFixed(2)} ${y3.toFixed(2)} ` +
      `A${R_IN} ${R_IN} 0 ${large} 0 ${x4.toFixed(2)} ${y4.toFixed(2)} Z`;
  };

  // One category is the whole month: a full ring, because a 360 degree "slice" with
  // a gap cut into it reads as a broken circle rather than as everything.
  //
  // A circle has to be two half-arcs. An arc that ends where it starts is degenerate
  // and SVG is entitled to draw nothing, or anything; the first version of this drew
  // two overlapping discs. Splitting at the opposite side gives each arc real
  // endpoints, and evenodd punches the inner circle out as the hole.
  if (totals.length === 1) {
    const t = totals[0];
    const circle = (r) =>
      `M${(C - r).toFixed(2)} ${C} ` +
      `A${r} ${r} 0 1 0 ${(C + r).toFixed(2)} ${C} ` +
      `A${r} ${r} 0 1 0 ${(C - r).toFixed(2)} ${C} Z`;
    return wrap(
      `<path d="${circle(R_OUT)} ${circle(R_IN)}" fill="${seriesVar(t.id)}" ` +
      `fill-rule="evenodd" class="donut-slice" data-slice="${esc(t.id)}"/>`
    );
  }

  let cursor = 0;
  const parts = [];

  for (const t of totals) {
    const sweep = (t.amount / total) * 360;
    // Inset for the gap, unless the slice is too thin to give the gap away.
    const inset = sweep > gapDeg * 2.5 ? gapDeg / 2 : 0;
    const from = cursor + inset;
    const to = cursor + sweep - inset;
    const chosen = selectedId === t.id;

    let cx = C;
    let cy = C;
    if (chosen) {
      const [px, py] = point(0, 0, POP, cursor + sweep / 2);
      cx += px;
      cy += py;
    }

    parts.push(
      `<path d="${ring(cx, cy, from, to)}" fill="${seriesVar(t.id)}" ` +
      `class="donut-slice${chosen ? ' is-chosen' : ''}${selectedId && !chosen ? ' is-dimmed' : ''}" ` +
      `data-slice="${esc(t.id)}"/>`
    );
    cursor += sweep;
  }

  return wrap(parts.join(''));

  function wrap(inner) {
    return `<svg class="chart-donut" viewBox="0 0 ${SIZE} ${SIZE}" role="img" ` +
      `aria-label="Share of spending by category. The same figures are listed below.">${inner}</svg>`;
  }
}

/** A thin inline bar for a category row. One hue per category, no background track. */
export function rowBarSVG(share, categoryId) {
  const W = 100;
  const H = 4;
  const w = Math.max(2, share * W);
  return `<svg class="chart-rowbar" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" aria-hidden="true">` +
    `<rect x="0" y="0" width="${w.toFixed(1)}" height="${H}" rx="2" fill="${seriesVar(categoryId)}"/></svg>`;
}
