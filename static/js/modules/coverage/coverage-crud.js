/**
 * Coverage CRUD Operations
 * Handles Creating, Reading, Updating, and Deleting coverage areas
 */
/* global bootstrap */
import COVERAGE_API from "./coverage-api.js";

export class CoverageCRUD {
  constructor(
    notificationManager,
    progressModule,
    confirmationDialog,
    validatorModule,
    coverageManager, // Backward ref for reload triggers
  ) {
    this.notificationManager = notificationManager;
    this.progress = progressModule;
    this.confirmationDialog = confirmationDialog;
    this.validator = validatorModule;
    this.manager = coverageManager;

    this.currentProcessingLocation = null;
    this.pendingOperations = new Map();
  }

  /**
   * Add coverage area
   */
  async addCoverageArea() {
    if (
      !this.validator.validatedLocation ||
      !this.validator.validatedLocation.display_name
    ) {
      this.notificationManager.show(
        "Please validate a location first.",
        "warning",
      );
      return;
    }

    const addButton = document.getElementById("add-coverage-area");
    const modal = bootstrap.Modal.getInstance(
      document.getElementById("addAreaModal"),
    );

    if (!addButton) {
      return;
    }

    const originalButtonContent = addButton.innerHTML;
    addButton.disabled = true;
    addButton.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Adding...';

    const locationToAdd = { ...this.validator.validatedLocation };
    const segLenEl = document.getElementById("segment-length-input");
    if (segLenEl?.value) {
      const val = parseInt(segLenEl.value, 10);
      if (!Number.isNaN(val) && val > 0) {
        locationToAdd.segment_length_feet = val;
      }
    }
    const bufEl = document.getElementById("match-buffer-input");
    if (bufEl?.value) {
      const v = parseFloat(bufEl.value);
      if (!Number.isNaN(v) && v > 0) {
        locationToAdd.match_buffer_feet = v;
      }
    }
    const minEl = document.getElementById("min-match-length-input");
    if (minEl?.value) {
      const v2 = parseFloat(minEl.value);
      if (!Number.isNaN(v2) && v2 > 0) {
        locationToAdd.min_match_length_feet = v2;
      }
    }

    try {
      const areas = await COVERAGE_API.getAllAreas();
      const exists = areas.some(
        (area) => area.location?.display_name === locationToAdd.display_name,
      );

      if (exists) {
        this.notificationManager.show(
          "This area is already being tracked.",
          "warning",
        );
        return;
      }

      if (modal) {
        modal.hide();
      }

      this.currentProcessingLocation = locationToAdd;
      this.progress.currentProcessingLocation = locationToAdd;
      this.progress.currentTaskId = null;
      this.progress._addBeforeUnloadListener();

      this.progress.showProgressModal(
        `Starting processing for ${locationToAdd.display_name}...`,
        0,
      );

      const taskData = await COVERAGE_API.preprocessStreets(locationToAdd);

      this.notificationManager.show(
        "Coverage area processing started.",
        "info",
      );

      if (taskData?.task_id) {
        this.progress.currentTaskId = taskData.task_id;
        this.progress.activeTaskIds.add(taskData.task_id);
        this.progress.saveProcessingState();

        await this.progress.pollCoverageProgress(taskData.task_id);

        this.notificationManager.show(
          `Processing for ${locationToAdd.display_name} completed.`,
          "success",
        );

        await this.manager.loadCoverageAreas(true, false, false, true);
      } else {
        this.progress.hideProgressModal();
        this.notificationManager.show(
          "Processing started, but no task ID received.",
          "warning",
        );
        await this.manager.loadCoverageAreas(true, false, false, true);
      }

      const locationInput = document.getElementById("location-input");
      if (locationInput) {
        locationInput.value = "";
        locationInput.classList.remove("is-valid", "is-invalid");
      }
      this.validator.validatedLocation = null;
      this.manager.updateTotalAreasCount();
    } catch (error) {
      console.error("Error adding coverage area:", error);
      this.notificationManager.show(
        `Failed to add coverage area: ${error.message}`,
        "danger",
      );
      this.progress.hideProgressModal();
      await this.manager.loadCoverageAreas(true, false, false, true);
    } finally {
      addButton.disabled = true;
      addButton.innerHTML = originalButtonContent;
    }
  }

