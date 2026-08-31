const express = require("express");
const crypto = require("crypto");
const bcrypt = require("bcryptjs");
const { findUserByPhone, findUserById, listUsers, saveUser } = require("../db");

const router = express.Router();

// GET /api/users?role=rider&limit=&offset= — a dispatcher needs the rider
// list for their assign dropdown; a full, unfiltered directory (including
// everyone's email/phone) is admin-only oversight, not something a retailer
// or rider has a legitimate reason to pull. A pending (unapproved)
// dispatcher only gets this for role=rider — enough to function once
// approved for an assign dropdown they can't use yet anyway (assign itself
// is blocked in statusMachine.js), not the full directory.
router.get("/", async (req, res) => {
  if (!["dispatcher", "admin"].includes(req.user.role)) {
    return res.status(403).json({ error: "Not authorized to list users." });
  }
  if (req.user.role === "dispatcher" && req.user.approved === false && req.query.role !== "rider") {
    return res.status(403).json({ error: "Your dispatcher account is pending admin approval." });
  }

  let users = await listUsers({ role: req.query.role });
  users = users
    .slice()
    .sort((a, b) => new Date(b.created_at) - new Date(a.created_at))
    .map((u) => ({
      id: u.id,
      name: u.name,
      phone: u.phone,
      email: u.email || null,
      role: u.role,
      image: u.image || null,
      created_at: u.created_at,
      approved: u.approved !== false,
    }));

  // Same opt-in pagination contract as GET /deliveries — omitted params
  // return the full list unchanged, so existing callers aren't affected.
  if (req.query.limit) {
    const limit = Math.max(1, Math.min(500, Number(req.query.limit) || 100));
    const offset = Math.max(0, Number(req.query.offset) || 0);
    return res.json({ items: users.slice(offset, offset + limit), total: users.length, limit, offset });
  }

  res.json(users);
});

// PATCH /api/users/:id/approve — admin-only. The only write action admin
// has, deliberately: admin is oversight, not operational (see the comment
// above renderAdmin in the frontend and the state-machine notes), but a
// pending dispatcher account needs *some* way to actually get approved,
// and there's no legitimate reason for anyone but admin to grant that.
router.patch("/:id/approve", async (req, res) => {
  if (req.user.role !== "admin") return res.status(403).json({ error: "Only an admin can approve an account." });

  const target = await findUserById(req.params.id);
  if (!target) return res.status(404).json({ error: "User not found." });
  if (target.role !== "dispatcher") return res.status(400).json({ error: "Only dispatcher accounts need approval." });
  if (target.approved !== false) return res.status(400).json({ error: "This account is already approved." });

  target.approved = true;
  const saved = await saveUser(target);
  res.json({ id: saved.id, name: saved.name, role: saved.role, approved: true });
});

// POST /api/users/:id/reset-password — admin-only. There's no email/SMS
// provider wired into this app to deliver a reset *link*, so this is the
// pattern that actually works without one: admin generates a one-time
// temporary password (after verifying the person's identity out-of-band —
// a phone call, in person, whatever they'd already do), relays it to them
// directly, and the plaintext value is returned exactly once, in this
// response only. It's never logged, stored, or retrievable again — only
// its bcrypt hash gets persisted. The user should change it via the
// existing self-service PATCH /users/me/password right after logging in.
router.post("/:id/reset-password", async (req, res) => {
  if (req.user.role !== "admin") return res.status(403).json({ error: "Only an admin can reset another account's password." });

  const target = await findUserById(req.params.id);
  if (!target) return res.status(404).json({ error: "User not found." });

  // Base32-ish alphabet, no ambiguous characters (0/O, 1/I/l) — meant to be
  // read aloud or copied without transcription errors.
  const alphabet = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
  const tempPassword = Array.from(crypto.randomBytes(10))
    .map((b) => alphabet[b % alphabet.length])
    .join("");

  target.password_hash = bcrypt.hashSync(tempPassword, 10);
  await saveUser(target);

  res.json({ id: target.id, name: target.name, tempPassword });
});

// Matches the product-photo cap in routes/products.js — a data URL this
// size decodes to roughly 450KB, well above what the frontend actually
// sends (it compresses to a small JPEG client-side first), just a sanity
// ceiling against a huge/unexpected upload.
const MAX_IMAGE_DATA_URL_LENGTH = 600_000;

// GET /api/users/me — the current user's own record, straight from the
// live DB (req.user is already a fresh lookup — see requireAuth). Exists
// mainly so the frontend can revalidate a cached copy of state.user on
// boot: the login/register response is fresh at that instant, but a
// session resumed from localStorage on a later page load has no other way
// to notice a fact about the account that changed server-side since —
// most importantly, a dispatcher's approved flag flipping from false to
// true. Without this, an approved dispatcher reloading the page would
// still see the stale "pending approval" screen from their cached copy.
router.get("/me", (req, res) => res.json(publicUser(req.user)));

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

// PATCH /api/users/me/password  { currentPassword?, newPassword }
// currentPassword is required unless the account has no password hash
// yet (a Google-only sign-in) — in that case this doubles as "set a
// password for the first time" rather than "change" one, since there's
// nothing to verify against.
router.patch("/me/password", async (req, res) => {
  const { currentPassword, newPassword } = req.body || {};
  if (!newPassword || newPassword.length < 6) {
    return res.status(400).json({ error: "New password must be at least 6 characters." });
  }
  if (req.user.password_hash) {
    if (!currentPassword || !bcrypt.compareSync(currentPassword, req.user.password_hash)) {
      return res.status(401).json({ error: "Current password is incorrect." });
    }
  }
  req.user.password_hash = bcrypt.hashSync(newPassword, 10);
  await saveUser(req.user);
  res.json({ ok: true });
});

function publicUser(u) {
  return { id: u.id, name: u.name, phone: u.phone, email: u.email || null, role: u.role, image: u.image || null, approved: u.approved !== false };
}

module.exports = router;
