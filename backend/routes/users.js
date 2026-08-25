const express = require("express");
const { readDB } = require("../db");

const router = express.Router();

// GET /api/users?role=rider
router.get("/", async (req, res) => {
  const db = await readDB();
  let users = db.users;
  if (req.query.role) users = users.filter((u) => u.role === req.query.role);
  res.json(users.map((u) => ({ id: u.id, name: u.name, phone: u.phone, role: u.role })));
});

module.exports = router;