  /**
   * Add custom coverage area
   */
  async addCustomCoverageArea() {
    if (
      !this.validator.validatedCustomBoundary ||
      !this.validator.validatedCustomBoundary.display_name
    ) {
      this.notificationManager.show(
        "Please validate your custom boundary first.",
        "warning",
      );
      return;
    }

    const addButton = document.getElementById("add-custom-area");
    const modal = bootstrap.Modal.getInstance(
      document.getElementById("addAreaModal"),
    );

    if (!addButton) {
      return;
    }

    const originalButtonContent = addButton.innerHTML;
    addButton.disabled = true;
    addButton.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Adding...';

    const customAreaToAdd = { ...this.validator.validatedCustomBoundary };
    const segLenEl2 = document.getElementById("segment-length-input");
    if (segLenEl2?.value) {
      const val2 = parseInt(segLenEl2.value, 10);
      if (!Number.isNaN(val2) && val2 > 0) {
        customAreaToAdd.segment_length_feet = val2;
      }
    }
    const bufElC = document.getElementById("match-buffer-input");
    if (bufElC?.value) {
      const v = parseFloat(bufElC.value);
      if (!Number.isNaN(v) && v > 0) {
        customAreaToAdd.match_buffer_feet = v;
      }
    }
    const minElC = document.getElementById("min-match-length-input");
    if (minElC?.value) {
      const v2 = parseFloat(minElC.value);
      if (!Number.isNaN(v2) && v2 > 0) {
        customAreaToAdd.min_match_length_feet = v2;
      }
    }

    try {
      const areas = await COVERAGE_API.getAllAreas();
      const exists = areas.some(
        (area) => area.location?.display_name === customAreaToAdd.display_name,
      );

      if (exists) {
        this.notificationManager.show(
          "This area name is already being tracked.",
          "warning",
        );
        return;
      }

      if (modal) {
        modal.hide();
      }

      this.currentProcessingLocation = customAreaToAdd;
      this.progress.currentProcessingLocation = customAreaToAdd;
      this.progress.currentTaskId = null;
      this.progress._addBeforeUnloadListener();

      this.progress.showProgressModal(
        `Starting processing for ${customAreaToAdd.display_name}...`,
        0,
      );

      const taskData =
        await COVERAGE_API.preprocessCustomBoundary(customAreaToAdd);

      this.notificationManager.show(
        "Custom coverage area processing started.",
        "info",
      );

      if (taskData?.task_id) {
        this.progress.currentTaskId = taskData.task_id;
        this.progress.activeTaskIds.add(taskData.task_id);
        this.progress.saveProcessingState();

        await this.progress.pollCoverageProgress(taskData.task_id);

        this.notificationManager.show(
          `Processing for ${customAreaToAdd.display_name} completed.`,
          "success",
        );

        await this.manager.loadCoverageAreas(true, false, false, true);
      } else {
        this.progress.hideProgressModal();
        this.notificationManager.show(
          "Processing started, but no task ID received.",
          "warning",
        );
        await this.manager.loadCoverageAreas(true, false, false, true);
      }

      const customAreaName = document.getElementById("custom-area-name");
      if (customAreaName) {
        customAreaName.value = "";
      }
      this.validator.validatedCustomBoundary = null;
      this.manager.updateTotalAreasCount();
    } catch (error) {
      console.error("Error adding custom coverage area:", error);
      this.notificationManager.show(
        `Failed to add custom coverage area: ${error.message}`,
        "danger",
      );
      this.progress.hideProgressModal();
      await this.manager.loadCoverageAreas(true, false, false, true);
    } finally {
      addButton.disabled = true;
      addButton.innerHTML = originalButtonContent;
    }
  }

