const dbState = {
  settings: {},
  derived: {},
  ratings: [],
  feedback: [],
  reviewEvents: [],
  postedReviews: [],
  scans: [],
  qrCodes: [],
};

const elements = {
  menuButtons: document.querySelectorAll(".menu-item"),
  views: document.querySelectorAll(".dashboard-view"),
  pageTitle: document.querySelector("#pageTitle"),
  sidebar: document.querySelector("#sidebar"),
  mobileMenuButton: document.querySelector("#mobileMenuButton"),
  connectionBadge: document.querySelector("#connectionBadge"),
  feedbackCountBadge: document.querySelector("#feedbackCountBadge"),
  refreshDataButton: document.querySelector("#refreshDataButton"),
  totalScans: document.querySelector("#totalScans"),
  avgRating: document.querySelector("#avgRating"),
  totalRatingsCount: document.querySelector("#totalRatingsCount"),
  reviewClicks: document.querySelector("#reviewClicks"),
  conversionPercentage: document.querySelector("#conversionPercentage"),
  negativeFeedback: document.querySelector("#negativeFeedback"),
  negativePercentage: document.querySelector("#negativePercentage"),
  ratingsTable: document.querySelector("#ratingsTable"),
  dynamicQrUrl: document.querySelector("#dynamicQrUrl"),
  copyQrButton: document.querySelector("#copyQrButton"),
  openQrLink: document.querySelector("#openQrLink"),
  feedbackSearch: document.querySelector("#feedbackSearch"),
  feedbackCardsList: document.querySelector("#feedbackCardsList"),
  qrCodesRegistryTable: document.querySelector("#qrCodesRegistryTable"),
  createQrForm: document.querySelector("#createQrForm"),
  qrCreationStatus: document.querySelector("#qrCreationStatus"),
  reviewEventsList: document.querySelector("#reviewEventsList"),
  settingsForm: document.querySelector("#settingsForm"),
  dashboardStatus: document.querySelector("#dashboardStatus"),
  sidebarBusinessName: document.querySelector("#sidebarBusinessName"),
};

const fields = {
  APP_BUSINESS_NAME: document.querySelector("#businessNameInput"),
  APP_BASE_URL: document.querySelector("#baseUrlInput"),
  BUSINESS_ID: document.querySelector("#businessIdInput"),
  BRANCH_ID: document.querySelector("#branchIdInput"),
  BRANCH_NAME: document.querySelector("#branchNameInput"),
  QR_CODE_ID: document.querySelector("#qrCodeInput"),
  QR_CODE_LABEL: document.querySelector("#qrLabelInput"),
  GOOGLE_PLACE_ID: document.querySelector("#placeIdInput"),
  REVIEW_SYSTEM_PROMPT: document.querySelector("#systemPromptInput"),
  REVIEW_TOPICS: document.querySelector("#reviewTopicsInput"),
  FEEDBACK_TOPICS: document.querySelector("#feedbackTopicsInput"),
  OPENROUTER_MODEL: document.querySelector("#openRouterModelInput"),
  AI_TONE: document.querySelector("#aiToneSelector"),
  AI_LENGTH: document.querySelector("#aiLengthSelector"),
};

document.addEventListener("DOMContentLoaded", () => {
  setupNavigation();
  setupEvents();
  loadDashboardData();
});

function setupNavigation() {
  elements.menuButtons.forEach((button) => {
    button.addEventListener("click", () => {
      const page = button.dataset.page;
      elements.menuButtons.forEach((item) => item.classList.toggle("is-active", item === button));
      elements.views.forEach((view) => view.classList.toggle("is-active", view.id === `view-${page}`));
      elements.pageTitle.textContent = getPageTitle(page);
      elements.sidebar.classList.remove("is-open");
    });
  });

  elements.mobileMenuButton.addEventListener("click", () => {
    elements.sidebar.classList.toggle("is-open");
  });
}

function setupEvents() {
  elements.refreshDataButton.addEventListener("click", loadDashboardData);
  elements.copyQrButton.addEventListener("click", () => copyText(elements.dynamicQrUrl.value));
  elements.feedbackSearch.addEventListener("input", renderFeedbackInbox);
  elements.createQrForm.addEventListener("submit", createQrCode);
  elements.settingsForm.addEventListener("submit", saveSettings);
}

