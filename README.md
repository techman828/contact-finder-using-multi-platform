# Contact Finder

A Next.js app for Vercel. Paste a LinkedIn profile URL and get emails and phone numbers. Providers are tried in order (a "waterfall"): SignalHire first, then Prospeo, and so on. It stops once it has what you need. Every search is saved to history in Postgres.

## Deploy to Vercel

1. Push this repo to GitHub and import it in Vercel.
2. Add a Postgres database. In the Vercel dashboard, go to **Storage → Create → Neon**, or use Supabase or any other Postgres. This sets `DATABASE_URL` / `POSTGRES_URL`. Use the **pooled** connection string. Tables are created automatically on the first request.
3. Deploy, open **Settings**, add your API keys (as many per platform as you like), click **Check all**, then **Save settings**.

SignalHire's full waterfall mode works on Vercel without extra setup. The app detects your production domain (`VERCEL_PROJECT_PRODUCTION_URL`) and SignalHire posts results back to `/api/callbacks/signalhire/<token>`. To use a custom domain, set `APP_URL` or fill in *Settings → Public app URL*.

> ⚠️ **There is no login.** Anyone who has the URL can run searches on your credits, read the search history, and change the settings (including adding or removing keys). Saved keys are never sent back to the browser; only the last 4 characters are shown. Keep the URL private. If you need protection later, the simplest options are Vercel's *Password Protection* or a small single-password middleware. If you protect the production domain, SignalHire callbacks will be blocked. Use Vercel's *Protection Bypass for Automation* and add the bypass token to the public app URL.

## Run locally

```bash
docker run -d --name cf-pg -e POSTGRES_PASSWORD=pg -e POSTGRES_DB=contacts -p 55432:5432 postgres:16-alpine
cp .env.example .env.local     # set DATABASE_URL=postgres://postgres:pg@localhost:55432/contacts
npm install
npm run dev                    # http://localhost:3000
```

Locally there's no public URL, so SignalHire automatically uses **sync mode**. That's instant but only searches SignalHire's own database. To test waterfall mode locally, run a tunnel (e.g. `ngrok http 3000`) and paste its URL into *Settings → Public app URL*.

## How a search works (serverless design)

Vercel functions are short-lived and don't share memory, so all search state is stored in Postgres. Any function invocation can pick up where the last one stopped.

```
POST /api/searches            create search + one 'pending' step per enabled provider → respond 201
  └─ after(): advance()       lock the search row, claim the next pending step, call the provider, repeat
        ├─ sync result        → store it, check the stop rule, continue / finish
        └─ webhook provider   → step becomes 'waiting' (deadline = now + wait time), stop
POST /api/callbacks/:p/:token → store the result → after(): advance() continues with the next provider
GET  /api/searches/:id        UI polls every 1.5s; also times out overdue callbacks and resumes stalled searches
```

- **Stop rule** (Settings): *email AND phone* (default), *email only*, or *always query every provider*.
- **Saves credits.** Later providers are skipped once the rule is met. Prospeo is only asked to reveal a mobile number (10 credits) if no phone has been found yet.
- **Multiple API keys per platform.** Keys are tried top to bottom. If a key is out of credits, invalid, disabled or rate-limited, the same platform is retried immediately with the next key, and the search records which key answered. Keys that ran out or failed in the last 24h (or are known to have 0 credits) are moved to the end of the order automatically, so they don't waste time on later searches. A key that recovers is used again as soon as it succeeds or passes a credit check.
- **Merged results.** Contacts are de-duplicated, and each one shows which providers found it, plus a *verified* badge when available.
- **Robust.** A late callback is still saved to history. A step killed by the function time limit is marked *interrupted* and the waterfall continues. Running `advance()` concurrently is safe because of the row lock.
- **History.** Searchable and paginated. Click a row to reopen it, view each provider's raw API response, or **Export CSV**.

## Provider notes

| | SignalHire | Prospeo |
|---|---|---|
| Endpoint | `POST https://www.signalhire.com/api/v1/candidate/search` | `POST https://api.prospeo.io/enrich-person` |
| Auth header | `apikey` | `X-KEY` |
| Mode | Waterfall via callback (public URL), otherwise sync (`withoutWaterfall`) | Synchronous |
| Cost | 1 credit per matched profile | Email: 1 credit. Mobile: 10 credits. No match: free. Same person again within 90 days: free |
| Credits check | `GET /api/v1/credits` | `GET /account-information` |
| Rate limit | 600 profiles/min (trial: 5/min) | Per plan (HTTP 429 → automatic backoff) |

## Adding another platform

1. Create `lib/providers/<id>.ts` that exports a `Provider` (see `lib/types.ts`; `prospeo.ts` is the simplest template):
   - `id`, `name`, `website`, `docs`, `keyHelp`, `options[]`. These are rendered automatically in Settings.
   - `lookup({ linkedinUrl, apiKey, options, need, callbackUrl })` returns `{ found, person, emails, phones, ... }`, or `{ waiting: true }` if results will arrive by webhook.
   - Optional: `parseCallback(body)` for webhook APIs, served at `/api/callbacks/<id>/<token>`. Also optional: `credits(apiKey)`.
2. Add it to the list in `lib/providers/index.ts`.

Its API keys are managed on the Settings page like the others.

## Project layout

```
app/                     pages (/, /settings) and API route handlers
components/              React client components (SearchView, ResultCard, SettingsView)
lib/waterfall.ts         the resumable waterfall engine
lib/providers/           one file per platform + registry
lib/settings.ts          provider order / options (stored in Postgres)
lib/keys.ts              API keys per provider: ordering, failover, health (credits / last error)
lib/searches.ts          history queries
lib/db.ts                Postgres client + auto-created schema
test/                    unit tests + engine tests against real Postgres
```

## Tests

```bash
npm test                                   # unit tests (providers, merging, URL parsing)
TEST_DATABASE_URL=postgres://postgres:pg@localhost:55432/contacts_test npm test   # + engine tests
npm run typecheck
```

The engine tests cover key failover and demotion, saving the key list (add, rename, reorder, delete, reject duplicates, raw keys never exposed), migration from the old single-key setting, the stop rule, the fall-through to the next provider, error handling, the callback-then-resume flow, a callback arriving before the provider's 201 response, timeouts with late results, concurrent `advance()` calls, interrupted steps, and history search and paging.
