const express = require("express");
const { createProduct, listProducts, getProductById, deleteProduct } = require("../db");

const router = express.Router();

// GET /api/products — a retailer sees their own catalog; other roles pass
// ?retailer_id= to see a specific retailer's products (e.g. while logging
// a delivery on their behalf isn't a thing yet, but dispatch/rider views
// may want read access later without duplicating this route).
router.get("/", async (req, res) => {
  const retailer_id = req.user.role === "retailer" ? req.user.id : req.query.retailer_id;
  const products = await listProducts(retailer_id ? { retailer_id } : {});
  res.json(products);
});

// POST /api/products  (retailer only)  { name, price?, description? }
router.post("/", async (req, res) => {
  if (req.user.role !== "retailer") return res.status(403).json({ error: "Only a retailer can add products." });

  const { name, price, description } = req.body || {};
  if (!name || !name.trim()) return res.status(400).json({ error: "name is required." });

  let parsedPrice = null;
  if (price !== undefined && price !== null && price !== "") {
    parsedPrice = Number(price);
    if (!Number.isFinite(parsedPrice) || parsedPrice < 0) {
      return res.status(400).json({ error: "price must be a non-negative number." });
    }
  }

  const product = await createProduct({
    retailer_id: req.user.id,
    name: name.trim(),
    price: parsedPrice,
    description: description ? description.trim() : null,
  });
  res.status(201).json(product);
});

// DELETE /api/products/:id  (retailer only, own product)
router.delete("/:id", async (req, res) => {
  const product = await getProductById(req.params.id);
  if (!product) return res.status(404).json({ error: "Product not found." });
  if (req.user.role !== "retailer" || product.retailer_id !== req.user.id) {
    return res.status(403).json({ error: "You can only remove your own products." });
  }
  await deleteProduct(product.id);
  res.status(204).end();
});

module.exports = router;
