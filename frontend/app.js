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

// Disables a button and shows a spinner + label while `fn` is in flight —
// gives real feedback that a click registered (nothing here waits on a
// network round trip silently) and, just as importantly, stops a double
// click from firing the request twice (e.g. two "Assign" calls racing).
async function withLoading(btn, label, fn) {
  if (!btn || btn.disabled) return; // already in flight — this call is a double-click, drop it
  const original = btn.innerHTML;
  btn.disabled = true;
  btn.innerHTML = `<span class="spinner"></span>${escapeHtml(label)}`;
  try {
    return await fn();
  } finally {
    btn.disabled = false;
    btn.innerHTML = original;
  }
}

// ---------- PWA: service worker + install prompt ----------
if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("/sw.js").catch((e) => console.warn("SW registration failed:", e));
  });
}

// No fixed-position button here on purpose — an overlay button was covering
// the topbar's Log out button. Install access instead lives as a normal
// inline link (in the topbar and on the login card, both in normal document
// flow) plus an auto-shown prompt the first time the browser offers it.
let deferredInstallPrompt = null;
const installLinkLogin = document.getElementById("install-link-login");
const installLinkApp = document.getElementById("install-link-app");

window.addEventListener("beforeinstallprompt", (e) => {
  e.preventDefault();
  deferredInstallPrompt = e;
  installLinkLogin.classList.remove("hidden");
  installLinkApp.classList.remove("hidden");
  if (!localStorage.getItem("reflex_install_prompt_dismissed")) {
    openInstallPromptModal();
  }
});

[installLinkLogin, installLinkApp].forEach((btn) => btn.addEventListener("click", () => openInstallPromptModal()));

window.addEventListener("appinstalled", () => {
  installLinkLogin.classList.add("hidden");
  installLinkApp.classList.add("hidden");
  deferredInstallPrompt = null;
});

async function openInstallPromptModal() {
  if (!deferredInstallPrompt) return;
  const modal = openModal(`
    <button class="modal-close" data-close>&times;</button>
    <h3>Install Reflex</h3>
    <p style="font-size:13px;color:var(--muted)">
      Add Reflex to your home screen for quick, app-like access — its own icon, its own window, and it still opens when you're offline.
    </p>
    <div class="form-grid">
      <div class="full"><button class="btn btn-primary" id="install-modal-yes" type="button">Install</button></div>
      <div class="full"><button class="btn btn-secondary" id="install-modal-no" type="button">Not now</button></div>
    </div>
  `);
  const dismiss = () => {
    localStorage.setItem("reflex_install_prompt_dismissed", "1");
    closeModal(modal);
  };
  modal.querySelector("[data-close]").addEventListener("click", dismiss);
  modal.querySelector("#install-modal-no").addEventListener("click", dismiss);
  modal.querySelector("#install-modal-yes").addEventListener("click", async () => {
    closeModal(modal);
    if (!deferredInstallPrompt) return;
    deferredInstallPrompt.prompt();
    await deferredInstallPrompt.userChoice;
    deferredInstallPrompt = null;
  });
}

function toast(msg, isError = false) {
  const el = document.getElementById("toast");
  el.innerHTML = `<span class="toast-icon">${isError ? "⚠️" : "✅"}</span>${escapeHtml(msg)}`;
  el.classList.toggle("error", isError);
  el.classList.remove("hidden");
  clearTimeout(toast._t);
  toast._t = setTimeout(() => el.classList.add("hidden"), 3200);
}

// ---------- Landing page interactivity ----------
// A quick, real proof-of-life for anyone landing on the login screen —
// not a static claim, an actual call to /api/health.
(async function checkSystemHealth() {
  const dot = document.getElementById("hero-status-dot");
  const text = document.getElementById("hero-status-text");
  if (!dot || !text) return;
  try {
    const res = await fetch(API + "/health");
    if (!res.ok) throw new Error();
    dot.classList.add("status-dot-ok");
    text.textContent = "All systems live";
  } catch (e) {
    dot.classList.add("status-dot-bad");
    text.textContent = "Having trouble reaching the server";
  }
})();

