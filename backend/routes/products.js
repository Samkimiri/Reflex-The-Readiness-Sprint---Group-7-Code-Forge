const express = require("express");
const { createProduct, listProducts, getProductById, deleteProduct, saveProduct } = require("../db");

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

// A data URL this size decodes to roughly 450KB — the frontend compresses
// images to a ~480px JPEG before sending (usually tens of KB), so this is a
// sanity ceiling against a huge/unexpected upload bloating the JSON store,
// not the normal case.
const MAX_IMAGE_DATA_URL_LENGTH = 600_000;

// POST /api/products  (retailer only)  { name, price?, description?, image? }
router.post("/", async (req, res) => {
  if (req.user.role !== "retailer") return res.status(403).json({ error: "Only a retailer can add products." });

  const { name, price, description, image } = req.body || {};
  if (!name || !name.trim()) return res.status(400).json({ error: "name is required." });

  let parsedPrice = null;
  if (price !== undefined && price !== null && price !== "") {
    parsedPrice = Number(price);
    if (!Number.isFinite(parsedPrice) || parsedPrice < 0) {
      return res.status(400).json({ error: "price must be a non-negative number." });
    }
  }

  let parsedImage = null;
  if (image) {
    if (typeof image !== "string" || !image.startsWith("data:image/")) {
      return res.status(400).json({ error: "image must be an image data URL." });
    }
    if (image.length > MAX_IMAGE_DATA_URL_LENGTH) {
      return res.status(400).json({ error: "Image is too large — try a smaller photo." });
    }
    parsedImage = image;
  }

  const product = await createProduct({
    retailer_id: req.user.id,
    name: name.trim(),
    price: parsedPrice,
    description: description ? description.trim() : null,
    image: parsedImage,
  });
  res.status(201).json(product);
});

// PATCH /api/products/:id  (retailer only, own product)  { name?, price?, description?, image? }
// Every field is optional and only touched if present in the body, so the
// frontend can send just what changed rather than the whole product.
router.patch("/:id", async (req, res) => {
  const product = await getProductById(req.params.id);
  if (!product) return res.status(404).json({ error: "Product not found." });
  if (req.user.role !== "retailer" || product.retailer_id !== req.user.id) {
    return res.status(403).json({ error: "You can only edit your own products." });
  }

  const { name, price, description, image } = req.body || {};

  if (name !== undefined) {
    if (!name || !name.trim()) return res.status(400).json({ error: "name is required." });
    product.name = name.trim();
  }

  if (price !== undefined) {
    if (price === null || price === "") {
      product.price = null;
    } else {
      const parsedPrice = Number(price);
      if (!Number.isFinite(parsedPrice) || parsedPrice < 0) {
        return res.status(400).json({ error: "price must be a non-negative number." });
      }
      product.price = parsedPrice;
    }
  }

  if (description !== undefined) {
    product.description = description ? description.trim() : null;
  }

  if (image !== undefined) {
    if (image === null || image === "") {
      product.image = null;
    } else {
      if (typeof image !== "string" || !image.startsWith("data:image/")) {
        return res.status(400).json({ error: "image must be an image data URL." });
      }
      if (image.length > MAX_IMAGE_DATA_URL_LENGTH) {
        return res.status(400).json({ error: "Image is too large — try a smaller photo." });
      }
      product.image = image;
    }
  }

  const saved = await saveProduct(product);
  res.json(saved);
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
