const test = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const path = require("node:path");
const os = require("node:os");
const fs = require("node:fs");

// Isolate from local dev data (backend/data/db.json) by pointing at the
// same tmpdir-backed store Vercel uses, cleared first for a clean run.
process.env.VERCEL = "1";
const tmpDbFile = path.join(os.tmpdir(), "reflex-db.json");
if (fs.existsSync(tmpDbFile)) fs.rmSync(tmpDbFile);

const app = require("../server");

let server;
let baseUrl;

test.before(async () => {
  server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
  await new Promise((resolve) => setTimeout(resolve, 300)); // let seed() settle
});

test.after(() => {
  server.close();
});

async function api(reqPath, { method = "GET", token, body } = {}) {
  const res = await fetch(baseUrl + reqPath, {
    method,
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  return { status: res.status, data };
}

test("health check responds without auth or waiting on seeding", async () => {
  const { status, data } = await api("/api/health");
  assert.equal(status, 200);
  assert.equal(data.status, "ok");
});

test("register -> login -> access a protected route", async () => {
  const email = `test-${Date.now()}@example.com`;
  const reg = await api("/api/auth/register", {
    method: "POST",
    body: { name: "Test Retailer", phone: "0711000111", email, password: "testpass1", role: "retailer" },
  });
  assert.equal(reg.status, 201);
  assert.ok(reg.data.token);
  assert.equal(reg.data.user.role, "retailer");

  const login = await api("/api/auth/login", { method: "POST", body: { email, password: "testpass1" } });
  assert.equal(login.status, 200);
  assert.ok(login.data.token);

  const deliveries = await api("/api/deliveries", { token: login.data.token });
  assert.equal(deliveries.status, 200);
  assert.ok(Array.isArray(deliveries.data));
});

test("register rejects a password under 6 characters", async () => {
  const { status, data } = await api("/api/auth/register", {
    method: "POST",
    body: { name: "X", phone: "0711000222", email: `short-${Date.now()}@example.com`, password: "abc", role: "retailer" },
  });
  assert.equal(status, 400);
  assert.match(data.error, /at least 6 characters/);
});

test("register rejects a malformed email", async () => {
  const { status, data } = await api("/api/auth/register", {
    method: "POST",
    body: { name: "X", phone: "0711000333", email: "not-an-email", password: "testpass1", role: "retailer" },
  });
  assert.equal(status, 400);
  assert.match(data.error, /valid email/);
});

test("login fails with the wrong password", async () => {
  const email = `wrongpw-${Date.now()}@example.com`;
  await api("/api/auth/register", {
    method: "POST",
    body: { name: "X", phone: "0711000444", email, password: "correcthorse", role: "retailer" },
  });
  const { status, data } = await api("/api/auth/login", { method: "POST", body: { email, password: "nope" } });
  assert.equal(status, 401);
  assert.match(data.error, /Invalid email or password/);
});

test("protected routes reject a missing token", async () => {
  const { status } = await api("/api/deliveries");
  assert.equal(status, 401);
});

test("a dispatcher cannot add products (retailer-only)", async () => {
  const email = `dispatcher-${Date.now()}@example.com`;
  const reg = await api("/api/auth/register", {
    method: "POST",
    body: { name: "Dispatch Test", phone: "0711000555", email, password: "testpass1", role: "dispatcher" },
  });
  const { status, data } = await api("/api/products", {
    method: "POST",
    token: reg.data.token,
    body: { name: "Should not work" },
  });
  assert.equal(status, 403);
  assert.match(data.error, /Only a retailer/);
});

test("full delivery lifecycle enforces role checks at each step", async () => {
  const suffix = Date.now();
  const retailer = (
    await api("/api/auth/register", {
      method: "POST",
      body: { name: "R", phone: `0721${suffix % 1000000}`, email: `r-${suffix}@example.com`, password: "testpass1", role: "retailer" },
    })
  ).data;
  const dispatcher = (
    await api("/api/auth/register", {
      method: "POST",
      body: { name: "D", phone: `0722${suffix % 1000000}`, email: `d-${suffix}@example.com`, password: "testpass1", role: "dispatcher" },
    })
  ).data;
  const rider = (
    await api("/api/auth/register", {
      method: "POST",
      body: { name: "Ri", phone: `0723${suffix % 1000000}`, email: `ri-${suffix}@example.com`, password: "testpass1", role: "rider" },
    })
  ).data;

  const created = await api("/api/deliveries", {
    method: "POST",
    token: retailer.token,
    body: { customer_name: "Cust", customer_phone: "0700111222", address: "Nairobi", item_description: "Widget" },
  });
  assert.equal(created.status, 201);
  const deliveryId = created.data.id;

  const badAssign = await api(`/api/deliveries/${deliveryId}/assign`, {
    method: "PATCH",
    token: rider.token, // a rider can't assign — dispatcher-only
    body: { rider_id: rider.user.id },
  });
  assert.equal(badAssign.status, 403);

  const assign = await api(`/api/deliveries/${deliveryId}/assign`, {
    method: "PATCH",
    token: dispatcher.token,
    body: { rider_id: rider.user.id },
  });
  assert.equal(assign.status, 200);
  assert.equal(assign.data.status, "assigned");

  const badPickup = await api(`/api/deliveries/${deliveryId}/status`, {
    method: "PATCH",
    token: retailer.token, // only the assigned rider can mark picked_up
    body: { new_status: "picked_up" },
  });
  assert.equal(badPickup.status, 403);

  const pickup = await api(`/api/deliveries/${deliveryId}/status`, {
    method: "PATCH",
    token: rider.token,
    body: { new_status: "picked_up" },
  });
  assert.equal(pickup.status, 200);
  assert.equal(pickup.data.status, "picked_up");
});

test("a delivery is only visible/actionable to parties actually involved in it", async () => {
  const suffix = Date.now() + 1; // offset from the previous test's timestamps
  const owner = (
    await api("/api/auth/register", {
      method: "POST",
      body: { name: "Owner", phone: `0731${suffix % 1000000}`, email: `owner-${suffix}@example.com`, password: "testpass1", role: "retailer" },
    })
  ).data;
  const otherRetailer = (
    await api("/api/auth/register", {
      method: "POST",
      body: { name: "Other", phone: `0732${suffix % 1000000}`, email: `other-${suffix}@example.com`, password: "testpass1", role: "retailer" },
    })
  ).data;
  const dispatcher = (
    await api("/api/auth/register", {
      method: "POST",
      body: { name: "D2", phone: `0733${suffix % 1000000}`, email: `d2-${suffix}@example.com`, password: "testpass1", role: "dispatcher" },
    })
  ).data;
  const uninvolvedRider = (
    await api("/api/auth/register", {
      method: "POST",
      body: { name: "UR", phone: `0734${suffix % 1000000}`, email: `ur-${suffix}@example.com`, password: "testpass1", role: "rider" },
    })
  ).data;

  const created = await api("/api/deliveries", {
    method: "POST",
    token: owner.token,
    body: { customer_name: "Priv Cust", customer_phone: "0700999888", address: "Somewhere Private", item_description: "Confidential Item" },
  });
  const deliveryId = created.data.id;

  // A different retailer can't see it (not even that it exists — 404, not 403)
  const otherView = await api(`/api/deliveries/${deliveryId}`, { token: otherRetailer.token });
  assert.equal(otherView.status, 404);

  // Nor an uninvolved rider
  const riderView = await api(`/api/deliveries/${deliveryId}`, { token: uninvolvedRider.token });
  assert.equal(riderView.status, 404);

  // A dispatcher can, though — they coordinate everything
  const dispatchView = await api(`/api/deliveries/${deliveryId}`, { token: dispatcher.token });
  assert.equal(dispatchView.status, 200);

  // The owning retailer can, obviously
  const ownerView = await api(`/api/deliveries/${deliveryId}`, { token: owner.token });
  assert.equal(ownerView.status, 200);

  // A different retailer cannot cancel someone else's delivery
  const badCancel = await api(`/api/deliveries/${deliveryId}/status`, {
    method: "PATCH",
    token: otherRetailer.token,
    body: { new_status: "cancelled" },
  });
  assert.equal(badCancel.status, 403);

  // The QR image is likewise restricted to the owning retailer
  const otherQr = await api(`/api/deliveries/${deliveryId}/qrcode.png`, { token: otherRetailer.token });
  assert.equal(otherQr.status, 404);
  const ownerQr = await fetch(`${baseUrl}/api/deliveries/${deliveryId}/qrcode.png`, {
    headers: { Authorization: `Bearer ${owner.token}` },
  });
  assert.equal(ownerQr.status, 200);
  assert.equal(ownerQr.headers.get("content-type"), "image/png");

  // The owning retailer CAN cancel their own delivery
  const goodCancel = await api(`/api/deliveries/${deliveryId}/status`, {
    method: "PATCH",
    token: owner.token,
    body: { new_status: "cancelled" },
  });
  assert.equal(goodCancel.status, 200);
  assert.equal(goodCancel.data.status, "cancelled");
});
