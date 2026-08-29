// Data store.
//
// On Vercel, the filesystem is read-only/ephemeral, so this uses Upstash
// Redis (via the Vercel Marketplace Redis integration) when
// KV_REST_API_URL / KV_REST_API_TOKEN are present. Locally (npm start with
// no KV env vars) it falls back to a JSON file, so the app still runs
// anywhere with zero setup — no DB server to install.
//
// The shape mirrors the real schema from the architecture deck, extended
// with email/google_id (an account can be created via Google sign-in,
// which has no phone number) and a per-retailer product catalog:
//   users        -> id, name, phone, email, google_id, password_hash, role, created_at
//   deliveries   -> id, retailer_id, rider_id, customer_name, customer_phone,
//                   address, item_description, status, qr_code, created_at, updated_at
//   status_log   -> id, delivery_id, changed_by, old_status, new_status, changed_at
//   products     -> id, retailer_id, name, price, description, image, created_at
//   messages     -> id, delivery_id, sender_id, body, created_at (per-delivery chat)
//
// Swapping this for real Postgres later means replacing the storage
// primitives below (and the KV keys) with SQL queries — the higher-level
// functions (createUser, listDeliveries, ...) and everything above this
// file (routes, the state machine) don't change.
//
// --- Concurrency model ---
// This used to be one JSON blob (one Redis key / one file) read in full,
// mutated in memory, and written back in full on every single write. That
// meant ANY two writes anywhere in the app — not just to the same record —
// could race: whichever write landed last won, silently discarding
// whatever the other one changed. On Vercel that's not a theoretical
// concern, it's the normal case — multiple concurrent serverless instances
// hit the same Redis key constantly.
//
// Now every record lives at its own address (a field in a per-table Redis
// hash, or a mutex-serialized slot in the local file), so unrelated writes
// physically can't collide any more. Two remaining races needed their own
// explicit fix rather than just "smaller blast radius":
//   1. Uniqueness (email/phone/google_id at registration) was a classic
//      check-then-act TOCTOU race. `claimUnique`/`releaseUnique` below turn
//      that into a single atomic claim (SETNX in Redis; the file mutex
//      locally) — whoever claims it first wins, the loser gets a real 409
//      instead of a silently-broken uniqueness invariant.
//   2. A delivery's status transition (assign/pick_up/cancel/deliver) was
//      read-compare-write with an optimistic re-check that only narrowed
//      the race window without closing it — the code even said so ("a real
//      DB would use UPDATE ... WHERE status=..."). `casDeliveryTransition`
//      below IS that compare-and-swap: a Lua script in Redis (atomic on
//      the server, no window at all) / the same file mutex locally. The
//      loser of a race now gets an honest 409 instead of a false 200 whose
//      write silently got clobbered a moment later.

const fs = require("fs");
const os = require("os");
const path = require("path");

let kv = null;
if (process.env.KV_REST_API_URL && process.env.KV_REST_API_TOKEN) {
  const { Redis } = require("@upstash/redis");
  kv = Redis.fromEnv();
}

const TABLES = ["users", "deliveries", "status_log", "products", "messages"];

function httpError(status, message) {
  const err = new Error(message);
  err.status = status;
  return err;
}

// A single transient network blip to Redis (Upstash's REST endpoint having
// a bad half-second) used to fail the whole request outright. Retried only
// for operations where a lost response can't turn a real success into a
// false failure: plain reads, and writes whose end state doesn't depend on
// how many times they're applied (HSET/HDEL with a fixed value, INCR —
// worst case a retried INCR skips an id, which is harmless since ids only
// need to be unique and increasing, never contiguous). Deliberately NOT
// used for claimUnique's SETNX or the CAS eval: if the first attempt's
// response is what got lost, retrying either could report a real success
// as a failure — 500 the odd request and let the client retry itself
// (a person clicking "register" again) rather than risk a silent false
// rejection.
async function withRetry(fn, attempts = 3) {
  let lastErr;
  for (let i = 1; i <= attempts; i++) {
    try {
      return await fn();
    } catch (e) {
      lastErr = e;
      if (i < attempts) await new Promise((r) => setTimeout(r, 100 * i));
    }
  }
  throw lastErr;
}

