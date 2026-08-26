const API = "/api";
let state = { token: null, user: null, pollTimer: null };

// ---------- API helper ----------
async function api(path, { method = "GET", body } = {}) {
  const res = await fetch(API + path, {
    method,
    headers: {
      "Content-Type": "application/json",
      ...(state.token ? { Authorization: "Bearer " + state.token } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || "Request failed");
  return data;
}

function waitFor(check, timeoutMs) {
  return new Promise((resolve) => {
    const start = Date.now();
    (function poll() {
      if (check()) return resolve(true);
      if (Date.now() - start > timeoutMs) return resolve(false);
      setTimeout(poll, 100);
    })();
  });
}

// ---------- PWA: service worker + install prompt ----------
if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("/sw.js").catch((e) => console.warn("SW registration failed:", e));
  });
}

let deferredInstallPrompt = null;
const installBtn = document.getElementById("install-btn");

window.addEventListener("beforeinstallprompt", (e) => {
  e.preventDefault(); // stop Chrome's default mini-infobar — we show our own button instead
  deferredInstallPrompt = e;
  installBtn.classList.remove("hidden");
});

installBtn.addEventListener("click", async () => {
  if (!deferredInstallPrompt) return;
  installBtn.classList.add("hidden");
  deferredInstallPrompt.prompt();
  await deferredInstallPrompt.userChoice;
  deferredInstallPrompt = null;
});

window.addEventListener("appinstalled", () => {
  installBtn.classList.add("hidden");
  deferredInstallPrompt = null;
});

function toast(msg, isError = false) {
  const el = document.getElementById("toast");
  el.textContent = msg;
  el.classList.toggle("error", isError);
  el.classList.remove("hidden");
  clearTimeout(toast._t);
  toast._t = setTimeout(() => el.classList.add("hidden"), 3200);
}

// ---------- Auth ----------
document.getElementById("login-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const email = document.getElementById("login-email").value.trim();
  const password = document.getElementById("login-password").value;
  await doLogin(email, password);
});

document.querySelectorAll(".demo-btn").forEach((btn) => {
  btn.addEventListener("click", () => doLogin(btn.dataset.email, btn.dataset.pass));
});

async function doLogin(email, password) {
  const errEl = document.getElementById("login-error");
  errEl.textContent = "";
  try {
    const { token, user } = await api("/auth/login", { method: "POST", body: { email, password } });
    state.token = token;
    state.user = user;
    localStorage.setItem("reflex_token", token);
    localStorage.setItem("reflex_user", JSON.stringify(user));
    enterApp();
  } catch (e) {
    errEl.textContent = e.message;
  }
}

// ---------- Password show/hide ----------
document.querySelectorAll(".password-toggle").forEach((btn) => {
  btn.addEventListener("click", () => {
    const input = document.getElementById(btn.dataset.toggleFor);
    const showing = input.type === "text";
    input.type = showing ? "password" : "text";
    btn.textContent = showing ? "👁" : "🙈";
    btn.setAttribute("aria-label", showing ? "Show password" : "Hide password");
  });
});

// ---------- Register ----------
document.getElementById("show-register-btn").addEventListener("click", () => setAuthMode("register"));
document.getElementById("show-login-btn").addEventListener("click", () => setAuthMode("login"));

function setAuthMode(mode) {
  const isRegister = mode === "register";
  document.getElementById("login-form").classList.toggle("hidden", isRegister);
  document.getElementById("register-form").classList.toggle("hidden", !isRegister);
  document.getElementById("switch-to-register").classList.toggle("hidden", isRegister);
  document.getElementById("switch-to-login").classList.toggle("hidden", !isRegister);
  document.getElementById("demo-accounts").classList.toggle("hidden", isRegister);
  document.getElementById("auth-tagline").textContent = isRegister
    ? "Create your account"
    : "Delivery coordination for Kenyan retailers";
  document.getElementById("login-error").textContent = "";
  document.getElementById("register-error").textContent = "";
}

document.getElementById("register-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const errEl = document.getElementById("register-error");
  errEl.textContent = "";
  const fd = new FormData(e.target);
  const body = Object.fromEntries(fd);
  try {
    const { token, user } = await api("/auth/register", { method: "POST", body });
    state.token = token;
    state.user = user;
    localStorage.setItem("reflex_token", token);
    localStorage.setItem("reflex_user", JSON.stringify(user));
    enterApp();
  } catch (e) {
    errEl.textContent = e.message;
  }
});