  /**
   * Update coverage for area
   */
  async updateCoverageForArea(
    locationId,
    mode = "full",
    showNotification = true,
  ) {
    if (!locationId) {
      this.notificationManager.show(
        "Invalid location ID provided for update.",
        "warning",
      );
      return;
    }

    if (this.pendingOperations.has(`update-${locationId}`)) {
      this.notificationManager.show(
        "Update already in progress for this location.",
        "info",
      );
      return;
    }

    try {
      this.pendingOperations.set(`update-${locationId}`, () =>
        this.updateCoverageForArea(locationId, mode, showNotification),
      );

      const locationData = await COVERAGE_API.getArea(locationId);

      if (
        this.currentProcessingLocation?.display_name ===
        locationData.location.display_name
      ) {
        this.notificationManager.show(
          `Update already in progress for ${locationData.location.display_name}.`,
          "info",
        );
        this.progress.showProgressModal(
          `Update already running for ${locationData.location.display_name}...`,
        );
        return;
      }

      const processingLocation = { ...locationData.location };

      this.currentProcessingLocation = processingLocation;
      this.progress.currentProcessingLocation = processingLocation;
      this.progress.currentTaskId = null;
      this.progress._addBeforeUnloadListener();

      const isUpdatingDisplayedLocation =
        this.manager.dashboard.selectedLocation?._id === locationId;

      this.progress.showProgressModal(
        `Requesting ${mode} update for ${processingLocation.display_name}...`,
      );

      const data = await COVERAGE_API.updateCoverage(processingLocation, mode);

      if (data.task_id) {
        this.progress.currentTaskId = data.task_id;
        this.progress.activeTaskIds.add(data.task_id);
        this.progress.saveProcessingState();

        await this.progress.pollCoverageProgress(data.task_id);

        if (showNotification) {
          this.notificationManager.show(
            `Coverage updated for ${processingLocation.display_name}.`,
            "success",
          );
        }

        // Reload the list to show updated timestamps
        await this.manager.loadCoverageAreas(false, true, false, true);

        // If we are currently viewing this location's dashboard, refresh it
        if (isUpdatingDisplayedLocation) {
          await this.manager.displayCoverageDashboard(locationId);
        }
      } else {
        this.progress.hideProgressModal();
        this.notificationManager.show(
          "Update started, but no task ID received.",
          "warning",
        );
        await this.manager.loadCoverageAreas(true, false, false, true);
      }
    } catch (error) {
      console.error("Error updating coverage:", error);
      if (showNotification) {
        this.notificationManager.show(
          `Coverage update failed: ${error.message}`,
          "danger",
        );
      }
      this.progress.hideProgressModal();
      await this.manager.loadCoverageAreas(true, false, false, true);
      throw error;
    } finally {
      this.pendingOperations.delete(`update-${locationId}`);
    }
  }

  /**
   * Cancel processing
   */
  async cancelProcessing(location = null) {
    const locationToCancel = location || this.currentProcessingLocation;

    if (!locationToCancel || !locationToCancel.display_name) {
      this.notificationManager.show(
        "No active processing to cancel.",
        "warning",
      );
      return;
    }

    const confirmed = await this.confirmationDialog.show({
      title: "Cancel Processing",
      message: `Are you sure you want to cancel processing for <strong>${locationToCancel.display_name}</strong>?`,
      details:
        "This will stop the current operation. You can restart it later.",
      confirmText: "Yes, Cancel",
      cancelText: "No, Continue",
      confirmButtonClass: "btn-danger",
    });

    if (!confirmed) {
      return;
    }

    this.notificationManager.show(
      `Attempting to cancel processing for ${locationToCancel.display_name}...`,
      "info",
    );

    try {
      await COVERAGE_API.cancelProcessing(locationToCancel.display_name);

      this.notificationManager.show(
        `Processing for ${locationToCancel.display_name} cancelled.`,
        "success",
      );

      if (
        this.currentProcessingLocation?.display_name ===
        locationToCancel.display_name
      ) {
        if (this.progress.currentTaskId) {
          this.progress.activeTaskIds.delete(this.progress.currentTaskId);
          this.progress._removeBeforeUnloadListener();
        }
        this.progress.hideProgressModal();
      }

      await this.manager.loadCoverageAreas(true, false, false, true);
    } catch (error) {
      console.error("Error cancelling processing:", error);
      this.notificationManager.show(
        `Failed to cancel processing: ${error.message}`,
        "danger",
      );
    }
  }

  /**
   * Delete area
   */
  async deleteArea(location) {
    if (!location || !location.display_name) {
      this.notificationManager.show(
        "Invalid location data for deletion.",
        "warning",
      );
      return;
    }

    const confirmed = await this.confirmationDialog.show({
      title: "Delete Coverage Area",
      message: `Are you sure you want to delete <strong>${location.display_name}</strong>?`,
      details:
        "This will permanently delete all associated street data, statistics, and history. This action cannot be undone.",
      confirmText: "Delete Permanently",
      confirmButtonClass: "btn-danger",
    });

    if (!confirmed) {
      return;
    }

    try {
      this.notificationManager.show(
        `Deleting coverage area: ${location.display_name}...`,
        "info",
      );

      await COVERAGE_API.deleteArea(location.display_name);

      await this.manager.loadCoverageAreas(true, false, false, true);

      if (
        this.manager.dashboard.selectedLocation?.location?.display_name ===
        location.display_name
      ) {
        this.manager.dashboard.closeCoverageDashboard();
      }

      this.notificationManager.show(
        `Coverage area '${location.display_name}' deleted.`,
        "success",
      );

      this.manager.updateTotalAreasCount();
    } catch (error) {
      console.error("Error deleting coverage area:", error);
      this.notificationManager.show(
        `Error deleting coverage area: ${error.message}`,
        "danger",
      );
    }
  }