const EMAIL_CHECK_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function wireEmailCheck(inputId, checkId) {
  const input = document.getElementById(inputId);
  const check = document.getElementById(checkId);
  if (!input || !check) return;
  const update = (showInvalid) => {
    const val = input.value.trim();
    check.classList.remove("valid", "invalid");
    if (!val) { check.textContent = ""; return; }
    if (EMAIL_CHECK_RE.test(val)) {
      check.textContent = "✓";
      check.classList.add("valid");
    } else if (showInvalid) {
      check.textContent = "✕";
      check.classList.add("invalid");
    } else {
      check.textContent = "";
    }
  };
  input.addEventListener("input", () => update(false)); // don't scold mid-typing
  input.addEventListener("blur", () => update(true)); // but do flag it once they've moved on
}
wireEmailCheck("login-email", "login-email-check");
wireEmailCheck("register-email", "register-email-check");

(function wirePasswordStrength() {
  const input = document.getElementById("register-password");
  const bar = document.querySelector("#password-strength .password-strength-bar");
  if (!input || !bar) return;
  input.addEventListener("input", () => {
    const val = input.value;
    bar.classList.remove("weak", "medium", "strong");
    if (!val) { bar.style.width = "0"; return; }
    let score = 0;
    if (val.length >= 6) score++;
    if (val.length >= 10) score++;
    if (/[0-9]/.test(val) && /[a-zA-Z]/.test(val)) score++;
    if (/[^a-zA-Z0-9]/.test(val)) score++;
    bar.classList.add(score <= 1 ? "weak" : score <= 2 ? "medium" : "strong");
  });
})();

// ---------- Auth ----------
document.getElementById("login-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const email = document.getElementById("login-email").value.trim();
  const password = document.getElementById("login-password").value;
  const btn = e.target.querySelector('button[type="submit"]');
  await withLoading(btn, "Logging in…", () => doLogin(email, password));
});

document.querySelectorAll(".demo-btn").forEach((btn) => {
  btn.addEventListener("click", () => withLoading(btn, "Logging in…", () => doLogin(btn.dataset.email, btn.dataset.pass)));
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

// ---------- "How it works" guide ----------
document.getElementById("guide-link").addEventListener("click", openGuideModal);

function openGuideModal() {
  const steps = [
    { icon: "📝", role: "Retailer", title: "Log a delivery", desc: "A shop owner logs what's going out, to whom, and where — takes seconds, no paperwork." },
    { icon: "🧭", role: "Dispatcher", title: "Assign a rider", desc: "The dispatch desk sees every open request and hands it to whoever's free." },
    { icon: "🛵", role: "Rider", title: "Pick it up", desc: "The rider taps \"Mark Picked Up\" the moment they've physically got the item." },
    { icon: "✅", role: "Rider + Retailer", title: "Scan to confirm", desc: "Delivery isn't \"done\" until the rider scans the retailer's QR code — proof, not just a claim." },
  ];

  const modal = openModal(`
    <button class="modal-close" data-close>&times;</button>
    <h3>How Reflex works</h3>
    <p class="guide-intro">Think of it as a relay race — one delivery, three people, everyone accountable for their leg of it.</p>
    <div class="guide-steps">
      ${steps.map((s) => `
        <div class="guide-step">
          <div class="guide-step-icon">${s.icon}</div>
          <div class="guide-step-body">
            <div class="guide-step-title">${escapeHtml(s.title)}<span class="guide-step-role">${escapeHtml(s.role)}</span></div>
            <div class="guide-step-desc">${escapeHtml(s.desc)}</div>
          </div>
        </div>
      `).join("")}
    </div>
    <div class="guide-tip">
      💡 <strong>Try it live:</strong> pick a demo account below, then open this same site in an incognito
      window (or another tab) and log in as a different role. Watch one delivery move through the whole
      relay in real time — that's the actual point of this prototype.
    </div>
    <button class="btn btn-primary guide-close-btn" id="guide-got-it" type="button">Got it, let's go!</button>
  `);
  modal.querySelector("[data-close]").addEventListener("click", () => closeModal(modal));
  modal.querySelector("#guide-got-it").addEventListener("click", () => closeModal(modal));
}

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
  const btn = e.target.querySelector('button[type="submit"]');
  await withLoading(btn, "Creating account…", async () => {
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
  if (state.user.role === "admin") return renderAdmin(root);
}

// Restarts the CSS fade-in animation on every re-render (forcing a reflow
// between removing and re-adding the class) so each poll refresh reads as
// "new content just arrived" rather than an abrupt content swap.
function setViewHTML(root, html) {
  root.innerHTML = html;
  root.classList.remove("view-fade-in");
  void root.offsetWidth;
  root.classList.add("view-fade-in");
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

  setViewHTML(root, `
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
        <div class="full">
          <label>Photo (optional)</label>
          <div class="image-picker">
            <img id="product-image-preview" class="image-preview hidden" alt="" />
            <input type="file" name="imageFile" id="product-image-input" accept="image/*" />
          </div>
        </div>
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
  `);

  let pendingProductImage = null;
  const imageInput = document.getElementById("product-image-input");
  const imagePreview = document.getElementById("product-image-preview");
  if (imageInput) {
    imageInput.addEventListener("change", async () => {
      const file = imageInput.files[0];
      if (!file) return;
      try {
        pendingProductImage = await compressImageToDataUrl(file);
        imagePreview.src = pendingProductImage;
        imagePreview.classList.remove("hidden");
      } catch (e) {
        toast("Couldn't read that image — try a different file.", true);
        imageInput.value = "";
      }
    });
  }

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
    const btn = e.target.querySelector('button[type="submit"]');
    await withLoading(btn, "Logging…", async () => {
      try {
        await api("/deliveries", { method: "POST", body: Object.fromEntries(fd) });
        toast("Delivery logged.");
        renderRetailer(root);
      } catch (err) {
        toast(err.message, true);
      }
    });
  });

  document.getElementById("new-product-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const fd = new FormData(e.target);
    const body = Object.fromEntries(fd);
    delete body.imageFile;
    if (!body.price) delete body.price;
    if (!body.description) delete body.description;
    if (pendingProductImage) body.image = pendingProductImage;
    const btn = e.target.querySelector('button[type="submit"]');
    await withLoading(btn, "Adding…", async () => {
      try {
        await api("/products", { method: "POST", body });
        toast("Product added.");
        renderRetailer(root);
      } catch (err) {
        toast(err.message, true);
      }
    });
  });

  root.querySelectorAll("[data-qr]").forEach((btn) => btn.addEventListener("click", () => openQrModal(btn.dataset.qr)));
  root.querySelectorAll("[data-history]").forEach((btn) => btn.addEventListener("click", () => openHistoryModal(btn.dataset.history)));
  root.querySelectorAll("[data-cancel]").forEach((btn) =>
    btn.addEventListener("click", () => cancelDelivery(btn, btn.dataset.cancel, () => renderRetailer(root)))
  );
  root.querySelectorAll("[data-remove-product]").forEach((btn) =>
    btn.addEventListener("click", () => removeProduct(btn, btn.dataset.removeProduct, () => renderRetailer(root)))
  );
}

