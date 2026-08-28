const express = require("express");
const crypto = require("crypto");
const QRCode = require("qrcode");
const {
  createDelivery,
  getDeliveryById,
  listDeliveries,
  saveDelivery,
  addStatusLog,
  getStatusLog,
  findUserById,
  createMessage,
  listMessages,
} = require("../db");
const { canTransition, assertRole, httpError } = require("../statusMachine");

const router = express.Router();

// POST /api/deliveries  (retailer creates a request)
router.post("/", async (req, res) => {
  if (req.user.role !== "retailer") return res.status(403).json({ error: "Only a retailer can log a delivery request." });

  const { customer_name, customer_phone, address, item_description } = req.body || {};
  if (!customer_name || !customer_phone || !address || !item_description) {
    return res.status(400).json({ error: "customer_name, customer_phone, address, and item_description are all required." });
  }

  const qr_code = crypto.randomBytes(16).toString("hex"); // opaque token — no PII encoded
  const delivery = await createDelivery({
    retailer_id: req.user.id,
    customer_name,
    customer_phone,
    address,
    item_description,
    qr_code,
  });
  await addStatusLog({ delivery_id: delivery.id, changed_by: req.user.id, old_status: null, new_status: "requested" });

  res.status(201).json(withView(delivery, req.user));
});

// GET /api/deliveries?status=&rider_id=me&retailer_id=me
router.get("/", async (req, res) => {
  const filter = {};
  if (req.query.status) filter.status = req.query.status;
  if (req.query.rider_id) filter.rider_id = req.query.rider_id === "me" ? req.user.id : req.query.rider_id;
  if (req.query.retailer_id) filter.retailer_id = req.query.retailer_id === "me" ? req.user.id : req.query.retailer_id;

  // Role-scoped visibility, even if a filter wasn't explicitly passed
  if (req.user.role === "retailer" && !filter.retailer_id) filter.retailer_id = req.user.id;
  if (req.user.role === "rider" && !filter.rider_id && req.query.rider_id !== "unassigned") filter.rider_id = req.user.id;

  let deliveries = await listDeliveries(filter);
  deliveries = deliveries
    .slice()
    .sort((a, b) => new Date(b.created_at) - new Date(a.created_at))
    .map((d) => withView(d, req.user));

  res.json(deliveries);
});

// GET /api/deliveries/:id  (full detail + status history)
router.get("/:id", async (req, res) => {
  const delivery = await getDeliveryById(req.params.id);
  if (!delivery) return res.status(404).json({ error: "Delivery not found." });
  if (!canViewDelivery(req.user, delivery)) return res.status(404).json({ error: "Delivery not found." });

  const rawHistory = await getStatusLog(delivery.id);
  const history = await Promise.all(
    rawHistory.map(async (h) => ({
      ...h,
      changed_by_name: (await findUserById(h.changed_by))?.name || "Unknown",
    }))
  );

  res.json({ ...withView(delivery, req.user), history });
});

// PATCH /api/deliveries/:id/assign   (dispatcher)  { rider_id }
router.patch("/:id/assign", async (req, res, next) => {
  try {
    const delivery = await getDeliveryById(req.params.id);
    if (!delivery) return res.status(404).json({ error: "Delivery not found." });

    assertRole("assign", req.user, delivery);
    if (!canTransition(delivery.status, "assigned")) {
      throw httpError(400, `Cannot assign a delivery that is currently '${delivery.status}'.`);
    }

    const { rider_id } = req.body || {};
    if (!rider_id) return res.status(400).json({ error: "rider_id is required." });
    const rider = await findUserById(rider_id);
    if (!rider || rider.role !== "rider") return res.status(400).json({ error: "rider_id must belong to a rider." });

    // Atomic-in-spirit: re-check status hasn't moved before writing (single-process JSON store
    // makes this effectively atomic; a real DB would use `UPDATE ... WHERE status='requested'`).
    const fresh = await getDeliveryById(delivery.id);
    if (fresh.status !== "requested") {
      return res.status(409).json({ error: "This delivery was already assigned by someone else." });
    }

    const old_status = fresh.status;
    fresh.status = "assigned";
    fresh.rider_id = Number(rider_id);
    await saveDelivery(fresh);
    await addStatusLog({ delivery_id: fresh.id, changed_by: req.user.id, old_status, new_status: "assigned" });

    res.json(withView(fresh, req.user));
  } catch (e) {
    next(e);
  }
});

// PATCH /api/deliveries/:id/status   { new_status }  — pick_up and cancel go through here
router.patch("/:id/status", async (req, res, next) => {
  try {
    const delivery = await getDeliveryById(req.params.id);
    if (!delivery) return res.status(404).json({ error: "Delivery not found." });

    const { new_status } = req.body || {};
    if (!new_status) return res.status(400).json({ error: "new_status is required." });

    if (new_status === "delivered") {
      throw httpError(400, "Use POST /api/deliveries/:id/scan to confirm delivery — it requires the QR token.");
    }

    const action = new_status === "picked_up" ? "pick_up" : new_status === "cancelled" ? "cancel" : null;
    if (!action) throw httpError(400, `Unsupported transition to '${new_status}'.`);

    assertRole(action, req.user, delivery);
    if (!canTransition(delivery.status, new_status)) {
      throw httpError(400, `Cannot move from '${delivery.status}' to '${new_status}'.`);
    }

    const old_status = delivery.status;
    delivery.status = new_status;
    await saveDelivery(delivery);
    await addStatusLog({ delivery_id: delivery.id, changed_by: req.user.id, old_status, new_status });

    res.json(withView(delivery, req.user));
  } catch (e) {
    next(e);
  }
});

