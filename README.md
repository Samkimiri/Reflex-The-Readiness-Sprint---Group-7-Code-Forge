# Reflex — The Readiness Sprint

A working build of the case study: retailers log deliveries, a dispatcher assigns
a rider, the rider updates status, and drop-off is confirmed by scanning a QR
code — not just the rider's word.

## Run it

Requires Node.js (v18+ recommended). No database to install.

```bash
npm install
npm start
```

Then open **http://localhost:4000** in your browser. The frontend is served by
the same server — one command runs everything.

Run the test suite with `npm test` (Node's built-in test runner — no extra
dependency): unit tests for the status-machine rules in `statusMachine.js`,
plus integration tests that boot the real Express app on a random port and
exercise it over HTTP — registration/login, role checks on every delivery
transition, and the access-control rules described below.

On first run it seeds three demo accounts — login is by **email**, not phone
(phone is still collected and stored, just no longer the login identifier):

| Role       | Email                   | Password     |
|------------|--------------------------|--------------|
| Retailer   | retailer@reflex.demo     | retailer123  |
| Dispatcher | dispatcher@reflex.demo   | dispatch123  |
| Rider      | rider@reflex.demo        | rider123     |

...plus one **admin** account, seeded the same way but *not* shown as a
public demo button on the login screen — it has full read access to every
user and every retailer's deliveries, so a one-click public login for it
would be a real privacy exposure. Log in with it through the normal
email/password form:

| Role  | Email               | Password                              |
|-------|---------------------|----------------------------------------|
| Admin | admin@reflex.demo   | `5I9H3ifTmCMj` (or `ADMIN_SEED_PASSWORD` if you set one before first boot) |

...plus five example deliveries under the retailer account, one in each
status (`requested`, `assigned`, `picked_up`, `delivered`, `cancelled`), and
four example products in the retailer's catalog — so every dashboard has
something to show instead of an empty state: the dispatcher has an open
request to assign, the rider has one to pick up and one to scan-confirm, the
retailer's "History" shows a full audit trail on the delivered one, and the
product catalog has something to pick from when logging a new delivery.

Log in as each in a separate browser tab (or a normal + incognito window) to
demo the full three-role flow at once.

## Installing it as an app (PWA)

Reflex is an installable Progressive Web App — `manifest.json` + `sw.js`
(service worker) turn it into something with its own icon, its own window
(no browser chrome), and an app-shell that still opens when offline.

- **Desktop Chrome/Edge & Android Chrome**: once the browser decides the page
  qualifies (needs HTTPS — works on the Vercel deployment; `localhost` also
  counts as a secure context), Reflex shows an actual install prompt — a
  dialog offering **Install** / **Not now**, not just a hard-to-notice
  button. Dismiss it and an "📲 Install app" link stays available in the
  topbar (and on the login card pre-login) to bring it back anytime.
  Nothing here is a fixed-position overlay, so it never sits on top of
  other controls (earlier versions had an install button that could cover
  the Log out button — fixed by keeping install access in normal page flow
  instead of a floating layer).
- **iOS Safari**: no automatic prompt (Apple doesn't support
  `beforeinstallprompt`) — use Share → **Add to Home Screen** manually.

Only the static shell (HTML/CSS/JS/icons) is cached for offline use —
`/api/*` is deliberately never cached, since delivery status is live data
the app polls every 4s and stale cached numbers would be actively
misleading. Offline just means the shell still opens instead of a browser
error page; it doesn't mean deliveries can be updated without a connection.

## Creating accounts

Click **Create an account** on the login screen to self-register with a
name, email, phone, password, and role (retailer/dispatcher/rider) — this
calls the same `/api/auth/register` endpoint that seeds the demo accounts.
**Email + password is how everyone logs in** (both password fields have a
👁 toggle to check what you typed before submitting).

### Google sign-in

"Continue with Google" is available once `GOOGLE_CLIENT_ID` is set in the
environment; the button stays hidden otherwise (no error, just absent). To
enable it:

1. In [Google Cloud Console](https://console.cloud.google.com/apis/credentials),
   create an **OAuth client ID** of type **Web application**.
2. Add every origin the app is actually served from to **Authorized
   JavaScript origins** — e.g. `http://localhost:4000` for local dev and your
   `https://your-app.vercel.app` domain for the deployed site. (No redirect
   URI needed — this uses Google Identity Services' token flow, not a
   redirect.)
3. Set `GOOGLE_CLIENT_ID` to that client ID, both locally (`.env`/shell) and
   as a Vercel project environment variable, then restart/redeploy.

The client ID isn't a secret (it's meant to ship in browser JS), but the ID
**token** Google hands back is always verified server-side
(`google-auth-library`) before any session is issued.

