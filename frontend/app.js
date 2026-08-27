const API = "/api";
let state = {
  token: null,
  user: null,
  pollTimer: null,
  // Per-role search/status filter state for the dispatcher and rider
  // delivery lists — kept here (not in the DOM) so it survives the
  // full-innerHTML re-render every poll tick without losing what the
  // user typed.
  filters: {
    dispatcher: { search: "", status: "" },
    rider: { search: "", status: "" },
  },
  // Per-role snapshot of {id -> status} from the last render, used to
  // detect and toast what changed since the previous poll tick.
  snapshots: { dispatcher: null, rider: null },
};

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

// ---------- Offline queue (IndexedDB) ----------
// Lets the retailer log a delivery or add a product while offline instead
// of just failing — the request is saved locally and replayed once the
// connection is back, so the "install as an app" pitch holds up even with
// a flaky connection, not just when the wifi's good. Scoped to the
// currently logged-in user (userId on every record) so a shared/demo
// browser switching between retailer accounts never replays one
// retailer's queued items under another's token.
const OFFLINE_DB_NAME = "reflex-offline";
const OFFLINE_STORE = "queue";

function openOfflineDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(OFFLINE_DB_NAME, 1);
    req.onupgradeneeded = () => {
      req.result.createObjectStore(OFFLINE_STORE, { keyPath: "id", autoIncrement: true });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function queueOfflineRequest(path, body) {
  const db = await openOfflineDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(OFFLINE_STORE, "readwrite");
    tx.objectStore(OFFLINE_STORE).add({ path, body, userId: state.user.id, queuedAt: new Date().toISOString() });
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

async function getQueuedRequests() {
  if (!state.user) return [];
  const db = await openOfflineDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(OFFLINE_STORE, "readonly");
    const req = tx.objectStore(OFFLINE_STORE).getAll();
    req.onsuccess = () => resolve((req.result || []).filter((item) => item.userId === state.user.id));
    req.onerror = () => reject(req.error);
  });
}

