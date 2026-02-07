/**
 * InvalidTripReview - Handles display and management of invalid trips
 */
import apiClient from "../../core/api-client.js";
import confirmationDialog from "../../ui/confirmation-dialog.js";
import notificationManager from "../../ui/notifications.js";
export class InvalidTripReview {
  constructor() {
    this.tableBody = document.querySelector("#invalidTripsTable tbody");
    this.paginationContainer = document.getElementById("invalidTripsPagination");
    this.trips = [];
    this.currentPage = 1;
    this.itemsPerPage = 10;
    this.init();
  }

  init() {
    this.fetchInvalidTrips();
    this.attachEventListeners();
  }

  async fetchInvalidTrips() {
    try {
      const response = await apiClient.raw("/api/trips/invalid");
      if (!response.ok) {
        throw new Error("Failed to fetch invalid trips");
      }

      const data = await response.json();
      this.trips = data.trips;
      this.renderTable();
      this.renderPagination();
    } catch {
      if (this.tableBody) {
        this.tableBody.innerHTML
          = '<tr><td colspan="5" class="text-center text-danger">Failed to load invalid trips</td></tr>';
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
      this.tableBody.innerHTML
        = '<tr><td colspan="5" class="text-center">No invalid trips found</td></tr>';
      return;
    }

    const escapeHtml = (value) => {
      const str = String(value ?? "");
      return str
        .replaceAll("&", "&amp;")
        .replaceAll("<", "&lt;")
        .replaceAll(">", "&gt;")
        .replaceAll('"', "&quot;")
        .replaceAll("'", "&#039;");
    };

    const formatDate = (value) => {
      if (!value) {
        return "N/A";
      }
      const dt = new Date(value);
      if (Number.isNaN(dt.getTime())) {
        return String(value);
      }
      return dt.toLocaleString();
    };

    this.tableBody.innerHTML = pageTrips
      .map((trip) => {
        const transactionId = trip.transaction_id || "";
        const source = trip.source || "N/A";
        const when = trip.start_time || trip.end_time || trip.validated_at || null;
        const reason = trip.invalidation_reason || "Unknown";

        const disableActions = !transactionId;
        const disabledAttr = disableActions ? "disabled" : "";

        return `
      <tr data-trip-id="${escapeHtml(transactionId)}">
        <td><span class="trip-issues-mono">${escapeHtml(transactionId || "N/A")}</span></td>
        <td>${escapeHtml(source)}</td>
        <td class="col-hide-mobile">${escapeHtml(formatDate(when))}</td>
        <td>${escapeHtml(reason)}</td>
        <td>
          <div class="btn-group btn-group-sm">
            <button class="btn btn-outline-success restore-trip-btn"
                    data-trip-id="${escapeHtml(transactionId)}"
                    title="Restore trip"
                    ${disabledAttr}>
              <i class="fas fa-undo"></i>
            </button>
            <button class="btn btn-outline-danger delete-trip-btn"
                    data-trip-id="${escapeHtml(transactionId)}"
                    title="Delete permanently"
                    ${disabledAttr}>
              <i class="fas fa-trash"></i>
            </button>
          </div>
        </td>
      </tr>
    `;
      })
      .join("");
  }

  attachEventListeners() {
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