function productCard(p) {
  const thumb = p.image
    ? `<img class="product-thumb" src="${p.image}" alt="${escapeHtml(p.name)}" />`
    : `<div class="product-thumb product-thumb-placeholder">${escapeHtml((p.name || "?")[0].toUpperCase())}</div>`;
  return `
    <div class="delivery-card">
      ${thumb}
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

// Resizes+recompresses an image client-side before it's stored as a data
// URL in the product record (the store is a JSON/Redis blob, not a file
// bucket, so keeping payloads small matters). Caps the longest edge at
// 480px and re-encodes as JPEG.
function compressImageToDataUrl(file, maxDim = 480, quality = 0.72) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error);
    reader.onload = () => {
      const img = new Image();
      img.onerror = () => reject(new Error("Invalid image file."));
      img.onload = () => {
        const scale = Math.min(1, maxDim / Math.max(img.width, img.height));
        const canvas = document.createElement("canvas");
        canvas.width = Math.round(img.width * scale);
        canvas.height = Math.round(img.height * scale);
        const ctx = canvas.getContext("2d");
        ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
        resolve(canvas.toDataURL("image/jpeg", quality));
      };
      img.src = reader.result;
    };
    reader.readAsDataURL(file);
  });
}

async function removeProduct(btn, id, after) {
  if (!confirm("Remove this product from your catalog?")) return;
  await withLoading(btn, "Removing…", async () => {
    try {
      await api(`/products/${id}`, { method: "DELETE" });
      toast("Product removed.");
      after();
    } catch (e) {
      toast(e.message, true);
    }
  });
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

  setViewHTML(root, `
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
  `);

  root.querySelectorAll("[data-assign-btn]").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const id = btn.dataset.assignBtn;
      const select = root.querySelector(`select[data-assign-select="${id}"]`);
      const rider_id = select.value;
      if (!rider_id) return toast("Pick a rider first.", true);
      await withLoading(btn, "Assigning…", async () => {
        try {
          await api(`/deliveries/${id}/assign`, { method: "PATCH", body: { rider_id } });
          toast("Rider assigned.");
          renderDispatcher(root);
        } catch (e) {
          toast(e.message, true);
        }
      });
    });
  });

  root.querySelectorAll("[data-history]").forEach((btn) => btn.addEventListener("click", () => openHistoryModal(btn.dataset.history)));
  root.querySelectorAll("[data-cancel]").forEach((btn) =>
    btn.addEventListener("click", () => cancelDelivery(btn, btn.dataset.cancel, () => renderDispatcher(root)))
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

  setViewHTML(root, `
    <h2>Rider — Your Deliveries</h2>
    <p class="subtitle">Update status as you go. Delivery is confirmed by scanning the retailer's QR code.</p>

    <div class="panel">
      <h3>Assigned to you (${mine.length})</h3>
      <div class="delivery-list">
        ${mine.length ? mine.map(riderCard).join("") : `<div class="empty-state">No deliveries assigned right now.</div>`}
      </div>
    </div>
  `);

  root.querySelectorAll("[data-pickup]").forEach((btn) => {
    btn.addEventListener("click", () => withLoading(btn, "Updating…", async () => {
      try {
        await api(`/deliveries/${btn.dataset.pickup}/status`, { method: "PATCH", body: { new_status: "picked_up" } });
        toast("Marked picked up.");
        renderRider(root);
      } catch (e) {
        toast(e.message, true);
      }
    }));
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

// ================= ADMIN =================
// Oversight only — a way to verify the whole system is actually healthy
// (every user, every delivery, every product across every retailer), not
// an operational dashboard. Read access to everything; the only writes it
// can make are the dispatcher-equivalent assign/cancel overrides the
// backend already grants this role.
async function renderAdmin(root) {
  const [health, users, deliveries, products] = await Promise.all([
    api("/health").catch(() => null),
    api("/users").catch((e) => { toast(e.message, true); return []; }),
    api("/deliveries").catch((e) => { toast(e.message, true); return []; }),
    api("/products").catch((e) => { toast(e.message, true); return []; }),
  ]);

  const usersById = Object.fromEntries(users.map((u) => [u.id, u]));
  const byRole = countBy(users, (u) => u.role);
  const byStatus = countBy(deliveries, (d) => d.status);

  setViewHTML(root, `
    <h2>Admin — System Overview</h2>
    <p class="subtitle">Read-only view across every retailer, rider, and dispatcher — for verifying the prototype is actually working, not day-to-day operations.</p>

    <div class="panel">
      <h3>At a glance</h3>
      <div class="stat-grid">
        ${statCard("API", health ? "Healthy" : "Unreachable", health ? "ok" : "bad")}
        ${statCard("Uptime", health ? fmtUptime(health.uptime) : "—")}
        ${statCard("Users", users.length, null, `${byRole.retailer || 0} retailer · ${byRole.dispatcher || 0} dispatcher · ${byRole.rider || 0} rider`)}
        ${statCard("Deliveries", deliveries.length, null, `${byStatus.requested || 0} open · ${byStatus.delivered || 0} delivered`)}
        ${statCard("Products", products.length)}
        ${statCard("Cancelled", byStatus.cancelled || 0)}
      </div>
    </div>

    <div class="panel">
      <h3>All deliveries (${deliveries.length})</h3>
      <div class="delivery-list">
        ${deliveries.length ? deliveries.slice().sort((a, b) => new Date(b.created_at) - new Date(a.created_at)).map((d) => adminDeliveryCard(d, usersById)).join("") : `<div class="empty-state">No deliveries in the system yet.</div>`}
      </div>
    </div>

    <div class="panel">
      <h3>All users (${users.length})</h3>
      <div class="table-scroll">
        <table class="data-table">
          <thead><tr><th>Name</th><th>Email</th><th>Phone</th><th>Role</th><th>Joined</th></tr></thead>
          <tbody>
            ${users.map((u) => `
              <tr>
                <td>${escapeHtml(u.name)}</td>
                <td>${escapeHtml(u.email || "—")}</td>
                <td>${escapeHtml(u.phone || "—")}</td>
                <td><span class="role-pill role-${u.role}">${u.role}</span></td>
                <td>${fmtTime(u.created_at)}</td>
              </tr>
            `).join("")}
          </tbody>
        </table>
      </div>
    </div>

    <div class="panel">
      <h3>All products (${products.length})</h3>
      <div class="delivery-list">
        ${products.length ? products.map((p) => adminProductCard(p, usersById)).join("") : `<div class="empty-state">No products in the system yet.</div>`}
      </div>
    </div>
  `);

  root.querySelectorAll("[data-history]").forEach((btn) => btn.addEventListener("click", () => openHistoryModal(btn.dataset.history)));
  root.querySelectorAll("[data-qr]").forEach((btn) => btn.addEventListener("click", () => openQrModal(btn.dataset.qr)));
}

function adminDeliveryCard(d, usersById) {
  const retailerName = (usersById[d.retailer_id] || {}).name || `retailer #${d.retailer_id}`;
  const riderName = d.rider_id ? (usersById[d.rider_id] || {}).name || `rider #${d.rider_id}` : null;
  return `
    <div class="delivery-card">
      <div class="delivery-main">
        <div class="delivery-title">${escapeHtml(d.customer_name)} <span class="status-pill status-${d.status}">${statusLabel(d.status)}</span></div>
        <div class="delivery-sub">${escapeHtml(d.item_description)} — ${escapeHtml(d.address)}</div>
        <div class="delivery-sub">Retailer: ${escapeHtml(retailerName)}${riderName ? ` · Rider: ${escapeHtml(riderName)}` : ""}</div>
      </div>
      <div class="delivery-actions">
        ${d.status !== "delivered" && d.status !== "cancelled" ? `<button class="btn btn-secondary btn-sm" data-qr="${d.id}">Show QR</button>` : ""}
        <button class="btn btn-secondary btn-sm" data-history="${d.id}">History</button>
      </div>
    </div>
  `;
}

