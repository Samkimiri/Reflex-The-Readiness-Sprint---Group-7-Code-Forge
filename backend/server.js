const express = require("express");
const helmet = require("helmet");
const { rateLimit } = require("express-rate-limit");
const { Ratelimit } = require("@upstash/ratelimit");
const compression = require("compression");
const path = require("path");

const { requireAuth } = require("./middleware/auth");
const authRoutes = require("./routes/auth");
const deliveryRoutes = require("./routes/deliveries");
const userRoutes = require("./routes/users");
const productRoutes = require("./routes/products");
const trackRoutes = require("./routes/track");
const { seed } = require("./seed");
const { kv } = require("./db");

// A JWT signed with a hardcoded, publicly-visible fallback secret can be
// forged by anyone who's read this file — fine on localhost, not once the
// source is public. Failing loudly at startup (not just noting it in the
// README) means a real deployment can't accidentally go live without a
// real secret set. VERCEL is set automatically by the platform; this never
// fires for local dev, where the fallback in middleware/auth.js is fine.
if (process.env.VERCEL && !process.env.JWT_SECRET) {
  throw new Error(
    "JWT_SECRET must be set in production — refusing to start with the hardcoded dev fallback. " +
      "Set it in the Vercel project's environment variables."
  );
}

const app = express();

// Vercel (and most PaaS) puts the app behind a proxy — without this,
// express-rate-limit and req.ip would key off the proxy's address instead
// of the real client, making every visitor share one rate-limit bucket.
app.set("trust proxy", 1);

app.use(compression()); // gzip everything — matters most on the mobile networks this app targets

// CSP is scoped to what this app actually loads: jsQR from cdnjs, Google
// Identity Services for sign-in (script + its iframe/XHR), same-origin
// fetches, and data:/blob: images (product photos and the QR code, both
// rendered client-side without a round trip to a file host).
app.use(
  helmet({
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'", "https://cdnjs.cloudflare.com", "https://cdn.jsdelivr.net", "https://accounts.google.com"],
        styleSrc: ["'self'", "'unsafe-inline'", "https://fonts.googleapis.com"], // inline `style="..."` attributes in a few modals + the Inter stylesheet
        fontSrc: ["'self'", "https://fonts.gstatic.com"], // the actual Inter font files, served from Google's font CDN
        imgSrc: ["'self'", "data:", "blob:", "https://*.gstatic.com", "https://accounts.google.com"],
        connectSrc: ["'self'", "https://accounts.google.com"],
        frameSrc: ["https://accounts.google.com"],
        workerSrc: ["'self'"],
        manifestSrc: ["'self'"],
        objectSrc: ["'none'"],
        baseUri: ["'self'"],
        formAction: ["'self'"],
      },
    },
    crossOriginEmbedderPolicy: false, // would block Google's sign-in iframe
    crossOriginOpenerPolicy: { policy: "same-origin-allow-popups" }, // Google's OAuth flow
  })
);

// Default 100kb is too small for a product photo — the frontend compresses
// images before sending, but this headroom keeps that from being fragile.
app.use(express.json({ limit: "2mb" }));

// One structured line per request — method, path, status, duration — so
// Vercel's function logs are actually searchable during an incident
// instead of just whatever individual console.error calls happened to
// fire. req.id lets a specific failed request's summary line be matched
// up with the full stack trace the error handler below logs separately.
// Skips /api/health: it's polled constantly by uptime monitors, and its
// own simplicity (see below) is the point — logging every ping would just
// bury the requests that actually matter.
app.use((req, res, next) => {
  if (req.path === "/api/health") return next();
  req.id = Math.random().toString(36).slice(2, 8);
  // Captured now, not read back off req inside the finish handler below:
  // by the time a request has been routed into /api/auth, /api/deliveries,
  // etc., req.path is that sub-router's path with the mount prefix
  // stripped ("/login", not "/api/auth/login") — originalUrl is the one
  // Express property that always holds the full path regardless.
  const { method, originalUrl } = req;
  const start = Date.now();
  res.on("finish", () => {
    const ms = Date.now() - start;
    const level = res.statusCode >= 500 ? "ERROR" : res.statusCode >= 400 ? "WARN" : "INFO";
    console.log(`[${req.id}] ${level} ${method} ${originalUrl} ${res.statusCode} ${ms}ms`);
  });
  next();
});

// A liveness check on purpose doesn't depend on anything else (seeding,
// the data store) — it answers "is the process up", not "is everything
// ready". Placed before the seed gate so it can't be blocked by it.
app.get("/api/health", (req, res) => res.json({ status: "ok", uptime: process.uptime() }));

// Gate every other request behind seeding once — cheap after the first
// request, and avoids a cold-start race between seeding and the first API
// call. A transient blip (e.g. Redis not answering yet right at cold
// start) used to permanently skip seeding for that instance's whole
// lifetime, with nothing but a log line to show for it — on a fresh
// deploy that means "nobody can log in" with no visible error. A few
// retries with a short backoff absorbs that without needing to touch
// /api/health's own contract (deliberately answers "is the process up",
// not "is everything ready" — see above — so seed status isn't piped into
// it; a seed failure means missing demo accounts, not broken app
// functionality for real users, so this fails open, not closed).
async function seedWithRetry(attempts = 3) {
  for (let i = 1; i <= attempts; i++) {
    try {
      await seed();
      return;
    } catch (err) {
      console.error(`Seed attempt ${i}/${attempts} failed:`, err);
      if (i < attempts) await new Promise((r) => setTimeout(r, 500 * i));
    }
  }
  console.error("Seeding did not complete after retries — demo accounts may be missing.");
}
const seeded = seedWithRetry();
app.use((req, res, next) => {
  seeded.then(() => next());
});

