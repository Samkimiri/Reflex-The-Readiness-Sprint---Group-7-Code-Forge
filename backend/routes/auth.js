const express = require("express");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const { findUserByPhone, createUser } = require("../db");
const { JWT_SECRET } = require("../middleware/auth");

const router = express.Router();

const ROLES = ["retailer", "dispatcher", "rider"];

router.post("/register", async (req, res) => {
  const { name, phone, password, role } = req.body || {};
  if (!name || !phone || !password || !role) {
    return res.status(400).json({ error: "name, phone, password, and role are all required." });
  }
  if (!ROLES.includes(role)) {
    return res.status(400).json({ error: `role must be one of: ${ROLES.join(", ")}` });
  }
  if (await findUserByPhone(phone)) {
    return res.status(409).json({ error: "A user with that phone number already exists." });
  }

  const password_hash = bcrypt.hashSync(password, 10);
  const user = await createUser({ name, phone, password_hash, role });
  const token = jwt.sign({ id: user.id, role: user.role }, JWT_SECRET, { expiresIn: "12h" });

  res.status(201).json({ token, user: publicUser(user) });
});

router.post("/login", async (req, res) => {
  const { phone, password } = req.body || {};
  if (!phone || !password) return res.status(400).json({ error: "phone and password are required." });

  const user = await findUserByPhone(phone);
  if (!user || !bcrypt.compareSync(password, user.password_hash)) {
    return res.status(401).json({ error: "Invalid phone or password." });
  }

  const token = jwt.sign({ id: user.id, role: user.role }, JWT_SECRET, { expiresIn: "12h" });
  res.json({ token, user: publicUser(user) });
});

function publicUser(u) {
  return { id: u.id, name: u.name, phone: u.phone, role: u.role };
}

module.exports = router;