function getPageTitle(page) {
  return {
    overview: "Overview",
    feedback: "Feedback Inbox",
    qrcodes: "QR Links",
    reviews: "Review Events",
    settings: "Settings",
  }[page] || "Dashboard";
}

async function loadDashboardData() {
  setConnectionStatus("connecting", "Connecting");
  try {
    const [settingsResponse, dataResponse] = await Promise.all([
      fetch("/api/dashboard/settings"),
      fetch("/api/dashboard/data"),
    ]);
    const settingsData = await settingsResponse.json();
    const dashboardData = await dataResponse.json();

    if (!settingsResponse.ok) throw new Error(settingsData.error || "Settings API failed.");
    if (!dataResponse.ok) throw new Error(dashboardData.error || "Dashboard data API failed.");

    Object.assign(dbState, {
      settings: settingsData.settings || {},
      derived: settingsData.derived || {},
      ratings: dashboardData.ratings || [],
      feedback: dashboardData.feedback || [],
      reviewEvents: dashboardData.reviewEvents || [],
      postedReviews: dashboardData.postedReviews || [],
      scans: dashboardData.scans || [],
      qrCodes: dashboardData.qrCodes || [],
    });

    const firebaseStatus = dbState.derived.firebaseStatus || "not_configured";
    if (firebaseStatus === "connected") {
      setConnectionStatus("live", "Firestore live");
    } else if (firebaseStatus === "fallback") {
      setConnectionStatus("demo", "Local fallback");
      setFormStatus(dbState.derived.firebaseError || "Firestore unavailable, using local fallback.", true);
    } else {
      setConnectionStatus("demo", "Local only");
    }
    syncDataToViews();
  } catch (error) {
    setConnectionStatus("demo", "Needs Node server");
    setFormStatus(error.message, true);
  }
}

function syncDataToViews() {
  renderOverview();
  renderRatingsTable();
  renderFeedbackInbox();
  renderQrRegistry();
  renderReviewEvents();
  syncSettingsFormValues();
  applyClientMode();
}

function renderOverview() {
  const ratings = dbState.ratings.filter((item) => Number(item.rating) >= 1 && Number(item.rating) <= 5);
  const positives = ratings.filter((item) => Number(item.rating) >= 4);
  const negatives = ratings.filter((item) => Number(item.rating) <= 3);
  const googleClicks = dbState.reviewEvents.filter((item) => item.type === "google_review_clicked" || item.reviewText);
  const pendingFeedback = dbState.feedback.filter((item) => item.status !== "resolved");
  const average = ratings.length
    ? ratings.reduce((sum, item) => sum + Number(item.rating || 0), 0) / ratings.length
    : 0;
  const conversion = positives.length ? Math.round((googleClicks.length / positives.length) * 100) : 0;

  elements.totalScans.textContent = dbState.scans.length.toLocaleString();
  elements.avgRating.textContent = average ? average.toFixed(1) : "0.0";
  elements.totalRatingsCount.textContent = `${ratings.length} ratings logged`;
  elements.reviewClicks.textContent = googleClicks.length.toLocaleString();
  elements.conversionPercentage.textContent = `${conversion}% of positive ratings`;
  elements.negativeFeedback.textContent = dbState.feedback.length.toLocaleString();
  elements.negativePercentage.textContent = `${negatives.length} low ratings routed privately`;
  elements.feedbackCountBadge.textContent = pendingFeedback.length;
  elements.feedbackCountBadge.hidden = pendingFeedback.length === 0;
  elements.sidebarBusinessName.textContent = dbState.settings.APP_BUSINESS_NAME || "Dashboard";

  const qrUrl = dbState.derived.dynamicQrUrl || dbState.derived.localDynamicQrUrl || "";
  elements.dynamicQrUrl.value = qrUrl;
  elements.openQrLink.href = qrUrl || "/";

  prefillQrForm();
  renderRatingDistribution(ratings);
}

function renderRatingDistribution(ratings) {
  const max = ratings.length || 1;
  for (let star = 1; star <= 5; star++) {
    const count = ratings.filter((r) => Number(r.rating) === star).length;
    const pct = Math.round((count / max) * 100);
    const fill = document.getElementById(`dist${star}`);
    const counter = document.getElementById(`distCount${star}`);
    if (fill) fill.style.width = `${pct}%`;
    if (counter) counter.textContent = count;
  }
}

