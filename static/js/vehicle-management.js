/* global $, handleError, bootstrap */

/**
 * Vehicle Management
 * Manage vehicles, custom names, VINs, and active status
 */

class VehicleManager {
  constructor() {
    this.vehicles = [];
    this.editingVehicleId = null;
    this.modal = null;
  }

  async init() {
    this.modal = new bootstrap.Modal(document.getElementById("vehicle-modal"));
    this.initializeEventListeners();
    await this.loadVehicles();
  }

  initializeEventListeners() {
    // Add vehicle button
    document
      .getElementById("add-vehicle-btn")
      ?.addEventListener("click", () => {
        this.showAddModal();
      });

    // Sync vehicles button
    document
      .getElementById("sync-vehicles-btn")
      ?.addEventListener("click", async () => {
        await this.syncVehicles();
      });

    // Save vehicle button
    document
      .getElementById("save-vehicle-btn")
      ?.addEventListener("click", async () => {
        await this.saveVehicle();
      });

    // Form submission
    document
      .getElementById("vehicle-form")
      ?.addEventListener("submit", async (e) => {
        e.preventDefault();
        await this.saveVehicle();
      });
  }

  async loadVehicles() {
    try {
      const response = await fetch("/api/vehicles");
      if (!response.ok) throw new Error("Failed to load vehicles");

      this.vehicles = await response.json();
      this.renderVehicles();
    } catch (error) {
      console.error("Error loading vehicles:", error);
      if (typeof handleError === "function") {
        handleError(error, "Error loading vehicles", "error");
      }
    }
  }

  renderVehicles() {
    const container = document.getElementById("vehicles-container");
    if (!container) return;

    if (this.vehicles.length === 0) {
      container.innerHTML = `
        <div class="col-12">
          <div class="card">
            <div class="card-body text-center py-5">
              <i class="fas fa-car fa-3x mb-3 text-muted"></i>
              <p class="text-muted mb-3">No vehicles found</p>
              <button class="btn btn-primary" onclick="vehicleManager.syncVehicles()">
                <i class="fas fa-sync me-2"></i>Sync from Trips
              </button>
            </div>
          </div>
        </div>
      `;
      return;
    }

    container.innerHTML = this.vehicles
      .map((vehicle) => this.createVehicleCard(vehicle))
      .join("");
  }

  createVehicleCard(vehicle) {
    const statusBadge = vehicle.is_active
      ? '<span class="badge bg-success">Active</span>'
      : '<span class="badge bg-secondary">Inactive</span>';

    const vehicleInfo = [];
    if (vehicle.make || vehicle.model) {
      vehicleInfo.push(`${vehicle.make || ""} ${vehicle.model || ""}`.trim());
    }
    if (vehicle.year) {
      vehicleInfo.push(`Year: ${vehicle.year}`);
    }
    if (vehicle.vin) {
      vehicleInfo.push(`VIN: ${vehicle.vin}`);
    }

    return `
      <div class="col-12 col-md-6 col-xl-4">
        <div class="card">
          <div class="card-body">
            <div class="d-flex justify-content-between align-items-start mb-3">
              <div>
                <h5 class="card-title mb-1">
                  <i class="fas fa-car me-2"></i>${vehicle.custom_name}
                </h5>
                <small class="text-muted">IMEI: ${vehicle.imei}</small>
              </div>
              ${statusBadge}
            </div>

            ${
              vehicleInfo.length > 0
                ? `
              <div class="mb-3">
                ${vehicleInfo.map((info) => `<div class="text-muted small">${info}</div>`).join("")}
              </div>
            `
                : ""
            }

            <div class="d-flex gap-2">
              <button class="btn btn-sm btn-outline-secondary flex-fill" onclick="vehicleManager.editVehicle('${vehicle._id}')">
                <i class="fas fa-edit me-1"></i>Edit
              </button>
              <button class="btn btn-sm btn-danger" onclick="vehicleManager.deleteVehicle('${vehicle._id}')">
                <i class="fas fa-trash"></i>
              </button>
            </div>
          </div>
        </div>
      </div>
    `;
  }

  showAddModal() {
    this.editingVehicleId = null;
    document.getElementById("modal-title-text").textContent = "Add Vehicle";
    document.getElementById("vehicle-form").reset();
    document.getElementById("vehicle-id").value = "";
    document.getElementById("vehicle-active").checked = true;
    this.modal.show();
  }

