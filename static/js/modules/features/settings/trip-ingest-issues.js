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

export class TripIngestIssues {
  constructor() {
    this.tableBody = document.querySelector("#tripIngestIssuesTable tbody");
    this.paginationContainer = document.getElementById("tripIngestIssuesPagination");

    this.chips = document.getElementById("trip-ingest-issues-chips");
    this.countAll = document.getElementById("trip-ingest-issues-count-all");
    this.countFetch = document.getElementById("trip-ingest-issues-count-fetch");
    this.countValidation = document.getElementById("trip-ingest-issues-count-validation");
    this.countProcess = document.getElementById("trip-ingest-issues-count-process");

    this.searchInput = document.getElementById("trip-ingest-issues-search");
    this.includeResolvedSwitch = document.getElementById(
      "trip-ingest-issues-include-resolved"
    );

    this.issues = [];
    this.currentPage = 1;
    this.itemsPerPage = 25;
    this.issueType = "";
    this.includeResolved = false;
    this.search = "";

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
      const data = await apiClient.get(`/api/trips/ingest-issues?${params.toString()}`);
      this.issues = Array.isArray(data?.issues) ? data.issues : [];
      this.totalCount = Number(data?.count) || 0;
      this.renderStats(data);
      this.renderTable();
      this.renderPagination();
    } catch (error) {
      this.tableBody.innerHTML
        = `<tr><td colspan="7" class="text-center text-danger">${escapeHtml(
            error.message || "Failed to load issues"
          )}</td></tr>`;
      if (this.paginationContainer) {
        this.paginationContainer.innerHTML = "";
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
    if (this.countFetch) {
      this.countFetch.textContent = String(fetchCount);
    }
    if (this.countValidation) {
      this.countValidation.textContent = String(validationCount);
    }
    if (this.countProcess) {
      this.countProcess.textContent = String(processCount);
    }
  }

  renderTable() {
    if (!this.tableBody) {
      return;
    }

    if (!Array.isArray(this.issues) || this.issues.length === 0) {
      this.tableBody.innerHTML
        = '<tr><td colspan="7" class="text-center text-muted">No ingest issues found.</td></tr>';
      return;
    }

    this.tableBody.innerHTML = this.issues
      .map((issue) => {
        const issueId = issue?.id || "";
        const tx = issue?.transaction_id || "";
        const imei = issue?.imei || "";
        const lastSeen = formatLocal(issue?.last_seen_at || issue?.created_at);
        const count = Number(issue?.occurrences) || 1;
        const message = issue?.message || "";
        const resolved = Boolean(issue?.resolved);
        const details = issue?.details && typeof issue.details === "object" ? issue.details : null;

        const tripCell = tx
          ? `<a class="trip-issue-link" href="/trips/${encodeURIComponent(
              tx
            )}" data-no-swup>${escapeHtml(tx)}</a>`
          : '<span class="text-muted">--</span>';

        const deviceCell = imei ? `<span class="trip-issue-mono">${escapeHtml(imei)}</span>` : "--";

        const detailsEl = details
          ? `
            <details class="trip-issue-details">
              <summary>Details</summary>
              <pre>${escapeHtml(JSON.stringify(details, null, 2))}</pre>
            </details>
          `
          : "";

        const actionButtons = resolved
          ? `
            <span class="badge text-bg-light border">Dismissed</span>
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
              <div class="trip-issue-message">${escapeHtml(message)}</div>
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
      await apiClient.post(`/api/trips/ingest-issues/${encodeURIComponent(issueId)}/resolve`, {});
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
