# Spendo

A personal expense tracker that runs as an installable PWA on the phone. It replaces an
existing n8n + Telegram + Google Sheets workflow with a real app.

Postgres is the source of truth. The same Google Spreadsheet the n8n workflow wrote to is
kept as a mirror, and Google Calendar events per expense are kept, but both are now written
by this app's own server. Once Spendo works, the n8n workflow is switched off entirely.

---

## Status

**Phase 1 done.** The app runs, offline, with no build step and no network request. Add an
expense or an income, see the month's balance, a daily-spend chart against the even-spread
budget, three stat tiles, the transaction list, a per-entry detail sheet where every field
edits in place, a category breakdown, a month history, search, opening money, theme, and a
JSON backup export. Everything is in `localStorage`; nothing has left the device yet.

Verified in a browser at 400x860: all four tabs, the add sheet in both directions, save,
delete with undo, each field of the detail sheet edited and read back from storage, light and
dark, and `scrollWidth` measured against `clientWidth` after every layout change. Defects found and fixed during those passes, two of which
are worth keeping in mind because they will recur:

- **`display` in a class rule outranks the `[hidden]` attribute on equal specificity.** Any
  element toggled with `.hidden = true` needs its own `[hidden] { display: none }` rule. It
  bit the chart tooltip and the floating Add button, both of which stayed visible.
- **A grid item's width floors at its min-content.** `.app` had an implicit `auto` column, so
  one nowrap row widened the column, widened `.view` with it, and scrolled the whole page
  sideways. Fixed with `grid-template-columns: minmax(0, 1fr)`. Measure `scrollWidth` against
  `clientWidth` after any layout change rather than judging it from a screenshot.
- **A CSS animation on an element going from `display: none` to shown can be created and
  never started.** `playState` reads "running" while `startTime` stays null and `currentTime`
  never leaves 0, so the element sits at its first keyframe permanently. It stranded the
  snackbar 12px out of place with a transform keyframe, then fully transparent with an
  opacity one. Do not let an entry animation own a property that has to be correct: make the
  base style the resting state, and treat the animation as the thing that can be lost.
- **An SVG arc that ends where it starts is degenerate.** The single-category donut drew a
  full circle as one arc from a point back to itself, and the browser rendered two overlapping
  discs instead of a ring. A circle in a path is always two half-arcs, split at opposite
  sides, so each arc has real endpoints. Test charts with one data point, not only with a
  realistic spread: the whole-of-one case is where geometry breaks.
- **Dark mode is declared twice and both copies must be kept in step.** `tokens.css` has a
  `@media (prefers-color-scheme: dark)` block and a `:root[data-theme='dark']` block, because
  the manual toggle has to beat the OS in both directions. A token added to only one of them
  works on a system-dark phone and silently fails for anyone who picked dark by hand. The
  hero surface shipped that way for one build. After editing either block, count the token in
  the file: it should appear three times, once per block.
- **A cache-first service worker makes every fix look like it did not work.** Three separate
  changes during phase 1 were reported as not working when the code was already correct and
  the browser was running the previous build. Fixed at the root by switching `sw.js` to
  network-first rather than by remembering to clear caches.
- **An inner scroller's overflow can leak into the document's scroll height.** The windowed
  transaction list made the page report 1781px of scroll for a 1456px page, so the reader
  could drag 325px past the end and the list drifted up under its own pinned header. Neither
  `overflow-y: hidden` nor `overflow-x: hidden` stops it. `contain: paint` does. Compare
  `documentElement.scrollHeight` against `body.scrollHeight` when scrolling goes further than
  the layout should allow; they should be equal.
- **A hex that looks neutral is not neutral. Read the channels.** The ink ramp was picked as
  `#15181a` / `#4a4f52` / `#676d70`, all of which have BLUE as their highest channel: a cool
  grey ramp on the warm ground that had just been chosen to replace a cool one. It undid the
  whole point of the palette work and was invisible until the computed values were printed.
- **Contrast must be measured on every ground a colour lands on.** Captions sit on `--bg` as
  often as on `--surface`. `#6a7069` clears 5.1:1 on white and 4.48:1 on the ground, so it
  passes a white-only check and fails the real one.
- **A `border` on the element beats a `border-top` from its container at equal specificity.**
  `.group-rows > * + *` lost to `.row { border: 0 }` because `.row` sits later in the file, so
  the ledger shipped with no dividers at all. `:not(:first-child)` raises specificity and
  wins. Dark mode had the mirror of this: the edge belongs on the surface, not on every row
  inside it, or each line gets a box drawn round it.
