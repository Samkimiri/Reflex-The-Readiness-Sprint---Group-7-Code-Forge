const express = require("express");
const { readDB, findUserByPhone, saveUser } = require("../db");

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
  res.json(users.map((u) => ({ id: u.id, name: u.name, phone: u.phone, email: u.email || null, role: u.role, image: u.image || null, created_at: u.created_at })));
});

// Matches the product-photo cap in routes/products.js — a data URL this
// size decodes to roughly 450KB, well above what the frontend actually
// sends (it compresses to a small JPEG client-side first), just a sanity
// ceiling against a huge/unexpected upload.
const MAX_IMAGE_DATA_URL_LENGTH = 600_000;

// PATCH /api/users/me  { name?, phone?, image? }  — self-service profile
// edit, available to any authenticated role. Deliberately excludes email,
// password, and role: those need extra verification (uniqueness checks,
// current-password confirmation, admin-only role changes) that's out of
// scope here — this covers "my name is misspelled" / "add a photo".
router.patch("/me", async (req, res) => {
  const { name, phone, image } = req.body || {};

  if (name !== undefined) {
    if (!name || !name.trim()) return res.status(400).json({ error: "name is required." });
    req.user.name = name.trim();
  }

  if (phone !== undefined) {
    if (!phone || !phone.trim()) return res.status(400).json({ error: "phone is required." });
    const existing = await findUserByPhone(phone.trim());
    if (existing && existing.id !== req.user.id) {
      return res.status(409).json({ error: "That phone number is already in use." });
    }
    req.user.phone = phone.trim();
  }

  if (image !== undefined) {
    if (image === null || image === "") {
      req.user.image = null;
    } else {
      if (typeof image !== "string" || !image.startsWith("data:image/")) {
        return res.status(400).json({ error: "image must be an image data URL." });
      }
      if (image.length > MAX_IMAGE_DATA_URL_LENGTH) {
        return res.status(400).json({ error: "Image is too large — try a smaller photo." });
      }
      req.user.image = image;
    }
  }

  const saved = await saveUser(req.user);
  res.json(publicUser(saved));
});

function publicUser(u) {
  return { id: u.id, name: u.name, phone: u.phone, email: u.email || null, role: u.role, image: u.image || null };
}

module.exports = router;
