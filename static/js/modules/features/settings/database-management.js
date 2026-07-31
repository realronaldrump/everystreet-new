import apiClient from "../../core/api-client.js";
import { withSignal as withAbortSignal } from "../../core/feature-api.js";
import notificationManager from "../../ui/notifications.js";
import { formatBytes, formatDateTime } from "../../utils/formatting.js";
import { escapeHtml } from "../../utils.js";

function hasFiniteNumericAttribute(value) {
  if (value == null) {
    return false;
  }
  const normalized = String(value).trim();
  if (!normalized) {
    return false;
  }
  const parsed = Number(normalized);
  return Number.isFinite(parsed);
}

export function initDatabaseManagement({ signal } = {}) {
  const refreshStorageBtn = document.getElementById("refresh-storage");
  const storageTabButton = document.querySelector(".settings-tab[data-tab='storage']");
  const storageTabContent = document.getElementById("storage-tab");
  const storageTotalEl = document.getElementById("storage-total-value");
  const storageDbEl = document.getElementById("storage-db-value");
  const storageUpdatedEl = document.getElementById("storage-updated-at");
  const storageSourcesContainer = document.getElementById("storage-sources-container");
  const storageSortSelect = document.getElementById("storage-sort-select");

  let storageSummaryLoading = false;

  const hasInitialStorageSummary =
    hasFiniteNumericAttribute(storageTotalEl?.dataset?.bytes) ||
    hasFiniteNumericAttribute(storageDbEl?.dataset?.bytes) ||
    Boolean(storageSourcesContainer?.querySelector(".storage-source-card"));
  let storageSummaryLoaded = hasInitialStorageSummary;

  function formatStorageTimestamp(value) {
    return formatDateTime(value, {
      default: "N/A",
      invalid: value,
      locale: null,
      formatOptions: null,
    });
  }

  function setButtonLoading(button, isLoading) {
    if (!button) {
      return;
    }

    button.disabled = isLoading;
    button.innerHTML = isLoading
      ? '<i class="fas fa-spinner fa-spin"></i>'
      : '<i class="fas fa-sync-alt"></i>';
  }

  function performDatabaseAction(endpoint) {
    return apiClient.get(endpoint, withAbortSignal(signal));
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
      storageUpdatedEl.textContent = formatStorageTimestamp(iso);
      storageUpdatedEl.dataset.iso = iso;
    }
  }

  function getCategoryIcon(category) {
    switch (category?.toLowerCase()) {
      case "docker volume":
        return "fab fa-docker";
      case "app cache":
      case "cache":
        return "fas fa-bolt";
      case "app data":
        return "fas fa-folder";
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
      storageUpdatedEl.textContent = formatStorageTimestamp(
        storageUpdatedEl.dataset.iso
      );
    }
  }

  function isStorageTabActive() {
    return storageTabContent?.classList.contains("active") === true;
  }

  async function loadStorageSummary({
    force = false,
    showNotification = false,
    showLoading = true,
  } = {}) {
    if ((!force && storageSummaryLoaded) || storageSummaryLoading) {
      return;
    }

    storageSummaryLoading = true;
    if (showLoading && refreshStorageBtn) {
      setButtonLoading(refreshStorageBtn, true);
    }

    try {
      const data = await performDatabaseAction("/api/storage/summary");
      updateStorageSummary(data);
      renderStorageSources(data?.sources || []);

      if (storageSortSelect?.value) {
        sortStorageSources(storageSortSelect.value);
      }

      storageSummaryLoaded = true;
      if (showNotification) {
        notificationManager.show("Storage information updated successfully", "success");
      }
    } catch (error) {
      notificationManager.show(
        error.message || "Failed to perform storage action",
        "danger"
      );
    } finally {
      storageSummaryLoading = false;
      if (showLoading && refreshStorageBtn) {
        setButtonLoading(refreshStorageBtn, false);
      }
    }
  }

  hydrateInitialStorage();
  initializeStorageSources();

  if (isStorageTabActive() && !storageSummaryLoaded) {
    loadStorageSummary({ showLoading: true });
  }

  if (storageTabButton) {
    storageTabButton.addEventListener(
      "click",
      () => {
        if (!storageSummaryLoaded) {
          loadStorageSummary({ showLoading: true });
        }
      },
      signal ? { signal } : false
    );
  }

  window.addEventListener(
    "hashchange",
    () => {
      if (window.location.hash === "#storage" && !storageSummaryLoaded) {
        loadStorageSummary({ showLoading: true });
      }
    },
    signal ? { signal } : false
  );

  // Refresh button handler
  if (refreshStorageBtn) {
    refreshStorageBtn.addEventListener(
      "click",
      async (e) => {
        if (typeof e.button === "number" && e.button !== 0) {
          return;
        }
        await loadStorageSummary({
          force: true,
          showNotification: true,
          showLoading: true,
        });
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
}