- **A field that salvages a number is worse than one that refuses.** The amount input is
  `type="text"` (deliberately: `type=number` brings a spinner and a browser error bubble),
  and the submit handler used to run `parseFloat(value.replace(/[^0-9.]/g, ''))`. Typing
  `8979erte` therefore saved 8979 - a figure the user never entered. Fixed in two places:
  the field filters as you type, and the submit check uses `Number()` on the whole string so
  junk is NaN rather than a salvaged prefix. Stripping input at validation time is always
  this bug in disguise.
- **Watch the leading dot when cleaning a numeric paste.** Stripping non-digits from
  "Rs. 1,299.994" leaves ".1299.994", whose first dot is the one from "Rs.", so a
  twelve-hundred rupee expense read as .12. Leading dots are dropped before the decimal
  point is chosen.
- **A validation error belongs to the state of a field, not to the last submit.** "Say what
  it was for." sat under a description that already had text in it, because errors were only
  cleared by the next submit. They now clear on `input` for the field they name.
- **One unreadable record must not fail the whole sync batch.** `POST /api/sync` used to
  throw on the first record it could not parse, so a single malformed row - left by an old
  client or a hand-edited store - meant the device could never sync anything again and its
  pending count only went up. Records are now rejected individually and reported back in
  `rejected`. Found against the real database, not in review.
- **`if (!record.updatedAt)` treats epoch 0 as missing.** It is a real timestamp and a falsy
  number. Combined with the above it was what wedged a device. Timestamp checks use
  `Number.isFinite(v) && v >= 0`.
- **A rejected record must not drive the sync scheduler.** It stays dirty forever by design,
  so counting it as work-to-do made the write-triggered sync schedule a sync for the sync that
  just finished, in a loop. `sendableCount()` excludes anything the server has already
  refused.
- **A library module must never `process.exit()` at import time.** `db.js` exited when
  `DATABASE_URL` was unset, so importing `sync.js` to test its validator killed the test
  runner before a single assertion ran. The check moved to `assertConfigured()`, called by
  `index.js` and `migrate.js`.
- **`pg` parses a `date` column into a local-time `Date`.** A row stored as 2026-08-31 comes
  back as 2026-08-30T18:30:00Z in IST and reads as the 30th. `db.js` registers a type parser
  that keeps `date` as the string it went in as.
- **Data arriving from the server does not repaint anything on its own.** The app repainted
  after each local action, so nothing was subscribed to the store. The first sync pulled a
  month of entries down and the screen went on showing an empty list until the user changed
  tab, which reads as the sync having done nothing. `sync.onRemoteChange` now fires only when
  a round actually delivered records, and app.js repaints on it - deliberately narrower than
  the status listener, which ticks several times a minute and would restart entry animations.
- **`--` inside a `/* */` SQL comment breaks some parsers.** It is legal Postgres, and it
  made pg-mem swallow the rest of `schema.sql` and report "relation does not exist" for every
  table. The section dividers in that file are line comments now. Worth avoiding in any SQL a
  migration runner or GUI client might also read.
- **`node --test test/` fails on Windows**, resolving the directory as a module before
  running anything. The `test` script uses the glob `"test/*.test.js"`, which the runner
  expands itself on every platform.
- **Nested scrollers: the browser always gives the drag to the inner one.** Home now has a
  windowed transaction list inside the scrolling page. Left to itself the list scrolled its
  rows while the chart above was still on screen and the page had not moved, which is not
  what anyone means by "scroll down". The fix is to keep the inner container
  `overflow-y: hidden` and only unlock it once `scrollY + innerHeight >= scrollHeight`, so
  the two hand over instead of competing. Chaining back outwards is left at the default -
  `overscroll-behavior: contain` would trap the reader at the top of the list.
- **A state read from scroll position must be re-read after the layout settles.** The same
  unlock was computed inside `render()`, which runs before focusing the search field scrolls
  the page. Opening search at the bottom of the page left the list locked shut with nowhere
  else to scroll. `render()` now calls the sync a second time on the next frame.
- **A row that only highlights something else is half a control.** Tapping a category in
  Insights lit its donut slice and changed the centre figure, which answers "how much" and
  not "on what" - and "on what" is the question a share of 17% actually raises. The row now
  expands to the transactions inside it, and one of those opens its detail sheet. The
  expansion drops the category line from each row, since repeating the name of the category
  you just opened is the one thing the reader already knows.