// ---------- Google sign-in ----------
// Google's ID token proves *who* someone is, not *which role* they hold in
// this app — a brand-new Google account has to pick a role once before an
// account can be created for it.
let pendingGoogleCredential = null;

(async function initGoogleSignIn() {
  let googleClientId = null;
  try {
    ({ googleClientId } = await api("/auth/config"));
  } catch (e) {
    return; // no config endpoint reachable yet — leave the button hidden
  }
  if (!googleClientId) return;

  // accounts.google.com/gsi/client loads with `async`, so it can still be
  // in flight once this runs — give it a few seconds to show up.
  const gsiReady = await waitFor(() => window.google && window.google.accounts && window.google.accounts.id, 5000);
  if (!gsiReady) return;

  window.google.accounts.id.initialize({ client_id: googleClientId, callback: handleGoogleCredential });
  document.getElementById("google-btn-wrap").classList.remove("hidden");
  window.google.accounts.id.renderButton(document.getElementById("google-btn"), {
    theme: "outline",
    size: "large",
    width: 268,
  });
})();

async function handleGoogleCredential(response) {
  pendingGoogleCredential = response.credential;
  await submitGoogleCredential();
}

async function submitGoogleCredential(role) {
  try {
    const result = await api("/auth/google", { method: "POST", body: { credential: pendingGoogleCredential, role } });
    if (result.needsRole) {
      openGoogleRolePicker();
      return;
    }
    pendingGoogleCredential = null;
    state.token = result.token;
    state.user = result.user;
    localStorage.setItem("reflex_token", result.token);
    localStorage.setItem("reflex_user", JSON.stringify(result.user));
    enterApp();
  } catch (e) {
    toast(e.message, true);
  }
}

function openGoogleRolePicker() {
  const modal = openModal(`
    <button class="modal-close" data-close>&times;</button>
    <h3>One more thing</h3>
    <p style="font-size:13px;color:var(--muted)">Google doesn't tell us your role here — pick the one that's you.</p>
    <div class="form-grid">
      <div class="full">
        <label>I am a...</label>
        <select id="google-role-select">
          <option value="retailer">Retailer</option>
          <option value="dispatcher">Dispatcher</option>
          <option value="rider">Rider</option>
        </select>
      </div>
      <div class="full"><button class="btn btn-primary" id="google-role-submit" type="button">Finish creating account</button></div>
    </div>
  `);
  modal.querySelector("[data-close]").addEventListener("click", () => {
    pendingGoogleCredential = null;
    closeModal(modal);
  });
  modal.querySelector("#google-role-submit").addEventListener("click", async () => {
    const role = modal.querySelector("#google-role-select").value;
    closeModal(modal);
    await submitGoogleCredential(role);
  });
}

document.getElementById("logout-btn").addEventListener("click", () => {
  clearInterval(state.pollTimer);
  state = { token: null, user: null, pollTimer: null };
  localStorage.removeItem("reflex_token");
  localStorage.removeItem("reflex_user");
  document.getElementById("app-screen").classList.add("hidden");
  document.getElementById("login-screen").classList.remove("hidden");
});

function enterApp() {
  document.getElementById("login-screen").classList.add("hidden");
  document.getElementById("app-screen").classList.remove("hidden");
  document.getElementById("who-name").textContent = state.user.name;
  document.getElementById("who-role").textContent = state.user.role;
  render();
  clearInterval(state.pollTimer);
  // Polling refresh — see trade-off log: simplest way to keep views current
  // without building websocket infrastructure in a one-week sprint.
  state.pollTimer = setInterval(render, 4000);
}

// ---------- Router by role ----------
function render() {
  const root = document.getElementById("view-root");
  if (state.user.role === "retailer") return renderRetailer(root);
  if (state.user.role === "dispatcher") return renderDispatcher(root);
  if (state.user.role === "rider") return renderRider(root);
}

