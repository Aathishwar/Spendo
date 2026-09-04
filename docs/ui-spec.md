# Spendo - UI specification

Read this before writing any interface code. Tokens live in `../styles/tokens.css`; this
document says what to build out of them.

---

## Design read

Personal-finance product UI, one daily user, Android phone first, with a calm Material 3
product language, implemented as hand-rolled M3 tokens in plain CSS because the project has
no build step.

**There is no brand hue.** The chrome is ink on paper: buttons, the FAB, section marks and
the chart bars are all near-black. The colours that remain all carry information rather than
identity - `--spend` and `--receive` for direction, and the category series on the row tiles,
the donut and the Insights list. Nothing is coloured to look designed. See *Colour* below.

**Dials:** `DESIGN_VARIANCE 3` · `MOTION_INTENSITY 4` · `VISUAL_DENSITY 5`.

Low variance is the correct setting and not a compromise. A money app opened several times a
day should be boringly predictable: the same card in the same place, the total where it was
yesterday. Asymmetry, scroll hijacking and editorial layout are all wrong here.

### On Material 3

The reference screenshots are Material 3. The official route would be `@material/web`, but
that package is ESM web components that expect bundling, and this project's whole premise is
zero build step and zero runtime network requests. So we implement M3's specifications -
tokens, shape scale, state layers, elevation, motion easings - by hand in CSS.

Call it what it is in comments: Material 3 informed, not the official package. Do not claim
compliance we are not testing for.

---

## What we take from the reference, and what we change

**Kept**, because it is why the reference reads as clean and professional:

- White cards on a light grey page, generous 16px radius, hairline-free separation.
- One screen, one primary number, stated large.
- Rows built as `date · icon tile · title over category · amount`, right-aligned amount.
- Full-pill chips for filters and segmented choices.
- Extended FAB with a label, not a bare circle with a plus in it.
- Uppercase field labels above filled inputs.
- Bottom navigation with icon plus label, four items.

**Changed**, with reasons:

| Reference | Spendo | Why |
|---|---|---|
| Teal for actions, blue for every number | One teal for both | Two accents competing means neither reads as "the brand". The reference's own teal, `#00695c`, now does both jobs and no blue appears in the interface at all. |
| Handwritten script font on chips | Same family as the rest of the UI, medium weight | A second, decorative typeface inside a control is the reference's weakest move. Chips are controls, not decoration. |
| 5 tabs including Friends and Groups | 4 tabs | Spendo is single-user. There is nothing to split with anybody. |
| Category rows with a chevron into a filtered list | Same, but the chevron only appears where a destination exists | A chevron that goes nowhere is a lie about affordance. |
| "Connect your data" card with PRO badges | Not built | There is no paid tier and no SMS parsing in a PWA. Shipping a disabled upsell in a personal app is noise. |
| Light mode only | Light and dark, following the system | The app is opened at night. Track8 is dark-first and this one is opened next to it. |
| Uniform grey icon tile on every row | Tile tinted to the row's category | The categories exist and carry colour on the Insights screen. Spending the same colour on the list makes a row identifiable before its text is read. |

---

## Screens

Four tabs plus modal surfaces. Every screen is a single scrolling column, `max-width 560px`,
centred on wider viewports, `padding-inline: var(--space-4)`.

### 1. Home

The tab is labelled **Home**. Its internal id stays `today`, because the screen is scoped to
one month and defaults to the current one; renaming the id would touch every branch in
`render()` for no user-visible gain.

Top to bottom:

1. **Screen title.** "August 2026", `--text-title`, `--weight-bold`, left aligned. The month
   is the title because the month is the unit of the whole app.
2. **Balance card.** Remaining balance in `--text-hero`, `.money`, on the one dark surface in
   the app. A meter under it for the single ratio of spent against pot, then one line of
   context in `--text-caption`: spent of pot, and days left. No ring, no chart. This card is
   glanced at, not studied.

   **A month with no opening figure and no income reads oddly here**: balance is then just
   negative spending, and the meter divides by a pot of zero, so the card shows a figure like
   `-1,901` and a note reading "1,955 of 54 used". A second hero mode that reported total
   spending instead was built and then rewound at the owner's request. Opening money is
   therefore a step the user is expected to take, which is why the empty state leads with it
   and the walkthrough's last screen explains it. Worth revisiting if the app is ever used by
   someone who only records what they spend.
3. **Expense list**, newest first, in a **window of its own** rather than running on down
   the page. See *Two scrollers* below for the sizing and the handover. There are no per-day
   headings: every row states its own date, the way the reference does, and the month is
   already the screen title. A row is:
   `[Aug over 31] [icon tile] [description over category] [direction over amount]`
   The direction is spelled out in words above the figure, "you paid" or "you received", and
   both the words and the figure take `--spend` or `--receive`. The words are what make the
   colour a second channel rather than the only one, which is also why the amount carries no
   sign: the label already says which way the money went.
