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
(phone is still collected and stored, just no longer the login identifier).
The credentials aren't dumped in plain sight on the login screen: they sit
behind a "🔑 Try a demo account" toggle (a collapsed `<details>`, same
pattern as the retailer's "+ Add a product" toggle) that a visitor has to
deliberately open — a first impression of a real login screen, not a
sandbox with the keys taped to the door.

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
| Admin | admin@reflex.demo   | `admin123` (or `ADMIN_SEED_PASSWORD` if you set one before first boot) |

...plus five example deliveries under the retailer account, one in each
status (`requested`, `assigned`, `picked_up`, `delivered`, `cancelled`), and
fourteen example products in the retailer's catalog — so every dashboard has
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

## Language toggle (English / Swahili)

An **EN / SW** toggle sits at the top of the login card — Reflex is
built for Kenyan retailers, so a first-language option on the very
first screen someone sees matters more than translating the whole app.
It's a plain JS dictionary (`TRANSLATIONS` in `app.js`) hydrating every
`data-i18n`-tagged element on the login screen (hero tagline, the
role-showcase slideshow, form labels, buttons, the demo-accounts
toggle) — no i18n library, consistent with the rest of this app's
zero-unnecessary-dependency approach. The choice is saved to
`localStorage` and re-applied on load, so it persists across visits and
reloads. Scoped deliberately to just the login screen rather than the
full authenticated app: that's the highest-value spot (it's what a
brand-new visitor sees before they've even signed in) without taking on
translating every dashboard string for a prototype.

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

The one deliberate exception to "oversight, not operations": admin can
**approve a pending dispatcher** (see the access-control gate in Security
notes above) and **reset a user's password** when they're locked out —
both real write actions, both scoped narrowly to problems literally only
admin can solve, not a general editing capability over other accounts.

## Product catalog

Retailers manage a simple product catalog (name, optional price, optional
description, optional photo) in the same dashboard where they log and track
deliveries — one connected view, not a separate page. Products render as a
responsive card grid (photo/placeholder, name, price, description, edit and
remove buttons) rather than a plain list, 2 columns on phones with no
horizontal overflow at any width down to 360px, and the "add a product"
form lives behind a collapsible toggle so the catalog itself is the focus.
Each card's **Edit** button opens the same style of form pre-filled with
that product's current values — name, price, description, and photo are
all independently editable after the fact, not just at creation. When
logging a new delivery, a dropdown lists the retailer's products; picking
one fills in the item description (still editable, or skip it and type
freely). Products are scoped to the retailer that created them
(`GET/POST /api/products`, `PATCH/DELETE /api/products/:id`) — only a
retailer can manage their own catalog.

Product photos are resized/re-encoded to a small JPEG **in the browser**
before upload (max 480px, quality ~0.72) and stored as a data URL on the
product record. There's no separate file/blob storage to configure — the
data store is a JSON/Redis blob either way, so this keeps setup at zero —
but it does mean payload size matters: the backend rejects anything over
~450KB decoded as a sanity check, well above what the client-side
compression normally produces.

## Profile editing

Every retailer, dispatcher, and rider can edit their own name, phone
number, and profile photo via the "👤 Profile" link in the topbar — a
modal reachable from any view, not tied to a specific role's dashboard.
The photo (compressed client-side the same way product photos are, just
smaller — max 300px) shows as a small avatar next to the user's name in
the topbar once set. `PATCH /api/users/me` deliberately excludes email,
password, and role: those need extra verification (uniqueness checks,
current-password confirmation, admin-only role changes) that's out of
scope here — this covers "my name is misspelled" / "add a photo", not a
full account-settings page. The admin account doesn't get this link —
consistent with it already being excluded from self-registration and the
public demo logins (see `backend/seed.js`), it's an oversight account,
not a normal user profile.

### Changing your password

The same profile modal has a "Change password" section underneath the
name/phone/photo form — `PATCH /api/users/me/password`, deliberately its
own endpoint and route handler rather than folded into the profile-edit
one above, since it needs different rules: it requires the *current*
password (bcrypt-compared server-side, not just trusted from the client)
before accepting a new one, and the new password has the same
minimum-length check as registration. One edge case is handled
explicitly: a Google-only account has no `password_hash` yet, so for
that account current-password verification is skipped — this doubles as
"set a password for the first time" rather than "change" one, since
there's nothing to verify against. On success the form clears and shows
a confirmation toast; the modal itself stays open (consistent with every
other in-modal save in this app) so you can keep editing or close it
yourself.

## Delivery chat

Every delivery card (retailer, dispatcher, rider) has a "💬 Chat" button
opening a per-delivery message thread — the retailer, any dispatcher, and
the assigned rider (once one exists) can all read and post to it, so
coordinating a specific delivery ("what time works for pickup?", "5 mins
away") doesn't mean falling back to a phone call. Backed by
`GET/POST /api/deliveries/:id/messages`, gated by the exact same
`canViewDelivery()` check the delivery itself uses — no separate
visibility rule to get wrong. Admin can read a thread (oversight, same as
everywhere else in this app) but not post — consistent with admin being
oversight-only throughout, not a participant in day-to-day coordination.

**"Live" here means polling, not WebSockets — deliberately.** While a
chat modal is open, the frontend polls its thread every 3s (tighter than
the 5s dashboard poll, since a conversation is more latency-sensitive
than a delivery list) and appends anything new; sending a message posts
immediately and re-fetches. This is the same trade-off already made for
the dashboard auto-refresh (see the trade-off log) applied to chat: the
app runs on Vercel serverless functions, which don't hold a persistent
connection open between invocations, so real push (WebSockets/SSE) would
mean standing up separate always-on infrastructure just for this one
feature. The poll only runs while a chat modal is actually open — not as
a constant background cost — and is torn down the moment the modal
closes, however it closes (the ✕ button, clicking the backdrop, or
opening a different modal on top of it).

## Customer tracking page

Every delivery's QR token doubles as a public tracking link — no second
token type, no login required. From the retailer's "Show QR" modal, a
"🔗 Copy tracking link for customer" button (shown once the delivery has
a `qr_code`) copies `https://<your-deploy>/track/<token>` to the
clipboard, ready to text or share straight to the customer. That URL
opens a standalone page (`frontend/track.html` /
`frontend/track.js`, no dependency on the main app's auth/state) showing
the item, delivery address, current status, and the full status
timeline, polling every 10s so it reflects reality without a refresh.

The backing route, `GET /api/track/:token` (`backend/routes/track.js`),
is mounted **before** `requireAuth` with its own rate limiter
(`trackLimiter`, separate from the auth limiter) — it's intentionally
public, since the whole point is a customer with no Reflex account
being able to open it. What it returns is deliberately minimal: item
description, address, customer *name* (not phone — that stays
internal), status, retailer name, and the history timeline. An unknown
or mistyped token gets a generic 404 rather than a distinct
"invalid token" vs. "not found" response, so a guess can't be used to
probe which tokens are real.

## Demoing the QR scan

- As the **retailer**, click "Show QR" on a delivery once it's `picked_up`.
- As the **rider**, click "Scan to Confirm Delivery" — it opens your camera
  (via `jsQR`) and reads the code shown on the other screen/device. Because
  this app's real-world scan path is screen-to-camera (a rider's phone
  reading the retailer's phone/monitor) rather than scanning a print, the
  QR is rendered with a full quiet zone (`margin: 4`, the spec minimum) and
  the camera stream requests a higher resolution than the browser default —
  both matter more here than they would for a printed code.
- No camera handy, or the scan just isn't landing? The same "Show QR" modal
  the retailer opens also shows a **backup code** — the same token as the
  QR, as plain text, with a "Copy code" button. Read or send that to the
  rider, who enters it under "Camera not working?" in their scan modal.
  That field tolerates how a human actually relays a 32-character code —
  spaces, dashes, mixed case — rather than requiring an exact paste.

## Security notes

- **A self-registered dispatcher starts unapproved, and can't act — or even
  read — anything until an admin approves them.** Dispatcher is full
  oversight of every retailer's deliveries (customer names, phones,
  addresses, the works), and unlike retailer or rider that access isn't
  otherwise scoped down to "their own" — so open self-registration into
  that role used to mean anyone who filled in a form got it instantly, with
  no vetting at all. Now `POST /api/auth/register` (and the Google
  sign-in equivalent) creates a dispatcher account with `approved: false`;
  every dispatcher-level read and write checks that flag live against the
  current user record (`statusMachine.js`, `canViewDelivery` in
  `deliveries.js`), not something baked into the JWT, so an admin approving
  someone takes effect on their very next request. Admin's "System
  Overview" screen shows a **Pending dispatcher approvals** panel — the one
  write action that read-only oversight role has — and the frontend shows
  an unapproved dispatcher a clear "pending approval" screen instead of a
  dashboard that would just 403 on every fetch. Covered end-to-end by a
  regression test in `backend/test/api.test.js` (registration → blocked
  read/write → admin approval → the same, unchanged token now works).
  Retailer and rider don't need this gate: a retailer only ever touches
  their own deliveries, and a rider only ever touches deliveries a
  dispatcher explicitly assigned them.
- **Access control is scoped per-party, not just per-role.** A retailer can
  only see and cancel *their own* deliveries; a rider can only see
  deliveries assigned to *them*. Requesting a delivery you're not party to
  returns 404, not 403 — deliberately, so an unauthorized request can't be
  used to confirm a given ID even exists. (An earlier version of this
  checked role but not ownership, letting any retailer view or cancel any
  other retailer's deliveries — fixed, and covered by a regression test in
  `backend/test/api.test.js` so it can't quietly come back.)
- **Rate limiting on `/api/auth/*` and `/api/track/*`** (30 and 60 requests
  per 15 minutes per IP) is shared across every serverless instance via
  `@upstash/ratelimit` on the same Redis the data layer already connects
  to, not a separate per-instance in-memory counter — a distributed
  attacker spreading requests across instances no longer partially evades
  it. Falls back to the old in-memory limiter only when no Redis is
  configured (local dev, where there's exactly one instance anyway, so
  in-memory is already exact).
- **CSP and other security headers** via `helmet`, scoped to exactly what
  this app loads (jsQR from jsDelivr, Google Identity Services, same-origin
  fetches, `data:`/`blob:` images for product photos and the QR code).
- **`JWT_SECRET` must be a real secret in production, and the server
  refuses to start without one.** The hardcoded dev fallback only applies
  when `VERCEL` isn't set (i.e. `npm start` locally) — on Vercel with no
  `JWT_SECRET` configured, `server.js` throws at startup instead of
  silently signing every login token with a value that's sitting in this
  public repo. Vercel's env var UI is where to set it (see the deployment
  section below).
- Passwords and emails are validated server-side (minimum length, basic
  email shape), not just in the browser — client-side `required`/`type`
  attributes are a UX nicety, not a security boundary, since anyone can
  call the API directly.
- No CORS middleware: the frontend and API are served from the same origin
  by the same Express app, so there's no cross-origin request to allow in
  the first place — `cors()` was removed as unneeded attack surface.
- **Password reset is admin-mediated, not email-based** — there's no
  email/SMS provider wired into this app, so there's no way to actually
  deliver a reset *link*. `POST /api/users/:id/reset-password` (admin-only)
  generates a random one-time temporary password, returns it in that single
  response, and never stores or logs the plaintext — only its bcrypt hash
  persists. The expectation is the same as any of this app's other
  "generate a code and relay it out-of-band" patterns (the QR backup code,
  the tracking link): an admin verifies who they're talking to some other
  way (phone call, in person) before handing it over, and the user changes
  it via the existing self-service `PATCH /users/me/password` right after
  logging in.

## What's actually implemented

- Full auth (self-service register/login by email+password, a show/hide
  toggle on every password field, JWT, bcrypt password hashing, optional
  Google sign-in)
- Automated tests (`npm test`) and a `GET /api/health` liveness endpoint
- Typography: Inter (Google Fonts), replacing the system-font stack —
  chosen via the `ui-ux-pro-max` design skill's typography data, which
  tags it for "Dashboards, admin panels, ... enterprise apps", matching
  this app's category. CSP updated to allow `fonts.googleapis.com` /
  `fonts.gstatic.com`; system fonts remain the fallback if that ever
  fails to load
- A per-role hero background: each dashboard (`#app-screen[data-role]`,
  set in `enterApp()`) gets its own faint, slow-drifting SVG motif — a
  product-catalog grid for the retailer, a hub-and-spoke network for the
  dispatcher, an in-transit route for the rider, radar rings for admin
  oversight — hand-drawn as self-hosted SVGs (`frontend/hero/`), no
  external image host or new dependency. Kept to one subtle 40s drift
  animation per view (opacity ~0.09, `pointer-events: none`, positioned
  in the corner so it never sits under real content) — per the
  `ui-ux-pro-max` skill's own "animate 1-2 elements max" and "honor
  prefers-reduced-motion" guidance, both already followed here
- A 3-slide auto-advancing role showcase in the login hero panel
  (`#hero-slideshow`, `initHeroSlideshow()` in app.js) — retailer,
  dispatcher, and rider each get a slide (icon badge + role name +
  one-line caption), cross-fading every 10s. Standard carousel etiquette,
  not just extra code: pauses on hover/focus and while the tab isn't
  visible (a slide changing under someone's cursor, or silently still
  ticking in a background tab, is exactly what those pauses prevent),
  and honors `prefers-reduced-motion` by never starting the auto-advance
  timer at all — the dots below the slides still work as manual
  navigation either way. A fixed-height container (not per-slide) means
  the three captions, which differ in length, never cause a layout jump
  when the active slide changes. A full-bleed photo carousel sits behind
  the entire login screen (`.hero-bg-carousel`, `frontend/hero-photos/`),
  one photo per role, cross-fading in lockstep with the slide above it —
  same `index`/timer, so there's exactly one 10s clock driving both rather
  than two to keep in sync, with a slower, smoother 2.4s opacity fade
  (`ease-in-out`) between photos to match the heavier visual. Each photo
  has a light dark-teal gradient wash baked into its own `background-image`
  so text stays legible over it without a separate scrim element, kept
  subtle enough that the photos themselves stay clearly visible rather
  than mostly obscured. The dispatcher and rider photos are sized larger
  than a strict cover fit (`background-size: auto 118%` / `130%`) purely
  to create vertical slack to position within — `cover` alone has zero
  vertical room to pan on this layout (height is always the binding
  dimension), so without the oversize, `background-position` would have
  nothing to actually move. On wide viewports the existing frosted-glass
  hero panel sits on top and blurs it further; on narrow viewports (where
  that panel is hidden) it's just a tinted photo behind the login card
- **Motion** (motion.dev — a small, framework-agnostic animation library
  from the Framer Motion team, loaded via CDN in `index.html`, no React or
  build step needed) drives several specific animations on top of behavior
  that already worked without it:
  - The hero carousel's photo crossfade on the login screen (a real
    two-sided fade with a barely-there scale-in, replacing the plain CSS
    opacity transition)
  - A staggered fade/slide entrance for card lists on first render: the
    retailer's delivery cards and product grid, the dispatcher's open and
    in-flight lists, and the rider's list. Scoped to first render only
    (not every 5s poll) to avoid flickery re-animation on every list
    refresh; re-triggers again after the viewing role's own action
    (log/cancel a delivery, etc.) causes a fresh mount of that screen,
    since the whole list is replaced via `innerHTML` on every render
    rather than diffed, so there's no persistent element identity for a
    true FLIP-style reorder animation between in-place renders — the
    entrance re-triggering on remount is the honest fit for that
    architecture, not a limitation being worked around
  - A spring-physics pop-in for modals (chat, delivery detail, etc.),
    replacing the plain CSS `@keyframes` entrance — the existing keyframe
    is explicitly cancelled (`el.style.animation = "none"`) before Motion
    attaches, since a already-declared CSS keyframe animation doesn't
    cede priority to a later WAAPI animation the way a CSS *transition*
    would
  - A spring slide/fade-in and eased fade-out for toast notifications
  - A quick scale "pop" on a delivery's status pill when a live poll
    (not the viewing user's own action — see `silent` in
    `diffAndToastChanges`) detects that its status changed, so a
    dispatcher or rider watching the list can see at a glance which card
    just updated

  Everything built on it checks `window.Motion` and `prefers-reduced-motion`
  first (`motionAvailable()` in app.js) — if the CDN script doesn't load
  (offline, blocked) or reduced motion is preferred, it silently no-ops
  and the plain CSS-driven behavior underneath (still there, unchanged)
  is exactly what's left
- All four role dashboards (Retailer, Dispatcher, Rider, admin oversight),
  including a retailer product catalog (with photos) wired into delivery
  creation
- A two-panel login/register screen (brand + feature highlights alongside
  the form on wide viewports, collapsing to just the form on phones). The
  brand panel is a frosted-glass (`backdrop-filter: blur`) surface over
  the screen's radial-gradient background, so the glow blurs through it
  instead of sitting under a flat fill — layered behind `@supports` with
  a plain-gradient fallback for browsers without backdrop-filter support
- Responsive layout tuned for phone-sized viewports and the installed-app
  window specifically (safe-area padding for notches/home indicators,
  collapsing grids, a topbar that wraps instead of clipping), plus hover
  and transition polish (`prefers-reduced-motion` respected)
- The retailer view specifically gets 44px-minimum touch targets on every
  button/select on mobile (the shared `.btn`/`.btn-sm` sizing is mouse-
  first and runs 26-33px tall by default — fine with a cursor, fiddly
  with a thumb) and 16px form text (below that, iOS Safari zooms the
  whole page in on focus, hiding the rest of the view until the user
  zooms back out). Scoped to a `.retailer-view` wrapper so dispatcher/
  rider/admin, which reuse the same component classes, are unaffected
- Backend response compression (gzip) and long-lived caching for static
  icons, so repeat loads are cheap on mobile connections
- An in-app "How Reflex works" guide (✨ link on the login screen) — a
  four-step illustrated walkthrough of the retailer→dispatcher→rider→QR
  relay, for anyone opening the prototype cold
- Real interaction feedback everywhere it's needed: every action button
  (login, register, log a delivery, add a product, assign, cancel, pick
  up, scan-confirm) shows a spinner and disables itself while its request
  is in flight — both a UX nicety and a correctness fix, since it also
  stops a double-click from firing the same request twice. Login/register
  get live feedback too: a green check/red X on the email field as you
  type, and a strength meter under the password field on registration.
  The login screen's hero panel also shows a live `/api/health` status
  badge — an actual proof-of-life, not a static claim.
- The exact status state machine from the architecture deck, enforced
  server-side with role checks on every transition
- A real, provable audit trail (`status_log`) — visible as "History" on any
  delivery
- Real QR code generation (`qrcode` npm package) and camera-based scanning
  (`jsQR`), with a manual backup-code fallback shown right in the QR modal
  for when a camera isn't available or won't cooperate
- Polling refresh every 5s for dispatcher and rider (the Trade-off #1 from
  the trade-off log). Retailer and admin are both excluded from this,
  for different reasons. Retailer: it's a multi-field form, and a poll
  tick mid-fill would replace the form's HTML under the retailer's hands,
  wiping whatever they'd typed — the view re-renders after every action it
  takes instead (create/cancel/add product), plus a manual refresh button
  for the rest. Admin: it's a read-only system-wide overview an admin
  tends to leave open while doing other things, so a full re-render every
  5s is wasted work for a screen nobody's mid-task on — it gets the same
  manual refresh button instead
- Status-change toasts on the dispatcher and rider views: each poll tick
  diffs the freshly-fetched deliveries against what was on screen last
  tick and toasts whatever changed (a new delivery entering that role's
  view, or an existing one moving to a new status), so the 5s auto-refresh
  reads as live activity instead of a silent list swap. Skipped on the
  first render after login (nothing to diff against yet) and after the
  viewer's own action (which already shows its own confirmation toast)
- Search + status filtering on the dispatcher and rider delivery lists —
  a text search across customer name/address plus a status dropdown,
  filtered client-side against the already-fetched list so it's instant.
  Filter state (and focus/cursor position, if the search box was focused)
  survives the 5s poll re-render instead of resetting
- Retailer "at a glance" stats (deliveries in the last 7 days, average
  time from logged to delivered, cancellation rate) computed client-side
  from the retailer's own delivery history — no extra API calls
- Skeleton loading placeholders shaped like each role's real layout,
  shown the moment a view starts loading (first render after login, or a
  manual full re-render) so switching roles reads as "content is
  arriving" instead of a blank panel. Not shown on poll ticks — the
  existing content stays put until the new content is ready, no flicker
- A native Web Share button (📤) on the retailer's "Show QR" modal —
  feature-detected, so it only appears in browsers that actually support
  `navigator.share` (mainly mobile). Shares the QR straight to whatever
  the OS share sheet offers (WhatsApp, SMS, AirDrop, etc.) instead of
  requiring a screenshot-and-attach
- Offline queueing for the retailer's two write actions (log a delivery,
  add a product): if the request can't reach the server, it's saved to
  IndexedDB instead of failing, the form resets, and a "⏳ N pending
  sync" badge appears next to the refresh button. Replay is triggered by
  the browser's `online` event and, as a backstop, opportunistically on
  every retailer view load — not the Background Sync API, which only
  Chromium supports; the `online` event works everywhere, including
  Safari/iOS, which matters more here than replaying while the tab is
  fully closed
