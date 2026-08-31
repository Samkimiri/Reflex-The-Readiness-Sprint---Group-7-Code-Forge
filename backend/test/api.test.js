const test = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const path = require("node:path");
const os = require("node:os");
const fs = require("node:fs");

// Isolate from local dev data (backend/data/db.json) by pointing at the
// same tmpdir-backed store Vercel uses, cleared first for a clean run.
process.env.VERCEL = "1";
// Raises (not disables) the /api/auth rate limit — see server.js. This
// suite makes 30+ register/login calls across its full run, all from
// the same address, which is exactly what that limiter is designed to
// catch in production; here it's just test volume.
process.env.NODE_ENV = "test";
// server.js refuses to start on VERCEL with no JWT_SECRET set (a real
// deploy must have a real one — see the check there). Give the suite one
// so it's actually exercising that same production-like startup path
// rather than getting an exemption from it.
process.env.JWT_SECRET = process.env.JWT_SECRET || "test-only-secret-do-not-use-in-production";
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

// A self-registered dispatcher now starts unapproved (see the dedicated
// approval-lifecycle test) — most other tests just need a dispatcher that
// actually works, so this logs in as the seeded admin and approves one.
async function approveDispatcher(dispatcherId) {
  const adminLogin = await api("/api/auth/login", {
    method: "POST",
    body: { email: "admin@reflex.demo", password: process.env.ADMIN_SEED_PASSWORD || "admin123" },
  });
  await api(`/api/users/${dispatcherId}/approve`, { method: "PATCH", token: adminLogin.data.token });
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
  await approveDispatcher(dispatcher.user.id);
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

// Regression test for the concurrency fix in db.js (casDeliveryTransition):
// two dispatchers racing to assign the same delivery used to be a plain
// read-compare-write with only an optimistic re-check narrowing (not
// closing) the window — both requests could read "requested" before either
// wrote, and the second write would silently clobber the first's. Now it's
// a real compare-and-swap, so exactly one of these two concurrent requests
// must succeed and the other must get a clean 409, never two 200s and
// never a 500/hang.
test("two concurrent assign requests for the same delivery: exactly one succeeds", async () => {
  const suffix = Date.now();
  const retailer = (
    await api("/api/auth/register", {
      method: "POST",
      body: { name: "R2", phone: `0731${suffix % 1000000}`, email: `r2-${suffix}@example.com`, password: "testpass1", role: "retailer" },
    })
  ).data;
  const dispatcher = (
    await api("/api/auth/register", {
      method: "POST",
      body: { name: "D2", phone: `0732${suffix % 1000000}`, email: `d2-${suffix}@example.com`, password: "testpass1", role: "dispatcher" },
    })
  ).data;
  await approveDispatcher(dispatcher.user.id);
  const riderA = (
    await api("/api/auth/register", {
      method: "POST",
      body: { name: "RiA", phone: `0733${suffix % 1000000}`, email: `ria-${suffix}@example.com`, password: "testpass1", role: "rider" },
    })
  ).data;
  const riderB = (
    await api("/api/auth/register", {
      method: "POST",
      body: { name: "RiB", phone: `0734${suffix % 1000000}`, email: `rib-${suffix}@example.com`, password: "testpass1", role: "rider" },
    })
  ).data;

  const created = await api("/api/deliveries", {
    method: "POST",
    token: retailer.token,
    body: { customer_name: "Cust2", customer_phone: "0700111333", address: "Nairobi", item_description: "Widget2" },
  });
  const deliveryId = created.data.id;

  const [resA, resB] = await Promise.all([
    api(`/api/deliveries/${deliveryId}/assign`, { method: "PATCH", token: dispatcher.token, body: { rider_id: riderA.user.id } }),
    api(`/api/deliveries/${deliveryId}/assign`, { method: "PATCH", token: dispatcher.token, body: { rider_id: riderB.user.id } }),
  ]);

  // Exactly one must win (200). The loser's outcome depends on exactly
  // where the race lands: if its own optimistic pre-read happens to run
  // after the winner's write already landed, the route's early
  // canTransition() check catches it first (400, "already assigned/not
  // requested"); if the pre-read ran before that, it reaches the atomic
  // compare-and-swap itself and loses there instead (409). Both are the
  // same real thing — "you lost the race, and correctly so" — never a 500,
  // and never two 200s.
  const winCount = [resA.status, resB.status].filter((s) => s === 200).length;
  assert.equal(winCount, 1, `expected exactly one winner, got statuses ${resA.status} and ${resB.status}`);
  const loserStatus = resA.status === 200 ? resB.status : resA.status;
  assert.ok([400, 409].includes(loserStatus), `expected the loser to get 400 or 409, got ${loserStatus}`);

  const winner = resA.status === 200 ? resA : resB;
  assert.equal(winner.data.status, "assigned");
  assert.ok(winner.data.rider_id === riderA.user.id || winner.data.rider_id === riderB.user.id);

  // The delivery's final state must match whichever request actually won
  // — not a corrupted mix of both, and not silently reverted by the loser.
  const final = await api(`/api/deliveries/${deliveryId}`, { token: dispatcher.token });
  assert.equal(final.data.status, "assigned");
  assert.equal(final.data.rider_id, winner.data.rider_id);
});

// Regression test for the register race fixed by making createUser's
// email/phone claim atomic (SETNX-style) instead of a separate
// findUserByEmail check followed by a later, unrelated write.
test("two concurrent registrations with the same email: exactly one succeeds", async () => {
  const suffix = Date.now();
  const email = `race-${suffix}@example.com`;
  const body = (phoneSuffix) => ({
    name: "Racer",
    phone: `0741${(suffix + phoneSuffix) % 1000000}`,
    email,
    password: "testpass1",
    role: "retailer",
  });

  const [resA, resB] = await Promise.all([
    api("/api/auth/register", { method: "POST", body: body(1) }),
    api("/api/auth/register", { method: "POST", body: body(2) }),
  ]);

  const statuses = [resA.status, resB.status].sort();
  assert.deepEqual(statuses, [201, 409], `expected one 201 and one 409, got ${resA.status} and ${resB.status}`);
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
  await approveDispatcher(dispatcher.user.id);
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

test("admin role is not self-registerable", async () => {
  const { status, data } = await api("/api/auth/register", {
    method: "POST",
    body: { name: "Sneaky", phone: "0711000666", email: `sneaky-${Date.now()}@example.com`, password: "testpass1", role: "admin" },
  });
  assert.equal(status, 400);
  assert.match(data.error, /role must be one of/);
});

test("admin has full oversight: sees every user and every retailer's deliveries", async () => {
  // admin@reflex.demo is seeded by the app itself (see backend/seed.js) —
  // admin accounts can't be created through the public API, only seeded.
  const adminLogin = await api("/api/auth/login", {
    method: "POST",
    body: { email: "admin@reflex.demo", password: process.env.ADMIN_SEED_PASSWORD || "admin123" },
  });
  assert.equal(adminLogin.status, 200);
  const adminToken = adminLogin.data.token;

  const retailer = (
    await api("/api/auth/register", {
      method: "POST",
      body: { name: "Oversight Test", phone: `0741${Date.now() % 1000000}`, email: `oversight-${Date.now()}@example.com`, password: "testpass1", role: "retailer" },
    })
  ).data;
  const created = await api("/api/deliveries", {
    method: "POST",
    token: retailer.token,
    body: { customer_name: "Admin Sees This", customer_phone: "0700555444", address: "Nairobi", item_description: "Oversight check" },
  });

  const allUsers = await api("/api/users", { token: adminToken });
  assert.equal(allUsers.status, 200);
  assert.ok(allUsers.data.some((u) => u.email === retailer.user.email));

  const allDeliveries = await api("/api/deliveries", { token: adminToken });
  assert.equal(allDeliveries.status, 200);
  assert.ok(allDeliveries.data.some((d) => d.id === created.data.id));

  const oneDelivery = await api(`/api/deliveries/${created.data.id}`, { token: adminToken });
  assert.equal(oneDelivery.status, 200);
});

// Regression test for the dispatcher self-registration gap: a dispatcher
// used to get full system-wide oversight (every retailer's deliveries,
// full read+write) the instant they self-registered, with nothing else
// gating that access. Now a self-registered dispatcher starts unapproved
// and is blocked from every dispatcher-level read/write until an admin
// approves them — this walks the whole lifecycle end to end.
test("a self-registered dispatcher is unapproved until admin approves them", async () => {
  const suffix = Date.now();
  const retailer = (
    await api("/api/auth/register", {
      method: "POST",
      body: { name: "Approval Test Retailer", phone: `0751${suffix % 1000000}`, email: `approval-retailer-${suffix}@example.com`, password: "testpass1", role: "retailer" },
    })
  ).data;
  const created = await api("/api/deliveries", {
    method: "POST",
    token: retailer.token,
    body: { customer_name: "Gated Delivery", customer_phone: "0700111000", address: "Nairobi", item_description: "Approval gate check" },
  });
  const deliveryId = created.data.id;

  const dispatcherReg = await api("/api/auth/register", {
    method: "POST",
    body: { name: "New Dispatcher", phone: `0752${suffix % 1000000}`, email: `new-dispatcher-${suffix}@example.com`, password: "testpass1", role: "dispatcher" },
  });
  assert.equal(dispatcherReg.status, 201);
  assert.equal(dispatcherReg.data.user.approved, false);
  const dispatcherToken = dispatcherReg.data.token;
  const dispatcherId = dispatcherReg.data.user.id;

  // Blocked from the system-wide list...
  const blockedList = await api("/api/deliveries", { token: dispatcherToken });
  assert.equal(blockedList.status, 403);
  assert.match(blockedList.data.error, /pending admin approval/);

  // ...blocked from a single delivery's detail (404, not 403 — same
  // IDOR-safe pattern as every other unauthorized-access check here)...
  const blockedDetail = await api(`/api/deliveries/${deliveryId}`, { token: dispatcherToken });
  assert.equal(blockedDetail.status, 404);

  // ...and blocked from actually assigning a rider.
  const rider = (
    await api("/api/auth/register", {
      method: "POST",
      body: { name: "Approval Test Rider", phone: `0753${suffix % 1000000}`, email: `approval-rider-${suffix}@example.com`, password: "testpass1", role: "rider" },
    })
  ).data;
  const blockedAssign = await api(`/api/deliveries/${deliveryId}/assign`, {
    method: "PATCH",
    token: dispatcherToken,
    body: { rider_id: rider.user.id },
  });
  assert.equal(blockedAssign.status, 403);
  assert.match(blockedAssign.data.error, /pending admin approval/);

  // A non-admin can't approve them...
  const badApprove = await api(`/api/users/${dispatcherId}/approve`, { method: "PATCH", token: retailer.token });
  assert.equal(badApprove.status, 403);

  // ...but admin can.
  const adminLogin = await api("/api/auth/login", { method: "POST", body: { email: "admin@reflex.demo", password: process.env.ADMIN_SEED_PASSWORD || "admin123" } });
  const adminToken = adminLogin.data.token;
  const approve = await api(`/api/users/${dispatcherId}/approve`, { method: "PATCH", token: adminToken });
  assert.equal(approve.status, 200);
  assert.equal(approve.data.approved, true);

  // Approving twice is rejected, not silently a no-op.
  const doubleApprove = await api(`/api/users/${dispatcherId}/approve`, { method: "PATCH", token: adminToken });
  assert.equal(doubleApprove.status, 400);

  // Now the same dispatcher token — unchanged, still their original
  // login — actually works, because approval is checked live against the
  // current user record on every request, not baked into the JWT.
  const allowedList = await api("/api/deliveries", { token: dispatcherToken });
  assert.equal(allowedList.status, 200);

  const allowedAssign = await api(`/api/deliveries/${deliveryId}/assign`, {
    method: "PATCH",
    token: dispatcherToken,
    body: { rider_id: rider.user.id },
  });
  assert.equal(allowedAssign.status, 200);
  assert.equal(allowedAssign.data.status, "assigned");
});

test("approve rejects a non-dispatcher account", async () => {
  const suffix = Date.now();
  const retailer = (
    await api("/api/auth/register", {
      method: "POST",
      body: { name: "Not A Dispatcher", phone: `0754${suffix % 1000000}`, email: `not-dispatcher-${suffix}@example.com`, password: "testpass1", role: "retailer" },
    })
  ).data;
  const adminLogin = await api("/api/auth/login", { method: "POST", body: { email: "admin@reflex.demo", password: process.env.ADMIN_SEED_PASSWORD || "admin123" } });
  const { status, data } = await api(`/api/users/${retailer.user.id}/approve`, { method: "PATCH", token: adminLogin.data.token });
  assert.equal(status, 400);
  assert.match(data.error, /Only dispatcher accounts/);
});

test("admin-mediated password reset: admin-only, and the new password actually works", async () => {
  const suffix = Date.now();
  const email = `reset-target-${suffix}@example.com`;
  const target = (
    await api("/api/auth/register", {
      method: "POST",
      body: { name: "Reset Target", phone: `0755${suffix % 1000000}`, email, password: "originalpass1", role: "retailer" },
    })
  ).data;

  // A non-admin can't trigger it.
  const badReset = await api(`/api/users/${target.user.id}/reset-password`, { method: "POST", token: target.token });
  assert.equal(badReset.status, 403);

  const adminLogin = await api("/api/auth/login", { method: "POST", body: { email: "admin@reflex.demo", password: process.env.ADMIN_SEED_PASSWORD || "admin123" } });
  const reset = await api(`/api/users/${target.user.id}/reset-password`, { method: "POST", token: adminLogin.data.token });
  assert.equal(reset.status, 200);
  assert.ok(reset.data.tempPassword && reset.data.tempPassword.length >= 8);

  const oldLogin = await api("/api/auth/login", { method: "POST", body: { email, password: "originalpass1" } });
  assert.equal(oldLogin.status, 401);

  const newLogin = await api("/api/auth/login", { method: "POST", body: { email, password: reset.data.tempPassword } });
  assert.equal(newLogin.status, 200);
});

test("GET /api/deliveries pagination is opt-in and doesn't change the default response shape", async () => {
  const suffix = Date.now();
  const retailer = (
    await api("/api/auth/register", {
      method: "POST",
      body: { name: "Pagination Test", phone: `0756${suffix % 1000000}`, email: `pagination-${suffix}@example.com`, password: "testpass1", role: "retailer" },
    })
  ).data;
  await api("/api/deliveries", {
    method: "POST",
    token: retailer.token,
    body: { customer_name: "Pagination Check", customer_phone: "0700222333", address: "Nairobi", item_description: "Ensures at least one delivery exists" },
  });

  const adminLogin = await api("/api/auth/login", { method: "POST", body: { email: "admin@reflex.demo", password: process.env.ADMIN_SEED_PASSWORD || "admin123" } });
  const adminToken = adminLogin.data.token;

  const unpaged = await api("/api/deliveries", { token: adminToken });
  assert.equal(unpaged.status, 200);
  assert.ok(Array.isArray(unpaged.data));

  const paged = await api("/api/deliveries?limit=1&offset=0", { token: adminToken });
  assert.equal(paged.status, 200);
  assert.ok(Array.isArray(paged.data.items));
  assert.equal(paged.data.items.length, 1);
  assert.equal(paged.data.total, unpaged.data.length);
});

test("only a dispatcher or admin can list users; a retailer/rider cannot", async () => {
  const retailer = (
    await api("/api/auth/register", {
      method: "POST",
      body: { name: "No Directory", phone: `0742${Date.now() % 1000000}`, email: `nodir-${Date.now()}@example.com`, password: "testpass1", role: "retailer" },
    })
  ).data;
  const { status, data } = await api("/api/users", { token: retailer.token });
  assert.equal(status, 403);
  assert.match(data.error, /Not authorized/);
});

test("a retailer can edit their own product; another retailer cannot", async () => {
  const suffix = Date.now();
  const owner = (
    await api("/api/auth/register", {
      method: "POST",
      body: { name: "Prod Owner", phone: `0751${suffix % 1000000}`, email: `powner-${suffix}@example.com`, password: "testpass1", role: "retailer" },
    })
  ).data;
  const other = (
    await api("/api/auth/register", {
      method: "POST",
      body: { name: "Prod Other", phone: `0752${suffix % 1000000}`, email: `pother-${suffix}@example.com`, password: "testpass1", role: "retailer" },
    })
  ).data;

  const created = await api("/api/products", {
    method: "POST",
    token: owner.token,
    body: { name: "Original Name", price: 100 },
  });
  assert.equal(created.status, 201);
  const productId = created.data.id;

  const badEdit = await api(`/api/products/${productId}`, {
    method: "PATCH",
    token: other.token,
    body: { name: "Hijacked" },
  });
  assert.equal(badEdit.status, 403);

  const goodEdit = await api(`/api/products/${productId}`, {
    method: "PATCH",
    token: owner.token,
    body: { name: "Updated Name", price: 250, description: "Now with a description" },
  });
  assert.equal(goodEdit.status, 200);
  assert.equal(goodEdit.data.name, "Updated Name");
  assert.equal(goodEdit.data.price, 250);
  assert.equal(goodEdit.data.description, "Now with a description");

  const emptyName = await api(`/api/products/${productId}`, {
    method: "PATCH",
    token: owner.token,
    body: { name: "   " },
  });
  assert.equal(emptyName.status, 400);
});

test("a user can edit their own profile; a duplicate phone is rejected", async () => {
  const suffix = Date.now();
  const userA = (
    await api("/api/auth/register", {
      method: "POST",
      body: { name: "Profile A", phone: `0761${suffix % 1000000}`, email: `profa-${suffix}@example.com`, password: "testpass1", role: "rider" },
    })
  ).data;
  const userB = (
    await api("/api/auth/register", {
      method: "POST",
      body: { name: "Profile B", phone: `0762${suffix % 1000000}`, email: `profb-${suffix}@example.com`, password: "testpass1", role: "rider" },
    })
  ).data;

  const edit = await api("/api/users/me", {
    method: "PATCH",
    token: userA.token,
    body: { name: "Renamed A", image: "data:image/png;base64,AAAA" },
  });
  assert.equal(edit.status, 200);
  assert.equal(edit.data.name, "Renamed A");
  assert.equal(edit.data.image, "data:image/png;base64,AAAA");

  // Persisted, not just echoed back
  const relogin = await api("/api/auth/login", { method: "POST", body: { email: userA.user.email, password: "testpass1" } });
  assert.equal(relogin.data.user.name, "Renamed A");
  assert.equal(relogin.data.user.image, "data:image/png;base64,AAAA");

  const dupePhone = await api("/api/users/me", {
    method: "PATCH",
    token: userB.token,
    body: { phone: userA.user.phone },
  });
  assert.equal(dupePhone.status, 409);

  const badImage = await api("/api/users/me", {
    method: "PATCH",
    token: userB.token,
    body: { image: "not-a-data-url" },
  });
  assert.equal(badImage.status, 400);
});

test("delivery chat: involved parties can read/post, admin is read-only, outsiders get 404", async () => {
  const suffix = Date.now();
  const retailer = (
    await api("/api/auth/register", {
      method: "POST",
      body: { name: "Chat Retailer", phone: `0771${suffix % 1000000}`, email: `chatr-${suffix}@example.com`, password: "testpass1", role: "retailer" },
    })
  ).data;
  const dispatcher = (
    await api("/api/auth/register", {
      method: "POST",
      body: { name: "Chat Dispatcher", phone: `0772${suffix % 1000000}`, email: `chatd-${suffix}@example.com`, password: "testpass1", role: "dispatcher" },
    })
  ).data;
  await approveDispatcher(dispatcher.user.id);
  const rider = (
    await api("/api/auth/register", {
      method: "POST",
      body: { name: "Chat Rider", phone: `0773${suffix % 1000000}`, email: `chatri-${suffix}@example.com`, password: "testpass1", role: "rider" },
    })
  ).data;
  const outsider = (
    await api("/api/auth/register", {
      method: "POST",
      body: { name: "Chat Outsider", phone: `0774${suffix % 1000000}`, email: `chato-${suffix}@example.com`, password: "testpass1", role: "retailer" },
    })
  ).data;
  const adminLogin = await api("/api/auth/login", {
    method: "POST",
    body: { email: "admin@reflex.demo", password: process.env.ADMIN_SEED_PASSWORD || "admin123" },
  });

  const created = await api("/api/deliveries", {
    method: "POST",
    token: retailer.token,
    body: { customer_name: "Chat Cust", customer_phone: "0700111222", address: "Nairobi", item_description: "Chat Widget" },
  });
  const deliveryId = created.data.id;

  // Before assignment: retailer and dispatcher can chat, an outsider cannot
  const retailerMsg = await api(`/api/deliveries/${deliveryId}/messages`, {
    method: "POST",
    token: retailer.token,
    body: { body: "Please pick this up soon" },
  });
  assert.equal(retailerMsg.status, 201);
  assert.equal(retailerMsg.data.sender_name, "Chat Retailer");
  assert.equal(retailerMsg.data.sender_role, "retailer");

  const dispatcherMsg = await api(`/api/deliveries/${deliveryId}/messages`, {
    method: "POST",
    token: dispatcher.token,
    body: { body: "On it" },
  });
  assert.equal(dispatcherMsg.status, 201);

  const outsiderRead = await api(`/api/deliveries/${deliveryId}/messages`, { token: outsider.token });
  assert.equal(outsiderRead.status, 404);
  const outsiderPost = await api(`/api/deliveries/${deliveryId}/messages`, {
    method: "POST",
    token: outsider.token,
    body: { body: "Sneaking in" },
  });
  assert.equal(outsiderPost.status, 404);

  // Assign a rider, then confirm the rider can now chat too
  await api(`/api/deliveries/${deliveryId}/assign`, {
    method: "PATCH",
    token: dispatcher.token,
    body: { rider_id: rider.user.id },
  });
  const riderMsg = await api(`/api/deliveries/${deliveryId}/messages`, {
    method: "POST",
    token: rider.token,
    body: { body: "On my way" },
  });
  assert.equal(riderMsg.status, 201);

  const thread = await api(`/api/deliveries/${deliveryId}/messages`, { token: retailer.token });
  assert.equal(thread.status, 200);
  assert.equal(thread.data.length, 3);
  assert.deepEqual(thread.data.map((m) => m.body), ["Please pick this up soon", "On it", "On my way"]);

  // Admin can read (oversight) but not post
  const adminRead = await api(`/api/deliveries/${deliveryId}/messages`, { token: adminLogin.data.token });
  assert.equal(adminRead.status, 200);
  const adminPost = await api(`/api/deliveries/${deliveryId}/messages`, {
    method: "POST",
    token: adminLogin.data.token,
    body: { body: "Admin butting in" },
  });
  assert.equal(adminPost.status, 403);

  // Validation
  const emptyBody = await api(`/api/deliveries/${deliveryId}/messages`, {
    method: "POST",
    token: retailer.token,
    body: { body: "   " },
  });
  assert.equal(emptyBody.status, 400);

  const tooLong = await api(`/api/deliveries/${deliveryId}/messages`, {
    method: "POST",
    token: retailer.token,
    body: { body: "x".repeat(2001) },
  });
  assert.equal(tooLong.status, 400);
});

test("password change requires the current password and enforces a minimum length", async () => {
  const suffix = Date.now();
  const email = `pwchange-${suffix}@example.com`;
  const reg = await api("/api/auth/register", {
    method: "POST",
    body: { name: "PW Change", phone: `0781${suffix % 1000000}`, email, password: "originalpw", role: "rider" },
  });
  const token = reg.data.token;

  const wrongCurrent = await api("/api/users/me/password", {
    method: "PATCH",
    token,
    body: { currentPassword: "not-it", newPassword: "brandnewpw" },
  });
  assert.equal(wrongCurrent.status, 401);

  const tooShort = await api("/api/users/me/password", {
    method: "PATCH",
    token,
    body: { currentPassword: "originalpw", newPassword: "abc" },
  });
  assert.equal(tooShort.status, 400);

  const missingCurrent = await api("/api/users/me/password", {
    method: "PATCH",
    token,
    body: { newPassword: "brandnewpw" },
  });
  assert.equal(missingCurrent.status, 401);

  const success = await api("/api/users/me/password", {
    method: "PATCH",
    token,
    body: { currentPassword: "originalpw", newPassword: "brandnewpw" },
  });
  assert.equal(success.status, 200);

  // Old password no longer works; new one does
  const loginOld = await api("/api/auth/login", { method: "POST", body: { email, password: "originalpw" } });
  assert.equal(loginOld.status, 401);
  const loginNew = await api("/api/auth/login", { method: "POST", body: { email, password: "brandnewpw" } });
  assert.equal(loginNew.status, 200);
});

test("public tracking page works with no auth, rejects unknown tokens, and leaks no PII beyond what's needed", async () => {
  const suffix = Date.now();
  const retailer = (
    await api("/api/auth/register", {
      method: "POST",
      body: { name: "Track Retailer", phone: `0791${suffix % 1000000}`, email: `trackr-${suffix}@example.com`, password: "testpass1", role: "retailer" },
    })
  ).data;

  const created = await api("/api/deliveries", {
    method: "POST",
    token: retailer.token,
    body: { customer_name: "Track Customer", customer_phone: "0700123123", address: "Track Address, Nairobi", item_description: "Trackable Widget" },
  });
  assert.equal(created.status, 201);
  const qrToken = created.data.qr_code;
  assert.ok(qrToken, "the owning retailer's own create-delivery response should include qr_code");

  // No Authorization header at all — this must work
  const track = await api(`/api/track/${qrToken}`);
  assert.equal(track.status, 200);
  assert.equal(track.data.item_description, "Trackable Widget");
  assert.equal(track.data.status, "requested");
  assert.equal(track.data.retailer_name, "Track Retailer");
  assert.ok(Array.isArray(track.data.history));
  assert.equal(track.data.history.length, 1);
  assert.equal(track.data.history[0].status, "requested");

  // Customer phone is deliberately not exposed on the public page
  assert.equal(track.data.customer_phone, undefined);

  // Unknown token -> 404, not a 401/500 that would hint at anything else
  const unknown = await api("/api/track/not-a-real-token-at-all");
  assert.equal(unknown.status, 404);
});
