/**
 * TripIngestIssuesReview - user-facing diagnostics for trip sync issues.
 *
 * Powers the "Trip Data Health -> Ingest issues" panel in Settings -> Data.
 */

import apiClient from "../../core/api-client.js";
import confirmationDialog from "../../ui/confirmation-dialog.js";
import notificationManager from "../../ui/notifications.js";

const ISSUE_TYPE_META = {
  fetch_error: { label: "Fetch", tone: "fetch" },
  validation_failed: { label: "Validation", tone: "validation" },
  process_error: { label: "Processing", tone: "process" },
};

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
    return "—";
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

function clampInt(value, fallback = 0) {
  const n = Number(value);
  if (!Number.isFinite(n)) {
    return fallback;
  }
  return Math.max(0, Math.trunc(n));
}

export class TripIngestIssuesReview {
  constructor() {
    this.tableBody = document.querySelector("#tripIngestIssuesTable tbody");
    this.paginationContainer = document.getElementById("tripIngestIssuesPagination");

    this.chipsRoot = document.getElementById("trip-ingest-issues-chips");
    this.countAll = document.getElementById("trip-ingest-issues-count-all");
    this.countFetch = document.getElementById("trip-ingest-issues-count-fetch");
    this.countValidation = document.getElementById(
      "trip-ingest-issues-count-validation"
    );
    this.countProcess = document.getElementById("trip-ingest-issues-count-process");

    this.searchInput = document.getElementById("trip-ingest-issues-search");
    this.includeResolvedToggle = document.getElementById(
      "trip-ingest-issues-include-resolved"
    );

    this.currentPage = 1;
    this.itemsPerPage = 25;
    this.issueType = "";
    this.includeResolved = false;
    this.search = "";

    this.totalCount = 0;
    this.issues = [];

    this._searchDebounce = null;

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
    if (this.chipsRoot) {
      this.chipsRoot.addEventListener("click", (e) => {
        const chip = e.target.closest(".trip-issues-chip");
        if (!chip) {
          return;
        }
        const type = chip.dataset.issueType ?? "";
        this.issueType = type;
        this.currentPage = 1;
        this.setActiveChip(type);
        this.fetchIssues();
      });
    }

    this.searchInput?.addEventListener("input", () => {
      if (this._searchDebounce) {
        clearTimeout(this._searchDebounce);
      }
      this._searchDebounce = setTimeout(() => {
        this.search = String(this.searchInput?.value || "").trim();
        this.currentPage = 1;
        this.fetchIssues();
      }, 250);
    });

    this.includeResolvedToggle?.addEventListener("change", () => {
      this.includeResolved = Boolean(this.includeResolvedToggle.checked);
      this.currentPage = 1;
      this.fetchIssues();
    });

    this.tableBody?.addEventListener("click", (e) => {
      const resolveBtn = e.target.closest(".resolve-issue-btn");
      const deleteBtn = e.target.closest(".delete-issue-btn");
      if (resolveBtn?.dataset?.issueId) {
        this.resolveIssue(resolveBtn.dataset.issueId);
      } else if (deleteBtn?.dataset?.issueId) {
        this.deleteIssue(deleteBtn.dataset.issueId);
      }
    });
  }

  setActiveChip(type) {
    if (!this.chipsRoot) {
      return;
    }
    this.chipsRoot
      .querySelectorAll(".trip-issues-chip")
      .forEach((el) =>
        el.classList.toggle("is-active", (el.dataset.issueType ?? "") === type)
      );
  }

  async fetchIssues() {
    if (!this.tableBody) {
      return;
    }

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

    try {
      const response = await apiClient.raw(
        `/api/trips/ingest-issues?${params.toString()}`
      );
      if (!response.ok) {
        throw new Error("Failed to fetch trip ingest issues");
      }
      const data = await response.json();
      this.issues = Array.isArray(data.issues) ? data.issues : [];
      this.totalCount = clampInt(data.count, 0);
      this.renderCounts(data);
      this.renderTable();
      this.renderPagination();
    } catch (error) {
      this.tableBody.innerHTML = `
        <tr>
          <td colspan="7" class="text-center text-danger">
            ${escapeHtml(error?.message || "Failed to load ingest issues")}
          </td>
        </tr>
      `;
      if (this.paginationContainer) {
        this.paginationContainer.innerHTML = "";
      }
    }
  }

  renderCounts(data) {
    const openTotal = clampInt(data.open_total, 0);
    const openCounts =
      data.open_counts && typeof data.open_counts === "object" ? data.open_counts : {};

    if (this.countAll) {
      this.countAll.textContent = String(openTotal);
    }
    if (this.countFetch) {
      this.countFetch.textContent = String(clampInt(openCounts.fetch_error, 0));
    }
    if (this.countValidation) {
      this.countValidation.textContent = String(
        clampInt(openCounts.validation_failed, 0)
      );
    }
    if (this.countProcess) {
      this.countProcess.textContent = String(clampInt(openCounts.process_error, 0));
    }
  }

