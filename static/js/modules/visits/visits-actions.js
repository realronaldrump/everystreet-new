/* global bootstrap */

/**
 * Visits Actions Module
 * Handles CRUD operations for places (save, delete, update)
 */

(() => {
  class VisitsActions {
    constructor(options = {}) {
      this.loadingManager = options.loadingManager || window.loadingManager;
      this.notificationManager =
        options.notificationManager || window.notificationManager;
      this.confirmationDialog =
        options.confirmationDialog || window.confirmationDialog;
    }

    /**
     * Save a new place
     * @param {Object} params - Save parameters
     * @param {string} params.name - Place name
     * @param {Object} params.geometry - Place geometry
     * @param {Function} params.onSuccess - Success callback (receives savedPlace)
     * @param {Function} params.onComplete - Completion callback
     * @returns {Promise<Object|null>} Saved place or null on failure
     */
    async savePlace({ name, geometry, onSuccess, onComplete }) {
      const placeNameInput = document.getElementById("place-name");

      if (!name) {
        this._showInputError(
          placeNameInput,
          "Please enter a name for the place.",
        );
        return null;
      }

      if (!geometry) {
        this.notificationManager?.show(
          "Please draw a boundary for the place first.",
          "warning",
        );
        return null;
      }

      const saveBtn = document.getElementById("save-place");
      saveBtn?.classList.add("loading");
      if (saveBtn) {
        saveBtn.innerHTML =
          '<span class="spinner-border spinner-border-sm me-2"></span>Saving...';
      }

      this.loadingManager?.show("Saving Place");

      try {
        const savedPlace = await window.VisitsDataService.createPlace({
          name,
          geometry,
        });

        this.notificationManager?.show(
          `Place "${name}" saved successfully!`,
          "success",
        );

        if (onSuccess) {
          await onSuccess(savedPlace);
        }

        return savedPlace;
      } catch (error) {
        console.error("Error saving place:", error);
        this.notificationManager?.show(
          "Failed to save place. Please try again.",
          "danger",
        );
        return null;
      } finally {
        saveBtn?.classList.remove("loading");
        if (saveBtn) {
          saveBtn.innerHTML =
            '<i class="fas fa-save me-2"></i><span>Save Place</span>';
        }
        this.loadingManager?.hide();
        if (onComplete) {
          onComplete();
        }
      }
    }

    /**
     * Delete a place
     * @param {string} placeId - Place ID to delete
     * @param {Object} place - Place data
     * @param {Function} onSuccess - Success callback
     * @returns {Promise<boolean>} Whether deletion was successful
     */
    async deletePlace(placeId, place, onSuccess) {
      if (!place) {
        this.notificationManager?.show(
          "Attempted to delete non-existent place.",
          "warning",
        );
        return false;
      }

      let confirmed = false;
      if (this.confirmationDialog) {
        confirmed = await this.confirmationDialog.show({
          title: "Delete Place",
          message: `Are you sure you want to delete the place "<strong>${place.name}</strong>"? This cannot be undone.`,
          confirmText: "Delete",
          confirmButtonClass: "btn-danger",
        });
      } else {
        confirmed = true;
      }

      if (!confirmed) {
        return false;
      }

      this.loadingManager?.show("Deleting Place");

      try {
        await window.VisitsDataService.deletePlace(placeId);

        this.notificationManager?.show(
          `Place "${place.name}" deleted successfully.`,
          "success",
        );

        if (onSuccess) {
          await onSuccess();
        }

        return true;
      } catch (error) {
        console.error("Error deleting place:", error);
        this.notificationManager?.show(
          "Failed to delete place. Please try again.",
          "danger",
        );
        return false;
      } finally {
        this.loadingManager?.hide();
      }
    }

    /**
     * Update an existing place
     * @param {Object} params - Update parameters
     * @param {string} params.placeId - Place ID
     * @param {string} params.newName - New place name
     * @param {Object} params.place - Current place data
     * @param {Object} params.newGeometry - New geometry (optional)
     * @param {Function} params.onSuccess - Success callback (receives updatedPlace)
     * @returns {Promise<Object|null>} Updated place or null on failure
     */
    async saveEditedPlace({ placeId, newName, place, newGeometry, onSuccess }) {
      if (!placeId || !newName) {
        this.notificationManager?.show(
          "Place ID or Name is missing.",
          "warning",
        );
        document.getElementById("edit-place-name")?.focus();
        return null;
      }

      if (!place) {
        this.notificationManager?.show(
          "Cannot find place to update.",
          "danger",
        );
        return null;
      }

      this.loadingManager?.show("Updating Place");

      try {
        const requestBody = { name: newName };

        if (newGeometry) {
          requestBody.geometry = newGeometry;
        }

        const updatedPlace = await window.VisitsDataService.updatePlace(
          placeId,
          requestBody,
        );

        const modalEl = document.getElementById("edit-place-modal");
        if (modalEl) {
          const modal = bootstrap.Modal.getInstance(modalEl);
          modal?.hide();
        }

        this.notificationManager?.show(
          `Place "${newName}" updated successfully.`,
          "success",
        );

        if (onSuccess) {
          await onSuccess(updatedPlace, Boolean(newGeometry));
        }

        return updatedPlace;
      } catch (error) {
        console.error("Error updating place:", error);
        this.notificationManager?.show(
          "Failed to update place. Please try again.",
          "danger",
        );
        return null;
      } finally {
        this.loadingManager?.hide();
      }
    }

    /**
     * Show input validation error
     * @param {HTMLElement} inputElement - Input element
     * @param {string} message - Error message
     */
    _showInputError(inputElement, message) {
      if (inputElement) {
        inputElement.classList.add("is-invalid");
        inputElement.focus();
      }
      this.notificationManager?.show(message, "warning");
    }
  }

  window.VisitsActions = VisitsActions;
})();