// ============================================================
// Storage primitives — the only functions that know whether they're
// talking to Redis or the local file. Everything below this section is
// backend-agnostic.
// ============================================================

const KEY_PREFIX = "reflex:";
const tableKey = (table) => `${KEY_PREFIX}${table}`;
const seqKey = (table) => `${KEY_PREFIX}seq:${table}`;
const uniqueKey = (name) => `${KEY_PREFIX}uniq:${name}`;
const statusKey = (id) => `${KEY_PREFIX}delivery-status:${id}`;

// --- local file backend (used when KV_REST_API_URL isn't set) ---
// On Vercel the deployed bundle itself is read-only — only os.tmpdir() is
// writable there (and ephemeral/per-instance, which is exactly why this
// path is dev/demo-only, not the production one). Locally, keep using
// backend/data so a restart doesn't lose the demo data.
const DB_FILE = process.env.VERCEL
  ? path.join(os.tmpdir(), "reflex-db.json")
  : path.join(__dirname, "data", "db.json");

function emptyFileDB() {
  const empty = { uniq: {} };
  for (const t of TABLES) {
    empty[t] = [];
    empty.seq = empty.seq || {};
    empty.seq[t] = 0;
  }
  return empty;
}

// Backfills fields added after some data may already have been written
// (e.g. `products`, added later) so an older persisted file doesn't crash
// on the first read/write after a deploy.
function withFileDefaults(data) {
  const empty = emptyFileDB();
  return {
    ...empty,
    ...data,
    seq: { ...empty.seq, ...(data && data.seq) },
    uniq: { ...(data && data.uniq) },
  };
}

function loadFileSync() {
  if (!fs.existsSync(DB_FILE)) {
    const empty = emptyFileDB();
    // backend/data/db.json is gitignored, and git doesn't track empty
    // directories — so a fresh clone has no backend/data/ at all yet.
    fs.mkdirSync(path.dirname(DB_FILE), { recursive: true });
    fs.writeFileSync(DB_FILE, JSON.stringify(empty, null, 2));
    return empty;
  }
  return withFileDefaults(JSON.parse(fs.readFileSync(DB_FILE, "utf8")));
}

