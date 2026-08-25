// Seeds three demo accounts (one per role) so the app is demo-ready on first run.
// Safe to re-run — it skips any account that already exists.

const bcrypt = require("bcryptjs");
const { findUserByPhone, createUser } = require("./db");

const DEMO_USERS = [
  { name: "Jane's Electronics (Retailer)", phone: "0700000001", password: "retailer123", role: "retailer" },
  { name: "Dispatch Desk", phone: "0700000002", password: "dispatch123", role: "dispatcher" },
  { name: "Boda Rider", phone: "0700000003", password: "rider123", role: "rider" },
];

async function seed() {
  for (const u of DEMO_USERS) {
    if (!(await findUserByPhone(u.phone))) {
      await createUser({ name: u.name, phone: u.phone, password_hash: bcrypt.hashSync(u.password, 10), role: u.role });
      console.log(`Seeded ${u.role}: ${u.phone} / ${u.password}`);
    }
  }
}

module.exports = { seed, DEMO_USERS };