  /**
   * Reprocess streets for area
   */
  async reprocessStreetsForArea(locationId) {
    try {
      const data = await COVERAGE_API.getArea(locationId);
      const { location } = data;
      if (!location.display_name) {
        throw new Error("Missing location");
      }

      const metersToFeet = (value) => value * 3.28084;
      const defaults = {
        segment:
          location.segment_length_feet ||
          (location.segment_length_meters
            ? metersToFeet(location.segment_length_meters)
            : 150),
        buffer:
          location.match_buffer_feet ||
          (location.match_buffer_meters
            ? metersToFeet(location.match_buffer_meters)
            : 25),
        min:
          location.min_match_length_feet ||
          (location.min_match_length_meters
            ? metersToFeet(location.min_match_length_meters)
            : 15),
      };
      const settings = await this.manager._askMatchSettings(
        location.display_name,
        defaults,
      );
      if (settings === null) {
        return;
      }

      location.segment_length_feet = settings.segment;
      location.match_buffer_feet = settings.buffer;
      location.min_match_length_feet = settings.min;

      this.progress.showProgressModal(
        `Reprocessing streets for ${location.display_name} (seg ${settings.segment} ft)...`,
        0,
      );

      const isCustom =
        location.osm_type === "custom" || location.boundary_type === "custom";
      let taskData = null;

      if (isCustom) {
        const geometry =
          location.geojson?.geometry || location.geojson || location.geometry;
        if (!geometry) {
          throw new Error("Custom boundary is missing geometry");
        }
        taskData = await COVERAGE_API.preprocessCustomBoundary({
          display_name: location.display_name,
          area_name: location.display_name,
          geometry,
          segment_length_feet: settings.segment,
          match_buffer_feet: settings.buffer,
          min_match_length_feet: settings.min,
        });
      } else {
        taskData = await COVERAGE_API.preprocessStreets(location);
      }

      this.currentProcessingLocation = location;
      this.progress.currentProcessingLocation = location;
      this.progress.currentTaskId = taskData.task_id;
      this.progress.activeTaskIds.add(taskData.task_id);
      this.progress.saveProcessingState();

      await this.progress.pollCoverageProgress(taskData.task_id);

      this.notificationManager.show(
        `Reprocessing for ${location.display_name} completed.`,
        "success",
      );
      await this.manager.loadCoverageAreas(false, true, false, true);

      // Refresh dashboard if needed
      if (this.manager.dashboard.selectedLocation?._id === locationId) {
        await this.manager.displayCoverageDashboard(locationId);
      }
    } catch (error) {
      console.error("Error reprocessing streets:", error);
      this.notificationManager.show(
        `Failed to reprocess streets: ${error.message}`,
        "danger",
      );
      this.progress.hideProgressModal();
    }
  }

  /**
   * Resume an interrupted task from saved state
   * @param {Object} progressData - Saved progress data from localStorage
   */
  async resumeInterruptedTask(progressData) {
    if (!progressData || !progressData.taskId) {
      this.notificationManager.show("No valid task data to resume.", "warning");
      return;
    }

    const { taskId, location, progress: savedProgress, stage } = progressData;

    if (!location || !location.display_name) {
      this.notificationManager.show(
        "Cannot resume: missing location information.",
        "warning",
      );
      localStorage.removeItem("coverageProcessingState");
      return;
    }

    try {
      // Set up processing context
      this.currentProcessingLocation = location;
      this.progress.currentProcessingLocation = location;
      this.progress.currentTaskId = taskId;
      this.progress.activeTaskIds.add(taskId);
      this.progress._addBeforeUnloadListener();

      // Show progress modal with last known state
      this.progress.showProgressModal(
        `Resuming: ${location.display_name}...`,
        savedProgress || 0,
      );

      // Update modal with saved progress data
      this.progress.modal.updateContent({
        stage: stage || "unknown",
        progress: savedProgress || 0,
        message: `Reconnecting to task...`,
      });

      // Resume polling - this will check the actual server status
      await this.progress.pollCoverageProgress(taskId);

      this.notificationManager.show(
        `Processing for ${location.display_name} completed.`,
        "success",
      );

      // Reload the coverage areas list
      await this.manager.loadCoverageAreas(true, false, false, true);
    } catch (error) {
      console.error("Error resuming interrupted task:", error);
      this.notificationManager.show(
        `Failed to resume task: ${error.message}`,
        "danger",
      );
      this.progress.hideProgressModal();

      // Clean up the saved state if the task truly failed
      localStorage.removeItem("coverageProcessingState");

      // Reload to get current state
      await this.manager.loadCoverageAreas(true, false, false, true);
    }
  }
}
