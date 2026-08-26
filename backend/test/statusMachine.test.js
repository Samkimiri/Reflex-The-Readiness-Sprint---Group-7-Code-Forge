const test = require("node:test");
const assert = require("node:assert/strict");
const { canTransition, assertRole, httpError } = require("../statusMachine");

test("canTransition — allowed transitions", () => {
  assert.equal(canTransition("requested", "assigned"), true);
  assert.equal(canTransition("requested", "cancelled"), true);
  assert.equal(canTransition("assigned", "picked_up"), true);
  assert.equal(canTransition("assigned", "cancelled"), true);
  assert.equal(canTransition("picked_up", "delivered"), true);
});

test("canTransition — rejects skipping states", () => {
  assert.equal(canTransition("requested", "picked_up"), false);
  assert.equal(canTransition("requested", "delivered"), false);
  assert.equal(canTransition("assigned", "delivered"), false);
});

test("canTransition — terminal states have no outgoing transitions", () => {
  assert.equal(canTransition("delivered", "requested"), false);
  assert.equal(canTransition("delivered", "cancelled"), false);
  assert.equal(canTransition("cancelled", "requested"), false);
  assert.equal(canTransition("cancelled", "assigned"), false);
});

test("canTransition — unknown status is never a valid `from`", () => {
  assert.equal(canTransition("bogus", "requested"), false);
});

test("assertRole — assign allows dispatcher", () => {
  assert.doesNotThrow(() => assertRole("assign", { role: "dispatcher" }, {}));
});

test("assertRole — assign rejects non-dispatchers with 403", () => {
  try {
    assertRole("assign", { role: "rider" }, {});
    assert.fail("expected assertRole to throw");
  } catch (e) {
    assert.equal(e.status, 403);
  }
});

test("assertRole — pick_up/deliver require the assigned rider specifically", () => {
  const delivery = { rider_id: 7 };
  assert.doesNotThrow(() => assertRole("pick_up", { role: "rider", id: 7 }, delivery));
  assert.doesNotThrow(() => assertRole("deliver", { role: "rider", id: 7 }, delivery));

  for (const action of ["pick_up", "deliver"]) {
    try {
      assertRole(action, { role: "rider", id: 99 }, delivery); // right role, wrong rider
      assert.fail(`expected ${action} to reject a different rider`);
    } catch (e) {
      assert.equal(e.status, 403);
    }
    try {
      assertRole(action, { role: "dispatcher", id: 7 }, delivery); // right id, wrong role — shouldn't matter
      assert.fail(`expected ${action} to reject a non-rider role`);
    } catch (e) {
      assert.equal(e.status, 403);
    }
  }
});

test("assertRole — cancel: a dispatcher can cancel anyone's delivery", () => {
  const delivery = { retailer_id: 42 };
  assert.doesNotThrow(() => assertRole("cancel", { role: "dispatcher", id: 1 }, delivery));
});

test("assertRole — cancel: a retailer can only cancel their own delivery", () => {
  const delivery = { retailer_id: 42 };
  assert.doesNotThrow(() => assertRole("cancel", { role: "retailer", id: 42 }, delivery));
  try {
    assertRole("cancel", { role: "retailer", id: 99 }, delivery); // a different retailer
    assert.fail("expected a non-owning retailer to be rejected");
  } catch (e) {
    assert.equal(e.status, 403);
  }
});

test("assertRole — cancel rejects a rider outright", () => {
  const delivery = { retailer_id: 42 };
  try {
    assertRole("cancel", { role: "rider", id: 42 }, delivery); // even if the id happens to match
    assert.fail("expected a rider to be rejected");
  } catch (e) {
    assert.equal(e.status, 403);
  }
});

test("assertRole — unknown action rejects with 400", () => {
  try {
    assertRole("teleport", { role: "dispatcher" }, {});
    assert.fail("expected assertRole to throw");
  } catch (e) {
    assert.equal(e.status, 400);
  }
});

test("httpError — attaches status to an Error", () => {
  const e = httpError(404, "not found");
  assert.ok(e instanceof Error);
  assert.equal(e.status, 404);
  assert.equal(e.message, "not found");
});
