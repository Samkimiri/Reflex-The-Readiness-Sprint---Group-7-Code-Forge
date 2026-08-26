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
        styleSrc: ["'self'", "'unsafe-inline'"], // inline `style="..."` attributes in a few modals
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
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 30,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many attempts — try again in a few minutes." },
});

app.use("/api/auth", authLimiter, authRoutes);
app.use("/api/deliveries", requireAuth, deliveryRoutes);
app.use("/api/users", requireAuth, userRoutes);
app.use("/api/products", requireAuth, productRoutes);

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