  renderTable() {
    if (!this.tableBody) {
      return;
    }

    if (!Array.isArray(this.issues) || this.issues.length === 0) {
      this.tableBody.innerHTML = `
        <tr>
          <td colspan="7" class="text-center text-muted">
            No ingest issues found.
          </td>
        </tr>
      `;
      return;
    }

    this.tableBody.innerHTML = this.issues
      .map((issue) => {
        const id = issue?.id || "";
        const type = issue?.issue_type || "unknown";
        const meta = ISSUE_TYPE_META[type] || { label: type, tone: "unknown" };
        const lastSeen = formatLocal(issue?.last_seen_at);
        const tx = issue?.transaction_id || "";
        const imei = issue?.imei || "";
        const count = clampInt(issue?.count, 1);
        const resolved = Boolean(issue?.resolved);
        const message = issue?.message || "Unknown error";
        const details =
          issue?.details && typeof issue.details === "object" ? issue.details : null;

        const subject = tx
          ? `<span class="trip-issues-mono">${escapeHtml(tx)}</span>`
          : imei
            ? `<span class="trip-issues-mono">${escapeHtml(imei)}</span>`
            : `<span class="text-muted">—</span>`;

        const detailsHtml = details
          ? `
            <details class="trip-issues-details">
              <summary>Details</summary>
              <pre>${escapeHtml(JSON.stringify(details, null, 2))}</pre>
            </details>
          `
          : "";

        const actions = resolved
          ? `
            <div class="btn-group btn-group-sm">
              <button type="button"
                      class="btn btn-outline-danger delete-issue-btn"
                      data-issue-id="${escapeHtml(id)}"
                      title="Delete">
                <i class="fas fa-trash"></i>
              </button>
            </div>
          `
          : `
            <div class="btn-group btn-group-sm">
              <button type="button"
                      class="btn btn-outline-success resolve-issue-btn"
                      data-issue-id="${escapeHtml(id)}"
                      title="Dismiss">
                <i class="fas fa-check"></i>
              </button>
              <button type="button"
                      class="btn btn-outline-danger delete-issue-btn"
                      data-issue-id="${escapeHtml(id)}"
                      title="Delete">
                <i class="fas fa-trash"></i>
              </button>
            </div>
          `;

        return `
          <tr class="${resolved ? "is-resolved" : ""}">
            <td>${escapeHtml(lastSeen)}</td>
            <td>
              <span class="trip-issues-type trip-issues-type--${escapeHtml(meta.tone)}">
                ${escapeHtml(meta.label)}
              </span>
            </td>
            <td class="col-hide-mobile">${subject}</td>
            <td class="col-hide-mobile">${escapeHtml(imei || "—")}</td>
            <td><span class="trip-issues-count">${escapeHtml(count)}</span></td>
            <td>
              <div class="trip-issues-reason">${escapeHtml(message)}</div>
              ${detailsHtml}
            </td>
            <td>${actions}</td>
          </tr>
        `;
      })
      .join("");
  }

  renderPagination() {
    if (!this.paginationContainer) {
      return;
    }

    const totalPages = Math.ceil(this.totalCount / this.itemsPerPage);
    if (totalPages <= 1) {
      this.paginationContainer.innerHTML = "";
      return;
    }

    const pagination = document.createElement("ul");
    pagination.className = "pagination justify-content-center";

    const mkPageLi = (label, page, { disabled = false, active = false } = {}) => {
      const li = document.createElement("li");
      li.className = `page-item${disabled ? " disabled" : ""}${active ? " active" : ""}`;
      li.innerHTML = `<a class="page-link" href="#">${escapeHtml(label)}</a>`;
      li.onclick = (e) => {
        e.preventDefault();
        if (disabled) {
          return;
        }
        this.currentPage = page;
        this.fetchIssues();
      };
      return li;
    };

    pagination.appendChild(
      mkPageLi("Previous", Math.max(1, this.currentPage - 1), {
        disabled: this.currentPage === 1,
      })
    );

    const startPage = Math.max(1, this.currentPage - 2);
    const endPage = Math.min(totalPages, startPage + 4);
    for (let i = startPage; i <= endPage; i += 1) {
      pagination.appendChild(
        mkPageLi(String(i), i, { active: i === this.currentPage })
      );
    }

    pagination.appendChild(
      mkPageLi("Next", Math.min(totalPages, this.currentPage + 1), {
        disabled: this.currentPage === totalPages,
      })
    );

    this.paginationContainer.innerHTML = "";
    this.paginationContainer.appendChild(pagination);
  }

  async resolveIssue(issueId) {
    if (!issueId) {
      return;
    }
    try {
      const response = await apiClient.raw(
        `/api/trips/ingest-issues/${issueId}/resolve`,
        {
          method: "POST",
        }
      );
      if (!response.ok) {
        throw new Error("Failed to dismiss issue");
      }
      notificationManager.show("Issue dismissed.", "success");
      this.fetchIssues();
    } catch (error) {
      notificationManager.show(error?.message || "Failed to dismiss issue.", "danger");
    }
  }

  async deleteIssue(issueId) {
    if (!issueId) {
      return;
    }

    const confirmed = await confirmationDialog.show({
      title: "Delete Issue",
      message: "Delete this issue entry? This does not delete any trips.",
      confirmText: "Delete",
      confirmButtonClass: "btn-danger",
    });
    if (!confirmed) {
      return;
    }

    try {
      const response = await apiClient.raw(`/api/trips/ingest-issues/${issueId}`, {
        method: "DELETE",
      });
      if (!response.ok) {
        throw new Error("Failed to delete issue");
      }
      notificationManager.show("Issue deleted.", "success");
      this.fetchIssues();
    } catch (error) {
      notificationManager.show(error?.message || "Failed to delete issue.", "danger");
    }
  }
}
