# Spendo

A personal expense tracker as an installable web app. It replaces an n8n + Telegram +
Google Sheets workflow with something that opens in a second, works with no signal, and
computes the balance instead of storing it.

- **Offline first.** Every write lands in `localStorage` and returns immediately. Nothing
  in the app waits on a network request, ever.
- **Sync when you sign in.** A six-digit code by email, then the whole backlog goes up.
  Signed out, the app is fully usable and nothing leaves the phone.
- **No build step.** Plain HTML, CSS and ES modules. No bundler, no framework, and no
  runtime request to any third-party origin - fonts and icons are vendored.
- **The model is the last resort, not the first.** The category is guessed from your
  own history and a keyword table before anything leaves the phone; Groq is
  asked only about descriptions neither could place, and its answer is cached so the
  same one is never sent twice.
- **Balance is computed, never stored.** Opening money plus a running sum over entries
  ordered by date. Backdate an expense and every figure downstream is right on the next
  read, because there is no stored figure to be wrong.

---

## Running it locally

### The app on its own, no database

```
python tools/serve.py            # http://127.0.0.1:8123
```

Everything works except syncing.

### With the server and a database

```
cd server
npm install
cp .env.example .env             # then fill in DATABASE_URL
npm run migrate                  # applies schema.sql then migrations.sql, safe to re-run
npm start                        # serves the API and the app on http://localhost:8123
```

Leave `BREVO_API_KEY` empty and sign-in codes are printed to the server console instead
of emailed, which is enough to test signing in end to end.

### Tests

```
cd server
npm test                         # the real SQL against an in-memory Postgres
node test/fake-server.js         # a stand-in server, for driving the client with no database
```

---

## Deploying to Render

`render.yaml` is a Blueprint. Point Render at this repository, then set these in the
service's **Environment** tab - they are marked `sync: false` and are never in the repo:

| Variable | What it is |
|---|---|
| `DATABASE_URL` | Neon, the **pooled** connection string |
| `BREVO_API_KEY` | sends the sign-in code |
| `MAIL_FROM_EMAIL` | a sender **verified** on that Brevo account |
| `GROQ_API_KEY` | Groq, for the category guess and month write-ups. Optional - both fall back cleanly without it |

Then point a cron at `https://<service>.onrender.com/healthz` every 10 minutes. The free
tier idles a service after about 15 minutes, and a cold start is 30+ seconds of someone
waiting to record a coffee.

---

## Layout

```
index.html              the whole shell; the icon sprite is inlined here
js/                     store, sync, identity, screen logic, rendering
styles/                 tokens.css is the design system; app.css is everything else
sw.js                   service worker, precaches the app for offline use
server/src/             express server, schema, sync endpoint, email sign-in
server/test/            the SQL suite, and a fake server for client testing
docs/ui-spec.md         what each screen is meant to do
CLAUDE.md               the decisions, and why - read this before changing anything
NOTICE.md               third-party assets and the attribution they require
```

`CLAUDE.md` is the real documentation. It records what was tried, what broke, and why each
decision went the way it did, which is the part that is expensive to rediscover.