Since Google only proves identity, not role, a brand-new Google sign-in is
asked to pick retailer/dispatcher/rider once, right after authenticating,
before its account is created. Signing in again after that just logs in —
no repeat prompt. If the Google account's email matches an existing
email/password account, that account is linked instead of creating a
duplicate.

## Admin oversight dashboard

A fourth role, `admin`, exists purely to answer "is the prototype actually
working" at a glance — not to run day-to-day operations. Logging in as
admin shows: live/uptime status from `/api/health`, counts of users by
role and deliveries by status, every delivery across every retailer (with
retailer + rider attribution, History, and QR access), every registered
user in a table (name/email/phone/role/joined), and every product across
every retailer's catalog.

It's deliberately scoped as **oversight, not operations**: admin can view
everything and has the same assign/cancel override a dispatcher has (both
backed by the same role check), but can't mark a delivery picked-up or
delivered — those represent a real rider physically doing something, and
letting admin fake that would make the audit trail (`changed_by`) lie
about who actually did it. Admin also isn't self-registerable — the
public `/api/auth/register` role list is still just
retailer/dispatcher/rider; an admin account only ever comes from seeding.

## Product catalog

Retailers manage a simple product catalog (name, optional price, optional
description, optional photo) in the same dashboard where they log and track
deliveries — one connected view, not a separate page. When logging a new
delivery, a dropdown lists the retailer's products; picking one fills in the
item description (still editable, or skip it and type freely). Products are
scoped to the retailer that created them (`GET/POST /api/products`,
`DELETE /api/products/:id`) — only a retailer can manage their own catalog.

Product photos are resized/re-encoded to a small JPEG **in the browser**
before upload (max 480px, quality ~0.72) and stored as a data URL on the
product record. There's no separate file/blob storage to configure — the
data store is a JSON/Redis blob either way, so this keeps setup at zero —
but it does mean payload size matters: the backend rejects anything over
~450KB decoded as a sanity check, well above what the client-side
compression normally produces.

## Demoing the QR scan

- As the **retailer**, click "Show QR" on a delivery once it's `picked_up`.
- As the **rider**, click "Scan to Confirm Delivery" — it opens your camera
  (via `jsQR`) and reads the code shown on the other screen/device.
- No camera handy, or scanning a second window on the same laptop? Use the
  manual entry field in the same modal — copy the token from the retailer's
  QR endpoint response or just paste it in.

## Security notes