- **`<datalist>` is a desktop control.** The description field offered recent entries
  through one, and on the phone it never opened - which is the whole feature, since a
  suggestion nobody can see is not a suggestion. Three separate reasons, any one of which is
  enough: its popup competes with the on-screen keyboard, Safari on iOS has never supported
  it, and inside a `<dialog>` - which every sheet in this app is - Chrome often does not
  render it at all. Replaced with chips that are visible without tapping anything. The
  general rule: a control whose only job is discoverability must not itself have to be
  discovered.
- **Filter a suggestion list by toggling `hidden`, never by re-rendering.** Re-rendering the
  sheet replaces the input, which drops focus and closes the keyboard on the second character
  of every word.
- **New markup needs its attribute registered in the delegated click listener.** One document
  listener handles every control, matching a fixed list of `data-` attributes. The edit
  pencils were added to the markup and did nothing until `[data-edit-field]` and its
  siblings were added to that selector. If a new control does nothing, check that list first.

### The ink pass (2026-08-31)

The app was rebuilt off its brand hue after the owner said the green read flat. What was
actually flat was not the hex: it was a fully saturated mid-green used as a large flat fill
against a stock blue-grey ground. Two structural things were doing more damage than the
colour and both are gone:

- every transaction row was its own elevated white card, twenty-four of them
- the three equal white stat tiles, which is a named anti-pattern

`--brand` is now ink: buttons, FAB, section marks and chart bars are near-black, and the
ground is a warm neutral rather than the stock blue-grey slate.

Two changes from this pass were **rewound at the owner's request** and should not be
reintroduced without asking:

- **Category hues on the row tiles.** They were made monochrome and put back. The tiles are
  how the list is scanned and the hue ties a row to its slice in the donut. Signed amounts
  stay, so direction still has a channel that is not colour.
- **The expenses-only hero.** A second hero mode reported total spending when a month had no
  opening figure and no income, because the balance card otherwise prints negative spending
  against a pot of zero (`Balance left -1,901`, `1,955 of 54 used`). The single balance card
  is back and opening money is again a step the user is expected to take. The defect is real
  and still there; it is a known, accepted state, not an oversight.

Kept from the pass: the ink palette, the ledger, the figures strip, signed amounts, and the
walkthrough. Credits was removed from Settings at the owner's request after the Flaticon
attribution requirement was raised; the obligation now lives in `NOTICE.md`, which is not a
substitute for in-product attribution under that licence and says so.

Next: phase 2, the server and sync.

### Known gaps


- **No tests.** Phase 1 was verified by driving a browser, which is fine for one pass and is
  not a regression net.
- **Search has no date operators yet.** Keywords and the amount operators (`>500`, `<200`,
  `100-500`, an exact number) work now; `d:21`, `21-06-2025` and `m:2025-05` arrive with the
  rest of search in phase 5.

---

## Where this came from

The predecessor is an n8n workflow, `ExpenseTracker - Auto Create Spreadsheet + Sheets`,
driven from a Telegram bot with six commands: `/start`, `/exp`, `/transactions`, `/undo`,
`/search`, `/help`, plus a scheduled month-close job.

It works, but it has structural problems that motivated the rewrite:

- Balance is a stored column, so a backdated expense or an undo forces a rewrite of every
  row in the sheet. Three separate code nodes exist only to do that rewriting.
- The month-close job is named "Every 28th", its sticky note says the 28th, and its code
  checks `dayOfMonth !== 30`. It therefore never runs in February.
- `/start` on an existing month adds to the opening balance while the help text says it
  sets it.
- Four near-identical "check month sheet" code nodes each read only the last row of the
  registry tab to decide whether the current month exists.
- The undo date parser guesses between `YYYY-MM-DD` and `YYYY-DD-MM` and picks wrong for
  days 1 to 12.

Spendo's data model removes the first class of bug by construction, and the rest are simply
not reimplemented.

---

## Decisions (locked 2026-08-31)

| Decision | Choice | Reasoning |
|---|---|---|
| Platform | PWA now, native later | No native capability is required for text and number entry. A native wrapper can come later against the same server API, if home-screen widgets or Android SMS bank-alert parsing turn out to be worth it. |
| Skeleton | Copied from `../daily_attendance_tracker` (Track8) | Working, deployed, offline-first PWA with auth, sync, push and Postgres already solved. |
| Build step | None | Inherited from Track8. Plain HTML, CSS and ES modules served as files. |
| External requests | None at runtime | No CDN fonts, no analytics, no remote icons. Everything is served from our own origin so the app works fully offline. |
| Source of truth | Postgres (Neon free tier) | An interactive UI cannot wait 1 to 3 seconds on the Google Sheets API for every tap. |
| Google Sheets | Mirror, written by our server | The spreadsheet view is still wanted. Mirror writes are best-effort and queued, never blocking a user action. |
| Google Calendar | Kept, written by our server | One event per expense, deleted when the expense is deleted. |
| Google auth | Service account | Share the spreadsheet and the calendar with the service account address. Avoids an OAuth refresh-token dance for a single-user app. |
| n8n | Retired once Spendo works | |
| Telegram bot | Retired with it | |