4. **Extended FAB**, "Add", pinned bottom right above the nav bar, `--r-pill`, `--brand`
   fill, `--on-brand` label, `--shadow-fab`. Its glyph is the rupee bag, not a plus: the
   button records an entry rather than incrementing something, and a bare plus reads thin and
   generic at this size.

   **It sheds its label as soon as the page is scrolled** and takes it back at the top,
   collapsing to a 56px circle of the same fill. Reading the month and adding to it are
   different moments: while the user is reading, the button only has to stay findable, and
   the word is covering part of a row. The tap target is 56px either way, so nothing is lost
   but width. The button keeps `aria-label="Add"` throughout, because the visible word is
   gone in the collapsed state and the control still has to have a name.

   The width is never animated directly - `auto` does not interpolate. The label's own
   `max-width` and the button's padding are, and the width follows from them.

   **It appears on this screen only.** On History it would be ambiguous, since that screen is
   a list of months and an entry has to land in one of them; on Insights and Settings adding
   is not the action of the screen.

**Spending per day** sits between the balance card and the list, one bar per day of the
month with the even-spread budget drawn under them as a dashed reference line. Tapping a day
pins its date and figure in a tip above the chart and drops every other bar to 32%; tapping
the same day again, or anywhere off the chart, clears it. It is a pin rather than a hover
because hover is not a gesture a phone has - the first version showed the figure on
`pointermove` and hid it on `pointerleave`, and a touch fires both, so on a phone the readout
appeared and vanished inside the same tap. A mouse still gets the hover preview, but only
while nothing is pinned. Nothing about the pin survives a re-render: it is a reading of the
chart, not a setting.

**Swipe a row left to delete it**, in the two-stage form: a short swipe puts a Delete
button on screen and waits, a long one deletes. The row rides on a track with the delete
surface underneath, so nothing is created mid-gesture - the row moves and what was always
behind it is revealed. Four zones, all measured on how far the finger travelled:

| travel | on release |
|---|---|
| under 14px | nothing. It was a tap, or a scroll |
| 14-46px | springs back |
| 46-150px | parks open at 104px, Delete exposed and tappable |
| over 150px | deletes |
| over 210px | deletes at once, without waiting for the release |

Past 104px the row rubber-bands, so it cannot be dragged off the screen and the change in
resistance is the gesture saying which of the two things it is about to do. A parked row
closes when you tap it, tap or swipe another row, or scroll - and the tap that closes it
does nothing else, because the way out of a gesture should not also be a way into a
screen nobody asked for.

Left only. Right is where Android's back gesture lives, and that is not a fight worth
picking at the edge of the screen. `touch-action: pan-y` is what makes the two gestures
coexist: vertical belongs to the list, horizontal to the row, decided by the browser
rather than by two handlers arguing. The axis is chosen once, on the first movement past
the slop, and never revisited - deciding continuously is what makes a diagonal drag feel
like the list is fighting the thumb.

Leaving happens in two stages, and the second is the one usually skipped: the row slides
out and fades, THEN the track collapses its height, so the rows below rise into the gap
instead of jumping up. Undo plays it back the other way, and a restored row arrives with
the same entrance a new row gets, because that is what it is.

Delete is optimistic with a **6 second** undo snackbar, and deletes inside that window
BATCH - three swipes are one bar reading "3 deleted" with one Undo that puts all three
back, not three bars stacked up to dismiss. **Nothing reaches the server until the window
closes.** The record is tombstoned locally the instant it is swiped, which is what makes
the row vanish and survive a reload, but it is held out of the push until the offer to
undo is gone from the screen. If the app is killed inside the window the hold dies with
it and the tombstone syncs on the next boot, which is correct: the delete did happen, and
only the offer to undo it was lost.

The gesture is not the only way to delete - the button inside the detail sheet is the
keyboard and screen-reader route, and both go through the same path.

### 2. History

A list of months. Each row: month name and year, total spent, closing balance, and a state
chip when the month is closed. Tapping a month opens the Home layout scoped to that month,
read-only for closed months.

Above the list, two cards.

1. **Spending over time**, one column a month for up to twelve months, with the average of
   the months that had any spending as the dashed reference line. Columns and not a line:
   a line reads as a continuous quantity sampled over time, and a month's spending is a
   total that exists only once the month is over, so a slope drawn between two of them
   invites the reader to believe in the middle of it. A month in the window with nothing in
   it keeps its slot as a 2px stub - a gap in a run of months is a fact about the months,
   and closing it up would make two Januaries look adjacent. Tap a column to pin its figure,
   the same gesture as the daily chart on Home. Below two months of data the card is left
   out rather than drawn as one column with an average line through the top of it.
