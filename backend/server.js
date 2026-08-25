const express = require("express");
const cors = require("cors");
const path = require("path");

const { requireAuth } = require("./middleware/auth");
const authRoutes = require("./routes/auth");
const deliveryRoutes = require("./routes/deliveries");
const userRoutes = require("./routes/users");
const { seed } = require("./seed");

const app = express();
app.use(cors());
app.use(express.json());

// Gate every request behind seeding once — cheap after the first request,
// and avoids a cold-start race between seeding and the first API call.
const seeded = seed().catch((err) => console.error("Seed failed:", err));
app.use((req, res, next) => {
  seeded.then(() => next());
});

app.use("/api/auth", authRoutes);
app.use("/api/deliveries", requireAuth, deliveryRoutes);
app.use("/api/users", requireAuth, userRoutes);

// Serve the frontend (plain HTML/JS — no build step) from the same server.
app.use(express.static(path.join(__dirname, "..", "frontend")));

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
