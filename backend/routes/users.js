const express = require("express");
const { readDB } = require("../db");

const router = express.Router();

// GET /api/users?role=rider — a dispatcher needs the rider list for their
// assign dropdown; a full, unfiltered directory (including everyone's
// email/phone) is admin-only oversight, not something a retailer or rider
// has a legitimate reason to pull.
router.get("/", async (req, res) => {
  if (!["dispatcher", "admin"].includes(req.user.role)) {
    return res.status(403).json({ error: "Not authorized to list users." });
  }

  const db = await readDB();
  let users = db.users;
  if (req.query.role) users = users.filter((u) => u.role === req.query.role);
  res.json(users.map((u) => ({ id: u.id, name: u.name, phone: u.phone, email: u.email || null, role: u.role, created_at: u.created_at })));
});

module.exports = router;