2. **Where to cut**, three suggestions behind a button. The figures are on the device and
   are already on this screen; what the model adds is the sentence. It is asked for rather
   than run on arrival, because advice nobody asked for is nagging and because this is the
   one screen where a person is already looking at what they spent. Suggestions are stored
   stamped with the figures they came from, so they survive a reload and are thrown away
   the moment an edit moves the numbers under them. Signed out, the card says so and does
   nothing else; unreachable, it says it could not get suggestions and the screen loses
   nothing it had before.

### 3. Insights

1. **Month stepper**, the same control as Home, so moving between months behaves
   identically wherever you are. The chosen month is shared app-wide: stepping here also
   moves Home. Next is disabled at the current month, since there is nothing ahead of it.
2. **Donut**, with the total in the hole. A donut asks the reader to compare angles, which
   people do less well than comparing lengths, so it does not carry the reading on its own:
   the ranked list beneath is the legend and gives every category a name, an amount, a share
   and a bar of its own. What the donut adds is the whole, one shape you can see the month
   in, and a hole with room for the number the reader came for.

   Segments are separated by a 2px gap in the card colour so two adjacent fills never merge.
   A slice too thin to survive that gap keeps its full angle instead of vanishing: a small
   category should read as small, not as absent. One category holding the whole month draws
   as an unbroken ring, because a 360 degree slice with a gap cut into it reads as broken.

3. **Tap a slice or a row** and that category is chosen: the slice steps out of the ring, the
   others drop to 32% rather than disappearing so the choice is still read against the whole,
   the hole switches to that category's name, amount and share, and its row takes a brand
   stripe. Tapping again clears it. Changing month or tab clears it too, since a chosen slice
   belongs to the month it was chosen in.

Categories are the reason this screen can exist. The n8n workflow had none, so the old
monthly report grouped by exact description text, which produced a "category" per typo.

The colours are the twelve validated categorical slots from `tokens.css`, assigned by identity
and never by rank, so a category keeps its colour whatever it does this month. Twelve is past
the point where colour alone separates every pair for a reader with CVD, which is why the
ranked list under the donut always prints the name, the amount and the share: the slots make
the chart scannable, the list makes it readable.

### 4. Settings

Three sections, each a `listHead` plus a `field-rows` group, so the screen reads as one
settings surface rather than as loose cards: opening money, appearance, and your data.
Explanatory prose sits under its group in `--ink-3`, never inside a row.

Field labels are short nouns. A long value like a month name belongs in the value column, not
the 92px label column, where it wraps.

Opening money offers **Set** and **Add** as two separate labelled actions. The old bot said
"set" in its help text and added in its code.

### Modal surfaces

**Add expense** - a bottom sheet, not a screen, because it is opened and dismissed dozens of
times a week and a sheet keeps the list visible behind it.

Order matters: amount first, because that is the field the user came to fill. The reference
puts description first, which means every entry starts with the least urgent keystroke.

```
AMOUNT        [ ₹ ] [ 0.00 ]        numeric keypad, autofocus
DESCRIPTION   [ ......... ]         free text, recent descriptions as suggestions
CATEGORY      ( Food ) ( Transport ) ( Groceries ) ...    scrollable chips
DATE          ( Today ) ( Yesterday ) ( Pick a date )   chips
              ( I paid ) ( I received )                   segmented, default "I paid"
```

Save is a full-width pill button at the bottom of the sheet, disabled until amount is a
positive number and description is non-empty. Disabled state keeps AA contrast; it is dimmed
by opacity on the label, never by making the button invisible.

**Search** - not a modal. Tapping the magnifier on the Transactions header opens a field
**in place**, directly under that header, and the list beneath it filters on every keystroke.
A sheet would have covered the very list the query is filtering.

Scope is the month on screen, because that is the list the field sits on top of, and
filtering a visible list into results from a month you are not looking at is a lie about what
you are seeing. When the query matches nothing here but something elsewhere, the note under
the field says so and offers to jump: "Nothing in August 2026. 1 match in other months". That
jump keeps the query and the focus, so the user carries on typing.

Results are newest first, the same order as the unfiltered list, and reuse the row component
exactly. The note reports the count and the total spent.

Operators carried over from the old bot: `>500`, `>=500`, `<200`, `<=200`, `100-500`, and a
bare number for an exact amount. Everything else is a keyword, and all keywords must match,
which is how `/search coffee zomato` behaved. Date operators arrive in phase 5.

Escape closes the field rather than only clearing it, and closing drops the query, so
reopening never shows a filtered list the user does not remember filtering. Changing tab or
month does the same.

---

## Type

**Geist**, self-hosted, latin subset, variable weight. 29KB for the whole family, vendored
from `@fontsource-variable` into `fonts/`, precached by the service worker. Still no request
leaves our origin.

The system stack was the honest starting point and gave the app no voice of its own. On a
screen that is mostly numbers, the numerals are the voice.