function statusLabel(s) {
  return s.replace("_", " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

function fmtTime(iso) {
  return new Date(iso).toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
}

// ================= RETAILER =================
async function renderRetailer(root) {
  const [deliveries, products] = await Promise.all([
    api("/deliveries").catch((e) => { toast(e.message, true); return []; }),
    api("/products").catch((e) => { toast(e.message, true); return []; }),
  ]);

  root.innerHTML = `
    <h2>Retailer — Log &amp; Track Deliveries</h2>
    <p class="subtitle">Every delivery you log, and where it stands right now.</p>

    <div class="panel">
      <h3>New delivery request</h3>
      <form id="new-delivery-form" class="form-grid">
        <div><label>Customer name</label><input name="customer_name" required /></div>
        <div><label>Customer phone</label><input name="customer_phone" required /></div>
        <div class="full"><label>Delivery address</label><input name="address" required /></div>
        <div class="full">
          <label>Item ${products.length ? "(pick from your products, or type below)" : ""}</label>
          ${products.length ? `
            <select id="product-pick">
              <option value="">— type manually below —</option>
              ${products.map((p) => `<option value="${p.id}">${escapeHtml(p.name)}${p.price != null ? ` (KSh ${p.price})` : ""}</option>`).join("")}
            </select>
          ` : ""}
        </div>
        <div class="full"><label>Item description</label><textarea name="item_description" rows="2" required></textarea></div>
        <div class="full"><button class="btn btn-primary" type="submit">Log delivery</button></div>
      </form>
    </div>

    <div class="panel">
      <h3>Your products (${products.length})</h3>
      <p class="subtitle" style="margin-bottom:14px;">What you sell — pick any of these when logging a delivery above.</p>
      <form id="new-product-form" class="form-grid">
        <div><label>Product name</label><input name="name" required /></div>
        <div><label>Price (KSh, optional)</label><input name="price" type="number" min="0" step="1" /></div>
        <div class="full"><label>Description (optional)</label><input name="description" /></div>
        <div class="full"><button class="btn btn-secondary" type="submit">Add product</button></div>
      </form>
      <div class="delivery-list" style="margin-top:16px;">
        ${products.length ? products.map(productCard).join("") : `<div class="empty-state">No products yet — add what you sell above.</div>`}
      </div>
    </div>

    <div class="panel">
      <h3>Your deliveries (${deliveries.length})</h3>
      <div class="delivery-list">
        ${deliveries.length ? deliveries.map(retailerCard).join("") : `<div class="empty-state">No deliveries logged yet.</div>`}
      </div>
    </div>
  `;

  const productPick = document.getElementById("product-pick");
  if (productPick) {
    productPick.addEventListener("change", () => {
      const p = products.find((x) => String(x.id) === productPick.value);
      const itemField = document.querySelector('#new-delivery-form [name="item_description"]');
      if (p) itemField.value = p.name + (p.description ? ` — ${p.description}` : "");
    });
  }

  document.getElementById("new-delivery-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const fd = new FormData(e.target);
    try {
      await api("/deliveries", { method: "POST", body: Object.fromEntries(fd) });
      toast("Delivery logged.");
      renderRetailer(root);
    } catch (err) {
      toast(err.message, true);
    }
  });

  document.getElementById("new-product-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const fd = new FormData(e.target);
    const body = Object.fromEntries(fd);
    if (!body.price) delete body.price;
    if (!body.description) delete body.description;
    try {
      await api("/products", { method: "POST", body });
      toast("Product added.");
      renderRetailer(root);
    } catch (err) {
      toast(err.message, true);
    }
  });

  root.querySelectorAll("[data-qr]").forEach((btn) => btn.addEventListener("click", () => openQrModal(btn.dataset.qr)));
  root.querySelectorAll("[data-history]").forEach((btn) => btn.addEventListener("click", () => openHistoryModal(btn.dataset.history)));
  root.querySelectorAll("[data-cancel]").forEach((btn) =>
    btn.addEventListener("click", () => cancelDelivery(btn.dataset.cancel, () => renderRetailer(root)))
  );
  root.querySelectorAll("[data-remove-product]").forEach((btn) =>
    btn.addEventListener("click", () => removeProduct(btn.dataset.removeProduct, () => renderRetailer(root)))
  );
}

function productCard(p) {
  return `
    <div class="delivery-card">
      <div class="delivery-main">
        <div class="delivery-title">${escapeHtml(p.name)}${p.price != null ? `<span class="price-tag">KSh ${p.price}</span>` : ""}</div>
        ${p.description ? `<div class="delivery-sub">${escapeHtml(p.description)}</div>` : ""}
      </div>
      <div class="delivery-actions">
        <button class="btn btn-danger btn-sm" data-remove-product="${p.id}">Remove</button>
      </div>
    </div>
  `;
}

