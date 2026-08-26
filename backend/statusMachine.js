// Delivery status state machine.
//
//   requested -> assigned -> picked_up -> delivered
//        \            \
//         -> cancelled  -> cancelled
//
// Rules (mirrors the architecture deck exactly):
//   requested -> assigned   : dispatcher only, must supply rider_id
//   assigned  -> picked_up  : only the assigned rider
//   picked_up -> delivered  : only the assigned rider, normally via /scan
//   requested -> cancelled  : the delivery's own retailer, or any dispatcher
//   assigned  -> cancelled  : the delivery's own retailer, or any dispatcher
//   anything else           : rejected

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
  switch (action) {
    case "assign":
      if (user.role !== "dispatcher") throw httpError(403, "Only a dispatcher can assign a rider.");
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
      if (user.role === "dispatcher") break; // a dispatcher can cancel any delivery
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