**Money is the same face with `tabular-nums`, not a monospace one.** Geist Mono was tried and
removed: a true monospace gives the comma a full cell, so a balance renders as "7 , 303" at
display size. Geist's own tabular figures were measured at 40px, where `1111` and `0000` both
set to 96px, so column alignment is real rather than assumed, and the comma stays tight. That
also saved 23KB and a request.

Scale, and what each step is for:

| Token | Size | Used by |
|---|---|---|
| `--text-hero` | 44px | The balance, and nothing else in the app. |
| `--text-display` | 34px | A screen's leading number. |
| `--text-title` | 28px | Screen title. |
| `--text-section` | 20px | Section heading. |
| `--text-row` | 16px | List row title and amount. |
| `--text-body` | 15px | Body. |
| `--text-caption` | 13px | Category, date, helper, notes. |
| `--text-label` | 12px | Uppercase field labels. |

Display sizes take `--track-tight` (-0.03em), because Geist sets loose by default at scale.
Weights stop at 600: Geist's 700 is heavy enough to look shouted in a 44px figure.

## Components

### Hero card

The balance card, and **the only saturated surface in the app**. Everything else is white or
near-black, and that is exactly what lets this one card carry the accent without the accent
becoming noise. Spend the boldness in one place and keep everything around it quiet.

Light mode uses the accent itself as a two-step gradient of the same hue, `--hero` to
`--hero-edge`. Dark mode uses a deep teal instead of the pale accent, because at night the
card should sit above the page rather than be a slab of light on it. Text comes from
`--on-hero` and `--on-hero-dim`; the semantic red and green never appear on this card, since
neither reads against teal.

It carries a **meter**: spent over the month's whole pot. A single ratio against a limit is a
meter, not a chart. One track, one fill, the same family of colour, no axis and no legend.
History rows carry the same meter at 4px so a month reads as a proportion rather than as two
figures the reader has to divide in their head.

### Colour

The app had a deep teal accent, `#00695c`, which is Material's Teal 800 used as a flat fill
across the balance card. It read as a slab, and as every other finance app. It is gone.

| Token | Value (light) | Job |
|---|---|---|
| `--hero` | `#171a18` | The balance card. The one dark surface on a light screen. |
| `--brand` | `#1b1f1c` | Buttons, FAB, section marks, chart bars. Ink, not a hue. |
| `--bg` | `#f0f1ef` | Page ground. Warm-neutral, not the stock blue-grey slate. |
| `--surface` | `#ffffff` | Cards and the ledger. Unchanged: the chart palette is validated against this exact value. |
| `--spend` | `#b42318` | Money out. |
| `--receive` | `#146c34` | Money in. Matched in weight to `--spend` (6.5:1 vs 6.6:1). |

Two rules that are easy to get wrong and were both got wrong first time:

**Check the channels, not the swatch.** The first ink ramp was `#15181a` / `#4a4f52` /
`#676d70`. Every one of those has *blue* as its highest channel: a cool grey ramp on a warm
ground, which is the exact mismatch the ground had just been repicked to fix. The shipped
ramp has green highest throughout.

**Measure on both grounds.** Captions sit on `--bg` as often as on `--surface`, so a value
that only clears 4.5:1 against white is half checked. `--ink-3` is 5.2:1 on white and 4.6:1
on the ground.

### Elevation

Elevation is spent only where it means something. There used to be a `--shadow-row` and every
transaction wore it; twenty-four lifted cards is not hierarchy, it is texture.

| Token | For | Why |
|---|---|---|
| `--shadow-hero` | The balance card | It leads the screen. Tinted to the ground, never black. |
| `--shadow-card` | Cards, and the ledger surface | Chart, empty states, sheets, the transaction list. |
| (none) | List rows | They are lines inside one surface, divided by `--line`. |

### Page ground
`--bg` with two faint diagonal repeating gradients in `--watermark` over it, fixed to the
viewport. This is the reference's textured paper. It is deliberately near the threshold of
visibility: at any strength where the lines read as a grid, it is wrong.

### Card
`--surface` background, `--r-card`, `--shadow-card`, `padding: var(--space-4)`. No border in
light mode. In dark mode add `1px solid var(--line)`, because shadow alone does not separate
surfaces on a dark ground.

### The ledger, and one row of it

Rows are lines inside **one** surface, not a stack of cards. `.group-rows` is the surface:
`--surface`, `--r-card`, `--shadow-card`, and `.group-rows > :not(:first-child)` carries a
1px `--line` divider. First and last rows inherit the surface's corners.

`:not(:first-child)` rather than the obvious `* + *`: at equal specificity the later rule
wins, and `.row { border: 0 }` sits further down the file, so the simple version shipped a
ledger with no dividers in it at all.

In dark mode the 1px edge goes on **`.group-rows`**, not on `.row`. Putting it on the row
draws a box round every line and undoes the hairlines.