async function removeProduct(id, after) {
  if (!confirm("Remove this product from your catalog?")) return;
  try {
    await api(`/products/${id}`, { method: "DELETE" });
    toast("Product removed.");
    after();
  } catch (e) {
    toast(e.message, true);
  }
}

function retailerCard(d) {
  return `
    <div class="delivery-card">
      <div class="delivery-main">
        <div class="delivery-title">${escapeHtml(d.customer_name)} <span class="status-pill status-${d.status}">${statusLabel(d.status)}</span></div>
        <div class="delivery-sub">${escapeHtml(d.item_description)} — ${escapeHtml(d.address)}</div>
        <div class="delivery-sub">Logged ${fmtTime(d.created_at)}</div>
      </div>
      <div class="delivery-actions">
        ${d.status !== "delivered" && d.status !== "cancelled" ? `<button class="btn btn-secondary btn-sm" data-qr="${d.id}">Show QR</button>` : ""}
        <button class="btn btn-secondary btn-sm" data-history="${d.id}">History</button>
        ${["requested", "assigned"].includes(d.status) ? `<button class="btn btn-danger btn-sm" data-cancel="${d.id}">Cancel</button>` : ""}
      </div>
    </div>
  `;
}

// ================= DISPATCHER =================
async function renderDispatcher(root) {
  const [open, riders] = await Promise.all([
    api("/deliveries?status=requested").catch(() => []),
    api("/users?role=rider").catch(() => []),
  ]);
  const inFlight = await api("/deliveries").then((all) => all.filter((d) => ["assigned", "picked_up"].includes(d.status))).catch(() => []);

  root.innerHTML = `
    <h2>Dispatcher — Assign Riders</h2>
    <p class="subtitle">Open requests waiting for a rider, and everything currently out for delivery.</p>

    <div class="panel">
      <h3>Open requests (${open.length})</h3>
      <div class="delivery-list">
        ${open.length ? open.map((d) => dispatcherCard(d, riders)).join("") : `<div class="empty-state">No open requests right now.</div>`}
      </div>
    </div>

    <div class="panel">
      <h3>In flight (${inFlight.length})</h3>
      <div class="delivery-list">
        ${inFlight.length ? inFlight.map(inFlightCard).join("") : `<div class="empty-state">Nothing currently assigned.</div>`}
      </div>
    </div>
  `;

  root.querySelectorAll("[data-assign-btn]").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const id = btn.dataset.assignBtn;
      const select = root.querySelector(`select[data-assign-select="${id}"]`);
      const rider_id = select.value;
      if (!rider_id) return toast("Pick a rider first.", true);
      try {
        await api(`/deliveries/${id}/assign`, { method: "PATCH", body: { rider_id } });
        toast("Rider assigned.");
        renderDispatcher(root);
      } catch (e) {
        toast(e.message, true);
      }
    });
  });

  root.querySelectorAll("[data-history]").forEach((btn) => btn.addEventListener("click", () => openHistoryModal(btn.dataset.history)));
  root.querySelectorAll("[data-cancel]").forEach((btn) =>
    btn.addEventListener("click", () => cancelDelivery(btn.dataset.cancel, () => renderDispatcher(root)))
  );
}

function dispatcherCard(d, riders) {
  return `
    <div class="delivery-card">
      <div class="delivery-main">
        <div class="delivery-title">${escapeHtml(d.customer_name)} <span class="status-pill status-${d.status}">${statusLabel(d.status)}</span></div>
        <div class="delivery-sub">${escapeHtml(d.item_description)} — ${escapeHtml(d.address)}</div>
      </div>
      <div class="delivery-actions">
        <select data-assign-select="${d.id}">
          <option value="">Assign rider…</option>
          ${riders.map((r) => `<option value="${r.id}">${escapeHtml(r.name)}</option>`).join("")}
        </select>
        <button class="btn btn-primary btn-sm" data-assign-btn="${d.id}">Assign</button>
        <button class="btn btn-danger btn-sm" data-cancel="${d.id}">Cancel</button>
      </div>
    </div>
  `;
}

