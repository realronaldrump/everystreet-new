/* global bootstrap, notificationManager, confirmationDialog */

document.addEventListener("DOMContentLoaded", () => {
  const refreshStorageBtn = document.getElementById("refresh-storage");
  const optimizeAllBtn = document.getElementById("optimize-all");
  const repairIndexesBtn = document.getElementById("repair-indexes");
  const progressBar = document.querySelector(".progress-bar");
  const storageText = document.querySelector(".storage-text");

  let currentAction = null;
  let currentCollection = null;
  let currentButton = null;

  /**
   * Displays a notification to the user. Uses the custom notificationManager.
   *
   * @param {string} message The message to display.
   * @param {'success' | 'danger' | 'info' | 'warning'} type The type of notification (success, danger, info, warning).
   */
  function showNotification(message, type) {
    if (notificationManager) {
      notificationManager.show(message, type);
    } else {
      // Extremely unlikely to happen, but keeping a fallback for completeness.
      console.error(`Notification Manager not available.  ${type}: ${message}`);
    }
  }

  /**
   * Sets the loading state of a button.
   *
   * @param {HTMLButtonElement} button The button element.
   * @param {boolean} isLoading Whether the button should be in a loading state.
   * @param {string} [action] The action being performed (for button text).
   */
  function setButtonLoading(button, isLoading, action) {
    if (!button) return;

    button.disabled = isLoading;

    if (isLoading) {
      button.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Processing...';
    } else {
      switch (action) {
        case "optimize-all":
          button.innerHTML =
            '<i class="fas fa-compress-arrows-alt"></i> Optimize All Collections';
          break;
        case "repair-indexes":
          button.innerHTML = '<i class="fas fa-tools"></i> Repair Indexes';
          break;
        case "optimize":
          button.innerHTML =
            '<i class="fas fa-compress-arrows-alt"></i> Optimize';
          break;
        case "clear":
          button.innerHTML = '<i class="fas fa-trash"></i> Clear';
          break;
        default:
          button.innerHTML = '<i class="fas fa-cog"></i> Manage';
      }
    }
  }

  /**
   * Performs a database action by making a POST request to the specified endpoint.
   *
   * @param {string} endpoint The API endpoint.
   * @param {object} [body={}] The request body.
   * @returns {Promise<object>} The JSON response from the server.
   * @throws {Error} If the request fails or the response is not OK.
   */
  async function performDatabaseAction(endpoint, body = {}) {
    const response = await fetch(endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      const errorData = await response.json();
      throw new Error(
        errorData.detail || `HTTP error! status: ${response.status}`
      );
    }

    return response.json();
  }

  /**
   * Updates the storage information display.
   * @param {object} data - The storage information data.
   * @param {number} data.usage_percent - The percentage of storage used.
   * @param {number} data.used_mb - The amount of storage used in MB.
   * @param {number} data.limit_mb - The total storage limit in MB.
   */
  function updateStorageDisplay(data) {
    if (progressBar) {
      progressBar.style.width = `${data.usage_percent}%`;
      progressBar.setAttribute("aria-valuenow", data.usage_percent);
      progressBar.textContent = `${data.usage_percent}%`;

      progressBar.classList.toggle("bg-danger", data.usage_percent > 95);
      progressBar.classList.toggle(
        "bg-warning",
        data.usage_percent > 80 && data.usage_percent <= 95
      );
      progressBar.classList.toggle("bg-success", data.usage_percent <= 80);
    }

    if (storageText) {
      storageText.textContent = `Using ${data.used_mb}MB of ${data.limit_mb}MB`;
    }
  }

  // Refresh storage info
  refreshStorageBtn?.addEventListener("click", async () => {
    try {
      setButtonLoading(refreshStorageBtn, true);
      const data = await performDatabaseAction("/api/database/storage-info");
      updateStorageDisplay(data);
      showNotification("Storage information updated successfully", "success");
    } catch (error) {
      showNotification("Failed to refresh storage information", "danger");
      // Log the error to the *console* (server-side, presumably) for debugging.
      console.error("Error refreshing storage info:", error);
    } finally {
      setButtonLoading(refreshStorageBtn, false);
    }
  });

  // Optimize/Clear collection buttons (using event delegation)
  document.body.addEventListener("click", async (event) => {
    const optimizeButton = event.target.closest(".optimize-collection");
    const clearButton = event.target.closest(".clear-collection");

    if (optimizeButton) {
      currentAction = "optimize";
      currentCollection = optimizeButton.dataset.collection;
      currentButton = optimizeButton;
      const confirmed = await confirmationDialog.show({
        message: `Are you sure you want to optimize the ${currentCollection} collection?`,
      });
      if (confirmed) {
        handleConfirmedAction();
      }
    } else if (clearButton) {
      currentAction = "clear";
      currentCollection = clearButton.dataset.collection;
      currentButton = clearButton;
      const confirmed = await confirmationDialog.show({
        message: `Are you sure you want to clear all documents from the ${currentCollection} collection? This action cannot be undone.`,
        confirmButtonClass: "btn-danger", // Use a danger button for destructive actions
      });
      if (confirmed) {
        handleConfirmedAction();
      }
    }
  });

  // Optimize all collections
  optimizeAllBtn?.addEventListener("click", async () => {
    currentAction = "optimize-all";
    currentButton = optimizeAllBtn;
    const confirmed = await confirmationDialog.show({
      message:
        "Are you sure you want to optimize all collections? This may take a while.",
    });
    if (confirmed) {
      handleConfirmedAction();
    }
  });

  // Repair indexes
  repairIndexesBtn?.addEventListener("click", async () => {
    currentAction = "repair-indexes";
    currentButton = repairIndexesBtn;
    const confirmed = await confirmationDialog.show({
      message: "Are you sure you want to repair all database indexes?",
    });
    if (confirmed) {
      handleConfirmedAction();
    }
  });

  async function handleConfirmedAction() {
    try {
      let endpoint = "";
      let body = {};

      switch (currentAction) {
        case "optimize":
          endpoint = "/api/database/optimize-collection";
          body = { collection: currentCollection };
          break;
        case "clear":
          endpoint = "/api/database/clear-collection";
          body = { collection: currentCollection };
          break;
        case "optimize-all":
          endpoint = "/api/database/optimize-all";
          break;
        case "repair-indexes":
          endpoint = "/api/database/repair-indexes";
          break;
        default:
          throw new Error("Invalid action");
      }

      setButtonLoading(currentButton, true, currentAction);
      const result = await performDatabaseAction(endpoint, body);
      showNotification(
        result.message || "Operation completed successfully",
        "success"
      );

      setTimeout(() => window.location.reload(), 1500);
    } catch (error) {
      showNotification(
        error.message || "Failed to perform database action",
        "danger"
      );
      console.error("Error performing database action:", error); // Log to console for debugging
      setButtonLoading(currentButton, false, currentAction);
    }
  }
});