One row: minimum height `--tap-min`, padding `--space-3 --space-4`. Leading date column 34px,
short month over the day number in `--ink-3`, day at 1.25rem tabular. Icon tile 40px,
`--r-tile`, filled with a 12% mix of the category hue and carrying the category glyph in that
hue. Title `--text-body` `--weight-medium` `--ink`. Category `--text-caption` `--ink-3`.
Amount `--text-row` `--weight-semibold`, `.money`, **signed**, semantic colour, right aligned.

The tiles were briefly monochrome, on the argument that eight pastels compete with the two
colours that carry meaning. Put back at the owner's request: the tiles are how the list is
scanned, and the same hue identifies a category here and in the donut on Insights, which is
worth more than the extra restraint. The signed amounts mean direction still has a channel
that is not colour, so nothing was lost by putting the hues back.

The direction used to be spelled out on every row, "you paid" above the figure, so that
colour was not the only channel. **The sign does that job now**, in a quarter of the space
and without repeating a phrase the reader learned on row one. The words stay in an `.sr-only`
span, where repetition costs nothing and is the only channel there is.

Press feedback is a background change, not `scale()`. A row is the full width of its surface
and cannot be pushed away from the reader the way a free-standing button can.

### The ledger's total line

Money in against money out, at the foot of the transaction list, in the band the Add button
floats in.

That band was 84px of reserved ground with a 56px button in one corner of it, held clear so
no row could sit under the button. Reserving it vertically wasted the other 260px. The
reserve is now horizontal - `--fab-clear`, on the total line's `padding-right` - and the band
carries the one reading Home did not already have. The hero gives a balance and a share of
the pot; the figures give averages and a count; money in against money out appeared nowhere.

`--fab-clear` is sized for the button's **expanded** width, about 101px, not its collapsed
56px. A list short enough that the page barely scrolls leaves the label showing while the
total line is on screen. Checked at the worst case: expanded button plus eight-digit totals
(`+₹98,76,543` / `-₹56,31,427`) still clears by 42px with no wrap.

It sums **the rows actually listed**, so a filtered list gets the filtered totals, and
`updateSearchResults()` repaints it on every keystroke alongside the rows. A month total
under a search result would be a total of things not on screen.

Zero gets no sign and no colour. Nothing has no direction, and `-₹0` is not a total.

### Figures

Three figures on the page ground, divided by hairlines: `.figures` / `.figure`. They were
three identical white cards, which is the most-copied layout on the web and says nothing:
three equal boxes claim the three numbers are three separate objects when they are one
reading of one month.

### Chip
`--r-pill`, height 36px, `padding-inline: var(--space-4)`, `--text-body`
`--weight-medium`. Unselected: `--surface-sunken` on `--on-sunken`. Selected: `--brand` on
`--on-brand`. Selected state also sets `aria-pressed`, so the change is not colour-only.

### Button
Primary: `--brand` fill, `--on-brand` label, `--r-pill`, height 48px. Text: `--brand` label
on transparent. Both get `transform: scale(var(--press-scale))` on `:active` over
`--dur-instant`.

Every button label fits on one line. Three words maximum, ideally two.

### Field
Filled style: `--surface-sunken` background, `--r-field`, no outline at rest, 2px `--brand`
outline on `:focus-visible`. Label sits above in `--text-label`, uppercase,
`letter-spacing: var(--track-label)`, `--ink-3`. Helper text below in `--text-caption`; error
text replaces it in `--spend`. Placeholder is never the label.

**Errors clear on input, not on the next submit.** An error describes the state of a field,
and typing in that field is the user answering it. Leaving the message up until the next Save
put "Say what it was for." under a description with text already in it.

### The amount field

`type="text"` with `inputmode="decimal"`, on purpose: `type="number"` brings a spinner, a
browser-shaped validation bubble, and no usable caret control.

The price of that choice is that nothing stops a letter going in, so the field enforces it
itself. `cleanAmount()` runs on every `input` and allows digits, one dot, and two places
after it; the caret is restored to where the user's own characters are, so a stray letter
typed mid-figure does not throw it to the end.

**Validation reads the value literally.** It used to be
`parseFloat(value.replace(/[^0-9.]/g, ''))`, which accepted `8979erte` and saved 8979 - a
figure the user never typed. A field that quietly invents a different number from the one on
screen is worse than one that refuses. `Number()` on the trimmed string returns NaN for junk,
and the error says so.

One case worth knowing: dots before the first digit are dropped rather than treated as the
decimal point, because stripping "Rs. 1,299.994" leaves ".1299.994" and the dot from "Rs."
would make it read .12. The trade is that typing ".5" gives 5 rather than 0.5.

All three amount inputs - add, edit, and opening money - share `name="amount"`, so one
delegated rule covers them.

### Sync, in Settings

The only place a sync problem is ever reported.

