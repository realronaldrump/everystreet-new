/**
 * InvalidTripReview - Handles display and management of invalid trips
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

function formatDateTime(value) {
  if (!value) {
    return "N/A";
  }
  const dt = new Date(value);
  if (Number.isNaN(dt.getTime())) {
    return String(value);
  }
  return dt.toLocaleString();
}

export class InvalidTripReview {
  constructor() {
    this.tableBody = document.querySelector("#invalidTripsTable tbody");
    this.paginationContainer = document.getElementById("invalidTripsPagination");

    this.navCountBadge = document.getElementById("invalid-trips-nav-count");
    this.refreshBtn = document.getElementById("invalid-trips-refresh");
    this.deleteAllBtn = document.getElementById("invalid-trips-delete-all");

    this.trips = [];
    this.currentPage = 1;
    this.itemsPerPage = 10;
    this.isLoading = false;
    this._requestId = 0;
    this.init();
  }

  init() {
    this.fetchInvalidTrips();
    this.attachEventListeners();
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

    if (this.deleteAllBtn) {
      const noTrips = !Array.isArray(this.trips) || this.trips.length === 0;
      const shouldDisable = this.isLoading || noTrips;
      this.deleteAllBtn.disabled = shouldDisable;
      this.deleteAllBtn.setAttribute("aria-disabled", String(shouldDisable));
    }
  }

  renderStateRow({ title, body = "", tone = "info" }) {
    if (!this.tableBody) {
      return;
    }

    this.tableBody.innerHTML = `
      <tr class="trip-issues-state-row">
        <td colspan="5" class="trip-issues-state-cell">
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

  async fetchInvalidTrips() {
    const requestId = ++this._requestId;
    this.setLoadingState(true);
    this.renderStateRow({
      tone: "loading",
      title: "Loading invalid trips...",
      body: "Fetching validation results from storage.",
    });

    try {
      const response = await apiClient.raw("/api/trips/invalid");
      if (!response.ok) {
        throw new Error("Failed to fetch invalid trips");
      }

      const data = await response.json();
      if (requestId !== this._requestId) {
        return;
      }
      this.trips = Array.isArray(data?.trips) ? data.trips : [];

      if (this.navCountBadge) {
        const count = Array.isArray(this.trips) ? this.trips.length : 0;
        this.navCountBadge.textContent = String(count);
        this.navCountBadge.classList.toggle("is-empty", count === 0);
      }

      if (this.deleteAllBtn) {
        const count = Array.isArray(this.trips) ? this.trips.length : 0;
        this.deleteAllBtn.disabled = count === 0;
        this.deleteAllBtn.setAttribute("aria-disabled", String(count === 0));
      }

      this.renderTable();
      this.renderPagination();
    } catch (error) {
      if (requestId === this._requestId) {
        this.trips = [];
        this.renderStateRow({
          tone: "danger",
          title: "Couldn't load invalid trips.",
          body: error.message || "Please try refreshing in a moment.",
        });
        if (this.paginationContainer) {
          this.paginationContainer.innerHTML = "";
        }
      }
    } finally {
      if (requestId === this._requestId) {
        this.setLoadingState(false);
      }
    }
  }

  renderTable() {
    if (!this.tableBody) {
      return;
    }

    const start = (this.currentPage - 1) * this.itemsPerPage;
    const end = start + this.itemsPerPage;
    const pageTrips = this.trips.slice(start, end);

    if (pageTrips.length === 0) {
      this.renderStateRow({
        tone: "success",
        title: "No invalid trips found.",
        body: "Your stored trip data currently passes validation.",
      });
      return;
    }

    this.tableBody.innerHTML = pageTrips
      .map((trip) => {
        const transactionId = trip.transaction_id || "";
        const source = trip.source || "N/A";
        const when = trip.start_time || trip.end_time || trip.validated_at || null;
        const reason = trip.invalidation_reason || "Unknown";

        const disableActions = !transactionId;
        const disabledAttr = disableActions ? "disabled" : "";

        const tripCell = transactionId
          ? `<a class="trip-issue-link trip-issues-mono" href="/trips/${encodeURIComponent(
              transactionId
            )}" data-no-swup>${escapeHtml(transactionId)}</a>`
          : `<span class="trip-issues-mono">N/A</span>`;

        const actions = disableActions
          ? '<span class="text-muted">—</span>'
          : `
            <div class="trip-issues-actions">
              <button class="btn btn-outline-success btn-sm restore-trip-btn"
                      data-trip-id="${escapeHtml(transactionId)}"
                      type="button"
                      ${disabledAttr}>
                Restore
              </button>
              <button class="btn btn-outline-danger btn-sm delete-trip-btn"
                      data-trip-id="${escapeHtml(transactionId)}"
                      type="button"
                      ${disabledAttr}>
                Delete
              </button>
            </div>
          `;

        return `
      <tr data-trip-id="${escapeHtml(transactionId)}">
        <td>${tripCell}</td>
        <td><span class="trip-invalid-source">${escapeHtml(source)}</span></td>
        <td class="col-hide-mobile trip-invalid-date">${escapeHtml(formatDateTime(when))}</td>
        <td><span class="trip-invalid-reason">${escapeHtml(reason)}</span></td>
        <td>${actions}</td>
      </tr>
    `;
      })
      .join("");
  }

  attachEventListeners() {
    this.refreshBtn?.addEventListener("click", () => {
      this.fetchInvalidTrips();
    });

    this.deleteAllBtn?.addEventListener("click", () => {
      this.bulkDeleteInvalidTrips();
    });

    if (!this.tableBody) {
      return;
    }

    this.tableBody.addEventListener("click", (e) => {
      const restoreBtn = e.target.closest(".restore-trip-btn");
      const deleteBtn = e.target.closest(".delete-trip-btn");

      if (restoreBtn) {
        this.restoreTrip(restoreBtn.dataset.tripId);
      } else if (deleteBtn) {
        this.deleteTrip(deleteBtn.dataset.tripId);
      }
    });
  }

  async restoreTrip(tripId) {
    try {
      const response = await apiClient.raw(`/api/trips/${tripId}/restore`, {
        method: "POST",
      });

      if (!response.ok) {
        throw new Error("Failed to restore trip");
      }

      notificationManager.show("Trip restored successfully", "success");
      this.fetchInvalidTrips();
    } catch (error) {
      notificationManager.show(`Failed to restore trip: ${error.message}`, "danger");
    }
  }

  async deleteTrip(tripId) {
    const confirmed = await confirmationDialog.show({
      title: "Delete Trip",
      message:
        "Are you sure you want to permanently delete this trip? This cannot be undone.",
      confirmText: "Delete",
      confirmButtonClass: "btn-danger",
    });

    if (!confirmed) {
      return;
    }

    try {
      const response = await apiClient.raw(`/api/trips/${tripId}/permanent`, {
        method: "DELETE",
      });

      if (!response.ok) {
        throw new Error("Failed to delete trip");
      }

      notificationManager.show("Trip deleted permanently", "success");
      this.fetchInvalidTrips();
    } catch (error) {
      notificationManager.show(`Failed to delete trip: ${error.message}`, "danger");
    }
  }

  async bulkDeleteInvalidTrips() {
    const tripIds = Array.isArray(this.trips)
      ? this.trips.map((t) => t?.transaction_id).filter(Boolean)
      : [];

    if (!tripIds.length) {
      notificationManager.show("No invalid trips to delete.", "info");
      return;
    }

    const confirmed = await confirmationDialog.show({
      title: "Delete All Invalid Trips",
      message: `Permanently delete ${tripIds.length} invalid trip${
        tripIds.length === 1 ? "" : "s"
      }? This cannot be undone.`,
      confirmText: "Delete all",
      confirmButtonClass: "btn-danger",
    });

    if (!confirmed) {
      return;
    }

    const btn = this.deleteAllBtn;
    if (btn) {
      btn.disabled = true;
      btn.setAttribute("aria-disabled", "true");
    }

    try {
      const result = await apiClient.post("/api/trips/bulk_delete", {
        trip_ids: tripIds,
      });
      const deleted = Number(result?.deleted_trips) || 0;
      notificationManager.show(
        deleted
          ? `Deleted ${deleted} trip${deleted === 1 ? "" : "s"}.`
          : "No trips were deleted.",
        deleted ? "success" : "info"
      );
      this.currentPage = 1;
      await this.fetchInvalidTrips();
    } catch (error) {
      notificationManager.show(error.message || "Failed to delete trips.", "danger");
    } finally {
      if (btn) {
        const count = Array.isArray(this.trips) ? this.trips.length : 0;
        btn.disabled = count === 0;
        btn.setAttribute("aria-disabled", String(count === 0));
      }
    }
  }

  renderPagination() {
    if (!this.paginationContainer) {
      return;
    }

    const totalPages = Math.ceil(this.trips.length / this.itemsPerPage);

    if (totalPages <= 1) {
      this.paginationContainer.innerHTML = "";
      return;
    }

    const pagination = document.createElement("ul");
    pagination.className = "pagination justify-content-center";

    // Previous button
    const prevLi = document.createElement("li");
    prevLi.className = `page-item ${this.currentPage === 1 ? "disabled" : ""}`;
    prevLi.innerHTML = '<a class="page-link" href="#">Previous</a>';
    prevLi.onclick = (e) => {
      e.preventDefault();
      if (this.currentPage > 1) {
        this.currentPage--;
        this.renderTable();
        this.renderPagination();
      }
    };
    pagination.appendChild(prevLi);

    // Page numbers
    const startPage = Math.max(1, this.currentPage - 2);
    const endPage = Math.min(totalPages, startPage + 4);

    for (let i = startPage; i <= endPage; i++) {
      const pageLi = document.createElement("li");
      pageLi.className = `page-item ${i === this.currentPage ? "active" : ""}`;
      pageLi.innerHTML = `<a class="page-link" href="#">${i}</a>`;
      pageLi.onclick = (e) => {
        e.preventDefault();
        this.currentPage = i;
        this.renderTable();
        this.renderPagination();
      };
      pagination.appendChild(pageLi);
    }

    // Next button
    const nextLi = document.createElement("li");
    nextLi.className = `page-item ${this.currentPage === totalPages ? "disabled" : ""}`;
    nextLi.innerHTML = '<a class="page-link" href="#">Next</a>';
    nextLi.onclick = (e) => {
      e.preventDefault();
      if (this.currentPage < totalPages) {
        this.currentPage++;
        this.renderTable();
        this.renderPagination();
      }
    };
    pagination.appendChild(nextLi);

    this.paginationContainer.innerHTML = "";
    this.paginationContainer.appendChild(pagination);
  }
}