- **Access control is scoped per-party, not just per-role.** A dispatcher
  legitimately sees and can act on every delivery; a retailer can only see
  and cancel *their own*; a rider can only see deliveries assigned to
  *them*. Requesting a delivery you're not party to returns 404, not 403 —
  deliberately, so an unauthorized request can't be used to confirm a given
  ID even exists. (An earlier version of this checked role but not
  ownership, letting any retailer view or cancel any other retailer's
  deliveries — fixed, and covered by a regression test in
  `backend/test/api.test.js` so it can't quietly come back.)
- **Rate limiting on `/api/auth/*`** (`express-rate-limit`, 30 requests per
  15 minutes per IP) is best-effort: a serverless deployment runs several
  concurrent instances, each with its own in-memory counter, so a
  distributed attacker can partially evade it by spreading requests across
  instances. Real protection at that level needs a shared store (the same
  Redis already used for data would work) — a reasonable next step if this
  ever needs to withstand a serious credential-stuffing attempt rather than
  casual abuse.
- **CSP and other security headers** via `helmet`, scoped to exactly what
  this app loads (jsQR from cdnjs, Google Identity Services, same-origin
  fetches, `data:`/`blob:` images for product photos and the QR code).
- **`JWT_SECRET` must be a real secret in production** — the code falls
  back to a hardcoded dev value otherwise, which is fine on `localhost` but
  not once the source is public. Vercel's env var UI is where to set it
  (see the deployment section above).
- Passwords and emails are validated server-side (minimum length, basic
  email shape), not just in the browser — client-side `required`/`type`
  attributes are a UX nicety, not a security boundary, since anyone can
  call the API directly.
- No CORS middleware: the frontend and API are served from the same origin
  by the same Express app, so there's no cross-origin request to allow in
  the first place — `cors()` was removed as unneeded attack surface.

## What's actually implemented

- Full auth (self-service register/login by email+password, a show/hide
  toggle on every password field, JWT, bcrypt password hashing, optional
  Google sign-in)
- Automated tests (`npm test`) and a `GET /api/health` liveness endpoint
- All four role dashboards (Retailer, Dispatcher, Rider, admin oversight),
  including a retailer product catalog (with photos) wired into delivery
  creation
- A two-panel login/register screen (brand + feature highlights alongside
  the form on wide viewports, collapsing to just the form on phones)
- Responsive layout tuned for phone-sized viewports and the installed-app
  window specifically (safe-area padding for notches/home indicators,
  collapsing grids, a topbar that wraps instead of clipping), plus hover
  and transition polish (`prefers-reduced-motion` respected)
- Backend response compression (gzip) and long-lived caching for static
  icons, so repeat loads are cheap on mobile connections
- An in-app "How Reflex works" guide (✨ link on the login screen) — a
  four-step illustrated walkthrough of the retailer→dispatcher→rider→QR
  relay, for anyone opening the prototype cold
- The exact status state machine from the architecture deck, enforced
  server-side with role checks on every transition
- A real, provable audit trail (`status_log`) — visible as "History" on any
  delivery
- Real QR code generation (`qrcode` npm package) and camera-based scanning
  (`jsQR`), with manual-entry fallback
- Polling refresh every 4s (the Trade-off #1 from the trade-off log)

## Architecture notes / where this differs from the original design doc

- **Data store:** a JSON file (`backend/data/db.json`) instead of PostgreSQL,
  so the whole thing runs with zero setup — no DB server to install for a
  one-week sprint. The schema is identical (`users`, `deliveries`,
  `status_log`) and every read/write goes through `db.js`, so swapping in
  real Postgres later means rewriting that one file, not the routes or the
  state machine. Worth naming this trade-off explicitly if a panelist asks
  why it's not Postgres.
- **Frontend:** plain HTML/CSS/JS instead of a React build, again to keep
  `npm install && npm start` as the entire setup. The API is a normal REST
  API underneath, so swapping in a React frontend later doesn't touch the
  backend at all.

## Project structure

```
package.json          dependencies + npm start (repo root — see below)
vercel.json            routes every request to api/index.js on Vercel
api/index.js            Vercel serverless entry point (wraps backend/server.js)
backend/
  server.js          entry point — wires up routes, serves the frontend
  db.js              data layer (JSON file locally / Upstash Redis on Vercel)
  statusMachine.js    the transition rules + role checks, in one place
  seed.js            demo account seeding
  middleware/auth.js  JWT verification
  routes/auth.js      register, login
  routes/deliveries.js create, list, assign, status, scan, QR image
  routes/users.js      list riders (for the dispatcher's assign dropdown)
  routes/products.js   a retailer's product catalog (create, list, delete)
frontend/
  index.html
  style.css
  app.js             all three role views + QR scan modal
```

Dependencies live in a single root `package.json` (not one per folder) so
both local dev and Vercel's build use one `npm install`.

## Resetting demo data

Delete `backend/data/db.json` and restart the server — it reseeds the three
demo accounts automatically.

## Deploying to Vercel

The app deploys as a single Vercel project: `api/index.js` wraps the Express
app from `backend/server.js` as a serverless function, and `vercel.json`
rewrites every request to it (so both the REST API and the static frontend
are served from the same place, just like local dev).

**Data storage on Vercel:** serverless functions have a read-only, ephemeral
filesystem, so the JSON-file store (`backend/data/db.json`) that's used
locally can't persist there. `backend/db.js` automatically switches to
Upstash Redis when `KV_REST_API_URL` / `KV_REST_API_TOKEN` are present in the
environment, keeping the exact same data shape. To enable it:

1. Deploy the project to Vercel (import the repo, or `vercel --prod`).
2. In the Vercel dashboard, go to **Storage → Marketplace Database
   Integrations** and add a **Redis** integration (Upstash), connecting it to
   this project. Vercel sets `KV_REST_API_URL` and `KV_REST_API_TOKEN`
   automatically.
3. Also set a `JWT_SECRET` environment variable (any random string) — the
   code falls back to a hardcoded dev secret otherwise, which is fine
   locally but not for a real deployment.
4. Redeploy so the new environment variables take effect. First request
   after that seeds the three demo accounts into Redis, same as local dev.

Without the Redis integration connected, the app still deploys and runs, but
falls back to writing `db.json` inside the function's `/tmp` — data won't be
shared across function instances and can reset at any time. Fine for a quick
look, not for a live multi-role demo.

### If auto-deploy silently stops working

Vercel requires each commit's author email to match a real GitHub account
with access to the connected repo — otherwise the deployment is created but
immediately marked `BLOCKED` (`COMMIT_AUTHOR_REQUIRED`), before a build even
runs. This is easy to miss because the site keeps serving the last
successful deployment, so nothing *looks* broken until you check the
Deployments tab and see recent ones stuck on `BLOCKED` (or the CLI shows
`UNKNOWN`). Fix: `git config user.email you@example.com` with an email
GitHub recognizes for your account, then push again.