function inFlightCard(d) {
  return `
    <div class="delivery-card">
      <div class="delivery-main">
        <div class="delivery-title">${escapeHtml(d.customer_name)} <span class="status-pill status-${d.status}">${statusLabel(d.status)}</span></div>
        <div class="delivery-sub">${escapeHtml(d.address)}</div>
      </div>
      <div class="delivery-actions">
        <button class="btn btn-secondary btn-sm" data-history="${d.id}">History</button>
      </div>
    </div>
  `;
}

// ================= RIDER =================
async function renderRider(root) {
  const mine = await api("/deliveries?rider_id=me").then((all) => all.filter((d) => ["assigned", "picked_up"].includes(d.status))).catch(() => []);

  root.innerHTML = `
    <h2>Rider — Your Deliveries</h2>
    <p class="subtitle">Update status as you go. Delivery is confirmed by scanning the retailer's QR code.</p>

    <div class="panel">
      <h3>Assigned to you (${mine.length})</h3>
      <div class="delivery-list">
        ${mine.length ? mine.map(riderCard).join("") : `<div class="empty-state">No deliveries assigned right now.</div>`}
      </div>
    </div>
  `;

  root.querySelectorAll("[data-pickup]").forEach((btn) => {
    btn.addEventListener("click", async () => {
      try {
        await api(`/deliveries/${btn.dataset.pickup}/status`, { method: "PATCH", body: { new_status: "picked_up" } });
        toast("Marked picked up.");
        renderRider(root);
      } catch (e) {
        toast(e.message, true);
      }
    });
  });

  root.querySelectorAll("[data-scan]").forEach((btn) => btn.addEventListener("click", () => openScanModal(btn.dataset.scan, () => renderRider(root))));
  root.querySelectorAll("[data-history]").forEach((btn) => btn.addEventListener("click", () => openHistoryModal(btn.dataset.history)));
}

function riderCard(d) {
  return `
    <div class="delivery-card">
      <div class="delivery-main">
        <div class="delivery-title">${escapeHtml(d.customer_name)} <span class="status-pill status-${d.status}">${statusLabel(d.status)}</span></div>
        <div class="delivery-sub">${escapeHtml(d.item_description)} — ${escapeHtml(d.address)}</div>
        <div class="delivery-sub">${escapeHtml(d.customer_phone)}</div>
      </div>
      <div class="delivery-actions">
        ${d.status === "assigned" ? `<button class="btn btn-primary btn-sm" data-pickup="${d.id}">Mark Picked Up</button>` : ""}
        ${d.status === "picked_up" ? `<button class="btn btn-primary btn-sm" data-scan="${d.id}">Scan to Confirm Delivery</button>` : ""}
        <button class="btn btn-secondary btn-sm" data-history="${d.id}">History</button>
      </div>
    </div>
  `;
}

// ================= Shared actions =================
async function cancelDelivery(id, after) {
  if (!confirm("Cancel this delivery?")) return;
  try {
    await api(`/deliveries/${id}/status`, { method: "PATCH", body: { new_status: "cancelled" } });
    toast("Delivery cancelled.");
    after();
  } catch (e) {
    toast(e.message, true);
  }
}

// ================= Modals =================
function openModal(html) {
  const backdrop = document.createElement("div");
  backdrop.className = "modal-backdrop";
  backdrop.innerHTML = `<div class="modal">${html}</div>`;
  backdrop.addEventListener("click", (e) => { if (e.target === backdrop) closeModal(backdrop); });
  document.body.appendChild(backdrop);
  return backdrop;
}
function closeModal(backdrop) {
  stopScanner();
  const img = backdrop.querySelector(".qr-img");
  if (img && img.dataset.blobUrl) URL.revokeObjectURL(img.dataset.blobUrl);
  backdrop.remove();
}

async function openQrModal(id) {
  const modal = openModal(`
    <button class="modal-close" data-close>&times;</button>
    <h3>Delivery QR Code</h3>
    <p style="font-size:13px;color:var(--muted)">Show this to the rider at drop-off. It's what turns "delivered" from a claim into proof.</p>
    <img class="qr-img" width="220" height="220" alt="Delivery QR code" />
  `);
  modal.querySelector("[data-close]").addEventListener("click", () => closeModal(modal));

  // A plain <img src> can't carry the Authorization header the API requires,
  // so fetch it authenticated and render the result as a blob URL instead.
  try {
    const res = await fetch(API + `/deliveries/${id}/qrcode.png`, {
      headers: { Authorization: "Bearer " + state.token },
    });
    if (!res.ok) throw new Error("Could not load QR code.");
    const blobUrl = URL.createObjectURL(await res.blob());
    const img = modal.querySelector(".qr-img");
    if (!img) { URL.revokeObjectURL(blobUrl); return; } // modal closed before fetch resolved
    img.src = blobUrl;
    img.dataset.blobUrl = blobUrl;
  } catch (e) {
    toast(e.message, true);
  }
}

