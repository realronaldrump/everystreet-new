import apiClient from "../../core/api-client.js";
import confirmationDialog from "../../ui/confirmation-dialog.js";
import notificationManager from "../../ui/notifications.js";
import { escapeHtml } from "../../utils.js";

export function initDatabaseManagement({ signal } = {}) {
  const refreshStorageBtn = document.getElementById("refresh-storage");
  const storageTotalEl = document.getElementById("storage-total-value");
  const storageDbEl = document.getElementById("storage-db-value");
  const storageUpdatedEl = document.getElementById("storage-updated-at");
  const storageSourcesTable = document.getElementById("storage-sources-table");

  let currentAction = null;
  let currentCollection = null;
  let currentButton = null;

  const withSignal = (options = {}) => (signal ? { ...options, signal } : options);

  function formatBytes(bytes) {
    if (!Number.isFinite(bytes) || bytes <= 0) {
      return "0 B";
    }
    const units = ["B", "KB", "MB", "GB", "TB"];
    let value = bytes;
    let unitIndex = 0;
    while (value >= 1024 && unitIndex < units.length - 1) {
      value /= 1024;
      unitIndex += 1;
    }
    const precision = value >= 100 || unitIndex === 0 ? 0 : value >= 10 ? 1 : 2;
    return `${value.toFixed(precision)} ${units[unitIndex]}`;
  }

  function formatTimestamp(value) {
    if (!value) {
      return "N/A";
    }
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) {
      return value;
    }
    return date.toLocaleString();
  }

  function setButtonLoading(button, isLoading, action) {
    if (!button) {
      return;
    }

    button.disabled = isLoading;

    if (isLoading) {
      button.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Processing...';
    } else {
      switch (action) {
        case "refresh":
          button.innerHTML = '<i class="fas fa-sync-alt"></i> Refresh Storage Info';
          break;
        case "clear":
          button.innerHTML = '<i class="fas fa-trash"></i> Clear';
          break;
        default:
          button.innerHTML = '<i class="fas fa-cog"></i> Manage';
      }
    }
  }

  async function performDatabaseAction(endpoint, body = {}) {
    const method = endpoint.includes("storage") ? "GET" : "POST";
    if (method === "GET") {
      return apiClient.get(endpoint, withSignal());
    }
    return apiClient.post(endpoint, body, withSignal());
  }

  function resolveCollectionName(button) {
    if (!button) {
      return "";
    }
    const fromDataset
      = button.dataset.collection || button.getAttribute("data-collection");
    if (fromDataset) {
      return fromDataset;
    }
    const row = button.closest("tr");
    const cell = row?.querySelector("td[data-value]") || row?.querySelector("td");
    return cell?.dataset?.value || cell?.textContent?.trim() || "";
  }

  function updateStorageSummary(data) {
    if (!data) {
      return;
    }
    if (storageTotalEl) {
      const totalBytes = Number.isFinite(data.total_bytes)
        ? data.total_bytes
        : Number.isFinite(data.used_mb)
          ? data.used_mb * 1024 * 1024
          : null;
      storageTotalEl.textContent = totalBytes == null ? "N/A" : formatBytes(totalBytes);
      if (Number.isFinite(totalBytes)) {
        storageTotalEl.dataset.bytes = String(totalBytes);
      }
    }
    if (storageDbEl) {
      const dbBytes = Number.isFinite(data.database_logical_bytes)
        ? data.database_logical_bytes
        : Number.isFinite(data.database_logical_mb)
          ? data.database_logical_mb * 1024 * 1024
          : null;
      storageDbEl.textContent = dbBytes == null ? "N/A" : formatBytes(dbBytes);
      if (Number.isFinite(dbBytes)) {
        storageDbEl.dataset.bytes = String(dbBytes);
      }
    }
    if (storageUpdatedEl) {
      const iso = data.updated_at || "";
      storageUpdatedEl.textContent = formatTimestamp(iso);
      storageUpdatedEl.dataset.iso = iso;
    }
  }

  function renderStorageSources(sources = []) {
    if (!storageSourcesTable) {
      return;
    }
    const tbody = storageSourcesTable.querySelector("tbody");
    if (!tbody) {
      return;
    }
    if (!sources.length) {
      tbody.innerHTML
        = '<tr><td colspan="5" class="text-muted">No storage sources available.</td></tr>';
      return;
    }

    tbody.innerHTML = sources
      .map((source) => {
        const sizeBytes = Number.isFinite(source.size_bytes) ? source.size_bytes : null;
        const sizeDisplay
          = sizeBytes == null
            ? Number.isFinite(source.size_mb)
              ? source.size_mb > 1024
                ? `${(source.size_mb / 1024).toFixed(2)} GB`
                : `${source.size_mb.toFixed(2)} MB`
              : "N/A"
            : formatBytes(sizeBytes);
        const status = source.error ? "Error" : "OK";
        const statusBadge = source.error
          ? '<span class="badge bg-danger">Error</span>'
          : '<span class="badge bg-success">OK</span>';
        const detailText = source.detail ? escapeHtml(source.detail) : "--";
        const errorText = source.error
          ? `<div class="text-muted small">${escapeHtml(source.error)}</div>`
          : "";
        return `
          <tr>
            <td data-label="Source" data-value="${escapeHtml(source.label || "")}" class="fw-medium">
              ${escapeHtml(source.label || "")}
            </td>
            <td data-label="Category" data-value="${escapeHtml(source.category || "")}">
              ${escapeHtml(source.category || "")}
            </td>
            <td data-label="Size" data-value="${sizeBytes || 0}" class="text-end">
              ${escapeHtml(sizeDisplay)}
            </td>
            <td data-label="Details" data-value="${escapeHtml(source.detail || "")}">
              <span class="text-muted small">${detailText}</span>
            </td>
            <td data-label="Status" data-value="${status}">
              ${statusBadge}
              ${errorText}
            </td>
          </tr>
        `;
      })
      .join("");
  }

  function hydrateInitialStorage() {
    if (storageTotalEl?.dataset?.bytes) {
      const bytes = Number(storageTotalEl.dataset.bytes);
      if (Number.isFinite(bytes)) {
        storageTotalEl.textContent = formatBytes(bytes);
      }
    }
    if (storageDbEl?.dataset?.bytes) {
      const bytes = Number(storageDbEl.dataset.bytes);
      if (Number.isFinite(bytes)) {
        storageDbEl.textContent = formatBytes(bytes);
      }
    }
    if (storageUpdatedEl?.dataset?.iso) {
      storageUpdatedEl.textContent = formatTimestamp(storageUpdatedEl.dataset.iso);
    }
  }

  hydrateInitialStorage();

  if (refreshStorageBtn) {
    refreshStorageBtn.addEventListener(
      "click",
      async (e) => {
        if (typeof e.button === "number" && e.button !== 0) {
          return;
        }
        try {
          setButtonLoading(refreshStorageBtn, true, "refresh");
          const data = await performDatabaseAction("/api/storage/summary");
          updateStorageSummary(data);
          renderStorageSources(data?.sources || []);
          notificationManager.show(
            "Storage information updated successfully",
            "success"
          );
        } catch (error) {
          notificationManager.show(
            error.message || "Failed to perform storage action",
            "danger"
          );
          setButtonLoading(currentButton, false, currentAction);
        } finally {
          setButtonLoading(refreshStorageBtn, false, "refresh");
        }
      },
      signal ? { signal } : false
    );
  }

  document.body.addEventListener(
    "click",
    async (event) => {
      if (typeof event.button === "number" && event.button !== 0) {
        return;
      }
      const clearButton = event.target.closest(".clear-collection");

      if (clearButton) {
        currentAction = "clear";
        currentCollection = resolveCollectionName(clearButton);
        currentButton = clearButton;

        if (!currentCollection) {
          notificationManager.show(
            "Could not determine which collection to clear.",
            "danger"
          );
          return;
        }

        const confirmed = await confirmationDialog.show({
          message: `Are you sure you want to clear all documents from the ${currentCollection} collection? This action cannot be undone.`,
          confirmButtonClass: "btn-danger",
        });

        if (confirmed) {
          handleConfirmedAction();
        }
      }
    },
    signal ? { signal } : false
  );

  function setupSortableTable(table) {
    if (!table) {
      return;
    }
    const headers = table.querySelectorAll("th[data-sort]");
    if (!headers.length) {
      return;
    }
    let currentSort = { column: null, dir: "asc" };
    const numericColumns = new Set(["count", "size"]);
    const eventOptions = signal ? { signal } : false;

    headers.forEach((th) => {
      th.addEventListener(
        "click",
        () => {
          const column = th.dataset.sort;
          const dir
            = currentSort.column === column && currentSort.dir === "asc" ? "desc" : "asc";

          currentSort = { column, dir };

          headers.forEach((h) => {
            const icon = h.querySelector("i");
            if (icon) {
              icon.className = "fas fa-sort small text-muted ms-1";
              if (h === th) {
                icon.className = `fas fa-sort-${dir === "asc" ? "up" : "down"} small text-primary ms-1`;
              }
            }
          });

          const tbody = table.querySelector("tbody");
          if (!tbody) {
            return;
          }
          const rows = Array.from(tbody.querySelectorAll("tr"));

          rows.sort((a, b) => {
            const aCell = a.children[th.cellIndex];
            const bCell = b.children[th.cellIndex];
            const aVal = aCell?.dataset?.value ?? aCell?.textContent?.trim() ?? "";
            const bVal = bCell?.dataset?.value ?? bCell?.textContent?.trim() ?? "";

            if (numericColumns.has(column)) {
              const aNum = parseFloat(aVal) || 0;
              const bNum = parseFloat(bVal) || 0;
              return dir === "asc" ? aNum - bNum : bNum - aNum;
            }
            return dir === "asc" ? aVal.localeCompare(bVal) : bVal.localeCompare(aVal);
          });

          rows.forEach((row) => {
            tbody.appendChild(row);
          });
        },
        eventOptions
      );
    });
  }

  setupSortableTable(storageSourcesTable);
  setupSortableTable(document.getElementById("collections-table"));

  async function handleConfirmedAction() {
    try {
      let endpoint = "";
      let body = {};

      if (currentAction === "clear") {
        endpoint = `/api/database/clear-collection?collection=${encodeURIComponent(
          currentCollection
        )}`;
        body = { collection: currentCollection };
      } else {
        throw new Error("Invalid action");
      }

      setButtonLoading(currentButton, true, currentAction);
      const result = await performDatabaseAction(endpoint, body);
      notificationManager.show(
        result.message || "Operation completed successfully",
        "success"
      );

      setTimeout(() => {
        if (!signal?.aborted) {
          window.location.reload();
        }
      }, 1500);
    } catch (error) {
      notificationManager.show(
        error.message || "Failed to perform storage action",
        "danger"
      );
      setButtonLoading(currentButton, false, currentAction);
    }
  }
}