---

## Architecture

Built so far, and what is still to come:

```
spendo/
  index.html            app shell, with the icon sprite inlined
  styles/
    tokens.css          design tokens, light and dark
    app.css             component and screen styles
  js/
    format.js           dates and money, one format in, one format out
    categories.js       the fixed category list and its colour slots
    store.js            local-first writes, returns immediately
    charts.js           inline SVG, no chart library
    ui.js               rendering, returns HTML strings, holds no state
    app.js              screen logic and events
    sync.js             phase 2: background push and pull
    push.js             phase 4: web push subscription
    xlsx.js             phase 5: spreadsheet export
  sw.js                 service worker, offline shell
  manifest.webmanifest
  fonts/
    geist-latin-variable.woff2   self-hosted, latin subset, variable weight
  icons/
    icon-192.png            app icon,   purpose: any
    icon-512.png            app icon,   purpose: any
    icon-maskable-512.png   full bleed, purpose: maskable
    apple-touch-icon.png    180px, opaque - iOS ignores the manifest
    favicon-32.png          browser tab
    sprite.svg              Phosphor symbols, vendored, inlined into index.html
  server/               phases 2 to 4
    index.js            serves the app and the API on one origin
    db.js               Postgres, row-level security
    auth.js             email plus 6-digit code, session cookie
    mail.js             Brevo HTTP API (Render blocks SMTP ports)
    sync.js             /api/sync
    sheets.js           Google Sheets mirror, queued and retried
    calendar.js         Google Calendar events
    close.js            month-close job
  docs/
    ui-spec.md          design system and screen specifications
  tools/
    serve.py            development server, sends no-store
    build-preview.py    flattens the app into one file
```

The app and the API share one origin on purpose: a push subscription belongs to the origin
that registered the service worker.

---

## Data model

```sql
accounts, sessions, login_codes    -- copied from Track8 unchanged

months (
  account_id, ym, opening_amount, sheet_name, closed_at
)

expenses (
  id, account_id, ym, txn_date, entered_at,
  amount, description, category,
  calendar_event_id, deleted_at, dirty
)
```

The tables as built are in `server/src/schema.sql`, which is the authoritative version of
the sketch above. Two things there that are not obvious:

- **`change_seq`, a database-wide sequence, is the pull cursor.** Not a timestamp. A device
  whose clock is a few seconds fast writes a row stamped in the future, the next pull asks
  for changes after a cursor that has already passed it, and that row is never sent again.
- **The key on `expenses` is `(account_id, id)`, not `id`.** Ids are generated on the device
  and are only unique within it, so two accounts are entitled to collide.

**Balance is computed, never stored:**

```
balance = opening_amount - running_sum(amount ORDER BY txn_date, id)
```

This single choice is what removes the n8n workflow's worst behaviour. A backdated expense
inserts one row, and every balance downstream of it is correct on the next read. There is
nothing to rewrite, so there is no rewrite to get wrong.

Deletes are soft (`deleted_at`), which makes undo trivial and keeps the Calendar event id
around long enough to delete the event.

---

## Feature map from the n8n workflow

| n8n | Spendo |
|---|---|
| `/start <amount>` | Settings, opening money. Set and Add are separate explicit actions, since the bot silently added while claiming to set. |
| `/exp <amount> <desc>` | Add screen. Date defaults to today, date picker to backdate. One code path, not two mirrored branches. |
| `/transactions` | Home, grouped by date, running balance. |
| `/undo` | Long-press or swipe to delete any row, not only the last one or a description substring match. |
| `/search <query>` | Search screen. Same operators kept: `>500`, `<200`, `100-500`, `d:21`, `21-06-2025`, `21-06-2025..25-06-2025`, `m:2025-05`. |
| Calendar event per expense | Same, written server-side. |
| Month close, 28th or 30th | Server job on the real last day of the month. |
| `/help` | Not needed. It is a user interface. |
| (none) | Categories. New, and the reason an Insights screen can exist at all. |

---

## Phases

1. **Scaffold and offline core.** Copy the skeleton, strip attendance, build add, list and
   delete working fully offline on the phone. Usable at the end of this phase.
2. **Server and sync.** Done. Postgres schema, one `/api/sync` endpoint, offline-first
   client with a dirty-set outbox.
2b. **Email sign-in.** Done. A six-digit code by Brevo, an httpOnly session cookie, and
   sync gated on being signed in.