Nothing about saving an expense touches the network, so a sync failure is not an
interruption to be thrown in front of someone recording what they spent on lunch. It is a
fact to come and look at. No screen blocks on a request, no save shows a spinner, no failure
opens a dialog.

Four lines: what it is doing in words, when it last succeeded, the first eight characters of
the account id, and a Sync now button. The number that actually matters is **how many changes
are still only on this phone**, so that is what the status line says when there are any.

Colour is never the only channel - `is-ok` and `is-warn` only tint a value that already
spells the state out.

### Two scrollers

Home has a scrolling page and, inside it, a scrolling list. They are sized and sequenced so
they read as one gesture rather than as two things fighting over a drag.

**Sizing.** The list section is
`max-height: calc(100dvh - var(--nav-height) - var(--safe-bottom) - var(--fab-reserve))`,
and on a screen that contains one, `.view` drops its usual bottom padding to
`var(--fab-reserve)`. Those two together make the geometry exact: at the page's last pixel of
scroll, the **Transactions** header sits at the top of the screen and the rows fill
everything below it down to the band the Add button floats in. Measured at 390x844: header
`top: 0` at max scroll, eleven whole rows visible, 10px of clearance between the last row and
the button.

**How many rows that is depends on the phone** - around ten on a 6.1 inch screen, a couple
more on a taller one. A fixed row count was the other option and it is the wrong one: it
leaves a strip of dead ground on one device and clips on another. The rule is "one screenful,
with the header at the top", and the count falls out of it.

**Containment.** `.list-scroll .group-rows` carries `contain: paint`. Without it the inner
scroller's overflow leaks into the *document's* scroll height: measured 1781px of page scroll
for a 1456px page, so the reader could drag 325px past the end and the list drifted upwards
under its own pinned header. Neither `overflow-y: hidden` nor `overflow-x: hidden` stops it;
paint containment does, because it is the thing that actually promises the browser nothing
inside will be drawn outside.

**Handover.** The rows container is `overflow-y: hidden` until the page has nowhere left to
go, at which point `app.js` adds `.is-scrollable` and it becomes `auto`. Without that lock
the browser hands every drag to the inner scroller, which is the nearer one, and the list
would scroll its rows while the chart above it was still on screen and the page had not moved
at all. Chaining back out is left at the default, so a drag downwards at the top of the list
carries on into the page and brings the chart back.

The header is `position: sticky; top: 0` inside the section, on `--bg`. With the geometry
above it never actually needs to move, so it is there as the safety net for the case the
geometry is off by a pixel - a 1px nav border, a safe-area inset, a browser without `:has()`
support that keeps the old bottom padding.

Clipped, not hidden: the row the window cuts through stays half visible and is what says
there is more underneath.

### Walkthrough

Three screens on first run, remembered in `settings.seenIntro`, replayable from Settings.

They exist because two things about this app are not guessable from looking at it: that the
Add button records money arriving as well as money leaving, and that the balance counts down
from an opening figure the user has to set. Everything else the interface explains by being
used, so it is not explained here.

Centred, and that is the one place in the app where centred is right: a mark, a line and a
sentence are a single moment each, not a layout to scan. Everywhere else Spendo is left
aligned because everywhere else the reader is comparing figures down a column.

The dots are progress, not decoration: they say how many screens there are and which one this
is, which is the whole reason a reader tolerates an intro at all.

Marked seen when it closes, **however** it closes: Start tracking, Skip, Escape, or a tap on
the backdrop. Marking it only on the button would mean anyone who dismissed it any other way
met it again every launch, which is how an intro turns into an obstacle.

### Bottom navigation
Fixed, `--surface`, `1px` top `--line`, height `--nav-height` plus `--safe-bottom`. Four
items: Today, History, Insights, Settings. Active item is `--brand` for both icon and label
plus a `--brand-tint` pill behind the icon. Inactive is `--ink-3`.

### Calendar

Ours, not the browser's. `<input type="date">` cannot be styled: it opens in the browser's own
blue, in the browser's own shape, and reads as a different product dropped into the sheet.

Most expenses are today or yesterday, so those are two chips and cost one tap. The third chip
opens the calendar and shows the chosen date once it is neither.

The calendar is a **mode of the sheet that opened it**, not a sheet of its own, so it hands
the date back to the add sheet or the detail row it came from and the draft survives the trip.
Cells are square by `aspect-ratio` and sized by the grid, so the month fits any phone width.
Today is outlined and the chosen day is filled, which lets both be true at once. Days after
today are disabled rather than hidden: an expense is something that already happened, and a
future day should read as unusable, not as a hole in the month.

### Detail sheet
Opened by tapping any row, and the only place an entry is edited. Five rows, one per field:
amount, description, category, date, direction. Each carries its own pencil and opens **in
place**, where the value already sits, rather than dropping the whole record into a form.
Correcting one wrong digit should not make the user re-confirm four fields that were already
right.

