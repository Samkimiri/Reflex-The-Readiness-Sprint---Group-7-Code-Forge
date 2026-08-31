// Delivery status state machine.
//
//   requested -> assigned -> picked_up -> delivered
//        \            \
//         -> cancelled  -> cancelled
//
// Rules (mirrors the architecture deck exactly):
//   requested -> assigned   : dispatcher (or admin), must supply rider_id
//   assigned  -> picked_up  : only the assigned rider
//   picked_up -> delivered  : only the assigned rider, normally via /scan
//   requested -> cancelled  : the delivery's own retailer, or dispatcher/admin
//   assigned  -> cancelled  : the delivery's own retailer, or dispatcher/admin
//   anything else           : rejected
//
// admin is an oversight role (verifying the system is healthy), not an
// operational one — it gets dispatcher-level override on assign/cancel, but
// pick_up/deliver stay rider-only since those represent a real person
// physically doing something; letting admin fake that would make the audit
// trail (`changed_by`) lie about who actually did it.

const TRANSITIONS = {
  requested: ["assigned", "cancelled"],
  assigned: ["picked_up", "cancelled"],
  picked_up: ["delivered"],
  delivered: [],
  cancelled: [],
};

function canTransition(from, to) {
  return (TRANSITIONS[from] || []).includes(to);
}

function assertRole(action, user, delivery) {
  // A self-registered dispatcher starts unapproved (see auth.js) — until an
  // admin reviews them, they're blocked from every dispatcher-level action.
  // Every other role's capability is already scoped narrowly enough (a
  // retailer only their own deliveries, a rider only deliveries a dispatcher
  // assigned them) that this gate doesn't need to apply to them.
  if (user.role === "dispatcher" && user.approved === false) {
    throw httpError(403, "Your dispatcher account is pending admin approval.");
  }
  switch (action) {
    case "assign":
      if (user.role !== "dispatcher" && user.role !== "admin") throw httpError(403, "Only a dispatcher can assign a rider.");
      break;
    case "pick_up":
      if (user.role !== "rider" || user.id !== delivery.rider_id)
        throw httpError(403, "Only the assigned rider can mark a delivery picked up.");
      break;
    case "deliver":
      if (user.role !== "rider" || user.id !== delivery.rider_id)
        throw httpError(403, "Only the assigned rider can confirm delivery.");
      break;
    case "cancel":
      if (user.role === "dispatcher" || user.role === "admin") break; // full override
      if (user.role === "retailer" && user.id === delivery.retailer_id) break; // but a retailer only their own
      throw httpError(403, "Only the retailer who logged this delivery, or a dispatcher, can cancel it.");
    default:
      throw httpError(400, "Unknown action.");
  }
}

function httpError(status, message) {
  const err = new Error(message);
  err.status = status;
  return err;
}

module.exports = { canTransition, assertRole, httpError, TRANSITIONS };