function renderRatingsTable() {
  const latest = [...dbState.ratings]
    .filter((item) => Number(item.rating) >= 1 && Number(item.rating) <= 5)
    .sort(sortNewestFirst)
    .slice(0, 8);
  if (!latest.length) {
    elements.ratingsTable.innerHTML = `<tr><td colspan="3" class="table-empty">No ratings yet.</td></tr>`;
    return;
  }

  elements.ratingsTable.innerHTML = latest
    .map((item) => `
      <tr>
        <td><strong>${escapeHtml(item.rating || "-")} star</strong></td>
        <td>
          <strong>${escapeHtml(item.qrLabel || item.qrCodeId || "-")}</strong>
          <span class="table-subtle">${escapeHtml([item.branchName, item.source || item.campaign].filter(Boolean).join(" / "))}</span>
        </td>
        <td>${formatDate(item.createdAt)}</td>
      </tr>
    `)
    .join("");
}

function renderFeedbackInbox() {
  const query = elements.feedbackSearch.value.trim().toLowerCase();
  const feedback = [...dbState.feedback].sort(sortNewestFirst).filter((item) => {
    const searchable = [
      item.name,
      item.phone,
      item.message,
      item.qrCodeId,
      item.qrLabel,
      item.branchName,
      item.source,
      item.campaign,
      ...(item.issues || []),
    ].join(" ").toLowerCase();
    return !query || searchable.includes(query);
  });

  if (!feedback.length) {
    elements.feedbackCardsList.innerHTML = `
      <div class="empty-state">
        <h3>No private feedback found</h3>
        <p>Customers who rate 1-3 stars will appear here instead of being pushed to Google.</p>
      </div>
    `;
    return;
  }

  elements.feedbackCardsList.innerHTML = feedback
    .map((item) => `
      <article class="feedback-card">
        <div class="feedback-card-header">
          <div class="customer-info">
            <h4>${escapeHtml(item.name || "Anonymous customer")}</h4>
            <div class="contact">${escapeHtml(item.phone || "No phone")} - ${formatDate(item.createdAt)}</div>
            <div class="contact">${escapeHtml([item.qrLabel || item.qrCodeId, item.branchName, item.source || item.campaign].filter(Boolean).join(" / ") || "No QR context")}</div>
          </div>
          <div class="card-meta-tags">
            <span class="badge ${Number(item.rating) === 3 ? "badge-warning" : "badge-danger"}">${escapeHtml(item.rating || "-")} star</span>
            <span class="badge ${item.status === "resolved" ? "badge-success" : "badge-danger"}">${item.status === "resolved" ? "Resolved" : "Pending"}</span>
          </div>
        </div>
        <div class="feedback-body">
          <p>${escapeHtml(item.message || "No message provided.")}</p>
          <div class="issues-tags">
            ${(item.issues || []).map((issue) => `<span class="issue-tag">${escapeHtml(issue)}</span>`).join("")}
          </div>
        </div>
        <div class="feedback-actions">
          ${item.status === "resolved"
            ? `<span class="trend-up">Resolved: ${escapeHtml(item.resolutionNotes || "No note")}</span>`
            : `<button class="primary-button" data-resolve="${escapeHtml(item.id || "")}" type="button">Resolve</button>`}
        </div>
      </article>
    `)
    .join("");

  elements.feedbackCardsList.querySelectorAll("[data-resolve]").forEach((button) => {
    button.addEventListener("click", () => resolveFeedback(button.dataset.resolve));
  });
}