- **CI** (`.github/workflows/test.yml`) runs the full backend suite on
  every push and PR to `main` — a regression can't reach production
  without at least the same 35 checks that would have caught it locally
  actually running somewhere other than a developer's own machine.
- **Opt-in pagination** on `GET /api/deliveries` and `GET /api/users` —
  passing `?limit=&offset=` returns `{ items, total, limit, offset }`
  instead of a plain array; omitting them returns the full list exactly as
  before, so every existing view is unaffected. Exists as a guard against
  unbounded growth on the system-wide views (admin's "all deliveries"/"all
  users") rather than something every role's own scoped list needs today —
  a retailer's or rider's own deliveries stay naturally small. Wiring an
  actual "load more" control into the admin UI is the next step here, not
  yet done.

## Architecture notes / where this differs from the original design doc

- **Data store:** a JSON file (`backend/data/db.json`) locally, or a
  per-table Redis hash on Vercel (see below), instead of PostgreSQL — the
  whole thing runs with zero setup for a one-week sprint, no DB server to
  install. The schema is identical (`users`, `deliveries`, `status_log`)
  and every read/write goes through `db.js`, so swapping in real Postgres
  later means rewriting that one file's storage primitives, not the routes
  or the state machine. Worth naming this trade-off explicitly if a
  panelist asks why it's not Postgres.
  - Each record lives at its own address (a field in a per-table Redis
    hash; a mutex-serialized slot in the local file) rather than the whole
    database being one JSON blob read-modify-written on every write — that
    used to mean any two concurrent writes anywhere in the app, not just
    to the same record, could silently clobber each other on Vercel's
    multiple concurrent instances. A delivery's status transition
    (assign/pick_up/cancel/deliver) and account uniqueness (email/phone at
    registration) get their own explicit atomic guarantees on top of that
    (a Lua script for the former, `SETNX` for the latter) — both were
    previously check-then-act races, now a genuine compare-and-swap with
    no window for two requests to both "win." See the comment at the top
    of `db.js` for the full reasoning.
- **Frontend:** plain HTML/CSS/JS instead of a React build, again to keep
  `npm install && npm start` as the entire setup. The API is a normal REST
  API underneath, so swapping in a React frontend later doesn't touch the
  backend at all.
- **Image storage:** product photos and profile pictures (`backend/imageStore.js`)
  follow the exact same "zero setup, upgrades automatically when configured"
  shape as the data store and rate limiting above. Locally, an uploaded
  photo is stored as a base64 data URL right inside the record — always
  has been, no setup needed. On Vercel, where this project has a
  [Vercel Blob](https://vercel.com/docs/vercel-blob) store connected
  (`BLOB_READ_WRITE_TOKEN` auto-injected), it's uploaded there instead and
  only the resulting CDN URL is stored — the DB record stays small instead
  of every read dragging ~50-450KB of image bytes along with it, and the
  photo gets a real CDN in front of it. Replacing or clearing a photo
  deletes the old blob (fire-and-forget, best-effort); deleting a product
  deletes its photo too. Nothing about the frontend changed — it already
  treated `image` as an opaque URL string, whether that was a `data:` URL
  or an `https://` one.

## Known gaps — deliberately not built yet

Called out explicitly rather than left implicit, same spirit as the
trade-off log above. These either need an external account/service this
repo doesn't have credentials for, or are big enough to deserve their own
focused pass instead of being rushed in alongside something else:

- **No error tracking/monitoring** beyond Vercel's own runtime logs, which
  have short retention. A production 500 today is only visible if someone
  thinks to go pull them. Needs a real provider (Sentry or similar) and an
  account/DSN key this repo doesn't have.
- **No refresh tokens** — a single 12h JWT, no silent renewal, no
  revocation list. Reasonable for how this app is used today; a real fix
  changes login UX (silent refresh, longer-lived refresh-token storage,
  what "log out everywhere" even means) and deserves its own design pass
  rather than being bolted on under time pressure.
- **No 2FA anywhere**, including on the admin account, which has read
  access to every user's contact info. TOTP (an authenticator app) is
  buildable without a new external account, unlike SMS-based 2FA — but
  it's still a real feature (enrollment flow, backup codes, verify-on-login)
  that deserves being scoped on its own.
- **No relational database.** The JSON-file/Redis-hash data layer above is
  a deliberate trade-off for a zero-setup prototype, but it's worth
  restating as a real limitation on its own: no relational queries, no
  migration tooling, no backup/restore story beyond whatever the Redis
  provider does by default.

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
  routes/deliveries.js create, list, assign, status, scan, QR image, chat
  routes/users.js      list riders (for the dispatcher's assign dropdown),
                       self-service profile edit + password change
  routes/products.js   a retailer's product catalog (create, list, edit, delete)
  routes/track.js      public, unauthenticated delivery tracking lookup
frontend/
  index.html
  style.css
  app.js             all three role views + QR scan modal
  track.html          standalone public tracking page (no auth)
  track.js            fetches + renders /api/track/:token, polls every 10s
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
environment — same schema, same higher-level functions, just a different
storage layout under the hood (see the Data store note above). To enable it:

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

**Image storage on Vercel** works the same optional-upgrade way (see the
Image storage note above). To enable it:

1. In the Vercel dashboard (or `vercel blob create-store <name> --access
   public`), create a Blob store and connect it to this project — this
   auto-injects `BLOB_READ_WRITE_TOKEN` into every environment (production,
   preview, and, if you asked for it, development).
2. Redeploy so the new environment variable takes effect. No other setup —
   `backend/imageStore.js` picks it up automatically.

Without a Blob store connected, product/profile photos keep working exactly
as before: stored as base64 inside the record. Nothing breaks; you just
don't get the smaller records / real CDN benefit until it's connected.

### If auto-deploy silently stops working

Vercel requires each commit's author email to match a real GitHub account
with access to the connected repo — otherwise the deployment is created but
immediately marked `BLOCKED` (`COMMIT_AUTHOR_REQUIRED`), before a build even
runs. This is easy to miss because the site keeps serving the last
successful deployment, so nothing *looks* broken until you check the
Deployments tab and see recent ones stuck on `BLOCKED` (or the CLI shows
`UNKNOWN`). Fix: `git config user.email you@example.com` with an email
GitHub recognizes for your account, then push again.

## Deploying to Render

Render runs this app as a normal, always-on Node process (`npm start`,
listening on `process.env.PORT`, which Render sets automatically) rather
than a serverless function — no `api/index.js` wrapper needed there, and
no cold starts. `render.yaml` at the repo root is a Blueprint: importing it
in Render provisions the service with the right build/start commands
already filled in, instead of setting each field by hand.

Render's own filesystem is just as ephemeral as Vercel's serverless one —
a restart or redeploy wipes it — so the same Redis-backed persistence
`db.js` already supports is what makes this a real deployment instead of a
demo that forgets everything. This walkthrough sets up a deployment with
its **own independent data** (a fresh Redis + optional Blob store, not the
same ones the Vercel deployment uses) — do this if you want two genuinely
separate instances, e.g. to compare platforms or keep one as a backup that
can't be affected by a bug in the other.

1. **Push this repo to GitHub** (already done, if you're reading this from
   there) and go to [render.com](https://render.com) → **New** → **Blueprint**
   → connect the repo. Render reads `render.yaml` and proposes the service.
2. **Create an independent Redis database at [upstash.com](https://upstash.com)**
   (a separate account from Vercel's bundled one — Upstash's own free tier
   is generous and needs no credit card). Create a database, then from its
   dashboard copy the **REST API** `UPSTASH_REDIS_REST_URL` and
   `UPSTASH_REDIS_REST_TOKEN` values — these are what `KV_REST_API_URL` /
   `KV_REST_API_TOKEN` below expect (same REST client this app already
   uses for the Vercel deployment, just a different database instance).
3. In the Render dashboard, under the new service's **Environment**, set:
   - `JWT_SECRET` — a real random secret, **different from the one Vercel
     uses** (two independent deployments shouldn't trust each other's
     tokens). Generate one locally: `node -e "console.log(require('crypto').randomBytes(48).toString('base64'))"`
   - `KV_REST_API_URL` / `KV_REST_API_TOKEN` — from step 2.
   - `ADMIN_SEED_PASSWORD` (optional) — sets the seeded admin's password on
     first boot; omit it to use the same `admin123` default as local dev.
   - `GOOGLE_CLIENT_ID` (optional) — only if you want Google sign-in
     working on this deployment too; needs its own OAuth client if so,
     since Google Client IDs are tied to authorized origins/domains.
   - `BLOB_READ_WRITE_TOKEN` (optional) — skip this for a truly independent
     setup; product/profile photos fall back to base64-in-Redis
     automatically (see the Image storage note above), which is fine at
     this scale. Only set it if you specifically want Render's photos on a
     real CDN too — that means creating a *second* Vercel Blob store (the
     product works from any server, not just ones running on Vercel), not
     reusing the one already connected to the Vercel deployment.
4. Deploy. First request after that seeds the three demo accounts (plus
   the admin account) into this Redis instance, same as every other fresh
   environment this app has ever booted into.

Without Redis configured, the app still deploys and runs on Render, but
falls back to writing `backend/data/db.json` inside the service's own
ephemeral disk — it'll work until the next restart or redeploy, then reset.
Fine for a quick look, not for a live demo you want to keep coming back to.