  async editVehicle(vehicleId) {
    const vehicle = this.vehicles.find((v) => v._id === vehicleId);
    if (!vehicle) return;

    this.editingVehicleId = vehicleId;
    document.getElementById("modal-title-text").textContent = "Edit Vehicle";

    // Populate form
    document.getElementById("vehicle-id").value = vehicle._id;
    document.getElementById("vehicle-imei").value = vehicle.imei;
    document.getElementById("vehicle-name").value = vehicle.custom_name;
    document.getElementById("vehicle-vin").value = vehicle.vin || "";
    document.getElementById("vehicle-make").value = vehicle.make || "";
    document.getElementById("vehicle-model").value = vehicle.model || "";
    document.getElementById("vehicle-year").value = vehicle.year || "";
    document.getElementById("vehicle-active").checked = vehicle.is_active;

    this.modal.show();
  }

  async saveVehicle() {
    const saveBtn = document.getElementById("save-vehicle-btn");
    if (saveBtn) {
      saveBtn.disabled = true;
      saveBtn.innerHTML =
        '<i class="fas fa-spinner fa-spin me-2"></i>Saving...';
    }

    try {
      const formData = {
        imei: document.getElementById("vehicle-imei").value.trim(),
        custom_name: document.getElementById("vehicle-name").value.trim(),
        vin: document.getElementById("vehicle-vin").value.trim() || null,
        make: document.getElementById("vehicle-make").value.trim() || null,
        model: document.getElementById("vehicle-model").value.trim() || null,
        year: document.getElementById("vehicle-year").value
          ? parseInt(document.getElementById("vehicle-year").value, 10)
          : null,
        is_active: document.getElementById("vehicle-active").checked,
      };

      const vehicleId = document.getElementById("vehicle-id").value;
      const isEdit = vehicleId && vehicleId !== "";

      const url = isEdit ? `/api/vehicles/${vehicleId}` : "/api/vehicles";
      const method = isEdit ? "PUT" : "POST";

      const response = await fetch(url, {
        method,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(formData),
      });

      if (!response.ok) {
        const error = await response.json();
        throw new Error(error.detail || "Failed to save vehicle");
      }

      if (typeof handleError === "function") {
        handleError(
          null,
          `Vehicle ${isEdit ? "updated" : "added"} successfully!`,
          "success",
        );
      }

      this.modal.hide();
      await this.loadVehicles();
    } catch (error) {
      console.error("Error saving vehicle:", error);
      if (typeof handleError === "function") {
        handleError(error, error.message, "error");
      }
    } finally {
      if (saveBtn) {
        saveBtn.disabled = false;
        saveBtn.innerHTML = '<i class="fas fa-save me-2"></i>Save Vehicle';
      }
    }
  }

  async deleteVehicle(vehicleId) {
    const vehicle = this.vehicles.find((v) => v._id === vehicleId);
    if (!vehicle) return;

    const confirmed = confirm(
      `Are you sure you want to delete "${vehicle.custom_name}"?`,
    );
    if (!confirmed) return;

    try {
      const response = await fetch(`/api/vehicles/${vehicleId}`, {
        method: "DELETE",
      });

      if (!response.ok) {
        throw new Error("Failed to delete vehicle");
      }

      if (typeof handleError === "function") {
        handleError(null, "Vehicle deleted successfully", "success");
      }

      await this.loadVehicles();
    } catch (error) {
      console.error("Error deleting vehicle:", error);
      if (typeof handleError === "function") {
        handleError(error, "Error deleting vehicle", "error");
      }
    }
  }

  async syncVehicles() {
    const syncBtn = document.getElementById("sync-vehicles-btn");
    if (syncBtn) {
      syncBtn.disabled = true;
      syncBtn.innerHTML =
        '<i class="fas fa-spinner fa-spin me-2"></i>Syncing...';
    }

    try {
      const response = await fetch("/api/vehicles/sync-from-trips", {
        method: "POST",
      });

      if (!response.ok) {
        throw new Error("Failed to sync vehicles");
      }

      const result = await response.json();

      if (typeof handleError === "function") {
        handleError(
          null,
          `Synced ${result.new_vehicles_created} new vehicles from trips`,
          "success",
        );
      }

      await this.loadVehicles();
    } catch (error) {
      console.error("Error syncing vehicles:", error);
      if (typeof handleError === "function") {
        handleError(error, "Error syncing vehicles", "error");
      }
    } finally {
      if (syncBtn) {
        syncBtn.disabled = false;
        syncBtn.innerHTML = '<i class="fas fa-sync me-2"></i>Sync from Trips';
      }
    }
  }
}

// Initialize when DOM is ready
let vehicleManager;

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", () => {
    vehicleManager = new VehicleManager();
    vehicleManager.init();
  });
} else {
  vehicleManager = new VehicleManager();
  vehicleManager.init();
}
