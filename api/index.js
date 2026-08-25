// Vercel serverless entry point — wraps the existing Express app.
// vercel.json rewrites every request here; the app's own routing
// (API routes + static frontend) handles the rest, same as local dev.
module.exports = require("../backend/server.js");
