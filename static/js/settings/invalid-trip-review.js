/**
 * InvalidTripReview - Handles display and management of invalid trips
 */
export class InvalidTripReview {
  constructor() {
    this.tableBody = document.querySelector("#invalidTripsTable tbody");
    this.paginationContainer = document.getElementById(
      "invalidTripsPagination",
    );
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
      const response = await fetch("/api/trips/invalid");
      if (!response.ok) {
        throw new Error("Failed to fetch invalid trips");
      }

      const data = await response.json();
      this.trips = data.trips;
      this.renderTable();
      this.renderPagination();
    } catch {
      if (this.tableBody) {
        this.tableBody.innerHTML =
          '<tr><td colspan="5" class="text-center text-danger">Failed to load invalid trips</td></tr>';
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
      this.tableBody.innerHTML =
        '<tr><td colspan="5" class="text-center">No invalid trips found</td></tr>';
      return;
    }

    this.tableBody.innerHTML = pageTrips
      .map(
        (trip) => `
      <tr data-trip-id="${trip.id}">
        <td>${trip.id}</td>
        <td>${trip.transaction_id || "N/A"}</td>
        <td>${new Date(trip.start_time).toLocaleString()}</td>
        <td>${trip.invalidation_reason || "Unknown"}</td>
        <td>
          <div class="btn-group btn-group-sm">
            <button class="btn btn-success restore-trip-btn" data-trip-id="${trip.id}" title="Restore trip">
              <i class="fas fa-undo"></i>
            </button>
            <button class="btn btn-danger delete-trip-btn" data-trip-id="${trip.id}" title="Delete permanently">
              <i class="fas fa-trash"></i>
            </button>
          </div>
        </td>
      </tr>
    `,
      )
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
      const response = await fetch(`/api/trips/invalid/${tripId}/restore`, {
        method: "POST",
      });

      if (!response.ok) {
        throw new Error("Failed to restore trip");
      }

      window.notificationManager?.show("Trip restored successfully", "success");
      this.fetchInvalidTrips();
    } catch (error) {
      window.notificationManager?.show(
        `Failed to restore trip: ${error.message}`,
        "danger",
      );
    }
  }

  async deleteTrip(tripId) {
    const confirmed = await window.confirmationDialog.show({
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
      const response = await fetch(`/api/trips/invalid/${tripId}`, {
        method: "DELETE",
      });

      if (!response.ok) {
        throw new Error("Failed to delete trip");
      }

      window.notificationManager?.show("Trip deleted permanently", "success");
      this.fetchInvalidTrips();
    } catch (error) {
      window.notificationManager?.show(
        `Failed to delete trip: ${error.message}`,
        "danger",
      );
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