// Brute-force protection on auth. A serverless deployment runs many
// concurrent instances — an in-memory counter per instance means a
// distributed attacker can spread requests across instances and evade it
// almost entirely, so this uses the same Redis the data layer already
// connects to (via @upstash/ratelimit, a sliding window shared across every
// instance) whenever it's configured, falling back to the old per-instance
// in-memory limiter only when it isn't (local dev with no KV env vars —
// there's exactly one instance then anyway, so in-memory is already exact).
// The integration test suite runs every test sequentially against one
// server instance, all from 127.0.0.1 — a real production concern (many
// distinct users sharing an IP behind NAT) becomes a false positive in a
// growing test suite (many *tests* sharing one address). Raised, not
// disabled, under NODE_ENV=test (set only by backend/test/api.test.js,
// never in production) so the limiter's actual behavior still gets
// exercised, just without the test suite itself tripping it.
function makeLimiter({ name, points, message }) {
  const limit = process.env.NODE_ENV === "test" ? 500 : points;
  if (kv) {
    const ratelimit = new Ratelimit({
      redis: kv,
      limiter: Ratelimit.slidingWindow(limit, "15 m"),
      prefix: `reflex:rl:${name}`,
    });
    return async (req, res, next) => {
      try {
        const { success } = await ratelimit.limit(req.ip);
        if (!success) return res.status(429).json({ error: message });
        next();
      } catch (err) {
        // Rate limiting must never be the reason a request fails outright
        // — if Redis itself is having a bad moment, let the request
        // through rather than 500ing every request in the app.
        console.error("Rate limiter error (allowing request through):", err);
        next();
      }
    };
  }
  return rateLimit({
    windowMs: 15 * 60 * 1000,
    limit,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: message },
  });
}

const authLimiter = makeLimiter({
  name: "auth",
  points: 30,
  message: "Too many attempts — try again in a few minutes.",
});

// The public tracking page (below) needs its own, more generous limiter:
// unlike everything else in this app it requires no session token to hit,
// so it's reachable by anyone with a link — or a scanner with none. 60/15min
// comfortably covers a real customer refreshing their own tracking page,
// while still bounding casual scraping. Token guessing itself isn't the
// concern (128 bits of entropy makes that infeasible regardless of rate).
const trackLimiter = makeLimiter({
  name: "track",
  points: 60,
  message: "Too many requests — try again in a few minutes.",
});

app.use("/api/auth", authLimiter, authRoutes);
app.use("/api/track", trackLimiter, trackRoutes);
app.use("/api/deliveries", requireAuth, deliveryRoutes);
app.use("/api/users", requireAuth, userRoutes);
app.use("/api/products", requireAuth, productRoutes);

// The tracking page is a real URL path (/track/:token) rather than a query
// string, so it reads cleanly if a retailer texts it to a customer — same
// static frontend/track.html regardless of the token; that page reads the
// token from window.location itself and calls GET /api/track/:token client
// side. Must come before express.static below, or a request for
// /track/<token> would just 404 (no matching file on disk under that name).
app.get("/track/:token", (req, res) => {
  res.sendFile(path.join(__dirname, "..", "frontend", "track.html"));
});

// Serve the frontend (plain HTML/JS — no build step) from the same server.
// Icons are effectively static content (rebuilding them means renaming, not
// overwriting) so they get a long cache lifetime; everything else keeps
// express.static's normal no-aggressive-caching defaults so app updates
// (app.js, style.css, sw.js) show up on the next load instead of being
// stuck behind a stale cache.
app.use(
  express.static(path.join(__dirname, "..", "frontend"), {
    setHeaders(res, filePath) {
      if (filePath.includes(`${path.sep}icons${path.sep}`)) {
        res.setHeader("Cache-Control", `public, max-age=${60 * 60 * 24 * 7}`);
      }
    },
  })
);

// Central error handler — statusMachine (and db.js's uniqueness/CAS
// helpers) throw { status, message } for intentional, safe-to-show errors
// like "that email is taken" or "already assigned by someone else". An
// *unexpected* error (a raw exception — a Redis timeout, a bug) doesn't
// get its raw .message shown to the client: that can leak internal detail
// (connection strings, stack-adjacent text, library internals) that was
// never meant to be public. The real message still goes to the server log
// either way, just not in the HTTP response for the un-intentional case.
app.use((err, req, res, next) => {
  const status = err.status || 500;
  if (status === 500) {
    console.error(`[${req.id || "?"}]`, err);
    return res.status(500).json({ error: "Something went wrong. Please try again." });
  }
  res.status(status).json({ error: err.message || "Something went wrong." });
});

const PORT = process.env.PORT || 4000;
if (require.main === module) {
  app.listen(PORT, () => {
    console.log(`\nReflex API + app running at http://localhost:${PORT}\n`);
  });
}

module.exports = app;
