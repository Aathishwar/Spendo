/**
 * Spendo - motion that CSS cannot do on its own
 *
 * Nearly every animation in the app is a CSS rule. What lives here is motion that has
 * to know where something WAS: a row re-sorted into a new place, a balance counting on
 * from the figure it showed a moment ago, a bar growing from its old height. CSS
 * animates from one declared value to another, and none of those starting points is
 * known until it is measured, just before the screen is repainted.
 *
 * It runs on the Web Animations API and animation frames, which every browser already
 * has, so there is no library and nothing extra to download. anime.js does all of this
 * too - it calls the first one a layout animation - and was measured before any of
 * this was written: its bundle is 119KB, and with no build step to trim it, that is
 * what every phone would fetch to do what the functions below do.
 */

import { money, signedMoney } from './format.js';

/*
 * Durations and the curve come from tokens.css rather than being restated here, so
 * this moves in step with every other animation in the app, and stops moving under
 * prefers-reduced-motion, where tokens.css collapses the durations to 1ms.
 */
function token(name) {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

/** A duration token in milliseconds, or 0 when reduced motion has collapsed it. */
export function durationOf(name) {
  const value = parseFloat(token(name)) || 0;
  // 1ms is reduced motion asking for no movement, and anything that short would only
  // be a flicker. The change still happens; it just arrives at once.
  return value < 16 ? 0 : value;
}

/* ------------------------------------------------------------ a new screen */

/**
 * A new screen arriving, as one piece rather than card by card.
 *
 * It used to be a cascade: each card rose 10px in turn, then the first rows behind
 * them, for most of a second on every tab change and every launch. Fine once, slow on
 * the hundredth morning, and the owner asked for better. Two ways in now, both the
 * whole screen at once:
 *
 *   'through'        a fade with the faintest zoom - Material's "fade through", for
 *                    places that are not beside each other: the tabs, and the app
 *                    opening or reloading.
 *   'left', 'right'  a fade sliding in from that side - Material's "shared axis",
 *                    for stepping a month, which IS beside the last one, so the
 *                    direction says which way in time the reader went.
 *
 * The bars, the meter and the donut still draw themselves inside it: they carry the
 * numbers, and the screen arriving does not.
 */
export function enter(view, way = 'through') {
  const duration = durationOf('--dur-sheet');
  if (!duration) return;
  // Zoom about the middle of what is on screen, not the middle of a page that may be
  // three screens tall, or the top of the screen visibly slides.
  const origin = `50% ${Math.round(window.innerHeight / 2)}px`;
  const from = way === 'left' ? 'translateX(-24px)'
    : way === 'right' ? 'translateX(24px)'
      : 'scale(0.985)';
  const run = view.animate(
    [
      { opacity: 0, transform: from, transformOrigin: origin },
      { opacity: 1, transform: 'none', transformOrigin: origin }
    ],
    { duration, easing: token('--ease') || 'ease-out' }
  );
  // The first frame of this is the whole screen at opacity 0. If it never gets past
  // that frame, cancelling drops the effect and the screen is simply there.
  setTimeout(() => {
    if (run.playState !== 'finished') run.cancel();
  }, duration + 250);
}

/* ------------------------------------------------------------------- glide */

// How far a row arriving from out of sight travels into its place. See glide().
const ARRIVE = 16;

/**
 * Run `change`, then glide each child of `container` from where it was to where the
 * change put it.
 *
 * Children are matched across the change by `key`, not by node, so the change is free
 * to replace every one of them - which is how this app draws, from HTML strings. A row
 * found by what it is still glides from its old place, even though the node that was
 * there has gone.
 *
 * A child with no earlier position is new and simply appears. One that is out of sight
 * both before and after is left alone: nobody can see it move, and a month can be a
 * couple of hundred rows.
 *
 * A child arriving from out of sight does not make the whole trip. Measured from where
 * it really was, the largest expense of a month crossed the entire window in a third
 * of a second, and for most of that the top of the list sat empty waiting for it. It
 * rises the last few pixels into its place instead - the entrance a screen's rows
 * already make - from the side it came from, so the direction still says which way it
 * travelled.
 */
export function glide(container, change, key) {
  if (!container) {
    change();
    return;
  }

  // getBoundingClientRect includes a transform, so a second tap mid-glide measures
  // where each row is on screen and the new glide starts from there, not from a jump.
  const before = new Map();
  for (const el of container.children) before.set(key(el), el.getBoundingClientRect());

  change();

  const duration = durationOf('--dur-move');
  if (!duration) return;
  const easing = token('--ease') || 'ease-out';

  /*
   * Every position is read before any animation starts. Reading one, animating it and
   * then reading the next makes the browser recompute style between each pair, which
   * on a long month is two hundred recalculations instead of one.
   */
  const box = container.getBoundingClientRect();
  const top = Math.max(box.top, 0);
  const bottom = Math.min(box.bottom, window.innerHeight);
  const moves = [];
  for (const el of container.children) {
    const was = before.get(key(el));
    if (!was) continue;
    const now = el.getBoundingClientRect();
    const dy = was.top - now.top;
    if (Math.abs(dy) < 1) continue;
    const seenBefore = was.bottom > top && was.top < bottom;
    const seenAfter = now.bottom > top && now.top < bottom;
    if (seenBefore) moves.push({ el, dy, arrives: false });
    else if (seenAfter) moves.push({ el, dy, arrives: true });
  }

  const runs = [];
  for (const { el, dy, arrives } of moves) {
    /*
     * Who passes over whom. Rows rising pass over rows sinking: every row is opaque,
     * so one of each crossing pair is hidden, and it should not be the rows the reader
     * asked to see - the largest, on their way to the top. Arriving rows go under
     * both. They are part-transparent while they fade in, and one laid over a row
     * gliding through its slot showed two lines of text through each other.
     */
    if (!arrives) el.style.zIndex = dy > 0 ? '2' : '1';
    const frames = arrives
      ? [
        { opacity: 0, transform: `translateY(${Math.sign(dy) * ARRIVE}px)` },
        { opacity: 1, transform: 'none' }
      ]
      : [{ transform: `translateY(${dy}px)` }, { transform: 'none' }];
    const run = el.animate(frames, { duration, easing });
    const settle = () => { el.style.zIndex = ''; };
    run.onfinish = settle;
    run.oncancel = settle;
    runs.push(run);
  }

  /*
   * An animation can be created and never started - CLAUDE.md has this happening to
   * the snackbar twice - and one stuck on its first frame here is a row held at
   * opacity 0. Whatever has not finished when it should have is cancelled, which
   * drops the effect and leaves the row where the layout put it.
   */
  setTimeout(() => {
    for (const run of runs) if (run.playState !== 'finished') run.cancel();
  }, duration + 250);
}

/* ------------------------------------------------------- figures that move */

/*
 * How each kind of figure is written while it counts. The last frame is never one of
 * these: it is the exact text the renderer wrote, put back, so a paise amount or a
 * zero with no sign lands as it was drawn.
 */
const WRITE = {
  money: (v) => money(Math.round(v)),
  in: (v) => signedMoney(Math.round(v), 'in'),
  out: (v) => signedMoney(Math.round(v), 'out'),
  count: (v) => String(Math.round(v))
};

/**
 * What the reader can see of a screen's figures, read just before it is repainted.
 *
 * `[data-roll]` figures by their value, `[data-meter]` fills by their width, and chart
 * bars by their height. Only meaningful across a repaint of the SAME screen and month:
 * render() checks that before it asks, so nothing ever counts from one month's
 * balance to another's.
 */
export function capture(root) {
  const figures = new Map();
  for (const el of root.querySelectorAll('[data-roll]')) {
    figures.set(el.dataset.roll, Number(el.dataset.value));
  }
  const meters = new Map();
  for (const el of root.querySelectorAll('[data-meter]')) meters.set(el.dataset.meter, el.style.width);
  const bars = new Map();
  for (const el of root.querySelectorAll('.chart-bars [data-day]')) {
    bars.set(el.dataset.day, el.getBoundingClientRect().height);
  }
  return { figures, meters, bars };
}

/**
 * After the repaint, show what changed as a change.
 *
 * Each figure that moved counts from what it showed to what it says now, each meter
 * slides to its new length, and each bar grows or shrinks to its new height - all from
 * where the reader last saw them. Saving ₹500 then reads as the balance going down by
 * ₹500 and today's bar growing by it, instead of a month that is simply different.
 */
export function playChanges(before, root) {
  const duration = durationOf('--dur-count');
  if (!duration) return;

  for (const el of root.querySelectorAll('[data-roll]')) {
    const from = before.figures.get(el.dataset.roll);
    const to = Number(el.dataset.value);
    if (!Number.isFinite(from) || !Number.isFinite(to) || from === to) continue;
    count(el, from, to, WRITE[el.dataset.rollAs] || WRITE.money, duration);
  }

  for (const el of root.querySelectorAll('[data-meter]')) {
    const from = before.meters.get(el.dataset.meter);
    const to = el.style.width;
    if (!from || from === to) continue;
    // Drawn at the old width with no transition, then let go: the stylesheet's own
    // width transition carries it to the new one.
    el.style.transition = 'none';
    el.style.width = from;
    void el.offsetWidth;
    el.style.transition = '';
    el.style.width = to;
  }

  // Read every bar, then animate them: the same one-layout rule as glide().
  const easing = token('--ease') || 'ease-out';
  const grows = [];
  for (const el of root.querySelectorAll('.chart-bars [data-day]')) {
    const from = before.bars.get(el.dataset.day);
    if (from === undefined) continue;
    const to = el.getBoundingClientRect().height;
    if (to > 0 && Math.abs(from - to) >= 0.5) grows.push({ el, scale: from / to });
  }
  for (const { el, scale } of grows) {
    el.animate([{ transform: `scaleY(${scale})` }, { transform: 'none' }], { duration, easing });
  }
}

/*
 * Counted on animation frames, and landed on the rendered text whatever happens - a
 * phone that locks mid-count stops the frames, and a balance must never be left
 * showing a figure half way between two true ones.
 */
function count(el, from, to, write, duration) {
  const final = el.textContent;
  const start = performance.now();
  let done = false;
  const land = () => {
    if (done) return;
    done = true;
    el.textContent = final;
  };
  const step = (now) => {
    if (done) return;
    // A frame's timestamp can be a moment older than `start`, hence the floor.
    const t = Math.min(1, Math.max(0, (now - start) / duration));
    if (t >= 1) {
      land();
      return;
    }
    // Decelerating, like --ease: most of the change shows early and the figure
    // settles into place rather than stopping dead.
    const eased = 1 - (1 - t) ** 3;
    el.textContent = write(from + (to - from) * eased);
    requestAnimationFrame(step);
  };
  el.textContent = write(from);
  requestAnimationFrame(step);
  setTimeout(land, duration + 250);
}

/* --------------------------------------------------------------- crossfade */

/**
 * Change the whole page under a cross-fade, where the browser has view transitions.
 *
 * For a theme switch: every surface changes colour in the same frame, and a hard cut
 * from light to dark reads as a flash. Without the API, or under reduced motion, the
 * change simply happens.
 */
export function crossfade(change) {
  if (typeof document.startViewTransition !== 'function' || !durationOf('--dur-sheet')) {
    change();
    return;
  }
  const fade = document.startViewTransition(change);
  // A transition the browser skips - a hidden tab, a second one started on top -
  // still runs `change`, and rejects `ready`. That is not an error worth a console line.
  fade.ready.catch(() => {});
}
