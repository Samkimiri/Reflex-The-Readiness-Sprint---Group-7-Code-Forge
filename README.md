# Reflex — The Readiness Sprint

A working build of the case study: retailers log deliveries, a dispatcher assigns
a rider, the rider updates status, and drop-off is confirmed by scanning a QR
code — not just the rider's word.

## Run it

Requires Node.js (v18+ recommended). No database to install.

```bash
cd backend
npm install
npm start
```

Then open **http://localhost:4000** in your browser. The frontend is served by
the same server — one command runs everything.

On first run it seeds three demo accounts:

| Role       | Phone       | Password     |
|------------|-------------|--------------|
| Retailer   | 0700000001  | retailer123  |
| Dispatcher | 0700000002  | dispatch123  |
| Rider      | 0700000003  | rider123     |

Log in as each in a separate browser tab (or a normal + incognito window) to
demo the full three-role flow at once.

## Demoing the QR scan

- As the **retailer**, click "Show QR" on a delivery once it's `picked_up`.
- As the **rider**, click "Scan to Confirm Delivery" — it opens your camera
  (via `jsQR`) and reads the code shown on the other screen/device.
- No camera handy, or scanning a second window on the same laptop? Use the
  manual entry field in the same modal — copy the token from the retailer's
  QR endpoint response or just paste it in.

## What's actually implemented

- Full auth (register/login, JWT, bcrypt password hashing)
- All three role dashboards (Retailer, Dispatcher, Rider)
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
backend/
  server.js          entry point — wires up routes, serves the frontend
  db.js              data layer (JSON-file store)
  statusMachine.js    the transition rules + role checks, in one place
  seed.js            demo account seeding
  middleware/auth.js  JWT verification
  routes/auth.js      register, login
  routes/deliveries.js create, list, assign, status, scan, QR image
  routes/users.js      list riders (for the dispatcher's assign dropdown)
frontend/
  index.html
  style.css
  app.js             all three role views + QR scan modal
```

## Resetting demo data

Delete `backend/data/db.json` and restart the server — it reseeds the three
demo accounts automatically.
