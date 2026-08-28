const express = require("express");
const { getDeliveryByQrCode, getStatusLog, findUserById } = require("../db");

const router = express.Router();

function statusLabel(status) {
  return status.replace("_", " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

// GET /api/track/:token — deliberately public, no auth. Mounted before
// requireAuth in server.js. :token is the delivery's qr_code — already
// an opaque 128-bit random value the retailer controls who they hand it
// to (the same one shown to the rider for scan-confirmation), so this
// reuses it as a shareable tracking link rather than minting a second
// token type for the same purpose.
//
// Response is a deliberately minimal, customer-safe subset: no
// customer_phone, no internal user IDs, no rider identity beyond
// "assigned" (the status itself) — just enough to answer "where is my
// order", nothing an unauthenticated caller with just a link shouldn't
// see. 404 (not a more specific error) for an unknown/malformed token,
// so this endpoint can't be used to distinguish "wrong token" from
// "right token, delivery since deleted" — not that this app deletes
// deliveries, but the habit costs nothing.
router.get("/:token", async (req, res) => {
  const delivery = await getDeliveryByQrCode(req.params.token);
  if (!delivery) return res.status(404).json({ error: "Tracking link not found." });

  const retailer = await findUserById(delivery.retailer_id);
  const rawHistory = await getStatusLog(delivery.id);

  res.json({
    customer_name: delivery.customer_name,
    item_description: delivery.item_description,
    address: delivery.address,
    status: delivery.status,
    status_label: statusLabel(delivery.status),
    retailer_name: retailer ? retailer.name : "the retailer",
    created_at: delivery.created_at,
    updated_at: delivery.updated_at,
    history: rawHistory.map((h) => ({
      status: h.new_status,
      status_label: statusLabel(h.new_status),
      at: h.changed_at,
    })),
  });
});

module.exports = router;