The open row gets a 2px `--brand` stripe down its left edge and a `--surface` background
against the sunken group. Text fields commit with a tick button or Enter; category and
direction commit on tap, since choosing from a set is already the confirmation.

Switching direction moves the entry to that direction's default category when the current one
does not exist on the other side. An expense category on an income row would otherwise sit
there mislabelled.

### Snackbar
**Top**, below the status bar via `--safe-top`. At the bottom it landed on the Add button and
the nav bar, the two things most likely to be tapped next, and its Undo sat under the thumb
that had just pressed Save.

`--r-pill`, dark surface in both themes, one action ("Undo"), 6 second timeout. Centred with
auto margins rather than `translateX(-50%)`, so layout owns position and nothing else can
take that property over.

It has **no entry animation**, deliberately. See the note in `app.css`: an animation started
as the element goes from `display: none` to shown can be created and never committed to a
frame, leaving it at its first keyframe for good. Position and visibility are not negotiable
for a component whose job is to report what just happened.

### Several at once

Reached from a **Several** button at the far end of the add sheet's title bar
(`margin-left: auto`, never a spacer). One sheet, four states - the person is doing one
thing, and a flow that closed and reopened between speaking and reviewing loses the
thread.

| State | What is on screen |
|---|---|
| ask | an 88px mic orb, a 3-row textarea, and one line saying where the audio goes |
| listening | the orb in `--spend` with a pulsing halo, the transcript in a `min-height` box |
| reading | a dot-pulse and a line of copy, the sentence quoted, three skeleton rows |
| review | one row per draft, then Add / Start over |

**The mic orb is 88px** because it is pressed while talking rather than while looking,
and because starting is the only action on that screen. Everything else there is
deliberately smaller than it.

**The transcript box has a `min-height`, not a height.** Speech recognition revises what
it heard, so the text shortens as often as it lengthens, and a box that tracked it
exactly would jump on every revision.

**A review row is checkbox + [amount][description] + [category][direction][date].** The
amount leads, which is the reverse of every other row in this app - and it is deliberate.
Everywhere else the description leads and the figure is read off the right edge; here the
amount is the field most likely to be WRONG, because it came out of a microphone, so
putting it under the thumb first is putting the correction first.

Chips inside a row take `.chip-raised` (`--surface`). The default chip background IS
`--surface-sunken`, which is exactly what the row is made of, so on this one screen the
category and direction chips came out looking like plain text with an icon beside them.
Everything changeable in a row now shares one surface.

**An unticked row is dimmed to 0.55, never hidden and never struck through.** The reason
somebody unticks a row is usually that the amount is wrong, and the next thing they may
do is fix it and tick it again. A row that disappeared would make that a re-dictation.

### Waiting

Any wait that can exceed four seconds changes its wording, in three stages:

| after | says |
|---|---|
| 0s | "Reading that" / "Reading your last few months" |
| 4s | "Still reading - that is a long one" |
| 12s | "Taking longer than usual. It gives up at 25 seconds" (30 for suggestions) |

Each stage tells the reader something they did not know a moment ago. A line that never
changes reads as a hang at about four seconds, whatever it says.

Only the FIRST line names what is being read, and only the last names the deadline. Each
stage is a whole sentence, not a prefix with a subject stuck on the end - written the
other way it produced "Still reading - that is a long one your last few months".

The stage line is rewritten by setting `textContent` on ONE node, never by re-rendering
the screen or the sheet. Re-rendering restarts every animation inside it once a second,
which reads as a stutter rather than as progress.

Every looping animation in these states - the mic halo, the dot pulse, the skeleton sweep
- is off under `prefers-reduced-motion`. The copy beside them already says what they say,
and a loop that runs for the length of a wait is exactly what a vestibular trigger looks
like.

---

## States

Every list and every fetch ships four states. The success state alone is not a finished
component.

- **Loading** - skeleton blocks shaped like the real rows, on `--surface` (the RAISED
  colour, matching the inputs they stand in for), with a gradient sweeping across them.
  Never a centred spinner.

  Two rules learnt building the bulk review sheet. The bars must be legible **standing
  still**: built on `--surface-sunken` they were the same shade as the row behind them,
  so between sweeps there were three blank rounded blocks with no shape in them. And a
  wait over four seconds must **change its wording** - see Waiting below.
- **Empty** - one line of plain text saying what to do next, plus the action that does it.
  "No expenses in August yet." with the Add expense button underneath.
- **Error** - inline, in place, with the reason and a retry. Toasts only for things that
  passed and can be forgotten.
- **Offline** - not an error state. The app writes locally and returns; a small "saved on
  this device" note appears only when a sync has been pending long enough to be worth
  mentioning.

---

## Icons

Phosphor, vendored from `@phosphor-icons/core` into `icons/sprite.svg` and inlined into
`index.html`, because Chrome does not resolve `<use>` against an external file. No CDN, no
React package, no hand-drawn paths.

