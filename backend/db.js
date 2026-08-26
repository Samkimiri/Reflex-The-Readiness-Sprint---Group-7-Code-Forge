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
//
// Swapping this for real Postgres later means replacing readDB/writeDB (and
// the KV key) with SQL queries — the rest of the app (routes, state machine)
// doesn't change.

const fs = require("fs");
const os = require("os");
const path = require("path");

let kv = null;
if (process.env.KV_REST_API_URL && process.env.KV_REST_API_TOKEN) {
  const { Redis } = require("@upstash/redis");
  kv = Redis.fromEnv();
}

// On Vercel the deployed bundle itself is read-only — only os.tmpdir() is
// writable there (and ephemeral/per-instance). Locally, keep using
// backend/data so a restart doesn't lose the demo data.
const DB_FILE = process.env.VERCEL
  ? path.join(os.tmpdir(), "reflex-db.json")
  : path.join(__dirname, "data", "db.json");
const KV_KEY = "reflex_db";

function emptyDB() {
  return {
    users: [],
    deliveries: [],
    status_log: [],
    products: [],
    seq: { users: 0, deliveries: 0, status_log: 0, products: 0 },
  };
}

// Backfills fields added after some data may already have been written
// (e.g. `products`, added later) so an older persisted blob doesn't crash
// on the first read/write after a deploy.
function withDefaults(data) {
  const empty = emptyDB();
  return {
    ...empty,
    ...data,
    seq: { ...empty.seq, ...(data && data.seq) },
  };
}

async function readDB() {
  if (kv) {
    const data = await kv.get(KV_KEY);
    return withDefaults(data);
  }
  if (!fs.existsSync(DB_FILE)) {
    const empty = emptyDB();
    // backend/data/db.json is gitignored, and git doesn't track empty
    // directories — so a fresh clone has no backend/data/ at all yet.
    fs.mkdirSync(path.dirname(DB_FILE), { recursive: true });
    fs.writeFileSync(DB_FILE, JSON.stringify(empty, null, 2));
    return empty;
  }
  return withDefaults(JSON.parse(fs.readFileSync(DB_FILE, "utf8")));
}

async function writeDB(data) {
  if (kv) {
    await kv.set(KV_KEY, data);
    return;
  }
  fs.writeFileSync(DB_FILE, JSON.stringify(data, null, 2));
}

function nextId(db, table) {
  db.seq[table] += 1;
  return db.seq[table];
}

// ---------- users ----------
async function findUserByPhone(phone) {
  const db = await readDB();
  return db.users.find((u) => u.phone === phone) || null;
}

async function findUserByEmail(email) {
  const db = await readDB();
  return db.users.find((u) => u.email && u.email === email) || null;
}

async function findUserByGoogleId(google_id) {
  const db = await readDB();
  return db.users.find((u) => u.google_id === google_id) || null;
}

async function findUserById(id) {
  const db = await readDB();
  return db.users.find((u) => u.id === Number(id)) || null;
}

async function createUser({ name, phone = null, email = null, google_id = null, password_hash = null, role }) {
  const db = await readDB();
  const user = {
    id: nextId(db, "users"),
    name,
    phone,
    email,
    google_id,
    password_hash,
    role,
    created_at: new Date().toISOString(),
  };
  db.users.push(user);
  await writeDB(db);
  return user;
}

async function saveUser(updated) {
  const db = await readDB();
  const idx = db.users.findIndex((u) => u.id === updated.id);
  if (idx === -1) return null;
  db.users[idx] = updated;
  await writeDB(db);
  return updated;
}

// ---------- deliveries ----------
async function createDelivery({ retailer_id, customer_name, customer_phone, address, item_description, qr_code }) {
  const db = await readDB();
  const now = new Date().toISOString();
  const delivery = {
    id: nextId(db, "deliveries"),
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
  db.deliveries.push(delivery);
  await writeDB(db);
  return delivery;
}

async function getDeliveryById(id) {
  const db = await readDB();
  return db.deliveries.find((d) => d.id === Number(id)) || null;
}

async function listDeliveries({ status, rider_id, retailer_id } = {}) {
  const db = await readDB();
  return db.deliveries.filter((d) => {
    if (status && d.status !== status) return false;
    if (rider_id && d.rider_id !== Number(rider_id)) return false;
    if (retailer_id && d.retailer_id !== Number(retailer_id)) return false;
    return true;
  });
}

async function saveDelivery(updated) {
  const db = await readDB();
  const idx = db.deliveries.findIndex((d) => d.id === updated.id);
  if (idx === -1) return null;
  updated.updated_at = new Date().toISOString();
  db.deliveries[idx] = updated;
  await writeDB(db);
  return updated;
}

// ---------- status_log ----------
async function addStatusLog({ delivery_id, changed_by, old_status, new_status }) {
  const db = await readDB();
  const entry = {
    id: nextId(db, "status_log"),
    delivery_id,
    changed_by,
    old_status,
    new_status,
    changed_at: new Date().toISOString(),
  };
  db.status_log.push(entry);
  await writeDB(db);
  return entry;
}

async function getStatusLog(delivery_id) {
  const db = await readDB();
  return db.status_log
    .filter((s) => s.delivery_id === Number(delivery_id))
    .sort((a, b) => new Date(a.changed_at) - new Date(b.changed_at));
}

// ---------- products (a retailer's catalog of what they sell) ----------
async function createProduct({ retailer_id, name, price = null, description = null, image = null }) {
  const db = await readDB();
  const product = {
    id: nextId(db, "products"),
    retailer_id,
    name,
    price,
    description,
    image,
    created_at: new Date().toISOString(),
  };
  db.products.push(product);
  await writeDB(db);
  return product;
}

async function listProducts({ retailer_id } = {}) {
  const db = await readDB();
  return db.products.filter((p) => !retailer_id || p.retailer_id === Number(retailer_id));
}

async function getProductById(id) {
  const db = await readDB();
  return db.products.find((p) => p.id === Number(id)) || null;
}

async function deleteProduct(id) {
  const db = await readDB();
  const idx = db.products.findIndex((p) => p.id === Number(id));
  if (idx === -1) return false;
  db.products.splice(idx, 1);
  await writeDB(db);
  return true;
}

module.exports = {
  readDB,
  findUserByPhone,
  findUserByEmail,
  findUserByGoogleId,
  findUserById,
  createUser,
  saveUser,
  createDelivery,
  getDeliveryById,
  listDeliveries,
  saveDelivery,
  addStatusLog,
  createProduct,
  listProducts,
  getProductById,
  deleteProduct,
  getStatusLog,
};
