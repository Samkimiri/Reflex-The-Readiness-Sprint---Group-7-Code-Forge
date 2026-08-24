const jwt = require("jsonwebtoken");
const { findUserById } = require("../db");

const JWT_SECRET = process.env.JWT_SECRET || "reflex-dev-secret-change-me";

function requireAuth(req, res, next) {
  const header = req.headers.authorization || "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : null;
  if (!token) return res.status(401).json({ error: "Missing auth token." });

  try {
    const payload = jwt.verify(token, JWT_SECRET);
    const user = findUserById(payload.id);
    if (!user) return res.status(401).json({ error: "User no longer exists." });
    req.user = user;
    next();
  } catch (e) {
    return res.status(401).json({ error: "Invalid or expired token." });
  }
}

module.exports = { requireAuth, JWT_SECRET };
