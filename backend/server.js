const express = require("express");
const cors = require("cors");
const compression = require("compression");
const path = require("path");

const { requireAuth } = require("./middleware/auth");
const authRoutes = require("./routes/auth");
const deliveryRoutes = require("./routes/deliveries");
const userRoutes = require("./routes/users");
const productRoutes = require("./routes/products");
const { seed } = require("./seed");

const app = express();
app.use(compression()); // gzip everything — matters most on the mobile networks this app targets
app.use(cors());
// Default 100kb is too small for a product photo — the frontend compresses
// images before sending, but this headroom keeps that from being fragile.
app.use(express.json({ limit: "2mb" }));

// Gate every request behind seeding once — cheap after the first request,
// and avoids a cold-start race between seeding and the first API call.
const seeded = seed().catch((err) => console.error("Seed failed:", err));
app.use((req, res, next) => {
  seeded.then(() => next());
});

app.use("/api/auth", authRoutes);
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
