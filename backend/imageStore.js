// Image storage for product photos and profile pictures.
//
// Locally (or anywhere BLOB_READ_WRITE_TOKEN isn't set), an uploaded photo
// is stored exactly as this app has always done it: as a base64 data URL
// right inside the record. On Vercel — where the Blob store created for
// this project injects that token automatically — it's uploaded to Vercel
// Blob instead, and only the resulting CDN URL is stored. The DB record
// stays small (a URL instead of ~50-450KB of base64) and the photo gets a
// real CDN in front of it instead of every read of that record dragging
// the image bytes along with it.
//
// This mirrors the same "works with zero setup, upgrades automatically
// when configured" pattern already used for the data store (Redis vs a
// JSON file, see db.js) and rate limiting (Upstash vs in-memory, see
// server.js) — nothing about local `npm start` changes.

const { put, del } = require("@vercel/blob");

const BLOB_ENABLED = !!process.env.BLOB_READ_WRITE_TOKEN;

const DATA_URL_RE = /^data:(image\/[a-zA-Z0-9.+-]+);base64,(.+)$/s;

// Takes a data: URL (already validated by the caller as a real image, under
// the size cap) and returns either a Blob URL (if configured) or the same
// data URL unchanged (local-dev fallback). `folder` just namespaces the
// pathname in the store ("products" vs "avatars") for readability.
async function storeImage(dataUrl, folder) {
  if (!dataUrl) return null;
  if (!BLOB_ENABLED) return dataUrl;

  const match = DATA_URL_RE.exec(dataUrl);
  if (!match) return dataUrl; // not a data URL this function produced/expects — leave it untouched rather than guess

  const [, contentType, base64] = match;
  const buffer = Buffer.from(base64, "base64");
  const ext = contentType.split("/")[1] || "jpg";
  const filename = `${folder}/${Date.now()}-${Math.random().toString(36).slice(2, 8)}.${ext}`;

  const blob = await put(filename, buffer, { access: "public", contentType });
  return blob.url;
}

// Best-effort cleanup for the image a record is about to stop pointing at
// (replaced with a new photo, or cleared outright) — only ever called with
// a URL this same store produced, never a raw data URL (which was never
// uploaded anywhere, so there's nothing to delete) or a foreign URL. A
// failed delete is logged, not thrown: an orphaned blob costs pennies, and
// the request that triggered this shouldn't fail because cleanup didn't.
//
// Note for anyone debugging "the old photo still loads after I deleted
// it": that's expected. del() removes it from the store immediately (it
// stops being billed, stops showing up in `vercel blob list`), but public
// blob URLs are served with long CDN cache headers by design — Vercel's
// model is that a blob's pathname is effectively immutable, so "changing"
// a photo means uploading a new blob at a new path (see storeImage above)
// rather than overwriting one in place. A stale CDN edge can keep serving
// the old bytes for a while after deletion; nothing in this app still
// references that URL once the record's been updated, so it's harmless.
async function deleteImage(url) {
  if (!BLOB_ENABLED || !url) return;
  if (!url.includes(".public.blob.vercel-storage.com/")) return;
  try {
    await del(url);
  } catch (e) {
    console.error("imageStore: failed to delete blob", url, e.message);
  }
}

module.exports = { storeImage, deleteImage, BLOB_ENABLED };
