// Lightweight JSON-file data store.
//
// This stands in for the PostgreSQL database described in the architecture
// deck so the app runs anywhere with zero setup (no DB server to install).
// The shape mirrors the real schema exactly:
//   users        -> id, name, phone, password_hash, role, created_at
//   deliveries   -> id, retailer_id, rider_id, customer_name, customer_phone,
//                   address, item_description, status, qr_code, created_at, updated_at
//   status_log   -> id, delivery_id, changed_by, old_status, new_status, changed_at
//
// Swapping this for real Postgres later means replacing the functions below
// with SQL queries — the rest of the app (routes, state machine) doesn't change.

const fs = require("fs");
const path = require("path");

const DB_FILE = path.join(__dirname, "data", "db.json");

function readDB() {
  if (!fs.existsSync(DB_FILE)) {
    const empty = { users: [], deliveries: [], status_log: [], seq: { users: 0, deliveries: 0, status_log: 0 } };
    fs.writeFileSync(DB_FILE, JSON.stringify(empty, null, 2));
    return empty;
  }
  return JSON.parse(fs.readFileSync(DB_FILE, "utf8"));
}

function writeDB(data) {
  fs.writeFileSync(DB_FILE, JSON.stringify(data, null, 2));
}

function nextId(db, table) {
  db.seq[table] += 1;
  return db.seq[table];
}

// ---------- users ----------
function findUserByPhone(phone) {
  const db = readDB();
  return db.users.find((u) => u.phone === phone) || null;
}

function findUserById(id) {
  const db = readDB();
  return db.users.find((u) => u.id === id) || null;
}

function createUser({ name, phone, password_hash, role }) {
  const db = readDB();
  const user = { id: nextId(db, "users"), name, phone, password_hash, role, created_at: new Date().toISOString() };
  db.users.push(user);
  writeDB(db);
  return user;
}

// ---------- deliveries ----------
function createDelivery({ retailer_id, customer_name, customer_phone, address, item_description, qr_code }) {
  const db = readDB();
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
  writeDB(db);
  return delivery;
}

function getDeliveryById(id) {
  const db = readDB();
  return db.deliveries.find((d) => d.id === Number(id)) || null;
}

function listDeliveries({ status, rider_id, retailer_id } = {}) {
  const db = readDB();
  return db.deliveries.filter((d) => {
    if (status && d.status !== status) return false;
    if (rider_id && d.rider_id !== Number(rider_id)) return false;
    if (retailer_id && d.retailer_id !== Number(retailer_id)) return false;
    return true;
  });
}

function saveDelivery(updated) {
  const db = readDB();
  const idx = db.deliveries.findIndex((d) => d.id === updated.id);
  if (idx === -1) return null;
  updated.updated_at = new Date().toISOString();
  db.deliveries[idx] = updated;
  writeDB(db);
  return updated;
}

// ---------- status_log ----------
function addStatusLog({ delivery_id, changed_by, old_status, new_status }) {
  const db = readDB();
  const entry = {
    id: nextId(db, "status_log"),
    delivery_id,
    changed_by,
    old_status,
    new_status,
    changed_at: new Date().toISOString(),
  };
  db.status_log.push(entry);
  writeDB(db);
  return entry;
}

function getStatusLog(delivery_id) {
  const db = readDB();
  return db.status_log
    .filter((s) => s.delivery_id === Number(delivery_id))
    .sort((a, b) => new Date(a.changed_at) - new Date(b.changed_at));
}

module.exports = {
  readDB,
  findUserByPhone,
  findUserById,
  createUser,
  createDelivery,
  getDeliveryById,
  listDeliveries,
  saveDelivery,
  addStatusLog,
  getStatusLog,
};
