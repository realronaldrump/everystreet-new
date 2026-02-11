import apiClient from "../../core/api-client.js";
import { swupReady } from "../../core/navigation.js";
import confirmationDialog from "../../ui/confirmation-dialog.js";
import notificationManager from "../../ui/notifications.js";
import { escapeHtml } from "../../utils.js";

export function initDatabaseManagement({ signal } = {}) {
  const refreshStorageBtn = document.getElementById("refresh-storage");
  const storageTotalEl = document.getElementById("storage-total-value");
  const storageDbEl = document.getElementById("storage-db-value");
  const storageUpdatedEl = document.getElementById("storage-updated-at");
  const storageSourcesContainer = document.getElementById("storage-sources-container");
  const storageSortSelect = document.getElementById("storage-sort-select");
  const collectionsSortSelect = document.getElementById("collections-sort-select");

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

  function formatNumber(num) {
    if (!Number.isFinite(num)) {
      return "0";
    }
    if (num >= 1_000_000) {
      return `${(num / 1_000_000).toFixed(1)}M`;
    }
    if (num >= 1_000) {
      return `${(num / 1_000).toFixed(1)}K`;
    }
    return num.toString();
  }

  function setButtonLoading(button, isLoading, action) {
    if (!button) {
      return;
    }

    button.disabled = isLoading;

    if (isLoading) {
      button.innerHTML = '<i class="fas fa-spinner fa-spin"></i>';
    } else {
      switch (action) {
        case "refresh":
          button.innerHTML = '<i class="fas fa-sync-alt"></i>';
          break;
        case "clear":
          button.innerHTML = '<i class="fas fa-trash-alt"></i> Clear';
          break;
        default:
          button.innerHTML = '<i class="fas fa-cog"></i> Manage';
      }
    }
  }

  function performDatabaseAction(endpoint, body = {}) {
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
    const fromDataset =
      button.dataset.collection || button.getAttribute("data-collection");
    if (fromDataset) {
      return fromDataset;
    }
    const card = button.closest(".collection-card");
    const nameEl = card?.querySelector(".collection-name");
    return nameEl?.textContent?.trim() || "";
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

  function getCategoryIcon(category) {
    switch (category?.toLowerCase()) {
      case "docker volume":
        return "fab fa-docker";
      case "cache":
        return "fas fa-bolt";
      case "database":
        return "fas fa-database";
      case "logs":
        return "fas fa-file-alt";
      default:
        return "fas fa-folder";
    }
  }

  function renderStorageSources(sources = []) {
    if (!storageSourcesContainer) {
      return;
    }

    if (!sources.length) {
      storageSourcesContainer.innerHTML = `
        <div class="storage-empty-state">
          <i class="fas fa-inbox"></i>
          <p>No storage sources available.</p>
        </div>
      `;
      return;
    }

    // Calculate max size for bar scaling
    const maxSize = Math.max(...sources.map((s) => s.size_bytes || 0));

    storageSourcesContainer.innerHTML = sources
      .map((source) => {
        const sizeBytes = Number.isFinite(source.size_bytes) ? source.size_bytes : null;
        const sizeDisplay =
          sizeBytes == null
            ? Number.isFinite(source.size_mb)
              ? source.size_mb > 1024
                ? `${(source.size_mb / 1024).toFixed(2)} GB`
                : `${source.size_mb.toFixed(2)} MB`
              : "N/A"
            : formatBytes(sizeBytes);

        const hasError = Boolean(source.error);
        const barWidth = maxSize > 0 && sizeBytes ? (sizeBytes / maxSize) * 100 : 0;
        const iconClass = getCategoryIcon(source.category);

        return `
          <div class="storage-source-card"
               data-source="${escapeHtml(source.label || "")}"
               data-category="${escapeHtml(source.category || "")}"
               data-size="${sizeBytes || 0}">
            <div class="storage-source-header">
              <div class="storage-source-icon">
                <i class="${iconClass}"></i>
              </div>
              <div class="storage-source-info">
                <span class="storage-source-name">${escapeHtml(source.label || "")}</span>
                <span class="storage-source-category">${escapeHtml(source.category || "")}</span>
              </div>
              <div class="storage-source-status">
                ${
                  hasError
                    ? `<span class="status-chip status-error" title="${escapeHtml(source.error)}">
                      <i class="fas fa-exclamation-circle"></i>
                      Error
                    </span>`
                    : `<span class="status-chip status-ok">
                      <i class="fas fa-check-circle"></i>
                      OK
                    </span>`
                }
              </div>
            </div>
            <div class="storage-source-bar-container">
              <div class="storage-source-bar ${hasError ? "has-error" : ""}" style="width: ${barWidth}%" data-size="${sizeBytes || 0}"></div>
            </div>
            <div class="storage-source-footer">
              <span class="storage-source-size">${escapeHtml(sizeDisplay)}</span>
              ${source.detail ? `<span class="storage-source-detail">${escapeHtml(source.detail)}</span>` : ""}
            </div>
          </div>
        `;
      })
      .join("");

    // Animate bars after render
    requestAnimationFrame(() => {
      const bars = storageSourcesContainer.querySelectorAll(".storage-source-bar");
      bars.forEach((bar, index) => {
        setTimeout(() => {
          bar.style.opacity = "1";
        }, index * 50);
      });
    });
  }

  function initializeStorageSources() {
    if (!storageSourcesContainer) {
      return;
    }

    const cards = Array.from(
      storageSourcesContainer.querySelectorAll(".storage-source-card")
    );
    if (!cards.length) {
      return;
    }

    const sizes = cards.map((card) => parseFloat(card.dataset.size) || 0);
    const maxSize = Math.max(...sizes, 0);

    requestAnimationFrame(() => {
      cards.forEach((card, index) => {
        const bar = card.querySelector(".storage-source-bar");
        if (!bar) {
          return;
        }
        const size = parseFloat(card.dataset.size) || 0;
        const barWidth = maxSize > 0 && size ? (size / maxSize) * 100 : 0;
        bar.style.width = `${barWidth}%`;
        setTimeout(() => {
          bar.style.opacity = "1";
        }, index * 50);
      });
    });
  }

  function renderCollections(collections = []) {
    const container = document.getElementById("collections-container");
    if (!container) {
      return;
    }

    if (!collections.length) {
      container.innerHTML = `
        <div class="storage-empty-state">
          <i class="fas fa-inbox"></i>
          <p>No collections available.</p>
        </div>
      `;
      return;
    }

    container.innerHTML = collections
      .map((collection) => {
        const sizeDisplay =
          collection.size_mb != null
            ? collection.size_mb > 1024
              ? `${(collection.size_mb / 1024).toFixed(2)} GB`
              : `${collection.size_mb.toFixed(2)} MB`
            : "N/A";

        return `
          <div class="collection-card"
               data-collection="${escapeHtml(collection.name)}"
               data-count="${collection.document_count}"
               data-size="${collection.size_mb || 0}">
            <div class="collection-card-header">
              <div class="collection-icon">
                <i class="fas fa-table"></i>
              </div>
              <div class="collection-info">
                <span class="collection-name">${escapeHtml(collection.name)}</span>
              </div>
            </div>
            <div class="collection-stats">
              <div class="collection-stat">
                <span class="collection-stat-value">${formatNumber(collection.document_count)}</span>
                <span class="collection-stat-label">Documents</span>
              </div>
              <div class="collection-stat">
                <span class="collection-stat-value">${escapeHtml(sizeDisplay)}</span>
                <span class="collection-stat-label">Size</span>
              </div>
            </div>
            <div class="collection-card-actions">
              <button class="btn btn-outline-danger btn-sm clear-collection"
                      data-collection="${escapeHtml(collection.name)}"
                      title="Clear all documents from this collection">
                <i class="fas fa-trash-alt"></i>
                Clear
              </button>
            </div>
          </div>
        `;
      })
      .join("");
  }

  function sortStorageSources(sortValue) {
    const cards = Array.from(
      storageSourcesContainer?.querySelectorAll(".storage-source-card") || []
    );
    if (!cards.length) {
      return;
    }

    cards.sort((a, b) => {
      const aSize = parseFloat(a.dataset.size) || 0;
      const bSize = parseFloat(b.dataset.size) || 0;
      const aName = a.dataset.source || "";
      const bName = b.dataset.source || "";
      const aCategory = a.dataset.category || "";
      const bCategory = b.dataset.category || "";

      switch (sortValue) {
        case "size-desc":
          return bSize - aSize;
        case "size-asc":
          return aSize - bSize;
        case "name-asc":
          return aName.localeCompare(bName);
        case "name-desc":
          return bName.localeCompare(aName);
        case "category":
          return aCategory.localeCompare(bCategory) || bSize - aSize;
        default:
          return 0;
      }
    });

    cards.forEach((card) => storageSourcesContainer.appendChild(card));
  }

  function sortCollections(sortValue) {
    const container = document.getElementById("collections-container");
    const cards = Array.from(container?.querySelectorAll(".collection-card") || []);
    if (!cards.length) {
      return;
    }

    cards.sort((a, b) => {
      const aSize = parseFloat(a.dataset.size) || 0;
      const bSize = parseFloat(b.dataset.size) || 0;
      const aCount = parseInt(a.dataset.count, 10) || 0;
      const bCount = parseInt(b.dataset.count, 10) || 0;
      const aName = a.dataset.collection || "";
      const bName = b.dataset.collection || "";

      switch (sortValue) {
        case "size-desc":
          return bSize - aSize;
        case "size-asc":
          return aSize - bSize;
        case "name-asc":
          return aName.localeCompare(bName);
        case "name-desc":
          return bName.localeCompare(aName);
        case "count-desc":
          return bCount - aCount;
        case "count-asc":
          return aCount - bCount;
        default:
          return 0;
      }
    });

    cards.forEach((card) => container.appendChild(card));
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
  initializeStorageSources();

  // Refresh button handler
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
          renderCollections(data?.collections || []);
          notificationManager.show(
            "Storage information updated successfully",
            "success"
          );
        } catch (error) {
          notificationManager.show(
            error.message || "Failed to perform storage action",
            "danger"
          );
        } finally {
          setButtonLoading(refreshStorageBtn, false, "refresh");
        }
      },
      signal ? { signal } : false
    );
  }

  // Storage sort handler
  if (storageSortSelect) {
    storageSortSelect.addEventListener("change", (e) => {
      sortStorageSources(e.target.value);
    });
  }

  // Collections sort handler
  if (collectionsSortSelect) {
    collectionsSortSelect.addEventListener("change", (e) => {
      sortCollections(e.target.value);
    });
  }

  // Clear collection handler using event delegation
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
          message: `Are you sure you want to clear all documents from the "${currentCollection}" collection? This action cannot be undone.`,
          confirmButtonClass: "btn-danger",
        });

        if (confirmed) {
          handleConfirmedAction();
        }
      }
    },
    signal ? { signal } : false
  );

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
          swupReady.then((swup) => {
            swup.navigate(window.location.href, {
              cache: { read: false, write: true },
              history: "replace",
            });
          });
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