function adminProductCard(p, usersById) {
  const retailerName = (usersById[p.retailer_id] || {}).name || `retailer #${p.retailer_id}`;
  const thumb = p.image
    ? `<img class="product-thumb" src="${p.image}" alt="${escapeHtml(p.name)}" />`
    : `<div class="product-thumb product-thumb-placeholder">${escapeHtml((p.name || "?")[0].toUpperCase())}</div>`;
  return `
    <div class="delivery-card">
      ${thumb}
      <div class="delivery-main">
        <div class="delivery-title">${escapeHtml(p.name)}${p.price != null ? `<span class="price-tag">KSh ${p.price}</span>` : ""}</div>
        <div class="delivery-sub">${escapeHtml(retailerName)}${p.description ? ` — ${escapeHtml(p.description)}` : ""}</div>
      </div>
    </div>
  `;
}

function statCard(label, value, tone, sub) {
  return `
    <div class="stat-card${tone ? ` stat-${tone}` : ""}">
      <div class="stat-value">${escapeHtml(String(value))}</div>
      <div class="stat-label">${escapeHtml(label)}</div>
      ${sub ? `<div class="stat-sub">${escapeHtml(sub)}</div>` : ""}
    </div>
  `;
}

function countBy(items, keyFn) {
  return items.reduce((acc, item) => {
    const k = keyFn(item);
    acc[k] = (acc[k] || 0) + 1;
    return acc;
  }, {});
}

function fmtUptime(seconds) {
  const m = Math.floor(seconds / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  return `${h}h ${m % 60}m`;
}

// ================= Shared actions =================
async function cancelDelivery(btn, id, after) {
  if (!confirm("Cancel this delivery?")) return;
  await withLoading(btn, "Cancelling…", async () => {
    try {
      await api(`/deliveries/${id}/status`, { method: "PATCH", body: { new_status: "cancelled" } });
      toast("Delivery cancelled.");
      after();
    } catch (e) {
      toast(e.message, true);
    }
  });
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

  const manualBtn = document.getElementById("manual-submit");
  manualBtn.addEventListener("click", () => {
    const code = document.getElementById("manual-code").value.trim();
    if (!code) return;
    withLoading(manualBtn, "Confirming…", () => confirmDelivery(deliveryId, code, modal, after));
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