3. **Google mirror.** Service account, Sheets append and rebuild, Calendar events.
4. **Month close.** Scheduled job, summary rows, report push notification.
5. **Search, xlsx export, polish.** Then switch the n8n workflow off.

---

## External setup required from the user

None of this blocks phase 1.

- Neon Postgres connection string, the pooled one, ending in `?sslmode=require`.
- Google Cloud project, a service account, its JSON key. The spreadsheet id and the
  calendar address are personal identifiers and are NOT in this repository - they live in
  `server/.env` as `SHEET_ID` and `CALENDAR_ID` when phase 3 lands. Share the spreadsheet
  with the service account address, and share the calendar with it granting "Make changes
  to events".
- Render web service plus environment variables, and a cron pinging `/healthz` every 10
  minutes, because the free tier idles a service after about 15 minutes and an idle service
  cannot send a notification on time.
- A Brevo API key and a verified sender address, in `server/.env` as `BREVO_API_KEY` and
  `MAIL_FROM_EMAIL`. The same Brevo account as Track8; the free tier's 300 emails a day is
  shared between them, which sign-in codes come nowhere near. Without a key the code is
  printed to the server console instead, which is enough to test the whole flow.

---

## Running it

### With the server and a database (phase 2 onwards)

```
cd server
npm install
# put your connection string in server/.env:  DATABASE_URL=postgres://...
npm run migrate          # applies src/schema.sql, safe to re-run
npm start                # serves the API and the app on http://localhost:8123
```

The server serves the PWA as well as `/api`, on one origin. That is deliberate: the app is
built on the rule that no runtime request leaves our own origin, and an API on a second host
would break it, bring CORS with it, and add a preflight to every sync.

`npm test` runs the sync suite against an in-memory Postgres. It runs the real `schema.sql`
and the real upsert SQL, so it catches a broken conflict clause; it does not replace running
once against your actual database.

`node test/fake-server.js` is a stand-in that speaks the same two endpoints from memory, for
working on the client without a database attached.

### Client only, no database

Still works, and the app is fully usable this way - sync simply reports that it cannot reach
a server.

```
python tools/serve.py             # then open http://localhost:8123
```

Use that rather than `python -m http.server`. The built-in server sends no cache headers at
all, so the browser applies heuristic freshness and keeps serving an edited ES module from
memory. `tools/serve.py` sends `no-store`, so a reload is always a reload.

**This used to require unregistering the service worker after every change.** It no longer
does: `sw.js` was cache-first with a background refresh, which serves the previous version's
JavaScript on every load and only catches up on the load after that. It is now network-first
with the cache as the fallback, registered with `updateViaCache: 'none'`, and the page
reloads itself once when a new worker takes over. Online, one reload is enough. Offline is
unchanged, because the cache still answers the moment the network does not.

Open it from a phone on the same network by using the machine's LAN address instead of
localhost. A service worker needs a secure context, so it registers on localhost and over
HTTPS but not over a plain LAN IP; everything else still works there.

`python tools/build-preview.py` flattens the app into `dist/spendo-preview.html`, one file
that can be opened or hosted anywhere. It is a preview only, always generated, never edited:
the multi-file source is the app.

**When editing during development, remember the service worker serves the cached shell
first.** A changed file will not appear until the `CACHE` constant in `sw.js` is bumped, or
the worker is unregistered and its caches cleared.

## Signing in, and why sync waits for it

An account exists only after someone proves they can read mail at an address. There is no
password and no signup step: the first correct code for an address creates the account.

**What this replaced, and why.** The first version of phase 2 had the phone mint a UUID and
`POST /api/register` adopt it. That endpoint had to accept anyone, because the id was a claim
with nothing behind it - measured, not assumed: three strangers each got a 201, a working
token, and rows in Neon without proving anything. It also meant a person's spending reached
the database before they had agreed to any of it. `/api/register` is gone.

**Signed out is a supported state, not a degraded one.** The whole app works with no account:
localStorage is the working copy, and syncing is what you opt into. Deferring it costs
nothing structurally, because the outbox does not care how long it waits - everything written
while signed out stays `dirty`, and the first sync after signing in drains all of it. That was
verified end to end: a transaction recorded signed-out went up on sign-in with no dirty
records left behind.

**The session is an httpOnly cookie**, so nothing on the page can read it - including an
injected script. Same-origin `fetch` sends it on its own, so no code carries a token around.
The consequence is that the page cannot tell whether it is signed in without asking, so
`js/identity.js` caches the ANSWER in localStorage for an offline boot and calls `/api/me`
before the first sync. That cache is a display convenience and never an authorisation; a 401
is how it finds out it was wrong.