async function openHistoryModal(id) {
  const detail = await api(`/deliveries/${id}`).catch((e) => { toast(e.message, true); return null; });
  if (!detail) return;
  const modal = openModal(`
    <button class="modal-close" data-close>&times;</button>
    <h3>Status History</h3>
    ${detail.history.map((h) => `
      <div class="history-item">
        <span>${h.old_status ? statusLabel(h.old_status) + " → " : ""}${statusLabel(h.new_status)}</span>
        <span>${escapeHtml(h.changed_by_name)} · ${fmtTime(h.changed_at)}</span>
      </div>
    `).join("")}
  `);
  modal.querySelector("[data-close]").addEventListener("click", () => closeModal(modal));
}

// ---- QR scan modal (camera via jsQR, with manual fallback) ----
let scanStream = null;
let scanRAF = null;

function openScanModal(deliveryId, after) {
  const modal = openModal(`
    <button class="modal-close" data-close>&times;</button>
    <h3>Scan to Confirm Delivery</h3>
    <video id="scan-video" autoplay playsinline muted></video>
    <canvas id="scan-canvas" class="hidden"></canvas>
    <p id="scan-status" style="font-size:12px;color:var(--muted);margin-top:8px;">Point the camera at the retailer's QR code.</p>
    <div class="scan-manual">
      <label style="font-size:12px;font-weight:600;color:var(--muted);">Camera not working? Enter the code manually:</label>
      <input id="manual-code" placeholder="paste QR token here" />
      <button class="btn btn-primary btn-sm" id="manual-submit">Confirm Delivery</button>
    </div>
  `);
  modal.querySelector("[data-close]").addEventListener("click", () => closeModal(modal));

  document.getElementById("manual-submit").addEventListener("click", async () => {
    const code = document.getElementById("manual-code").value.trim();
    if (!code) return;
    await confirmDelivery(deliveryId, code, modal, after);
  });

  startScanner(deliveryId, modal, after);
}

async function startScanner(deliveryId, modal, after) {
  const video = document.getElementById("scan-video");
  const canvas = document.getElementById("scan-canvas");
  const statusEl = document.getElementById("scan-status");
  const ctx = canvas.getContext("2d");

  try {
    scanStream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: "environment" } });
    video.srcObject = scanStream;

    const tick = () => {
      if (!document.body.contains(video)) return; // modal closed
      if (video.readyState === video.HAVE_ENOUGH_DATA && window.jsQR) {
        canvas.width = video.videoWidth;
        canvas.height = video.videoHeight;
        ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
        const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
        const code = window.jsQR(imageData.data, imageData.width, imageData.height);
        if (code && code.data) {
          statusEl.textContent = "Code detected — confirming…";
          confirmDelivery(deliveryId, code.data, modal, after);
          return;
        }
      }
      scanRAF = requestAnimationFrame(tick);
    };
    scanRAF = requestAnimationFrame(tick);
  } catch (e) {
    statusEl.textContent = "Camera unavailable — use manual entry below.";
  }
}

function stopScanner() {
  if (scanRAF) cancelAnimationFrame(scanRAF);
  scanRAF = null;
  if (scanStream) scanStream.getTracks().forEach((t) => t.stop());
  scanStream = null;
}

async function confirmDelivery(deliveryId, qr_code, modal, after) {
  try {
    await api(`/deliveries/${deliveryId}/scan`, { method: "POST", body: { qr_code } });
    toast("Delivery confirmed.");
    closeModal(modal);
    after();
  } catch (e) {
    toast(e.message, true);
    const statusEl = document.getElementById("scan-status");
    if (statusEl) statusEl.textContent = "That code didn't match — try again.";
  }
}

// ---------- utils ----------
function escapeHtml(str) {
  return String(str).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

// ---------- boot ----------
(function boot() {
  const token = localStorage.getItem("reflex_token");
  const user = localStorage.getItem("reflex_user");
  if (token && user) {
    state.token = token;
    state.user = JSON.parse(user);
    enterApp();
  }
})();
