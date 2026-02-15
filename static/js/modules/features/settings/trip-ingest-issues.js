/**
 * TripIngestIssues - User-facing view of fetch/validation/processing issues.
 */
import apiClient from "../../core/api-client.js";
import confirmationDialog from "../../ui/confirmation-dialog.js";
import notificationManager from "../../ui/notifications.js";

function escapeHtml(value) {
  const str = String(value ?? "");
  return str
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function formatLocal(value) {
  if (!value) {
    return "";
  }
  try {
    const dt = new Date(value);
    if (Number.isNaN(dt.getTime())) {
      return String(value);
    }
    return dt.toLocaleString();
  } catch {
    return String(value);
  }
}

function formatLocalDate(value) {
  if (!value) {
    return "";
  }
  try {
    const dt = new Date(value);
    if (Number.isNaN(dt.getTime())) {
      return String(value);
    }
    return dt.toLocaleDateString();
  } catch {
    return String(value);
  }
}

function typeLabel(type) {
  switch (String(type || "").toLowerCase()) {
    case "fetch_error":
      return "Fetch";
    case "validation_failed":
      return "Validation";
    case "process_error":
      return "Processing";
    default:
      return String(type || "Unknown");
  }
}

function typeBadgeClass(type) {
  switch (String(type || "").toLowerCase()) {
    case "fetch_error":
      return "trip-issue-badge trip-issue-badge--fetch";
    case "validation_failed":
      return "trip-issue-badge trip-issue-badge--validation";
    case "process_error":
      return "trip-issue-badge trip-issue-badge--process";
    default:
      return "trip-issue-badge";
  }
}

function normalizeSourceLabel(source, urlHost = "") {
  const src = String(source || "")
    .trim()
    .toLowerCase();
  const host = String(urlHost || "")
    .trim()
    .toLowerCase();
  if (src === "bouncie" || host.includes("bouncie")) {
    return "Bouncie";
  }
  if (src) {
    return src;
  }
  return "the trip provider";
}

function parseHttpishError(message) {
  const text = String(message ?? "").trim();
  if (!text) {
    return null;
  }

  const statusMatch =
    text.match(/(?:^|\b)(\d{3})(?=\s*,\s*message=)/i) || text.match(/^(\d{3})\b/);
  const msgMatch = text.match(/message=['"]([^'"]+)['"]/i);
  const urlMatch =
    text.match(/\burl=(?:URL\()?['"]([^'"]+)['"]\)?/i) ||
    text.match(/\burl=['"]([^'"]+)['"]/i);

  const status = statusMatch ? Number(statusMatch[1]) : null;
  const statusText = msgMatch?.[1] ? String(msgMatch[1]) : null;
  const url = urlMatch?.[1] ? String(urlMatch[1]) : null;
  let host = null;
  if (url) {
    try {
      host = new URL(url).hostname;
    } catch {
      host = null;
    }
  }

  if (!status && !statusText && !url) {
    return null;
  }

  return { status, statusText, url, host };
}

function extractWindowInfo(details, fallbackUrl) {
  const out = {
    windowIndex: null,
    startIso: null,
    endIso: null,
  };

  if (details && typeof details === "object") {
    const idx = Number(details.window_index ?? details.windowIndex);
    out.windowIndex = Number.isFinite(idx) ? idx : null;
    out.startIso =
      details.window_start ?? details.windowStart ?? details.start_iso ?? null;
    out.endIso = details.window_end ?? details.windowEnd ?? details.end_iso ?? null;
  }

  if (!out.startIso && fallbackUrl) {
    try {
      const u = new URL(fallbackUrl);
      out.startIso = u.searchParams.get("starts-after");
      out.endIso = u.searchParams.get("ends-before");
    } catch {
      // ignore
    }
  }

  return out;
}

function formatWindowRangeText(windowInfo) {
  if (!windowInfo) {
    return "";
  }
  const start = windowInfo.startIso ? formatLocalDate(windowInfo.startIso) : "";
  const end = windowInfo.endIso ? formatLocalDate(windowInfo.endIso) : "";
  if (start && end) {
    return `${start} to ${end}`;
  }
  if (start) {
    return `starting ${start}`;
  }
  if (end) {
    return `ending ${end}`;
  }
  return "";
}

function buildFriendlyIssueCopy(issue, httpInfo, windowInfo) {
  const issueType = String(issue?.issue_type || "").toLowerCase();
  const provider = normalizeSourceLabel(issue?.source, httpInfo?.host);
  const windowText = formatWindowRangeText(windowInfo);
  const windowClause = windowText ? ` for ${windowText}` : "";

  const status = httpInfo?.status;

  if (issueType === "fetch_error") {
    if (status && status >= 500) {
      return {
        title: `Could not download trips from ${provider}.`,
        body: `${provider} had a server problem (error code ${status})${windowClause}.`,
        hint: "This is usually temporary. Try again later.",
      };
    }

    if (status === 401 || status === 403) {
      return {
        title: `Could not download trips from ${provider}.`,
        body: `${provider} rejected the request (error code ${status})${windowClause}.`,
        hint: "Your connection may need to be re-authorized.",
      };
    }

    if (status === 429) {
      return {
        title: `Could not download trips from ${provider}.`,
        body: `${provider} is rate limiting requests right now (error code ${status})${windowClause}.`,
        hint: "Try again later.",
      };
    }

    if (status) {
      return {
        title: `Could not download trips from ${provider}.`,
        body: `${provider} returned an error (error code ${status})${windowClause}.`,
        hint: 'Open "More info" for the technical details.',
      };
    }

    const raw = String(issue?.message || "").trim();
    const rawLower = raw.toLowerCase();
    if (rawLower.includes("timeout") || rawLower.includes("timed out")) {
      return {
        title: `Could not download trips from ${provider}.`,
        body: `The request timed out${windowClause}.`,
        hint: "Try again later.",
      };
    }
    if (
      rawLower.includes("cannot connect") ||
      rawLower.includes("connection") ||
      rawLower.includes("network")
    ) {
      return {
        title: `Could not download trips from ${provider}.`,
        body: `We could not connect to ${provider}${windowClause}.`,
        hint: "Try again later.",
      };
    }

    return {
      title: `Could not download trips from ${provider}.`,
      body: `Something went wrong while contacting ${provider}${windowClause}.`,
      hint: 'Open "More info" for the technical details.',
    };
  }

  if (issueType === "validation_failed") {
    const reason = issue?.details?.reason ?? issue?.message;
    const reasonText = String(reason || "").trim();
    if (reasonText.toLowerCase().includes("missing endtime")) {
      return {
        title: "Trip data was incomplete, so it was skipped.",
        body: `${provider} did not provide a trip end time, so we cannot store it as a completed trip.`,
        hint: "This comes from the data source, not your settings.",
      };
    }
    return {
      title: "Trip data did not pass validation, so it was skipped.",
      body: reasonText
        ? `Reason: ${reasonText}.`
        : "A required field was missing or invalid.",
      hint: 'Open "More info" for the technical details.',
    };
  }

  if (issueType === "process_error") {
    return {
      title: "Trip data was downloaded, but processing failed.",
      body: "We hit an error while saving or processing this trip data.",
      hint: 'Open "More info" for the technical details.',
    };
  }

  return {
    title: "Trip sync issue",
    body: "Something went wrong while fetching or processing trip data.",
    hint: 'Open "More info" for the technical details.',
  };
}

function buildTechnicalLines(issue, httpInfo, windowInfo) {
  const lines = [];
  const provider = normalizeSourceLabel(issue?.source, httpInfo?.host);

  lines.push(`Source: ${provider}`);
  if (issue?.imei) {
    lines.push(`Device (IMEI): ${issue.imei}`);
  }
  if (issue?.transaction_id) {
    lines.push(`Trip (transaction ID): ${issue.transaction_id}`);
  }

  const windowText = formatWindowRangeText(windowInfo);
  if (windowText) {
    lines.push(`Time window: ${windowText}`);
  }
  if (windowInfo?.windowIndex) {
    lines.push(`Window index: ${windowInfo.windowIndex}`);
  }

  if (httpInfo?.status || httpInfo?.statusText) {
    const status = httpInfo.status ? String(httpInfo.status) : "";
    const statusText = httpInfo.statusText ? String(httpInfo.statusText) : "";
    lines.push(
      `Provider response: ${status}${status && statusText ? " " : ""}${statusText}`.trim()
    );
  }
  if (httpInfo?.url) {
    lines.push(`Request URL: ${httpInfo.url}`);
  }

  if (issue?.details && typeof issue.details === "object") {
    if (issue.details.reason != null) {
      lines.push(`Details reason: ${String(issue.details.reason)}`);
    }
    if (issue.details.error != null) {
      lines.push(`Details error: ${String(issue.details.error)}`);
    }
  }

  const raw = String(issue?.message || "").trim();
  if (raw) {
    lines.push(`Raw error: ${raw}`);
  }

  return lines;
}

export class TripIngestIssues {
  constructor() {
    this.tableBody = document.querySelector("#tripIngestIssuesTable tbody");
    this.paginationContainer = document.getElementById("tripIngestIssuesPagination");

    this.chips = document.getElementById("trip-ingest-issues-chips");
    this.countAll = document.getElementById("trip-ingest-issues-count-all");
    this.countFetch = document.getElementById("trip-ingest-issues-count-fetch");
    this.countValidation = document.getElementById(
      "trip-ingest-issues-count-validation"
    );
    this.countProcess = document.getElementById("trip-ingest-issues-count-process");

    this.searchInput = document.getElementById("trip-ingest-issues-search");
    this.includeResolvedSwitch = document.getElementById(
      "trip-ingest-issues-include-resolved"
    );

    this.navCountBadge = document.getElementById("trip-ingest-issues-nav-count");
    this.refreshBtn = document.getElementById("trip-ingest-issues-refresh");

    this.bulkMenuToggle = document.getElementById("trip-ingest-issues-bulk-menu");
    this.dismissAllBtn = document.getElementById("trip-ingest-issues-dismiss-all");
    this.deleteAllBtn = document.getElementById("trip-ingest-issues-delete-all");

    this.issues = [];
    this.currentPage = 1;
    this.itemsPerPage = 25;
    this.issueType = "";
    this.includeResolved = false;
    this.search = "";
    this.openFilteredCount = 0;
    this.isLoading = false;

    this._searchDebounce = null;
    this._requestId = 0;

    this.init();
  }

  init() {
    if (!this.tableBody) {
      return;
    }
    this.attachEventListeners();
    this.fetchIssues();
  }

  attachEventListeners() {
    if (this.chips) {
      this.chips.addEventListener("click", (e) => {
        const btn = e.target.closest(".trip-issues-chip");
        if (!btn) {
          return;
        }
        this.issueType = btn.dataset.issueType || "";
        this.currentPage = 1;
        this.chips
          .querySelectorAll(".trip-issues-chip")
          .forEach((el) => el.classList.toggle("is-active", el === btn));
        this.fetchIssues();
      });
    }

    this.searchInput?.addEventListener("input", () => {
      if (this._searchDebounce) {
        clearTimeout(this._searchDebounce);
      }
      this._searchDebounce = setTimeout(() => {
        this.search = String(this.searchInput.value || "").trim();
        this.currentPage = 1;
        this.fetchIssues();
      }, 250);
    });

    this.includeResolvedSwitch?.addEventListener("change", () => {
      this.includeResolved = Boolean(this.includeResolvedSwitch.checked);
      this.currentPage = 1;
      this.fetchIssues();
    });

    this.refreshBtn?.addEventListener("click", () => {
      this.fetchIssues();
    });

    this.dismissAllBtn?.addEventListener("click", () => {
      this.bulkResolveMatchingIssues();
    });

    this.deleteAllBtn?.addEventListener("click", () => {
      this.bulkDeleteMatchingIssues();
    });

    this.tableBody.addEventListener("click", (e) => {
      const resolveBtn = e.target.closest(".trip-issue-resolve-btn");
      const deleteBtn = e.target.closest(".trip-issue-delete-btn");

      if (resolveBtn) {
        this.resolveIssue(resolveBtn.dataset.issueId);
        return;
      }
      if (deleteBtn) {
        this.deleteIssue(deleteBtn.dataset.issueId);
      }
    });
  }

  setLoadingState(isLoading) {
    this.isLoading = Boolean(isLoading);

    if (this.refreshBtn) {
      const icon = this.refreshBtn.querySelector("i");
      const label = this.refreshBtn.querySelector("span");
      this.refreshBtn.disabled = this.isLoading;
      this.refreshBtn.setAttribute("aria-busy", String(this.isLoading));
      icon?.classList.toggle("fa-spin", this.isLoading);
      icon?.classList.toggle("trip-issues-icon-spin", this.isLoading);
      if (label) {
        label.textContent = this.isLoading ? "Loading" : "Refresh";
      }
    }

    if (this.searchInput) {
      this.searchInput.disabled = this.isLoading;
    }
    if (this.includeResolvedSwitch) {
      this.includeResolvedSwitch.disabled = this.isLoading;
    }
    if (this.chips) {
      this.chips.querySelectorAll(".trip-issues-chip").forEach((chip) => {
        chip.disabled = this.isLoading;
      });
    }

    if (this.bulkMenuToggle && this.isLoading) {
      this.bulkMenuToggle.disabled = true;
      this.bulkMenuToggle.setAttribute("aria-disabled", "true");
      this.hideBulkMenu();
    }
  }

  renderStateRow({ title, body = "", tone = "info" }) {
    if (!this.tableBody) {
      return;
    }

    this.tableBody.innerHTML = `
      <tr class="trip-issues-state-row">
        <td colspan="7" class="trip-issues-state-cell">
          <div class="trip-issues-state trip-issues-state--${escapeHtml(tone)}">
            <p class="trip-issues-state-title">${escapeHtml(title || "")}</p>
            ${
              body
                ? `<p class="trip-issues-state-body">${escapeHtml(String(body))}</p>`
                : ""
            }
          </div>
        </td>
      </tr>
    `;
  }

  async fetchIssues() {
    if (!this.tableBody) {
      return;
    }

    const requestId = ++this._requestId;
    const params = new URLSearchParams();
    params.set("page", String(this.currentPage));
    params.set("limit", String(this.itemsPerPage));
    if (this.issueType) {
      params.set("issue_type", this.issueType);
    }
    if (this.includeResolved) {
      params.set("include_resolved", "true");
    }
    if (this.search) {
      params.set("search", this.search);
    }

    this.setLoadingState(true);
    this.renderStateRow({
      tone: "loading",
      title: "Loading ingest issues...",
      body: "Fetching the latest diagnostics for trip ingestion.",
    });

    try {
      const data = await apiClient.get(`/api/trips/ingest-issues?${params.toString()}`);
      if (requestId !== this._requestId) {
        return;
      }
      this.issues = Array.isArray(data?.issues) ? data.issues : [];
      this.totalCount = Number(data?.count) || 0;
      this.openFilteredCount = Number(data?.open_filtered_count) || 0;
      this.renderStats(data);
      this.renderTable();
      this.renderPagination();
    } catch (error) {
      if (requestId !== this._requestId) {
        return;
      }
      this.renderStateRow({
        tone: "danger",
        title: "Couldn't load ingest issues.",
        body: error.message || "Please try refreshing in a moment.",
      });
      if (this.paginationContainer) {
        this.paginationContainer.innerHTML = "";
      }
      this.openFilteredCount = 0;
      this.updateBulkActions({ count: 0, open_filtered_count: 0 });
    } finally {
      if (requestId === this._requestId) {
        this.setLoadingState(false);
        this.updateBulkActions({
          count: this.totalCount,
          open_filtered_count: this.openFilteredCount,
        });
      }
    }
  }

  renderStats(payload) {
    const openTotal = Number(payload?.open_total) || 0;
    const counts = payload?.open_counts || {};
    const fetchCount = Number(counts.fetch_error) || 0;
    const validationCount = Number(counts.validation_failed) || 0;
    const processCount = Number(counts.process_error) || 0;

    if (this.countAll) {
      this.countAll.textContent = String(openTotal);
    }

    if (this.navCountBadge) {
      this.navCountBadge.textContent = String(openTotal);
      this.navCountBadge.classList.toggle("is-empty", openTotal === 0);
    }
    if (this.countFetch) {
      this.countFetch.textContent = String(fetchCount);
    }
    if (this.countValidation) {
      this.countValidation.textContent = String(validationCount);
    }
    if (this.countProcess) {
      this.countProcess.textContent = String(processCount);
    }

    this.updateBulkActions(payload);
  }

  updateBulkActions(payload) {
    const openFiltered = Number(payload?.open_filtered_count) || 0;
    const totalFiltered = Number(payload?.count) || 0;
    const isBusy = Boolean(this.isLoading);
    const disableDismiss = isBusy || openFiltered === 0;
    const disableDelete = isBusy || totalFiltered === 0;

    if (this.dismissAllBtn) {
      this.dismissAllBtn.disabled = disableDismiss;
      this.dismissAllBtn.setAttribute("aria-disabled", String(disableDismiss));
      this.dismissAllBtn.textContent = openFiltered
        ? `Dismiss matches (${openFiltered})`
        : "Dismiss matches";
    }

    if (this.deleteAllBtn) {
      this.deleteAllBtn.disabled = disableDelete;
      this.deleteAllBtn.setAttribute("aria-disabled", String(disableDelete));
      this.deleteAllBtn.textContent = totalFiltered
        ? `Delete matches (${totalFiltered})...`
        : "Delete matches...";
    }

    if (this.bulkMenuToggle) {
      const disableToggle = isBusy || totalFiltered === 0;
      this.bulkMenuToggle.disabled = disableToggle;
      this.bulkMenuToggle.setAttribute("aria-disabled", String(disableToggle));
    }
  }

  hideBulkMenu() {
    try {
      if (!this.bulkMenuToggle) {
        return;
      }
      const bootstrapRef = window.bootstrap;
      if (!bootstrapRef?.Dropdown) {
        return;
      }
      bootstrapRef.Dropdown.getOrCreateInstance(this.bulkMenuToggle).hide();
    } catch {
      // ignore
    }
  }

  async bulkResolveMatchingIssues() {
    const openCount = Number(this.openFilteredCount) || 0;
    if (!openCount) {
      notificationManager.show("No open issues to dismiss.", "info");
      this.hideBulkMenu();
      return;
    }

    const confirmed = await confirmationDialog.show({
      title: "Dismiss All Matching Issues",
      message: `Dismiss ${openCount} matching ingest issue${openCount === 1 ? "" : "s"}? This only hides them from the default view and does not delete any trips.`,
      confirmText: "Dismiss all",
      confirmButtonClass: "btn-success",
    });

    if (!confirmed) {
      this.hideBulkMenu();
      return;
    }

    try {
      const result = await apiClient.post("/api/trips/ingest-issues/bulk_resolve", {
        issue_type: this.issueType || null,
        search: this.search || null,
      });
      const resolved = Number(result?.resolved) || 0;
      notificationManager.show(
        resolved
          ? `Dismissed ${resolved} issue${resolved === 1 ? "" : "s"}.`
          : "No issues were dismissed.",
        resolved ? "success" : "info"
      );
      this.currentPage = 1;
      this.fetchIssues();
    } catch (error) {
      notificationManager.show(error.message || "Failed to dismiss issues.", "danger");
    } finally {
      this.hideBulkMenu();
    }
  }

  async bulkDeleteMatchingIssues() {
    const total = Number(this.totalCount) || 0;
    if (!total) {
      notificationManager.show("No issues to delete.", "info");
      this.hideBulkMenu();
      return;
    }

    const resolvedSuffix = this.includeResolved ? " (including dismissed)" : "";
    const confirmed = await confirmationDialog.show({
      title: "Delete All Matching Issues",
      message: `Delete ${total} matching ingest issue${total === 1 ? "" : "s"}${resolvedSuffix}? This only clears the diagnostics log and does not delete any trips.`,
      confirmText: "Delete all",
      confirmButtonClass: "btn-danger",
    });

    if (!confirmed) {
      this.hideBulkMenu();
      return;
    }

    try {
      const result = await apiClient.post("/api/trips/ingest-issues/bulk_delete", {
        issue_type: this.issueType || null,
        include_resolved: Boolean(this.includeResolved),
        search: this.search || null,
      });
      const deleted = Number(result?.deleted) || 0;
      notificationManager.show(
        deleted
          ? `Deleted ${deleted} issue${deleted === 1 ? "" : "s"}.`
          : "No issues were deleted.",
        deleted ? "success" : "info"
      );
      this.currentPage = 1;
      this.fetchIssues();
    } catch (error) {
      notificationManager.show(error.message || "Failed to delete issues.", "danger");
    } finally {
      this.hideBulkMenu();
    }
  }

  renderTable() {
    if (!this.tableBody) {
      return;
    }

    if (!Array.isArray(this.issues) || this.issues.length === 0) {
      const hasFilters = Boolean(this.issueType || this.search || this.includeResolved);
      this.renderStateRow(
        hasFilters
          ? {
              tone: "muted",
              title: "No issues match these filters.",
              body: "Try clearing search or changing filters.",
            }
          : {
              tone: "success",
              title: "No ingest issues found.",
              body: "Trip ingestion is healthy right now.",
            }
      );
      return;
    }

    this.tableBody.innerHTML = this.issues
      .map((issue) => {
        const issueId = issue?.id || "";
        const tx = issue?.transaction_id || "";
        const imei = issue?.imei || "";
        const lastSeen = formatLocal(issue?.last_seen_at || issue?.created_at);
        const count = Number(issue?.occurrences) || 1;
        const resolved = Boolean(issue?.resolved);
        const details =
          issue?.details && typeof issue.details === "object" ? issue.details : null;

        const httpInfo = parseHttpishError(issue?.message || "");
        const windowInfo = extractWindowInfo(details, httpInfo?.url);
        const friendly = buildFriendlyIssueCopy(issue, httpInfo, windowInfo);
        const technicalLines = buildTechnicalLines(issue, httpInfo, windowInfo);

        const windowTripText = formatWindowRangeText(windowInfo);
        const tripCell = tx
          ? `<a class="trip-issue-link trip-issue-mono" href="/trips/${encodeURIComponent(
              tx
            )}" data-no-swup>${escapeHtml(tx)}</a>`
          : windowTripText
            ? `<span class="trip-issue-window">${escapeHtml(windowTripText)}</span>`
            : '<span class="text-muted">--</span>';

        const deviceCell = imei
          ? `<span class="trip-issue-mono">${escapeHtml(imei)}</span>`
          : "--";

        const detailsEl = technicalLines.length
          ? `
            <details class="trip-issue-details">
              <summary>More info</summary>
              <pre>${escapeHtml(technicalLines.join("\n"))}</pre>
            </details>
          `
          : "";

        const actionButtons = resolved
          ? `
            <span class="trip-issue-state-badge">Dismissed</span>
            <button class="btn btn-outline-danger btn-sm trip-issue-delete-btn"
                    data-issue-id="${escapeHtml(issueId)}"
                    type="button">
              Delete
            </button>
          `
          : `
            <button class="btn btn-outline-success btn-sm trip-issue-resolve-btn"
                    data-issue-id="${escapeHtml(issueId)}"
                    type="button">
              Dismiss
            </button>
            <button class="btn btn-outline-danger btn-sm trip-issue-delete-btn"
                    data-issue-id="${escapeHtml(issueId)}"
                    type="button">
              Delete
            </button>
          `;

        return `
          <tr>
            <td class="trip-issue-time">${escapeHtml(lastSeen)}</td>
            <td>
              <span class="${escapeHtml(typeBadgeClass(issue?.issue_type))}">
                ${escapeHtml(typeLabel(issue?.issue_type))}
              </span>
            </td>
            <td class="col-hide-mobile">${tripCell}</td>
            <td class="col-hide-mobile">${deviceCell}</td>
            <td class="trip-issue-count">${escapeHtml(count)}</td>
            <td>
              <div class="trip-issue-message">
                <div class="trip-issue-message-title">${escapeHtml(friendly.title)}</div>
                <div class="trip-issue-message-body">${escapeHtml(friendly.body)}</div>
                ${
                  friendly.hint
                    ? `<div class="trip-issue-message-hint">${escapeHtml(friendly.hint)}</div>`
                    : ""
                }
              </div>
              ${detailsEl}
            </td>
            <td>
              <div class="trip-issues-actions">
                ${actionButtons}
              </div>
            </td>
          </tr>
        `;
      })
      .join("");
  }

  renderPagination() {
    if (!this.paginationContainer) {
      return;
    }
    const totalPages = Math.ceil((Number(this.totalCount) || 0) / this.itemsPerPage);
    if (!totalPages || totalPages <= 1) {
      this.paginationContainer.innerHTML = "";
      return;
    }

    const pagination = document.createElement("ul");
    pagination.className = "pagination justify-content-center";

    const prevLi = document.createElement("li");
    prevLi.className = `page-item ${this.currentPage === 1 ? "disabled" : ""}`;
    prevLi.innerHTML = '<a class="page-link" href="#">Previous</a>';
    prevLi.onclick = (e) => {
      e.preventDefault();
      if (this.currentPage > 1) {
        this.currentPage -= 1;
        this.fetchIssues();
      }
    };
    pagination.appendChild(prevLi);

    const startPage = Math.max(1, this.currentPage - 2);
    const endPage = Math.min(totalPages, startPage + 4);

    for (let i = startPage; i <= endPage; i += 1) {
      const pageLi = document.createElement("li");
      pageLi.className = `page-item ${i === this.currentPage ? "active" : ""}`;
      pageLi.innerHTML = `<a class="page-link" href="#">${i}</a>`;
      pageLi.onclick = (e) => {
        e.preventDefault();
        this.currentPage = i;
        this.fetchIssues();
      };
      pagination.appendChild(pageLi);
    }

    const nextLi = document.createElement("li");
    nextLi.className = `page-item ${this.currentPage === totalPages ? "disabled" : ""}`;
    nextLi.innerHTML = '<a class="page-link" href="#">Next</a>';
    nextLi.onclick = (e) => {
      e.preventDefault();
      if (this.currentPage < totalPages) {
        this.currentPage += 1;
        this.fetchIssues();
      }
    };
    pagination.appendChild(nextLi);

    this.paginationContainer.innerHTML = "";
    this.paginationContainer.appendChild(pagination);
  }

  async resolveIssue(issueId) {
    if (!issueId) {
      return;
    }
    try {
      await apiClient.post(
        `/api/trips/ingest-issues/${encodeURIComponent(issueId)}/resolve`,
        {}
      );
      notificationManager.show("Issue dismissed.", "success");
      this.fetchIssues();
    } catch (error) {
      notificationManager.show(error.message || "Failed to dismiss issue.", "danger");
    }
  }

  async deleteIssue(issueId) {
    if (!issueId) {
      return;
    }

    const confirmed = await confirmationDialog.show({
      title: "Delete Issue",
      message: "Delete this issue entry? This only affects the diagnostics log.",
      confirmText: "Delete",
      confirmButtonClass: "btn-danger",
    });

    if (!confirmed) {
      return;
    }

    try {
      await apiClient.delete(`/api/trips/ingest-issues/${encodeURIComponent(issueId)}`);
      notificationManager.show("Issue deleted.", "success");
      this.fetchIssues();
    } catch (error) {
      notificationManager.show(error.message || "Failed to delete issue.", "danger");
    }
  }
}
