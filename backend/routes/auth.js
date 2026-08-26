const express = require("express");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const {
  findUserByPhone,
  findUserByEmail,
  findUserByGoogleId,
  createUser,
  saveUser,
} = require("../db");
const { JWT_SECRET } = require("../middleware/auth");

const router = express.Router();

const ROLES = ["retailer", "dispatcher", "rider"];
const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID || null;

// Client ID is not a secret — Google's Sign-In JS needs it in the browser —
// but the frontend has no build step to inject it at build time, so it
// fetches it from here instead. Absence just means the button stays hidden.
router.get("/config", (req, res) => {
  res.json({ googleClientId: GOOGLE_CLIENT_ID });
});

router.post("/register", async (req, res) => {
  const { name, phone, password, role } = req.body || {};
  const email = normalizeEmail(req.body && req.body.email);
  if (!name || !phone || !email || !password || !role) {
    return res.status(400).json({ error: "name, phone, email, password, and role are all required." });
  }
  if (!ROLES.includes(role)) {
    return res.status(400).json({ error: `role must be one of: ${ROLES.join(", ")}` });
  }
  if (await findUserByEmail(email)) {
    return res.status(409).json({ error: "A user with that email already exists." });
  }
  if (await findUserByPhone(phone)) {
    return res.status(409).json({ error: "A user with that phone number already exists." });
  }

  const password_hash = bcrypt.hashSync(password, 10);
  const user = await createUser({ name, phone, email, password_hash, role });
  const token = signToken(user);

  res.status(201).json({ token, user: publicUser(user) });
});

router.post("/login", async (req, res) => {
  const email = normalizeEmail(req.body && req.body.email);
  const { password } = req.body || {};
  if (!email || !password) return res.status(400).json({ error: "email and password are required." });

  const user = await findUserByEmail(email);
  if (!user || !user.password_hash || !bcrypt.compareSync(password, user.password_hash)) {
    return res.status(401).json({ error: "Invalid email or password." });
  }

  const token = signToken(user);
  res.json({ token, user: publicUser(user) });
});

// POST /api/auth/google   { credential, role? }
// `credential` is the Google ID token from Google Identity Services (the
// browser SDK), verified here server-side. `role` is only needed the first
// time — Google doesn't know whether this person is a retailer, dispatcher,
// or rider, so a brand-new account can't be created without it.
router.post("/google", async (req, res) => {
  if (!GOOGLE_CLIENT_ID) {
    return res.status(500).json({ error: "Google sign-in is not configured on this server." });
  }

  const { credential, role } = req.body || {};
  if (!credential) return res.status(400).json({ error: "credential is required." });

  let payload;
  try {
    const { OAuth2Client } = require("google-auth-library");
    const client = new OAuth2Client(GOOGLE_CLIENT_ID);
    const ticket = await client.verifyIdToken({ idToken: credential, audience: GOOGLE_CLIENT_ID });
    payload = ticket.getPayload();
  } catch (e) {
    return res.status(401).json({ error: "Invalid Google credential." });
  }

  if (!payload.email_verified) {
    return res.status(401).json({ error: "Your Google account's email isn't verified." });
  }

  const googleEmail = normalizeEmail(payload.email);
  let user = await findUserByGoogleId(payload.sub);

  if (!user) {
    // Same email, no google_id yet (e.g. registered by email/password earlier) — link it.
    const existingByEmail = await findUserByEmail(googleEmail);
    if (existingByEmail) {
      existingByEmail.google_id = payload.sub;
      user = await saveUser(existingByEmail);
    }
  }

  if (!user) {
    if (!role) {
      // Signal the frontend to ask which role this new account is, then
      // resubmit this same credential with the role included.
      return res.json({ needsRole: true });
    }
    if (!ROLES.includes(role)) {
      return res.status(400).json({ error: `role must be one of: ${ROLES.join(", ")}` });
    }
    user = await createUser({ name: payload.name, email: googleEmail, google_id: payload.sub, role });
  }

  const token = signToken(user);
  res.json({ token, user: publicUser(user) });
});

function normalizeEmail(email) {
  return (email || "").trim().toLowerCase();
}

function signToken(user) {
  return jwt.sign({ id: user.id, role: user.role }, JWT_SECRET, { expiresIn: "12h" });
}

function publicUser(u) {
  return { id: u.id, name: u.name, phone: u.phone, email: u.email || null, role: u.role };
}

module.exports = router;
