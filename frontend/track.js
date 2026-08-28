// Public delivery tracking page — no auth, no shared state with app.js
// (this loads standalone on track.html). Polls every 10s rather than
// pushing live updates, same trade-off made everywhere else in this app
// (see the trade-off log): no persistent-connection infrastructure to
// stand up just for this one read-only page.
const API = "/api";

function fmtTime(iso) {
  return new Date(iso).toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
}

function escapeHtml(str) {
  return String(str).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

// The token is the last segment of /track/:token — read from the URL
// itself rather than passed in some other way, so the same static
// track.html works for every delivery without a build step.
function getToken() {
  const parts = window.location.pathname.split("/").filter(Boolean);
  return parts[parts.length - 1] || "";
}

async function loadTracking() {
  const card = document.getElementById("track-card");
  const token = getToken();
  if (!token) {
    card.innerHTML = `<div class="empty-state">No tracking link provided.</div>`;
    return;
  }
  try {
    const res = await fetch(`${API}/track/${encodeURIComponent(token)}`);
    if (res.status === 404) {
      card.innerHTML = `<div class="empty-state">We couldn't find a delivery for this tracking link. Double-check the link your retailer sent you.</div>`;
      return;
    }
    if (!res.ok) throw new Error("Request failed");
    const data = await res.json();
    renderTracking(card, data);
  } catch (e) {
    // Only show the error state on the very first load — a poll tick
    // that fails (e.g. a flaky connection) shouldn't blank out a card
    // that was showing real data a moment ago.
    if (!card.dataset.loaded) {
      card.innerHTML = `<div class="empty-state">Couldn't load tracking info right now — try again in a moment.</div>`;
    }
  }
}

function renderTracking(card, d) {
  card.dataset.loaded = "1";
  card.innerHTML = `
    <div class="track-header">
      <span class="status-pill status-${d.status}">${escapeHtml(d.status_label)}</span>
      <h1 class="track-item">${escapeHtml(d.item_description)}</h1>
      <p class="track-sub">To ${escapeHtml(d.customer_name)} — ${escapeHtml(d.address)}</p>
      <p class="track-sub">From ${escapeHtml(d.retailer_name)}</p>
    </div>
    <div class="track-timeline">
      ${d.history
        .map(
          (h, i) => `
        <div class="track-timeline-step${i === d.history.length - 1 ? " is-current" : ""}">
          <div class="track-timeline-dot"></div>
          <div class="track-timeline-body">
            <div class="track-timeline-label">${escapeHtml(h.status_label)}</div>
            <div class="track-timeline-time">${fmtTime(h.at)}</div>
          </div>
        </div>
      `
        )
        .join("")}
    </div>
  `;
}

loadTracking();
setInterval(loadTracking, 10000);