**Signing in as a different address wipes the ledger first.** A record carries no owner
locally - the session decides who owns what - so without this, one person's spending would be
pushed into the next person's account on the same phone. Theme and "has seen the walkthrough"
survive, because they belong to the phone rather than to whoever is signed in on it. Signing
OUT deletes nothing.

**The rate limits are not decoration.** Sending is free to the caller and costs a quota
against a verified sender, so it is capped per address (60s cooldown, 5/hour, kept in the
table so a restart does not reset it) and per source IP (20/hour, in memory). One live code
per address, replaced on each send: two valid codes at once doubles the guess surface and
quietly turns "3 attempts" into six.

**Every rejection reads identically.** "Never asked", "expired", "used up" and "wrong" all
return the same sentence, so nothing can be learned by probing. The code is compared with
`timingSafeEqual` for the same reason.

**`schema.sql` and `migrations.sql` are two files on purpose.** `create table if not exists`
does nothing to a table that already exists, so a column added to a definition after the
first deploy reaches a fresh database only. `migrations.sql` is where it reaches a live one.
The test suite loads schema.sql alone, because a fresh database already has the final shape -
and because pg-mem cannot parse several of the alter statements.

---

## Where the model is used, and where it deliberately is not

Two features, both optional, both degrading to something useful when the key is
missing, the phone is offline, or nobody is signed in.

### Guessing the category: three layers, and the model is the last one

```
1  your own history     exact match, then a vote across shared words   0ms, offline
2  a keyword table      the cold start, before there is any history    0ms, offline
3  the server, and Groq only when 1 and 2 both miss                    ~700ms, online
```

**The ordering is the design, not an optimisation.** A model is the obvious first
reach and the wrong one: it costs a round trip on the hottest path in the app, it
does nothing with no signal, and it does not know that your "MRF" is a tyre shop.
Your own history does, because after a few weeks most descriptions repeat. Measured
against a seeded history of five descriptions, layers 1 and 2 answered 11 of 12 test
cases correctly with no network at all - including "petrol bunk near office" from
having once typed "Petrol", and "Swiggy dinner" from a word list.

Layer 3's answer is cached into layer 1 (`localStorage['spendo.aiCategories']`), so
any one description is only ever sent once. That cache is deliberately NOT in the
synced store: it can be rebuilt from nothing, and syncing it would push it to every
other device for no gain.

**`draft.categoryTouched` is the safety rule.** One tap on a category chip and no
guess may move it again for that entry. An assistant that keeps overruling a decision
you have already made is worse than one that never helps.

Two more rules that are easy to get wrong:

- **Never re-render the sheet to show a guess.** Re-rendering replaces the description
  input, which drops focus and closes the keyboard mid-word. The chip's class is
  toggled in place instead - the same trap the suggestion chips avoid.
- **Drop a late answer.** The request carries a sequence number and the description it
  was made for; if either has moved on, the reply is discarded. A category appearing
  under someone who has already moved past that field is exactly the behaviour that
  makes people stop trusting the feature.

### Two things that look like the same feature and are not

**Suggestion chips move to the front on their own.** Hiding the misses is enough,
because a hidden chip takes no space in a flex row. What that does NOT do is put the
LIKELIEST one first: typing "cof" left a more recently used "Morning filter coffee"
ahead of "Coffee beans refill". Anything starting with what was typed now sorts
first; everything else keeps its recency order, which is what `data-rank` on each
chip is for, and the original order is restored when the field is cleared.

**Tapping a suggestion runs the category guess too.** It is a description arriving,
which is the same event as one being typed, so it goes through the same path -
tapping "Petrol" fills the field and moves the chip to Transport in one action.

---

### Writing up a month

Opened by tapping a month in History. Tapping one used to silently change which month
Home was showing and drop you there to notice - an action with no visible cause. It
now opens a sheet, which is the pattern a transaction row already uses, and the jump
is a button that says what it does.

**Every figure on that sheet is computed on the device.** The model is handed those
figures and asked only to phrase them; it is never asked what a number is. A paragraph
that is confidently wrong about someone's money is worse than no paragraph, and the
reader has no way to tell the difference. So the numbers are the content and the
writing is laid on top - never the other way round, or the sheet would be empty on a
train.

### The provider, the model, and what measuring them taught

**Groq, `qwen/qwen3.8-27b`.** Chosen for a reason that has nothing to do with the two
features currently using it: it can also see. A category comes from a description and
a write-up from figures, so neither needs vision - but receipt-photo entry does, and
running one model for both means one client, one key, one set of limits. That is the
whole argument for the move; on the text work it answers in 287-764ms, roughly three
times faster than what it replaced.