function renderQrRegistry() {
  const activeQrCodes = dbState.qrCodes.filter((qr) => qr.status !== "deleted");
  if (!activeQrCodes.length) {
    elements.qrCodesRegistryTable.innerHTML = `<tr><td colspan="6" class="table-empty">No QR links yet.</td></tr>`;
    return;
  }

  elements.qrCodesRegistryTable.innerHTML = activeQrCodes
    .map((qr) => {
      const url = getQrUrl(qr.qrCodeId);
      return `
        <tr>
          <td><code>/r/${escapeHtml(qr.qrCodeId)}</code></td>
          <td>${escapeHtml(qr.label || qr.qrCodeId)}</td>
          <td>${escapeHtml(qr.branchName || "Main")}</td>
          <td>${escapeHtml(qr.source || qr.campaign || qr.staff || "General")}</td>
          <td><span class="badge badge-info">${Number(qr.scanCount || 0)} scans</span></td>
          <td>
            <button class="qr-download-btn" data-copy="${escapeHtml(url)}" type="button">Copy URL</button>
            <button class="qr-delete-btn" data-delete="${escapeHtml(qr.qrCodeId)}" type="button">Delete</button>
          </td>
        </tr>
      `;
    })
    .join("");

  elements.qrCodesRegistryTable.querySelectorAll("[data-copy]").forEach((button) => {
    button.addEventListener("click", () => copyText(button.dataset.copy));
  });
  elements.qrCodesRegistryTable.querySelectorAll("[data-delete]").forEach((button) => {
    button.addEventListener("click", () => deleteQrCode(button.dataset.delete));
  });
}

function renderReviewEvents() {
  const events = [...dbState.reviewEvents].sort(sortNewestFirst);
  const posted = [...dbState.postedReviews].sort(sortNewestFirst);
  const merged = [
    ...events.map((item) => ({ ...item, label: "Review action clicked" })),
    ...posted.map((item) => ({ ...item, label: "Marked as posted" })),
  ].sort((a, b) => new Date(b.createdAt || 0) - new Date(a.createdAt || 0));

  if (!merged.length) {
    elements.reviewEventsList.innerHTML = `
      <div class="empty-state">
        <h3>No review events yet</h3>
        <p>Generated reviews are not stored. Only customer review actions are saved here.</p>
      </div>
    `;
    return;
  }

  elements.reviewEventsList.innerHTML = merged
    .map((item) => `
      <article class="feedback-card">
        <div class="feedback-card-header">
          <div class="customer-info">
            <h4>${escapeHtml(item.label)}</h4>
            <div class="contact">${escapeHtml(item.qrLabel || item.qrCodeId || "-")} - ${formatDate(item.createdAt)}</div>
            <div class="contact">${escapeHtml([item.branchName, item.source || item.campaign].filter(Boolean).join(" / "))}</div>
          </div>
          <span class="badge badge-success">${escapeHtml(item.rating || "-")} star</span>
        </div>
        <div class="feedback-body">
          <p>${escapeHtml(item.reviewText || "No review text stored for this action.")}</p>
        </div>
      </article>
    `)
    .join("");
}

function syncSettingsFormValues() {
  Object.entries(fields).forEach(([key, field]) => {
    if (!field) return;
    field.value = key === "REVIEW_TOPICS" || key === "FEEDBACK_TOPICS"
      ? csvToLines(dbState.settings[key] || "")
      : dbState.settings[key] || "";
  });
}

function applyClientMode() {
  const isClient = Boolean(dbState.derived.clientMode);
  const form = elements.settingsForm;
  if (!form) return;

  // Toggle disabled state on all inputs, selects, and textareas
  form.querySelectorAll("input, select, textarea").forEach((el) => {
    el.disabled = isClient;
  });

  // Show/hide the save button and client notice
  const saveBtn = form.querySelector(".save-settings-btn");
  let notice = form.querySelector(".client-mode-notice");

  if (isClient) {
    if (saveBtn) saveBtn.style.display = "none";
    if (!notice) {
      notice = document.createElement("p");
      notice.className = "client-mode-notice";
      notice.textContent = "\u{1F512} Settings are managed by your account administrator and cannot be edited here.";
      const footer = form.querySelector(".settings-actions-footer");
      if (footer) footer.prepend(notice);
    }
  } else {
    if (saveBtn) saveBtn.style.display = "";
    if (notice) notice.remove();
  }
}

async function saveSettings(event) {
  event.preventDefault();
  setFormStatus("Saving settings...");

  const settings = Object.fromEntries(
    Object.entries(fields).map(([key, field]) => [
      key,
      key === "REVIEW_TOPICS" || key === "FEEDBACK_TOPICS" ? linesToCsv(field.value) : field.value.trim(),
    ]),
  );

  try {
    const response = await fetch("/api/dashboard/settings", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ settings }),
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || "Could not save settings.");

    dbState.settings = data.settings || settings;
    dbState.derived = data.derived || dbState.derived;
    syncDataToViews();
    setFormStatus("Settings saved.");
  } catch (error) {
    setFormStatus(error.message, true);
  }
}