async function removeQueuedRequest(id) {
  const db = await openOfflineDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(OFFLINE_STORE, "readwrite");
    tx.objectStore(OFFLINE_STORE).delete(id);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

let offlineFlushInFlight = false;
// Replays queued requests in the order they were made (not in parallel —
// a queued product should exist before a queued delivery that references
// it by name gets replayed). Stops at the first failure and leaves the
// rest queued rather than guessing whether it's still offline or a real
// validation error; either way the next trigger (another 'online' event,
// or the next time the retailer view loads) tries again from the front.
async function flushOfflineQueue() {
  if (offlineFlushInFlight || !state.token || !window.indexedDB) return;
  offlineFlushInFlight = true;
  try {
    const items = await getQueuedRequests().catch(() => []);
    if (!items.length) return;
    let synced = 0;
    for (const item of items) {
      try {
        await api(item.path, { method: "POST", body: item.body });
        await removeQueuedRequest(item.id);
        synced++;
      } catch (e) {
        break;
      }
    }
    if (synced > 0) {
      toast(`Synced ${synced} queued item${synced === 1 ? "" : "s"} from earlier.`);
      if (state.user && state.user.role === "retailer") render({ skeleton: false });
    }
  } finally {
    offlineFlushInFlight = false;
  }
}

window.addEventListener("online", flushOfflineQueue);

// Tries a POST normally; if the browser is (or turns out to be) offline,
// queues it instead of losing what was typed. `navigator.onLine` is
// checked upfront to skip a doomed request outright when it's already
// known, but it isn't fully reliable (some setups report "online" without
// real connectivity), so a TypeError from fetch() itself — as opposed to
// an Error the server deliberately returned for a validation failure — is
// treated as the authoritative "actually offline" signal. Returns "sent"
// or "queued" so the caller can decide how to update the view: a full
// re-render makes sense after a real POST, but re-fetching the delivery
// and product lists right after finding out we're offline would just
// fail the same way and bury the "saved for later" toast under a raw
// fetch-error one.
async function submitOrQueue(path, body, { successMsg, offlineMsg }) {
  if (!navigator.onLine) {
    await queueOfflineRequest(path, body);
    toast(offlineMsg);
    return "queued";
  }
  try {
    await api(path, { method: "POST", body });
    toast(successMsg);
    return "sent";
  } catch (err) {
    if (err instanceof TypeError) {
      await queueOfflineRequest(path, body);
      toast(offlineMsg);
      return "queued";
    }
    throw err;
  }
}

// Patches just the pending-sync badge in place from IndexedDB (no network
// call), used after queueing something while offline so the retailer sees
// the count update without the rest of the view flickering through an
// empty state while it waits on a fetch that's guaranteed to fail.
async function refreshPendingBadge(root) {
  const queued = await getQueuedRequests().catch(() => []);
  const actions = root.querySelector(".view-heading-actions");
  if (!actions) return;
  let badge = actions.querySelector(".pending-badge");
  if (queued.length) {
    if (!badge) {
      badge = document.createElement("span");
      badge.className = "pending-badge";
      badge.title = "Will send automatically once you're back online";
      actions.insertBefore(badge, actions.firstChild);
    }
    badge.textContent = `⏳ ${queued.length} pending sync`;
  } else if (badge) {
    badge.remove();
  }
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

// Wires an event listener only if the element actually exists, instead of
// throwing and halting every top-level statement after it. That halt is
// the real failure mode this guards against: a stale service-worker-cached
// page whose HTML doesn't match the freshly-fetched app.js (or vice versa)
// after a deploy — one missing #id here would otherwise silently break
// every feature wired up *after* it in this file, including login and the
// delivery form, even though neither is actually the broken part.
function on(id, event, handler) {
  const el = document.getElementById(id);
  if (!el) {
    console.warn(`Reflex: #${id} not found — skipping its setup. If this persists, hard-refresh (the cached page may be out of sync with the app).`);
    return null;
  }
  el.addEventListener(event, handler);
  return el;
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
const installLinks = [installLinkLogin, installLinkApp].filter(Boolean);

window.addEventListener("beforeinstallprompt", (e) => {
  e.preventDefault();
  deferredInstallPrompt = e;
  installLinks.forEach((btn) => btn.classList.remove("hidden"));
  if (!localStorage.getItem("reflex_install_prompt_dismissed")) {
    openInstallPromptModal();
  }
});

installLinks.forEach((btn) => btn.addEventListener("click", () => openInstallPromptModal()));

window.addEventListener("appinstalled", () => {
  installLinks.forEach((btn) => btn.classList.add("hidden"));
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
on("login-form", "submit", async (e) => {
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
    if (!input) return;
    const showing = input.type === "text";
    input.type = showing ? "password" : "text";
    btn.textContent = showing ? "👁" : "🙈";
    btn.setAttribute("aria-label", showing ? "Show password" : "Hide password");
  });
});

// ---------- "How it works" guide ----------
on("guide-link", "click", openGuideModal);

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
on("show-register-btn", "click", () => setAuthMode("register"));
on("show-login-btn", "click", () => setAuthMode("login"));

function setAuthMode(mode) {
  const isRegister = mode === "register";
  const toggle = (id, hidden) => document.getElementById(id)?.classList.toggle("hidden", hidden);
  toggle("login-form", isRegister);
  toggle("register-form", !isRegister);
  toggle("switch-to-register", isRegister);
  toggle("switch-to-login", !isRegister);
  toggle("demo-accounts", isRegister);
  const tagline = document.getElementById("auth-tagline");
  if (tagline) tagline.textContent = isRegister ? "Create your account" : "Delivery coordination for Kenyan retailers";
  const loginErr = document.getElementById("login-error");
  if (loginErr) loginErr.textContent = "";
  const registerErr = document.getElementById("register-error");
  if (registerErr) registerErr.textContent = "";
}

on("register-form", "submit", async (e) => {
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

on("logout-btn", "click", () => {
  clearInterval(state.pollTimer);
  state = { token: null, user: null, pollTimer: null };
  localStorage.removeItem("reflex_token");
  localStorage.removeItem("reflex_user");
  document.getElementById("app-screen")?.classList.add("hidden");
  document.getElementById("login-screen")?.classList.remove("hidden");
});

function enterApp() {
  document.getElementById("login-screen")?.classList.add("hidden");
  document.getElementById("app-screen")?.classList.remove("hidden");
  const whoName = document.getElementById("who-name");
  if (whoName) whoName.textContent = state.user.name;
  const whoRole = document.getElementById("who-role");
  if (whoRole) whoRole.textContent = state.user.role;
  // Fresh per-session: without this, logging out and back in as a
  // different dispatcher/rider would diff against the previous user's
  // last-seen statuses and fire bogus "changed" toasts on first render.
  state.filters = { dispatcher: { search: "", status: "" }, rider: { search: "", status: "" } };
  state.snapshots = { dispatcher: null, rider: null };
  render();
  // Catches items queued in a previous session that ended while still
  // offline (tab closed, app killed) — by the time this login happens,
  // connectivity may already be back with no 'online' event left to fire.
  flushOfflineQueue();
  clearInterval(state.pollTimer);
  // Polling refresh — see trade-off log: simplest way to keep views current
  // without building websocket infrastructure in a one-week sprint. Not for
  // the retailer, though: their view is a multi-field form (customer name,
  // phone, address, item description) that takes more than 5s to fill out
  // for a real person, and a poll tick does a full re-render — replacing
  // the form's HTML mid-type, wiping whatever they'd typed, and silently
  // detaching the submit button they'd meant to click. That's exactly what
  // "nothing happens when I try to log a delivery" looks like from the
  // outside. The retailer view already re-renders after every action it
  // takes (create/cancel/add product), so it doesn't go stale — it just
  // doesn't yank itself out from under someone mid-form. A manual refresh
  // button covers the rest.
  if (state.user.role !== "retailer") {
    // skeleton:false — a skeleton flashing over live data every 5s would
    // be more distracting than the brief blank moment it's meant to fix;
    // it's only useful for the "nothing on screen yet" case below.
    state.pollTimer = setInterval(() => render({ skeleton: false }), 5000);
  }
}

// ---------- Router by role ----------
function render(opts = {}) {
  const root = document.getElementById("view-root");
  if (!root) return console.warn("Reflex: #view-root not found — hard-refresh to fix.");
  if (opts.skeleton !== false) showSkeleton(root, state.user.role);
  if (state.user.role === "retailer") return renderRetailer(root);
  if (state.user.role === "dispatcher") return renderDispatcher(root);
  if (state.user.role === "rider") return renderRider(root);
  if (state.user.role === "admin") return renderAdmin(root);
}

// Shimmer placeholder shown the moment a role's view starts loading (first
// render after login, or a manual full re-render), so switching views reads
// as "content is arriving" instead of a blank panel for however long the
// fetch takes. Shaped roughly like each role's real layout so the swap-in
// doesn't jump around. Not used on poll ticks — see the setInterval call
// above.
function showSkeleton(root, role) {
  const line = (cls) => `<div class="skeleton-line ${cls}"></div>`;
  const cards = (n) => Array.from({ length: n }, () => `<div class="skeleton-card"></div>`).join("");
  const statRow = `<div class="stat-grid">${Array.from({ length: 3 }, () => `<div class="skeleton-stat"></div>`).join("")}</div>`;
  const panel = (bodyHtml) => `<div class="panel skeleton-panel">${line("skeleton-line-title")}${bodyHtml}</div>`;

  let body = "";
  if (role === "retailer") {
    body = panel(statRow) + panel(cards(1)) + panel(cards(3)) + panel(cards(3));
  } else if (role === "dispatcher") {
    body = panel(cards(2)) + panel(cards(2));
  } else if (role === "rider") {
    body = panel(cards(2));
  } else if (role === "admin") {
    body = panel(statRow) + panel(cards(3));
  }

  root.innerHTML = `${line("skeleton-line-heading")}${line("skeleton-line-subtitle")}${body}`;
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

// Retailer "at a glance" stats — computed client-side from the deliveries
// already fetched for the view, so no extra API calls. avgDeliveryMs uses
// updated_at on delivered deliveries as a stand-in for "when it was marked
// delivered" (updated_at is bumped on every status change, so for a
// delivery currently sitting at status "delivered" it's exactly that).
function computeRetailerStats(deliveries) {
  const sevenDaysAgo = Date.now() - 7 * 24 * 60 * 60 * 1000;
  const last7Days = deliveries.filter((d) => new Date(d.created_at).getTime() >= sevenDaysAgo).length;

  const delivered = deliveries.filter((d) => d.status === "delivered");
  const avgDeliveryMs = delivered.length
    ? delivered.reduce((sum, d) => sum + (new Date(d.updated_at) - new Date(d.created_at)), 0) / delivered.length
    : null;

  const cancelled = deliveries.filter((d) => d.status === "cancelled").length;
  const cancelRate = deliveries.length ? Math.round((cancelled / deliveries.length) * 100) : 0;

  return { last7Days, avgDeliveryMs, deliveredCount: delivered.length, cancelRate };
}

function fmtDuration(ms) {
  if (ms == null) return "—";
  const mins = Math.round(ms / 60000);
  if (mins < 60) return `${mins}m`;
  const hrs = mins / 60;
  if (hrs < 24) return `${hrs.toFixed(1)}h`;
  return `${(hrs / 24).toFixed(1)}d`;
}

// Shared by the dispatcher and rider list filter bars: a text match on
// customer name/address, AND'd with an exact status match if one is set.
function filterDeliveries(items, filters) {
  const q = (filters.search || "").trim().toLowerCase();
  return items.filter((d) => {
    if (filters.status && d.status !== filters.status) return false;
    if (!q) return true;
    return (d.customer_name || "").toLowerCase().includes(q) || (d.address || "").toLowerCase().includes(q);
  });
}

// Compares this render's fetched deliveries against what was seen last
// poll tick for this role, toasting whatever changed — a delivery
// entering this role's view for the first time, or an existing one
// moving to a new status — so the 5s auto-refresh reads as "live"
// instead of a silent list swap. Silently updates the snapshot without
// toasting on the very first render for a role (nothing to diff against
// yet) or when `silent` is set (used right after the viewer's own
// action, which already shows its own confirmation toast — diffing
// there would just repeat it).
function diffAndToastChanges(role, items, { silent = false } = {}) {
  const prev = state.snapshots[role];
  if (prev && !silent) {
    for (const d of items) {
      if (!prev.has(d.id)) {
        toast(`New delivery: ${d.customer_name}`);
      } else if (prev.get(d.id) !== d.status) {
        toast(`${d.customer_name} → ${statusLabel(d.status)}`);
      }
    }
  }
  state.snapshots[role] = new Map(items.map((d) => [d.id, d.status]));
}

// ================= RETAILER =================
async function renderRetailer(root) {
  const [deliveries, products, queued] = await Promise.all([
    api("/deliveries").catch((e) => { toast(e.message, true); return []; }),
    api("/products").catch((e) => { toast(e.message, true); return []; }),
    getQueuedRequests().catch(() => []),
  ]);
  // Opportunistic: covers the case where connectivity came back without a
  // reliable 'online' event (some browsers/OSes are inconsistent about
  // firing it). Runs in the background — doesn't block this render.
  flushOfflineQueue();

  const stats = computeRetailerStats(deliveries);

  setViewHTML(root, `
    <div class="retailer-view">
    <div class="view-heading-row">
      <div><h2>Retailer — Log &amp; Track Deliveries</h2>
      <p class="subtitle">Every delivery you log, and where it stands right now.</p></div>
      <div class="view-heading-actions">
        ${queued.length ? `<span class="pending-badge" title="Will send automatically once you're back online">⏳ ${queued.length} pending sync</span>` : ""}
        <button class="btn btn-secondary btn-sm" id="retailer-refresh" type="button">🔄 Refresh</button>
      </div>
    </div>

    <div class="panel">
      <h3>📊 At a glance</h3>
      <div class="stat-grid">
        ${statCard("Last 7 days", stats.last7Days, null, "deliveries logged")}
        ${statCard("Avg. delivery time", fmtDuration(stats.avgDeliveryMs), null, stats.deliveredCount ? `across ${stats.deliveredCount} delivered` : "no deliveries yet")}
        ${statCard("Cancellation rate", `${stats.cancelRate}%`, stats.cancelRate > 20 ? "bad" : null, `${deliveries.length} total logged`)}
      </div>
    </div>

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
      <div class="product-panel-head">
        <h3>🛍️ Your catalog (${products.length})</h3>
        <p class="subtitle">What you sell — pick any of these when logging a delivery above.</p>
      </div>
      <details class="add-product-toggle">
        <summary class="btn btn-secondary btn-sm">+ Add a product</summary>
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
          <div class="full"><button class="btn btn-primary" type="submit">Add product</button></div>
        </form>
      </details>
      <div class="product-grid">
        ${products.length ? products.map(productCard).join("") : `<div class="empty-state">No products yet — add what you sell above.</div>`}
      </div>
    </div>

    <div class="panel">
      <h3>Your deliveries (${deliveries.length})</h3>
      <div class="delivery-list">
        ${deliveries.length ? deliveries.map(retailerCard).join("") : `<div class="empty-state">No deliveries logged yet.</div>`}
      </div>
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
        const result = await submitOrQueue("/deliveries", Object.fromEntries(fd), {
          successMsg: "Delivery logged.",
          offlineMsg: "You're offline — this delivery will send automatically once you're back online.",
        });
        if (result === "sent") {
          renderRetailer(root);
        } else {
          e.target.reset();
          refreshPendingBadge(root);
        }
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
        const result = await submitOrQueue("/products", body, {
          successMsg: "Product added.",
          offlineMsg: "You're offline — this product will be added automatically once you're back online.",
        });
        if (result === "sent") {
          renderRetailer(root);
        } else {
          e.target.reset();
          pendingProductImage = null;
          imagePreview?.classList.add("hidden");
          refreshPendingBadge(root);
        }
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

  document.getElementById("retailer-refresh")?.addEventListener("click", (e) => {
    withLoading(e.currentTarget, "Refreshing…", async () => {
      renderRetailer(root);
    });
  });
}

function productCard(p) {
  const thumb = p.image
    ? `<img class="product-card-img" src="${p.image}" alt="${escapeHtml(p.name)}" />`
    : `<div class="product-card-img product-card-img-placeholder">${escapeHtml((p.name || "?")[0].toUpperCase())}</div>`;
  return `
    <div class="product-card">
      ${thumb}
      <div class="product-card-body">
        <div class="product-card-name">${escapeHtml(p.name)}</div>
        ${p.price != null ? `<div class="product-card-price">KSh ${p.price}</div>` : ""}
        ${p.description ? `<div class="product-card-desc">${escapeHtml(p.description)}</div>` : ""}
      </div>
      <button class="btn btn-danger btn-sm product-card-remove" data-remove-product="${p.id}">Remove</button>
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
async function renderDispatcher(root, opts = {}) {
  const [open, riders] = await Promise.all([
    api("/deliveries?status=requested").catch(() => []),
    api("/users?role=rider").catch(() => []),
  ]);
  const inFlight = await api("/deliveries").then((all) => all.filter((d) => ["assigned", "picked_up"].includes(d.status))).catch(() => []);

  diffAndToastChanges("dispatcher", [...open, ...inFlight], opts);

  const filters = state.filters.dispatcher;
  const searchHadFocus = document.activeElement && document.activeElement.id === "dispatcher-search";
  const caret = searchHadFocus ? document.activeElement.selectionStart : null;

  setViewHTML(root, `
    <h2>Dispatcher — Assign Riders</h2>
    <p class="subtitle">Open requests waiting for a rider, and everything currently out for delivery.</p>

    <div class="filter-bar">
      <input type="search" id="dispatcher-search" placeholder="Search customer or address…" value="${escapeHtml(filters.search)}" />
      <select id="dispatcher-status-filter">
        <option value="">All statuses</option>
        <option value="requested" ${filters.status === "requested" ? "selected" : ""}>Requested</option>
        <option value="assigned" ${filters.status === "assigned" ? "selected" : ""}>Assigned</option>
        <option value="picked_up" ${filters.status === "picked_up" ? "selected" : ""}>Picked up</option>
      </select>
    </div>

    <div class="panel">
      <h3>Open requests (${open.length})</h3>
      <div class="delivery-list" id="dispatcher-open-list"></div>
    </div>

    <div class="panel">
      <h3>In flight (${inFlight.length})</h3>
      <div class="delivery-list" id="dispatcher-inflight-list"></div>
    </div>
  `);

  function wireOpenList() {
    root.querySelectorAll("#dispatcher-open-list [data-assign-btn]").forEach((btn) => {
      btn.addEventListener("click", async () => {
        const id = btn.dataset.assignBtn;
        const select = root.querySelector(`select[data-assign-select="${id}"]`);
        const rider_id = select.value;
        if (!rider_id) return toast("Pick a rider first.", true);
        await withLoading(btn, "Assigning…", async () => {
          try {
            await api(`/deliveries/${id}/assign`, { method: "PATCH", body: { rider_id } });
            toast("Rider assigned.");
            renderDispatcher(root, { silent: true });
          } catch (e) {
            toast(e.message, true);
          }
        });
      });
    });
    root.querySelectorAll("#dispatcher-open-list [data-cancel]").forEach((btn) =>
      btn.addEventListener("click", () => cancelDelivery(btn, btn.dataset.cancel, () => renderDispatcher(root, { silent: true })))
    );
  }

  function wireInFlightList() {
    root.querySelectorAll("#dispatcher-inflight-list [data-history]").forEach((btn) => btn.addEventListener("click", () => openHistoryModal(btn.dataset.history)));
  }

  function renderLists() {
    const filteredOpen = filterDeliveries(open, filters);
    const filteredInFlight = filterDeliveries(inFlight, filters);
    const isFiltering = filters.search || filters.status;

    document.getElementById("dispatcher-open-list").innerHTML = filteredOpen.length
      ? filteredOpen.map((d) => dispatcherCard(d, riders)).join("")
      : `<div class="empty-state">${isFiltering ? "No open requests match your search." : "No open requests right now."}</div>`;
    wireOpenList();

    document.getElementById("dispatcher-inflight-list").innerHTML = filteredInFlight.length
      ? filteredInFlight.map(inFlightCard).join("")
      : `<div class="empty-state">${isFiltering ? "Nothing in flight matches your search." : "Nothing currently assigned."}</div>`;
    wireInFlightList();
  }

  renderLists();

  const searchInput = document.getElementById("dispatcher-search");
  const statusSelect = document.getElementById("dispatcher-status-filter");
  searchInput.addEventListener("input", () => {
    filters.search = searchInput.value;
    renderLists();
  });
  statusSelect.addEventListener("change", () => {
    filters.status = statusSelect.value;
    renderLists();
  });

  if (searchHadFocus) {
    searchInput.focus();
    if (caret != null) searchInput.setSelectionRange(caret, caret);
  }
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
async function renderRider(root, opts = {}) {
  const mine = await api("/deliveries?rider_id=me").then((all) => all.filter((d) => ["assigned", "picked_up"].includes(d.status))).catch(() => []);

  diffAndToastChanges("rider", mine, opts);

  const filters = state.filters.rider;
  const searchHadFocus = document.activeElement && document.activeElement.id === "rider-search";
  const caret = searchHadFocus ? document.activeElement.selectionStart : null;

  setViewHTML(root, `
    <h2>Rider — Your Deliveries</h2>
    <p class="subtitle">Update status as you go. Delivery is confirmed by scanning the retailer's QR code.</p>

    <div class="filter-bar">
      <input type="search" id="rider-search" placeholder="Search customer or address…" value="${escapeHtml(filters.search)}" />
      <select id="rider-status-filter">
        <option value="">All statuses</option>
        <option value="assigned" ${filters.status === "assigned" ? "selected" : ""}>Assigned</option>
        <option value="picked_up" ${filters.status === "picked_up" ? "selected" : ""}>Picked up</option>
      </select>
    </div>

    <div class="panel">
      <h3>Assigned to you (${mine.length})</h3>
      <div class="delivery-list" id="rider-list"></div>
    </div>
  `);

  function wireList() {
    root.querySelectorAll("#rider-list [data-pickup]").forEach((btn) => {
      btn.addEventListener("click", () => withLoading(btn, "Updating…", async () => {
        try {
          await api(`/deliveries/${btn.dataset.pickup}/status`, { method: "PATCH", body: { new_status: "picked_up" } });
          toast("Marked picked up.");
          renderRider(root, { silent: true });
        } catch (e) {
          toast(e.message, true);
        }
      }));
    });
    root.querySelectorAll("#rider-list [data-scan]").forEach((btn) => btn.addEventListener("click", () => openScanModal(btn.dataset.scan, () => renderRider(root, { silent: true }))));
    root.querySelectorAll("#rider-list [data-history]").forEach((btn) => btn.addEventListener("click", () => openHistoryModal(btn.dataset.history)));
  }

  function renderList() {
    const filtered = filterDeliveries(mine, filters);
    const isFiltering = filters.search || filters.status;
    document.getElementById("rider-list").innerHTML = filtered.length
      ? filtered.map(riderCard).join("")
      : `<div class="empty-state">${isFiltering ? "No deliveries match your search." : "No deliveries assigned right now."}</div>`;
    wireList();
  }

  renderList();

  const searchInput = document.getElementById("rider-search");
  const statusSelect = document.getElementById("rider-status-filter");
  searchInput.addEventListener("input", () => {
    filters.search = searchInput.value;
    renderList();
  });
  statusSelect.addEventListener("change", () => {
    filters.status = statusSelect.value;
    renderList();
  });

  if (searchHadFocus) {
    searchInput.focus();
    if (caret != null) searchInput.setSelectionRange(caret, caret);
  }
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
  // Feature-detected, not just hidden by CSS: most desktop browsers don't
  // implement the Web Share API at all, so the button is left out of the
  // markup entirely on those rather than rendered disabled/dead.
  const canShare = typeof navigator.share === "function";
  const modal = openModal(`
    <button class="modal-close" data-close>&times;</button>
    <h3>Delivery QR Code</h3>
    <p style="font-size:13px;color:var(--muted)">Show this to the rider at drop-off. It's what turns "delivered" from a claim into proof.</p>
    <img class="qr-img" width="220" height="220" alt="Delivery QR code" />
    ${canShare ? `<button class="btn btn-secondary qr-share-btn" id="qr-share-btn" type="button" disabled>📤 Share</button>` : ""}
  `);
  modal.querySelector("[data-close]").addEventListener("click", () => closeModal(modal));

  // A plain <img src> can't carry the Authorization header the API requires,
  // so fetch it authenticated and render the result as a blob URL instead.
  try {
    const res = await fetch(API + `/deliveries/${id}/qrcode.png`, {
      headers: { Authorization: "Bearer " + state.token },
    });
    if (!res.ok) throw new Error("Could not load QR code.");
    const blob = await res.blob();
    const blobUrl = URL.createObjectURL(blob);
    const img = modal.querySelector(".qr-img");
    if (!img) { URL.revokeObjectURL(blobUrl); return; } // modal closed before fetch resolved
    img.src = blobUrl;
    img.dataset.blobUrl = blobUrl;

    const shareBtn = modal.querySelector("#qr-share-btn");
    if (shareBtn) {
      shareBtn.disabled = false;
      shareBtn.addEventListener("click", () => shareQrCode(blob, id, shareBtn));
    }
  } catch (e) {
    toast(e.message, true);
  }
}

// Shares the QR code straight to whatever the OS share sheet offers
// (WhatsApp, SMS, AirDrop, etc.) instead of making the retailer save the
// image and attach it manually. Falls back to a text-only share if the
// browser supports navigator.share but not sharing files (canShare with
// files is the newer, less universally-supported half of the API).
async function shareQrCode(blob, deliveryId, btn) {
  await withLoading(btn, "Sharing…", async () => {
    try {
      const file = new File([blob], `reflex-delivery-${deliveryId}-qr.png`, { type: blob.type || "image/png" });
      const shareData = (navigator.canShare && navigator.canShare({ files: [file] }))
        ? { files: [file], title: "Reflex delivery QR code", text: "Scan this to confirm the delivery." }
        : { title: "Reflex delivery QR code", text: "Scan this to confirm the delivery." };
      await navigator.share(shareData);
    } catch (e) {
      if (e.name !== "AbortError") toast("Couldn't share — try saving the image instead.", true); // AbortError = user just closed the share sheet, not a real failure
    }
  });
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