It replaced NVIDIA NIM and `openai/gpt-oss-120b`, which had been picked by measuring
ten Indian descriptions the local layers would miss:

| model | right | median | worst |
|---|---|---|---|
| `openai/gpt-oss-120b` | 10/10 | 1135ms | 1416ms |
| `openai/gpt-oss-20b` | 9/10 | 2645ms | 6021ms |
| `nvidia/nemotron-3.5-lightning-30b-a3b` | 5/10 | 10315ms | 36174ms |

The 120b being both more accurate AND twice as fast as the 20b is not what anyone
would predict. That is the argument for running the test rather than recognising a
name, and it is why the notes below are kept: they are about the shape of the
problem, not about one vendor.

- **A model listed is not a model you may invoke.** NIM's `/v1/models` returned 82 and
  most of them 404'd on the first chat call. `meta/llama-3.1-8b-instruct`, the original
  default here purely because it sounded like the obvious small model, was not among
  the ones the key could call at all. Anything set here has to be tried.
- **`max_tokens: 8` produced nothing usable from any model tried.** They all reason
  first, and where they put that reasoning differs: gpt-oss uses a separate
  `reasoning_content` and leaves `content` clean, nemotron-lightning writes it into
  `content`, and Qwen wraps it in `<think>` tags inside `content`. The budget has to
  cover the thinking even when the answer is one word, so it is 512, and the reply is
  read with `reasoning_format: 'hidden'` AND a `<think>` strip - an unclosed tag from a
  budget that ran out mid-thought would otherwise arrive as the answer.
- **Reachability is not a property of the code.** `api.groq.com` was unreachable from
  the development machine for part of a session - TLS handshake rejected on the SNI,
  while the same IP accepted a handshake for a different hostname and NIM worked
  throughout. Nothing in the app was wrong. Test the endpoint before debugging the
  client.

**Real latency is not the benchmark latency.** In a tight loop these models answer in
about a second; spaced out the way a person actually types, the same calls took 2.2s
to 7.8s, because a cold function is slower than a warm one. That is why the client
waits twelve seconds rather than six, and why a late answer is cached even when it is
too late to apply: the same description will be typed again, and next time layer 1
has it.

**A prompt that says "answer `other` when unsure" is not enough, and saying it twice
is too much.** Asked to place a bare personal name, the model put "thari" in Shopping
rather than admit it could not tell - so the prompt gained a rule that a name with no
thing bought is not a purchase. That rule then over-applied: "gobi", "maavu", "router"
and "book" all came back as `other`, trading a wrong category for a useless one. It
needs both halves - a name alone is not a purchase, AND anything actually named is
categorised by that thing however unfamiliar the word. Some things a prompt cannot
reach at all: that "thari" is a person is a fact about the owner's life, not something
inferrable from four letters, so it is an explicit override.

### What leaves the device

| Route | Sent | Never sent |
|---|---|---|
| `/api/categorise` | the description text, the list of category ids | amount, date, history, anything else |
| `/api/review` | totals, category shares and labels, last month's total | any description, any date, any individual transaction |
| `/api/tips` | monthly totals over the window, and per category what was spent against what that category usually costs | any description, any date, any individual transaction |

The `/api/review` and `/api/tips` bodies are rebuilt field by field on the server
rather than passed through, so whatever else a caller puts in it does not reach the
model. All three routes require a session and are capped per account per hour: a
signed-in session is a credential someone could script, and without the cap one
account can empty the quota for the app.

**Suggestions are asked for, never pushed.** `/api/tips` is behind a button on
History, because advice nobody asked for is nagging, and because a call made on every
visit to a tab is quota spent on people who were only passing through. The answer
comes back as JSON - three `{title, detail}` objects - and is parsed, shape-checked
and truncated before it is rendered; a reply that is prose rather than an array is
answered with `null` and the card says it could not get suggestions. Prose would have
had to be split by hand, and the split is the thing that breaks first when the wording
changes.

**The prompt is told what each category usually costs, not just what it cost.**
Without the comparison the model returns the same three suggestions for everybody -
eat out less, cancel a subscription, make a budget - which is advice about spending in
general rather than about this person's spending. With it, a suggestion can say "Food
is Rs 1,290 above its own usual", which is a fact the reader can check on the screen
above it. Rent, Bills and Health are named in the prompt as hard to cut, so they are
not led with, and skipping medical care is never suggested.

### Not used for