function prefillQrForm() {
  const idField = document.querySelector("#regQrId");
  const labelField = document.querySelector("#regQrLabel");
  const branchField = document.querySelector("#regBranchName");
  // Only prefill if the user hasn't typed anything yet
  if (idField && !idField.value) {
    idField.value = dbState.settings.QR_CODE_ID || "";
  }
  if (labelField && !labelField.value) {
    labelField.value = dbState.settings.QR_CODE_LABEL || "";
  }
  if (branchField && !branchField.value) {
    branchField.value = dbState.settings.BRANCH_NAME || "";
  }
}

async function createQrCode(event) {
  event.preventDefault();
  elements.qrCreationStatus.textContent = "Creating tracker...";
  elements.qrCreationStatus.classList.remove("is-error");

  const branchName = document.querySelector("#regBranchName").value.trim() || "Main";
  const payload = {
    qrCodeId: document.querySelector("#regQrId").value.trim(),
    label: document.querySelector("#regQrLabel").value.trim(),
    branchName,
    branchId: slugify(branchName),
    source: document.querySelector("#regStaff").value.trim(),
  };

  try {
    const response = await fetch("/api/dashboard/qrcodes", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || "Could not create QR tracker.");

    event.currentTarget.reset();
    elements.qrCreationStatus.textContent = "Tracker created.";
    await loadDashboardData();
  } catch (error) {
    elements.qrCreationStatus.textContent = error.message;
    elements.qrCreationStatus.classList.add("is-error");
  }
}

async function resolveFeedback(id) {
  if (!id) return;
  const notes = window.prompt("Resolution note");
  if (notes === null) return;

  try {
    const response = await fetch("/api/dashboard/feedback/resolve", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id, notes }),
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || "Could not resolve feedback.");
    await loadDashboardData();
  } catch (error) {
    setFormStatus(error.message, true);
  }
}

async function deleteQrCode(qrCodeId) {
  if (!qrCodeId || !window.confirm(`Delete /r/${qrCodeId}?`)) return;
  try {
    const response = await fetch(`/api/dashboard/qrcodes/${encodeURIComponent(qrCodeId)}`, {
      method: "DELETE",
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || "Could not delete QR tracker.");
    await loadDashboardData();
  } catch (error) {
    setFormStatus(error.message, true);
  }
}

async function copyText(value) {
  if (!value) return;
  try {
    await navigator.clipboard.writeText(value);
    setFormStatus("Copied.");
  } catch {
    setFormStatus("Could not access clipboard.", true);
  }
}

function setConnectionStatus(type, text) {
  elements.connectionBadge.className = `connection-status badge is-${type}`;
  elements.connectionBadge.querySelector(".status-text").textContent = text;
}

function setFormStatus(message, isError = false) {
  if (!elements.dashboardStatus) return;
  elements.dashboardStatus.textContent = message;
  elements.dashboardStatus.style.color = isError ? "var(--danger)" : "var(--success)";
  window.clearTimeout(setFormStatus.timer);
  setFormStatus.timer = window.setTimeout(() => {
    elements.dashboardStatus.textContent = "";
  }, 3500);
}

function formatDate(value) {
  if (!value) return "-";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "-";
  return date.toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
}

function sortNewestFirst(a, b) {
  return new Date(b.createdAt || 0) - new Date(a.createdAt || 0);
}

function getQrUrl(qrCodeId) {
  const baseUrl = (dbState.settings.APP_BASE_URL || window.location.origin).replace(/\/$/, "");
  return `${baseUrl}/r/${encodeURIComponent(qrCodeId)}`;
}

function csvToLines(value) {
  return String(value || "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean)
    .join("\n");
}

function linesToCsv(value) {
  return String(value || "")
    .split(/[\n,]/)
    .map((item) => item.trim())
    .filter(Boolean)
    .join(",");
}

function slugify(value) {
  return String(value || "main")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}

function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
