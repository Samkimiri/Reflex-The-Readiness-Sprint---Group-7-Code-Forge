// Seeds three demo accounts (one per role) plus a handful of example
// deliveries spanning every status, so the app is demo-ready on first run
// instead of showing three empty dashboards. Safe to re-run — both the
// accounts and the deliveries are only created once.

const crypto = require("crypto");
const bcrypt = require("bcryptjs");
const {
  readDB,
  findUserByEmail,
  createUser,
  createDelivery,
  saveDelivery,
  addStatusLog,
  createProduct,
} = require("./db");

const DEMO_USERS = [
  { name: "Jane's Electronics (Retailer)", phone: "0700000001", email: "retailer@reflex.demo", password: "retailer123", role: "retailer" },
  { name: "Dispatch Desk", phone: "0700000002", email: "dispatcher@reflex.demo", password: "dispatch123", role: "dispatcher" },
  { name: "Boda Rider", phone: "0700000003", email: "rider@reflex.demo", password: "rider123", role: "rider" },
];

// The admin account is oversight/full-visibility (every user's contact
// info, every delivery) — unlike the three roles above, it's deliberately
// NOT offered as a public one-click demo button on the login screen, and
// gets a real password instead of a memorable demo one. Override via
// ADMIN_SEED_PASSWORD if you want to set your own before first boot
// (irrelevant after that — like the accounts above, this only runs once).
const ADMIN_USER = {
  name: "Site Admin",
  phone: "0700000004",
  email: "admin@reflex.demo",
  password: process.env.ADMIN_SEED_PASSWORD || "5I9H3ifTmCMj",
  role: "admin",
};

// A small starter catalog for the demo retailer, so the "log a delivery by
// picking a product" flow has something to pick from on first run.
const DEMO_PRODUCTS = [
  { name: "Wireless earbuds", price: 2500, description: "Bluetooth 5.0, charging case included" },
  { name: "Phone case", price: 600, description: "Silicone, various colors" },
  { name: "Bluetooth speaker", price: 3200, description: "Portable, 10W, USB-C charging" },
  { name: "65W laptop charger", price: 1800, description: "USB-C fast charging" },
];

// One example delivery per status, so every screen (retailer, dispatcher,
// rider) has something to look at instead of "No deliveries logged yet."
const DEMO_DELIVERIES = [
  {
    status: "requested",
    customer_name: "Amina Wanjiru",
    customer_phone: "0711223344",
    address: "Kilimani, Nairobi",
    item_description: "Wireless earbuds (Jumia order #4471)",
  },
  {
    status: "assigned",
    customer_name: "Brian Otieno",
    customer_phone: "0722334455",
    address: "Westlands, Nairobi",
    item_description: "Phone case + screen protector",
  },
  {
    status: "picked_up",
    customer_name: "Grace Achieng",
    customer_phone: "0733445566",
    address: "South B, Nairobi",
    item_description: "Bluetooth speaker",
  },
  {
    status: "delivered",
    customer_name: "Kevin Mwangi",
    customer_phone: "0744556677",
    address: "Lavington, Nairobi",
    item_description: "Laptop charger (65W)",
  },
  {
    status: "cancelled",
    customer_name: "Faith Njeri",
    customer_phone: "0755667788",
    address: "Karen, Nairobi",
    item_description: "Kitchen blender",
  },
];

async function seed() {
  for (const u of [...DEMO_USERS, ADMIN_USER]) {
    if (!(await findUserByEmail(u.email))) {
      await createUser({
        name: u.name,
        phone: u.phone,
        email: u.email,
        password_hash: bcrypt.hashSync(u.password, 10),
        role: u.role,
      });
      console.log(`Seeded ${u.role}: ${u.email} / ${u.password}`);
    }
  }

  await seedDeliveries();
  await seedProducts();
}

async function seedProducts() {
  const db = await readDB();
  if (db.products.length > 0) return; // already seeded, or the retailer has real products now

  const retailer = await findUserByEmail("retailer@reflex.demo");
  if (!retailer) return;

  for (const p of DEMO_PRODUCTS) {
    await createProduct({ retailer_id: retailer.id, name: p.name, price: p.price, description: p.description });
  }
  console.log(`Seeded ${DEMO_PRODUCTS.length} example products.`);
}

async function seedDeliveries() {
  const db = await readDB();
  if (db.deliveries.length > 0) return; // already seeded, or the app has real data now

  const retailer = await findUserByEmail("retailer@reflex.demo");
  const dispatcher = await findUserByEmail("dispatcher@reflex.demo");
  const rider = await findUserByEmail("rider@reflex.demo");
  if (!retailer || !dispatcher || !rider) return; // demo users didn't seed for some reason

  for (const spec of DEMO_DELIVERIES) {
    let delivery = await createDelivery({
      retailer_id: retailer.id,
      customer_name: spec.customer_name,
      customer_phone: spec.customer_phone,
      address: spec.address,
      item_description: spec.item_description,
      qr_code: crypto.randomBytes(16).toString("hex"),
    });
    await addStatusLog({ delivery_id: delivery.id, changed_by: retailer.id, old_status: null, new_status: "requested" });

    if (spec.status === "requested") continue;

    delivery.rider_id = rider.id;
    delivery.status = "assigned";
    delivery = await saveDelivery(delivery);
    await addStatusLog({ delivery_id: delivery.id, changed_by: dispatcher.id, old_status: "requested", new_status: "assigned" });

    if (spec.status === "cancelled") {
      delivery.status = "cancelled";
      delivery = await saveDelivery(delivery);
      await addStatusLog({ delivery_id: delivery.id, changed_by: dispatcher.id, old_status: "assigned", new_status: "cancelled" });
      continue;
    }
    if (spec.status === "assigned") continue;

    delivery.status = "picked_up";
    delivery = await saveDelivery(delivery);
    await addStatusLog({ delivery_id: delivery.id, changed_by: rider.id, old_status: "assigned", new_status: "picked_up" });

    if (spec.status === "picked_up") continue;

    delivery.status = "delivered";
    delivery = await saveDelivery(delivery);
    await addStatusLog({ delivery_id: delivery.id, changed_by: rider.id, old_status: "picked_up", new_status: "delivered" });
  }

  console.log(`Seeded ${DEMO_DELIVERIES.length} example deliveries.`);
}

module.exports = { seed, DEMO_USERS };
