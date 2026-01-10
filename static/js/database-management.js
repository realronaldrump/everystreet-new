/* global confirmationDialog, notificationManager */

document.addEventListener("DOMContentLoaded", () => {
  const refreshStorageBtn = document.getElementById("refresh-storage");
  const storageText = document.querySelector(".storage-text");

  let currentAction = null;
  let currentCollection = null;
  let currentButton = null;

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

    if (storageText) {
      storageText.textContent = `Using ${data.used_mb}MB`;
    }
  }

  if (refreshStorageBtn) {
    refreshStorageBtn.addEventListener("mousedown", async (e) => {
      if (e.button !== 0) return;
      try {
        setButtonLoading(refreshStorageBtn, true);
        const data = await performDatabaseAction("/api/database/storage-info");
        updateStorageDisplay(data);
        window.notificationManager.show(
          "Storage information updated successfully",
          "success",
        );
      } catch (error) {
        window.notificationManager.show(
          "Failed to refresh storage information",
          "danger",
        );
        console.error("Error refreshing storage info:", error);
      } finally {
        setButtonLoading(refreshStorageBtn, false);
      }
    });
  }

  document.body.addEventListener("mousedown", async (event) => {
    if (event.button !== 0) return;
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

  // Table Sorting Logic
  const table = document.getElementById("collections-table");
  if (table) {
    const headers = table.querySelectorAll("th[data-sort]");
    let currentSort = { column: null, dir: "asc" };

    headers.forEach((th) => {
      th.addEventListener("click", () => {
        const column = th.dataset.sort;
        const dir =
          currentSort.column === column && currentSort.dir === "asc"
            ? "desc"
            : "asc";

        // Update Sort State
        currentSort = { column, dir };

        // Update Icons
        headers.forEach((h) => {
          const icon = h.querySelector("i");
          if (icon) {
            icon.className = "fas fa-sort small text-muted ms-1";
            if (h === th) {
              icon.className = `fas fa-sort-${dir === "asc" ? "up" : "down"} small text-primary ms-1`;
            }
          }
        });

        // Sort Rows
        const tbody = table.querySelector("tbody");
        const rows = Array.from(tbody.querySelectorAll("tr"));

        rows.sort((a, b) => {
          const aVal =
            a.querySelector(`td[data-value]`).parentElement.children[
              th.cellIndex
            ].dataset.value;
          const bVal =
            b.querySelector(`td[data-value]`).parentElement.children[
              th.cellIndex
            ].dataset.value;

          let comparison = 0;
          if (column === "name") {
            comparison = aVal.localeCompare(bVal);
          } else {
            // Numeric sort for count and size
            comparison = parseFloat(aVal) - parseFloat(bVal);
          }

          return dir === "asc" ? comparison : -comparison;
        });

        // Re-append sorted rows
        rows.forEach((row) => tbody.appendChild(row));
      });
    });
  }

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
      window.notificationManager.show(
        result.message || "Operation completed successfully",
        "success",
      );

      setTimeout(() => window.location.reload(), 1500);
    } catch (error) {
      window.notificationManager.show(
        error.message || "Failed to perform database action",
        "danger",
      );
      console.error("Error performing database action:", error);
      setButtonLoading(currentButton, false, currentAction);
    }
  }
});