// POST /api/deliveries/:id/scan   { qr_code }  — rider confirms drop-off
router.post("/:id/scan", async (req, res, next) => {
  try {
    const delivery = await getDeliveryById(req.params.id);
    if (!delivery) return res.status(404).json({ error: "Delivery not found." });

    assertRole("deliver", req.user, delivery);

    const { qr_code } = req.body || {};
    if (!qr_code) return res.status(400).json({ error: "qr_code is required." });
    if (qr_code !== delivery.qr_code) {
      throw httpError(400, "QR code doesn't match this delivery.");
    }
    if (!canTransition(delivery.status, "delivered")) {
      throw httpError(400, `Cannot confirm delivery — status is currently '${delivery.status}', expected 'picked_up'.`);
    }

    const old_status = delivery.status;
    delivery.status = "delivered";
    await saveDelivery(delivery);
    await addStatusLog({ delivery_id: delivery.id, changed_by: req.user.id, old_status, new_status: "delivered" });

    res.json(withView(delivery, req.user));
  } catch (e) {
    next(e);
  }
});

// GET /api/deliveries/:id/qrcode.png  — the QR image the retailer displays/prints.
// Only the owning retailer can fetch this: it's a rendering of the raw
// qr_code token, and anyone holding that token can (mis)use it — the same
// party who's allowed to see `qr_code` in JSON responses (see canSeeToken
// below) is the only party who should be able to render it as an image.
router.get("/:id/qrcode.png", async (req, res) => {
  const delivery = await getDeliveryById(req.params.id);
  if (!delivery) return res.status(404).end();
  if (!canSeeToken(req.user, delivery)) return res.status(404).end();
  res.setHeader("Content-Type", "image/png");
  QRCode.toFileStream(res, delivery.qr_code, { width: 300, margin: 1 });
});

// GET /api/deliveries/:id/messages — per-delivery chat between whoever's
// actually involved (the retailer, any dispatcher, the assigned rider).
// Same visibility rule as the delivery itself, so there's no separate
// IDOR surface to get wrong here.
router.get("/:id/messages", async (req, res) => {
  const delivery = await getDeliveryById(req.params.id);
  if (!delivery) return res.status(404).json({ error: "Delivery not found." });
  if (!canViewDelivery(req.user, delivery)) return res.status(404).json({ error: "Delivery not found." });

  const raw = await listMessages(delivery.id);
  const messages = await Promise.all(
    raw.map(async (m) => {
      const sender = await findUserById(m.sender_id);
      return {
        id: m.id,
        body: m.body,
        created_at: m.created_at,
        sender_id: m.sender_id,
        sender_name: sender?.name || "Unknown",
        sender_role: sender?.role || null,
      };
    })
  );
  res.json(messages);
});

// POST /api/deliveries/:id/messages   { body }
// Admin can read (oversight, same as everywhere else) but not post — chat
// is an operational tool between the people actually coordinating a
// delivery, and admin's role throughout this app is deliberately
// oversight-only, not a participant in day-to-day operations.
router.post("/:id/messages", async (req, res) => {
  const delivery = await getDeliveryById(req.params.id);
  if (!delivery) return res.status(404).json({ error: "Delivery not found." });
  // Not involved in this delivery at all — same "don't confirm it exists"
  // treatment as every other delivery-scoped route.
  if (!canViewDelivery(req.user, delivery)) return res.status(404).json({ error: "Delivery not found." });
  // Involved (can see it, e.g. admin oversight) but not allowed to post —
  // a real permission failure, not a visibility one, so 403 is honest here.
  if (req.user.role === "admin") return res.status(403).json({ error: "Admin has read-only oversight of chat, not posting." });

  const { body } = req.body || {};
  if (!body || !body.trim()) return res.status(400).json({ error: "body is required." });
  if (body.trim().length > 2000) return res.status(400).json({ error: "Message is too long (max 2000 characters)." });

  const message = await createMessage({ delivery_id: delivery.id, sender_id: req.user.id, body: body.trim() });
  res.status(201).json({
    id: message.id,
    body: message.body,
    created_at: message.created_at,
    sender_id: req.user.id,
    sender_name: req.user.name,
    sender_role: req.user.role,
  });
});

// A dispatcher coordinates every delivery, so sees all of them; so does an
// admin (oversight — this is the account used to verify the whole system is
// healthy, not an operational role); a retailer only their own; a rider
// only the ones assigned to them.
function canViewDelivery(user, delivery) {
  if (user.role === "dispatcher" || user.role === "admin") return true;
  if (user.role === "retailer") return user.id === delivery.retailer_id;
  if (user.role === "rider") return user.id === delivery.rider_id;
  return false;
}

function canSeeToken(user, delivery) {
  if (user.role === "admin") return true;
  return user.role === "retailer" && user.id === delivery.retailer_id;
}

// Shape returned to clients — retailers/dispatchers/riders all see the same
// fields; only the raw qr_code stays out of list views to keep it out of casual reach.
function withView(delivery, requestingUser) {
  const base = { ...delivery };
  if (!canSeeToken(requestingUser, delivery)) delete base.qr_code;
  return base;
}

module.exports = router;