- **"Unusual spend" alerts.** That is a median and a multiplier - deterministic,
  instant, free, and never wrong in a way the reader cannot check. Spending a model
  call on arithmetic is how a feature becomes both slower and less trustworthy.
- **A chat assistant.** The dataset is eight columns and a few hundred rows; anything
  a chat could answer, Insights answers faster and cannot be confidently wrong about.

---

## Installing

**`manifest.webmanifest` declares `"id": "spendo"`, and that string must never change.**
Without an `id`, Chrome derives the app's identity from `start_url` - which is also what a
stale installation is keyed on. Changing it orphans every existing install.

The failure it fixes, seen on a real phone: the app was installed under the old icon, the
icon set was replaced, and the launcher icon never changed. Android bakes the icon into the
WebAPK at install time and only refreshes it when Chrome happens to notice a manifest change,
which can take a day and several launches; clearing Chrome's cache does not touch it. So the
app was uninstalled - and Chrome then offered only **Open Spendo**, never Install, because it
still had the site registered as installed. At that point there is no route back from inside
the browser at all.

Two things now cover it:

- **A declared `id`.** It is the documented identity field, and it is what stops the
  identity drifting with the URL again.
- **An Install section in Settings**, driven by `beforeinstallprompt`. The event is captured
  and held rather than used the moment it fires, so the offer is available when someone goes
  looking for it. `preventDefault()` is called deliberately: Chrome's own mini-infobar
  otherwise appears over the ledger at a moment nobody chose.

The section has three states and none of them is a button that does nothing:

| State | Shows |
|---|---|
| running standalone | "Installed", no button |
| prompt held | the real Add to home screen button |
| no prompt | the manual route for this browser - and, on Android, how to clear a stale registration |

That third state is not an edge case. `beforeinstallprompt` does not exist in Safari at all,
and the prompt is single-use: once `prompt()` has been called the event is spent, whether or
not the person accepted, so anyone who dismisses the dialog lands there immediately.

---

## The app icon

The source is one 1254px render: a rounded dark-green tile on a white page, with a drop
shadow. Three shapes are cut from it by `tools/make-icons.py`, and none of them is a
straight resize:

| File | Purpose | Why it differs |
|---|---|---|
| `icon-192`, `icon-512` | `any` | The tile with its own rounded corners, transparent outside |
| `icon-maskable-512` | `maskable` | Full bleed, artwork at 60% - a platform may crop to a circle of 80% diameter, and the largest square guaranteed to survive that is 80/sqrt(2) = 57% |
| `apple-touch-icon` | iOS | Opaque and full bleed. iOS ignores the manifest entirely and composites a transparent PNG onto BLACK, then applies its own rounding |

Three things went wrong building it and would go wrong again:

- **The tile's bounding box is not the box of non-white pixels.** That box includes the drop
  shadow, and one row of it left in becomes a grey ring on the home screen. The tile is found
  from the box of clearly DARK pixels instead, and cut square from its width - the height
  that test returns is ~19px taller, which is shadow.
- **A corner mask drawn on the measured radius still leaks.** The drawn corner is very
  slightly rounder than a true rounded rectangle, so pixels about 2px outside the real curve
  fall inside the mask and travel into the icon as white specks. The mask is inset 8px. The
  script asserts that the four corner squares contain zero page-white pixels; that assertion
  is the check that matters, because the specks are invisible at review size and obvious on a
  phone.
- **Separating artwork from background by BRIGHTNESS loses the dark teal wave.** It computes
  to 91.6 against a floor of 89.5, so it came out patchy rather than absent, which is harder
  to notice. Its COLOUR is 76 away from the background while the background's own gradient
  varies by about 15, so distance separates cleanly where luminance cannot. Related: read the
  artwork out of the flattened image, not the RGBA one - `convert('RGB')` discards alpha and
  hands back the white page underneath it.

The alternative artwork supplied alongside this one, with the background already removed, is
not used: its cutout has a speckled fringe along every edge, and its glyph is cream, which
disappears against the app's own light ground.

---

## Conventions

- No build step. If a change needs a bundler, it is the wrong change.
- No runtime request leaves our origin. Fonts, icons and everything else are served locally.
- Every write is local first and returns immediately. Sync is background, and is skipped
  entirely when there is nothing to sync to.
- Money is stored in rupees as `numeric(12,2)`. Never a float.
- Dates in the UI and in the sheet mirror are `DD-MM-YYYY`. Dates in Postgres are `date`.
  Conversion happens at the boundary, once, in one place.
- Design tokens live in `styles/tokens.css` and nowhere else. No hard-coded colour in a
  component.
- The design system is specified in `docs/ui-spec.md`. Read it before writing any UI.