// Write to a temp file and rename over the target — a crash mid-write
// leaves either the old file or the new one intact, never a half-written,
// corrupt one. (rename is atomic on the same filesystem, which this always
// is — both paths are in the same directory.)
function saveFileSyncAtomic(data) {
  const tmp = `${DB_FILE}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
  fs.renameSync(tmp, DB_FILE);
}

// A minimal async mutex. This file-backed path only ever runs as a single
// Node process (local dev), so serializing every operation through one
// promise chain gives it real atomicity — every operation below sees a
// fully-settled result of whatever ran before it, never an interleaved
// half-state. `chain` itself always resolves (errors are swallowed there
// only) so one failed operation doesn't jam every operation queued after
// it; the actual result/error for each call still goes to its own caller.
let fileChain = Promise.resolve();
function withFileLock(fn) {
  const result = fileChain.then(fn, fn);
  fileChain = result.then(
    () => {},
    () => {}
  );
  return result;
}

// --- backend-agnostic primitives ---

async function nextId(table) {
  if (kv) return withRetry(() => kv.incr(seqKey(table)));
  return withFileLock(() => {
    const db = loadFileSync();
    db.seq[table] += 1;
    saveFileSyncAtomic(db);
    return db.seq[table];
  });
}

async function getRecord(table, id) {
  if (kv) {
    const raw = await withRetry(() => kv.hget(tableKey(table), String(id)));
    return raw ? (typeof raw === "string" ? JSON.parse(raw) : raw) : null;
  }
  return withFileLock(() => {
    const db = loadFileSync();
    return db[table].find((r) => r.id === Number(id)) || null;
  });
}

async function getAllRecords(table) {
  if (kv) {
    const all = await withRetry(() => kv.hgetall(tableKey(table)));
    if (!all) return [];
    return Object.values(all).map((raw) => (typeof raw === "string" ? JSON.parse(raw) : raw));
  }
  return withFileLock(() => loadFileSync()[table].slice());
}

async function putRecord(table, id, record) {
  if (kv) {
    await withRetry(() => kv.hset(tableKey(table), { [String(id)]: JSON.stringify(record) }));
    if (table === "deliveries") await withRetry(() => kv.set(statusKey(id), record.status));
    return record;
  }
  return withFileLock(() => {
    const db = loadFileSync();
    const idx = db[table].findIndex((r) => r.id === id);
    if (idx === -1) db[table].push(record);
    else db[table][idx] = record;
    saveFileSyncAtomic(db);
    return record;
  });
}

async function deleteRecord(table, id) {
  if (kv) {
    const removed = await withRetry(() => kv.hdel(tableKey(table), String(id)));
    return removed > 0;
  }
  return withFileLock(() => {
    const db = loadFileSync();
    const idx = db[table].findIndex((r) => r.id === Number(id));
    if (idx === -1) return false;
    db[table].splice(idx, 1);
    saveFileSyncAtomic(db);
    return true;
  });
}

// Atomically claims a uniqueness slot (an email, phone number, or Google
// id) — returns true if this call is the one that claimed it, false if it
// was already taken (by another record entirely, or by a concurrent
// request that got there first). Always call this BEFORE writing the
// record that depends on it, and release it (see below) if the write that
// was supposed to follow doesn't happen after all.
async function claimUnique(name) {
  if (kv) return (await kv.setnx(uniqueKey(name), "1")) === 1;
  return withFileLock(() => {
    const db = loadFileSync();
    if (db.uniq[name]) return false;
    db.uniq[name] = true;
    saveFileSyncAtomic(db);
    return true;
  });
}

async function releaseUnique(name) {
  if (!name) return;
  if (kv) return void (await withRetry(() => kv.del(uniqueKey(name))));
  return withFileLock(() => {
    const db = loadFileSync();
    delete db.uniq[name];
    saveFileSyncAtomic(db);
  });
}

// The compare-and-swap this whole file's comment block is about: apply()
// only takes effect if the delivery's status is still exactly
// expectedStatus at the moment of the write. In Redis this is one Lua
// script — genuinely atomic, no window between the check and the write, no
// matter how many serverless instances are racing. Locally the file mutex
// gives the same guarantee for the same reason every other file operation
// does. Returns the updated record, or null if the status had already
// moved (the caller turns that into a 409 — someone else got there first).
const CAS_SCRIPT = `
  local current = redis.call('GET', KEYS[1])
  if current ~= ARGV[1] then
    return 0
  end
  redis.call('SET', KEYS[1], ARGV[2])
  redis.call('HSET', KEYS[2], ARGV[3], ARGV[4])
  return 1
`;

async function casDeliveryTransition(id, expectedStatus, apply) {
  const current = await getRecord("deliveries", id);
  if (!current) return null;
  if (current.status !== expectedStatus) return null; // fast local check; the CAS below is the real guarantee
  const updated = { ...apply(current), updated_at: new Date().toISOString() };

  if (kv) {
    const ok = await kv.eval(
      CAS_SCRIPT,
      [statusKey(id), tableKey("deliveries")],
      [expectedStatus, updated.status, String(id), JSON.stringify(updated)]
    );
    return ok === 1 ? updated : null;
  }

  return withFileLock(() => {
    const db = loadFileSync();
    const idx = db.deliveries.findIndex((d) => d.id === Number(id));
    if (idx === -1 || db.deliveries[idx].status !== expectedStatus) return null;
    db.deliveries[idx] = updated;
    saveFileSyncAtomic(db);
    return updated;
  });
}

// Full-snapshot read, kept for the couple of call sites (an admin-style
// listing, and seed.js's idempotency checks) that legitimately want
// "everything in one table" rather than a single record. Not used on any
// write path any more.
async function readDB() {
  const snapshot = { seq: {} };
  for (const t of TABLES) snapshot[t] = await getAllRecords(t);
  return snapshot;
}

// ============================================================
// users
// ============================================================

async function findUserByPhone(phone) {
  const users = await getAllRecords("users");
  return users.find((u) => u.phone === phone) || null;
}

async function findUserByEmail(email) {
  const users = await getAllRecords("users");
  return users.find((u) => u.email && u.email === email) || null;
}

async function findUserByGoogleId(google_id) {
  const users = await getAllRecords("users");
  return users.find((u) => u.google_id === google_id) || null;
}

async function findUserById(id) {
  if (id === null || id === undefined) return null;
  return getRecord("users", Number(id));
}

// Claims email/phone/google_id (whichever are non-null) atomically before
// writing the user, so two concurrent signups for the same email/phone
// can't both succeed — the loser gets a 409 instead of a silently-broken
// uniqueness invariant. Throws httpError(409, ...) on conflict, which
// Express 5 forwards to the central error handler even from routes that
// don't wrap this in their own try/catch.
async function createUser({ name, phone = null, email = null, google_id = null, password_hash = null, role }) {
  const claims = [];
  try {
    if (email) {
      if (!(await claimUnique(`email:${email}`))) throw httpError(409, "A user with that email already exists.");
      claims.push(`email:${email}`);
    }
    if (phone) {
      if (!(await claimUnique(`phone:${phone}`))) throw httpError(409, "A user with that phone number already exists.");
      claims.push(`phone:${phone}`);
    }
    if (google_id) {
      if (!(await claimUnique(`google:${google_id}`))) throw httpError(409, "That Google account is already linked to a user.");
      claims.push(`google:${google_id}`);
    }

    const id = await nextId("users");
    const user = {
      id,
      name,
      phone,
      email,
      google_id,
      password_hash,
      role,
      created_at: new Date().toISOString(),
    };
    await putRecord("users", id, user);
    return user;
  } catch (e) {
    // Roll back whichever claims this attempt actually acquired before
    // hitting the conflict, so a failed signup doesn't permanently squat
    // on an email/phone/google_id nobody ends up owning.
    await Promise.all(claims.map(releaseUnique));
    throw e;
  }
}

// Reconciles the email/phone/google_id uniqueness claims if this save
// changes any of them (profile edits changing phone; linking a Google
// account to an existing email/password user). Throws httpError(409, ...)
// if the new value is already claimed by someone else.
async function saveUser(updated) {
  const before = await getRecord("users", updated.id);
  if (!before) return null;

  const toClaim = [];
  const toRelease = [];
  for (const field of ["phone", "email", "google_id"]) {
    if (updated[field] && updated[field] !== before[field]) {
      toClaim.push(`${field === "google_id" ? "google" : field}:${updated[field]}`);
    }
    if (before[field] && before[field] !== updated[field]) {
      toRelease.push(`${field === "google_id" ? "google" : field}:${before[field]}`);
    }
  }

  const claimed = [];
  try {
    for (const name of toClaim) {
      if (!(await claimUnique(name))) {
        const [kind] = name.split(":");
        throw httpError(409, `That ${kind === "google" ? "Google account" : kind} is already in use.`);
      }
      claimed.push(name);
    }
    await putRecord("users", updated.id, updated);
    await Promise.all(toRelease.map(releaseUnique));
    return updated;
  } catch (e) {
    await Promise.all(claimed.map(releaseUnique));
    throw e;
  }
}

// ============================================================
// deliveries
// ============================================================

async function createDelivery({ retailer_id, customer_name, customer_phone, address, item_description, qr_code }) {
  const id = await nextId("deliveries");
  const now = new Date().toISOString();
  const delivery = {
    id,
    retailer_id,
    rider_id: null,
    customer_name,
    customer_phone,
    address,
    item_description,
    status: "requested",
    qr_code,
    created_at: now,
    updated_at: now,
  };
  await putRecord("deliveries", id, delivery);
  return delivery;
}

async function getDeliveryById(id) {
  if (id === null || id === undefined) return null;
  return getRecord("deliveries", Number(id));
}

// Backs the public customer tracking page (GET /api/track/:token) — the
// token IS the qr_code, already an opaque 128-bit value the retailer
// controls distribution of (same one used for rider scan-confirmation),
// so no new field/token type was needed just for tracking.
async function getDeliveryByQrCode(qr_code) {
  const deliveries = await getAllRecords("deliveries");
  return deliveries.find((d) => d.qr_code === qr_code) || null;
}

async function listDeliveries({ status, rider_id, retailer_id } = {}) {
  const deliveries = await getAllRecords("deliveries");
  return deliveries.filter((d) => {
    if (status && d.status !== status) return false;
    if (rider_id && d.rider_id !== Number(rider_id)) return false;
    if (retailer_id && d.retailer_id !== Number(retailer_id)) return false;
    return true;
  });
}

// Plain (non-CAS) overwrite — used by seed.js, which runs once, alone, with
// nothing else racing it. Route handlers that change a delivery's status
// go through casDeliveryTransition instead; see the file-level comment.
async function saveDelivery(updated) {
  const existing = await getRecord("deliveries", updated.id);
  if (!existing) return null;
  updated.updated_at = new Date().toISOString();
  await putRecord("deliveries", updated.id, updated);
  return updated;
}

// ============================================================
// status_log
// ============================================================

async function addStatusLog({ delivery_id, changed_by, old_status, new_status }) {
  const id = await nextId("status_log");
  const entry = {
    id,
    delivery_id,
    changed_by,
    old_status,
    new_status,
    changed_at: new Date().toISOString(),
  };
  await putRecord("status_log", id, entry);
  return entry;
}

async function getStatusLog(delivery_id) {
  const log = await getAllRecords("status_log");
  return log
    .filter((s) => s.delivery_id === Number(delivery_id))
    .sort((a, b) => new Date(a.changed_at) - new Date(b.changed_at));
}

// ============================================================
// products (a retailer's catalog of what they sell)
// ============================================================

async function createProduct({ retailer_id, name, price = null, description = null, image = null }) {
  const id = await nextId("products");
  const product = {
    id,
    retailer_id,
    name,
    price,
    description,
    image,
    created_at: new Date().toISOString(),
  };
  await putRecord("products", id, product);
  return product;
}

async function listProducts({ retailer_id } = {}) {
  const products = await getAllRecords("products");
  return products.filter((p) => !retailer_id || p.retailer_id === Number(retailer_id));
}

async function getProductById(id) {
  if (id === null || id === undefined) return null;
  return getRecord("products", Number(id));
}

async function deleteProduct(id) {
  return deleteRecord("products", id);
}

async function saveProduct(updated) {
  const existing = await getRecord("products", updated.id);
  if (!existing) return null;
  await putRecord("products", updated.id, updated);
  return updated;
}

// ============================================================
// messages (per-delivery chat between retailer/dispatcher/rider)
// ============================================================

async function createMessage({ delivery_id, sender_id, body }) {
  const id = await nextId("messages");
  const message = {
    id,
    delivery_id,
    sender_id,
    body,
    created_at: new Date().toISOString(),
  };
  await putRecord("messages", id, message);
  return message;
}

async function listMessages(delivery_id) {
  const messages = await getAllRecords("messages");
  return messages
    .filter((m) => m.delivery_id === Number(delivery_id))
    .sort((a, b) => new Date(a.created_at) - new Date(b.created_at));
}

module.exports = {
  // Exported so server.js can build a shared (cross-instance) rate limiter
  // on the same Redis connection instead of opening a second one — see the
  // rate-limiting comment in server.js for why this needs to be shared at
  // all. null when running on the local-file fallback (no KV configured).
  kv,
  readDB,
  findUserByPhone,
  findUserByEmail,
  findUserByGoogleId,
  findUserById,
  createUser,
  saveUser,
  createDelivery,
  getDeliveryById,
  getDeliveryByQrCode,
  listDeliveries,
  saveDelivery,
  casDeliveryTransition,
  addStatusLog,
  createProduct,
  listProducts,
  getProductById,
  deleteProduct,
  saveProduct,
  getStatusLog,
  createMessage,
  listMessages,
};