One family, three weights, each with a job:

- **regular** for everything by default.
- **fill** for the active bottom-nav item only. Weight, not just colour, marks the current
  section, so it survives a colour-blind reader and a greyscale screenshot.
- **bold** for the two marks that carry a whole control on their own: the plus in the Add
  button and the tick that commits a field edit.

**Glyphs are chosen for legibility at 22px, not for literal accuracy.** `receipt` is the
semantically correct icon for a bill and reads as a speech bubble at that size, so Bills uses
`lightning`. Shopping uses `shopping-bag` rather than `t-shirt`, which was both mushy and too
specific. When a glyph and a size disagree, the size wins.

A section header is: the section's mark on the left, its name, and its control on the right.
The mark is the filled weight of the glyph, sitting on the ground with no tile behind it.

### Raster glyphs

Four drawings from Flaticon are used by name: the bill on the Transactions header, send money
and receive money on the I paid and I received controls, and the rupee bag on the Add button. They are PNG, so they are drawn
as a **CSS mask** with `background-color: currentColor` rather than shown as an image. That
is what lets them tint to the theme and to the button state exactly as the sprite does;
without it they would be fixed black art, wrong on a teal button and invisible in dark mode.
Only monochrome line work survives being used as an alpha mask.

**Detail is the thing that decides whether one of these works.** The rupee bag is a solid
silhouette with the symbol knocked out of it, and it reads perfectly at 24px on the Add
button; it is the only filled glyph in the app, which is right for the primary action. An
accounting icon was tried in that same slot and rejected: a document with six ruled lines, a
chart and a twelve-key calculator became a grey smudge at 24px. The rule is silhouette count,
not source resolution. Serve these at 128px, not 512: nothing renders larger than 24 CSS
pixels, which is still five times the source needed on a 3x screen.

**Two of them are drawn for large sizes and it shows.** The bill reads at 24px on the section header.
The other two carry a lot of detail for an 18px control - a paper plane with a coin, and a
hand holding a money bag surrounded by four sparkles - so they are set larger, at 1.6rem, and
still read as busy next to Phosphor glyphs that were drawn for this size. That is a known
trade and was accepted deliberately, not missed.

**Licence.** The Flaticon free licence requires each icon's individual author to be credited
by name wherever it is used. The Settings screen has a Credits section carrying that, and the
author names still need filling in from each icon's page.

Emoji do not appear anywhere in the interface. The Telegram bot leaned on them because
Telegram gave it no other vocabulary. This app has icons.

---

## Motion

`MOTION_INTENSITY 4`. Every animation answers one of three questions, and nothing animates
for decoration:

| Question | Answer |
|---|---|
| Is this a new screen? | Cards rise and fade in sequence, then the first rows behind them. Runs on navigation only. |
| How big is this number? | The chart's bars grow out of the baseline they are measured from, which is the direction the magnitude is read in. |
| Did my tap land? | Sheet and backdrop entrance, snackbar rise, press scales, the nav pill growing behind the active icon. |

The entry stagger is deliberately **not** run when a row is saved or deleted. Re-animating a
whole list because one row changed reads as the app restarting. `render()` takes an `animate`
flag and only navigation passes it.

A newly saved row flashes `--brand-tint` once and is scrolled into view, so a save in a long
list is findable without re-reading it.

All of it collapses under `prefers-reduced-motion`, which zeroes every duration and delay
globally rather than per rule.

## Accessibility

- Body text meets WCAG AA against the surface it sits on. Every token in `tokens.css` carries
  its measured ratio in a comment; re-measure when a value changes.
- Nothing tappable is under 48px, and adjacent targets are separated by at least 8px.
- Money direction is carried by a sign and a word, not only by red and green.
- Focus is always visible: 2px `--brand` outline with a 2px offset. Never `outline: none`
  without a replacement.
- All motion collapses under `prefers-reduced-motion`, which `tokens.css` already handles by
  zeroing the duration tokens.
- The app works at 200% text zoom without horizontal scrolling.

---

## Banned in this app

Carried over from the anti-slop rules, plus the ones specific to Spendo:

- No em-dash anywhere the user can see it. Use a hyphen, a comma, or two sentences.
- No second accent colour. Red and green are semantic and only ever colour a signed amount.
- No radius outside the three in `tokens.css`, and no mixing them against the documented rule.
- No decorative status dots, no version strings, no "Powered by" footers.
- No fake or placeholder numbers in shipped screens. Empty states say the list is empty.
- No spinner as a loading state.
- No `window.addEventListener('scroll')`. Use IntersectionObserver or a CSS scroll timeline.
- No animation that cannot be justified in one sentence as hierarchy, feedback, or a state
  transition.
- No hard-coded colour in a component file. It goes in `tokens.css` or it does not exist.
