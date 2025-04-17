/* global confirmationDialog */

document.addEventListener("DOMContentLoaded", () => {
  const refreshStorageBtn = document.getElementById("refresh-storage");
  const progressBar = document.querySelector(".progress-bar");
  const storageText = document.querySelector(".storage-text");

  let currentAction = null;
  let currentCollection = null;
  let currentButton = null;

  function showNotification(message, type = "info") {
    if (window.notificationManager) {
      window.notificationManager.show(message, type);
    } else {
      window.handleError(`${type.toUpperCase()}: ${message}`);
    }
  }

  function setButtonLoading(button, isLoading, action) {
    if (!button) return;

    button.disabled = isLoading;

    if (isLoading) {
      button.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Processing...';
    } else {
      switch (action) {
        case "clear":
          button.innerHTML = '<i class="fas fa-trash"></i> Clear';
          break;
        default:
          button.innerHTML = '<i class="fas fa-cog"></i> Manage';
      }
    }
  }

  async function performDatabaseAction(endpoint, body = {}) {
    const method = endpoint.includes("storage-info") ? "GET" : "POST";

    const options = {
      method,
      headers: {
        "Content-Type": "application/json",
      },
    };

    if (method === "POST") {
      options.body = JSON.stringify(body);
    }

    const response = await fetch(endpoint, options);

    if (!response.ok) {
      const errorData = await response.json();
      throw new Error(
        errorData.detail || `HTTP error! status: ${response.status}`,
      );
    }

    return response.json();
  }

  function updateStorageDisplay(data) {
    if (!data) return;

    if (progressBar) {
      progressBar.style.width = `${data.usage_percent}%`;
      progressBar.setAttribute("aria-valuenow", data.usage_percent);
      progressBar.textContent = `${data.usage_percent}%`;

      progressBar.classList.remove("bg-danger", "bg-warning", "bg-success");

      if (data.usage_percent > 95) {
        progressBar.classList.add("bg-danger");
      } else if (data.usage_percent > 80) {
        progressBar.classList.add("bg-warning");
      } else {
        progressBar.classList.add("bg-success");
      }
    }

    if (storageText) {
      storageText.textContent = `Using ${data.used_mb}MB of ${data.limit_mb}MB`;
    }
  }

  if (refreshStorageBtn) {
    refreshStorageBtn.addEventListener("click", async () => {
      try {
        setButtonLoading(refreshStorageBtn, true);
        const data = await performDatabaseAction("/api/database/storage-info");
        updateStorageDisplay(data);
        showNotification("Storage information updated successfully", "success");
      } catch (error) {
        showNotification("Failed to refresh storage information", "danger");
        console.error("Error refreshing storage info:", error);
      } finally {
        setButtonLoading(refreshStorageBtn, false);
      }
    });
  }

  document.body.addEventListener("click", async (event) => {
    const clearButton = event.target.closest(".clear-collection");

    if (clearButton) {
      currentAction = "clear";
      currentCollection = clearButton.dataset.collection;
      currentButton = clearButton;

      const confirmed = await confirmationDialog.show({
        message: `Are you sure you want to clear all documents from the ${currentCollection} collection? This action cannot be undone.`,
        confirmButtonClass: "btn-danger",
      });

      if (confirmed) {
        handleConfirmedAction();
      }
    }
  });

  async function handleConfirmedAction() {
    try {
      let endpoint = "";
      let body = {};

      if (currentAction === "clear") {
        endpoint = "/api/database/clear-collection";
        body = { collection: currentCollection };
      } else {
        throw new Error("Invalid action");
      }

      setButtonLoading(currentButton, true, currentAction);
      const result = await performDatabaseAction(endpoint, body);
      showNotification(
        result.message || "Operation completed successfully",
        "success",
      );

      setTimeout(() => window.location.reload(), 1500);
    } catch (error) {
      showNotification(
        error.message || "Failed to perform database action",
        "danger",
      );
      console.error("Error performing database action:", error);
      setButtonLoading(currentButton, false, currentAction);
    }
  }
});
