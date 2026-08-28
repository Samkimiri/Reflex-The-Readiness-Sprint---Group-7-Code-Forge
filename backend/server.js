const express = require("express");
const helmet = require("helmet");
const { rateLimit } = require("express-rate-limit");
const compression = require("compression");
const path = require("path");

const { requireAuth } = require("./middleware/auth");
const authRoutes = require("./routes/auth");
const deliveryRoutes = require("./routes/deliveries");
const userRoutes = require("./routes/users");
const productRoutes = require("./routes/products");
const trackRoutes = require("./routes/track");
const { seed } = require("./seed");

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
        scriptSrc: ["'self'", "https://cdnjs.cloudflare.com", "https://accounts.google.com"],
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

// A liveness check on purpose doesn't depend on anything else (seeding,
// the data store) — it answers "is the process up", not "is everything
// ready". Placed before the seed gate so it can't be blocked by it.
app.get("/api/health", (req, res) => res.json({ status: "ok", uptime: process.uptime() }));

// Gate every other request behind seeding once — cheap after the first
// request, and avoids a cold-start race between seeding and the first API call.
const seeded = seed().catch((err) => console.error("Seed failed:", err));
app.use((req, res, next) => {
  seeded.then(() => next());
});

// Best-effort brute-force protection on auth. "Best-effort" because a
// serverless deployment runs many concurrent instances, each with its own
// in-memory counter — a distributed attacker can spread requests across
// instances and partially evade this. Real protection at scale needs a
// shared store (Redis, same as the KV_REST_API_URL used for data), which
// is a reasonable next step if this app ever needs to withstand a serious
// credential-stuffing attempt rather than casual abuse.
// The integration test suite runs every test sequentially against one
// server instance, all from 127.0.0.1 — a real production concern (many
// distinct users sharing an IP behind NAT) becomes a false positive in a
// growing test suite (many *tests* sharing one address). Raised, not
// disabled, under NODE_ENV=test (set only by backend/test/api.test.js,
// never in production) so the limiter's actual behavior still gets
// exercised, just without the test suite itself tripping it.
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: process.env.NODE_ENV === "test" ? 500 : 30,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many attempts — try again in a few minutes." },
});

// The public tracking page (below) needs its own, more generous limiter:
// unlike everything else in this app it requires no session token to hit,
// so it's reachable by anyone with a link — or a scanner with none. 60/15min
// comfortably covers a real customer refreshing their own tracking page,
// while still bounding casual scraping. Token guessing itself isn't the
// concern (128 bits of entropy makes that infeasible regardless of rate).
const trackLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: process.env.NODE_ENV === "test" ? 500 : 60,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many requests — try again in a few minutes." },
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

// Central error handler — statusMachine throws { status, message }
app.use((err, req, res, next) => {
  const status = err.status || 500;
  if (status === 500) console.error(err);
  res.status(status).json({ error: err.message || "Something went wrong." });
});

const PORT = process.env.PORT || 4000;
if (require.main === module) {
  app.listen(PORT, () => {
    console.log(`\nReflex API + app running at http://localhost:${PORT}\n`);
  });
}

module.exports = app;
