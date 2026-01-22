/* global bootstrap */

import apiClient from "./core/api-client.js";
import { CONFIG } from "./core/config.js";
import notificationManager from "./ui/notifications.js";
import { formatDateTime } from "./utils.js";

const STATE_META = {
  idle: {
    label: "Up to date",
    icon: "fas fa-check-circle",
    tone: "success",
  },
  syncing: {
    label: "Syncing",
    icon: "fas fa-sync fa-spin",
    tone: "info",
  },
  error: {
    label: "Needs attention",
    icon: "fas fa-triangle-exclamation",
    tone: "warning",
  },
  paused: {
    label: "Sync paused",
    icon: "fas fa-pause-circle",
    tone: "muted",
  },
  offline: {
    label: "Offline",
    icon: "fas fa-wifi-slash",
    tone: "muted",
  },
};

let currentStatus = null;
let pollingInterval = null;
let eventSource = null;
let autoSyncTriggered = false;

const POLL_INTERVAL_MS = 15000;

const getElement = (id) => document.getElementById(id);

function setText(el, value) {
  if (el) {
    el.textContent = value;
  }
}

function formatTimestamp(value) {
  if (!value) {
    return "--";
  }
  try {
    return formatDateTime(value);
  } catch {
    return new Date(value).toLocaleString();
  }
}

function setButtonsDisabled(disabled, elements) {
  [elements.syncButton, elements.historyButton, elements.emptyButton].forEach((btn) => {
    if (btn) {
      btn.disabled = disabled;
    }
  });
}

function updateStatusUI(status, elements) {
  if (!elements.pill) {
    return;
  }

  const meta = STATE_META[status.state] || STATE_META.idle;
  elements.pill.dataset.state = status.state;
  elements.pill.dataset.tone = meta.tone;
  elements.pill.innerHTML = `<i class="${meta.icon}"></i><span>${meta.label}</span>`;

  setText(
    elements.statusText,
    status.state === "syncing"
      ? "Refreshing trips in the background."
      : status.state === "paused"
        ? "Sync is paused. You can still browse stored trips."
        : status.state === "error"
          ? "Sync needs attention."
          : "Trips are ready to explore."
  );

  setText(elements.lastSuccess, formatTimestamp(status.last_success_at));
  setText(elements.lastAttempt, formatTimestamp(status.last_attempt_at));

  const hasError = status.state === "error" || status.state === "paused";
  if (elements.errorBanner) {
    elements.errorBanner.classList.toggle("d-none", !hasError);
  }
  if (hasError) {
    const errorMessage = status.error?.message || "Sync needs attention.";
    setText(elements.errorMessage, errorMessage);
    if (elements.errorCta) {
      elements.errorCta.textContent = status.error?.cta_label || "Review";
      elements.errorCta.href = status.error?.cta_href || "/settings#sync-settings";
    }
  }

  const showEmpty = status.trip_count === 0 && status.state !== "syncing";
  if (elements.emptyState) {
    elements.emptyState.classList.toggle("d-none", !showEmpty);
  }

  setButtonsDisabled(status.state === "syncing" || status.state === "paused", elements);
}

function updateOfflineUI(elements) {
  const meta = STATE_META.offline;
  if (elements.pill) {
    elements.pill.dataset.state = "offline";
    elements.pill.dataset.tone = meta.tone;
    elements.pill.innerHTML = `<i class="${meta.icon}"></i><span>${meta.label}</span>`;
  }
  setText(elements.statusText, "You appear to be offline. Sync will resume online.");
  setButtonsDisabled(true, elements);
}

function shouldAutoSync(status) {
  if (!status || status.state !== "idle" || autoSyncTriggered) {
    return false;
  }
  if (status.auto_sync_enabled === false) {
    return false;
  }
  if (!status.last_success_at) {
    return true;
  }
  const lastSuccess = new Date(status.last_success_at).getTime();
  if (Number.isNaN(lastSuccess)) {
    return true;
  }
  const intervalMinutes = status.auto_sync_interval_minutes || 720;
  const staleMinutes = Math.max(intervalMinutes, 30);
  return Date.now() - lastSuccess > staleMinutes * 60 * 1000;
}

async function fetchStatus(elements, { showError = false } = {}) {
  try {
    const status = await apiClient.get(CONFIG.API.tripSyncStatus);
    return status;
  } catch (error) {
    if (showError) {
      notificationManager.show(error.message, "danger");
    }
    return null;
  }
}

async function startSync(
  elements,
  { mode = "recent", startDate, endDate, trigger_source } = {}
) {
  if (!navigator.onLine) {
    notificationManager.show("You are offline. Connect to sync trips.", "warning");
    updateOfflineUI(elements);
    return null;
  }
  try {
    const payload = { mode };
    if (trigger_source) {
      payload.trigger_source = trigger_source;
    }
    if (startDate) {
      payload.start_date = startDate.toISOString();
    }
    if (endDate) {
      payload.end_date = endDate.toISOString();
    }
    const result = await apiClient.post(CONFIG.API.tripSyncStart, payload);
    notificationManager.show("Trip sync started.", "info");
    const status = await fetchStatus(elements);
    if (status) {
      handleStatusUpdate(status, elements);
    }
    return result;
  } catch (error) {
    notificationManager.show(error.message, "danger");
    return null;
  }
}

function setupHistoryModal(elements) {
  const modalEl = getElement("tripSyncHistoryModal");
  if (!modalEl || !elements.historyButton) {
    return;
  }
  const modal = bootstrap.Modal.getOrCreateInstance(modalEl);
  const startInput = getElement("trip-sync-history-start");
  const confirmBtn = getElement("trip-sync-history-confirm");

  if (startInput && !startInput.value) {
    const defaultDate = new Date("2020-01-01T00:00:00");
    startInput.value = defaultDate.toISOString().slice(0, 16);
  }

  elements.historyButton.addEventListener("click", () => {
    modal.show();
  });

  confirmBtn?.addEventListener("click", async () => {
    modal.hide();
    const startValue = startInput?.value;
    const startDate = startValue ? new Date(startValue) : null;
    await startSync(elements, {
      mode: "history",
      startDate: startDate && !Number.isNaN(startDate.getTime()) ? startDate : null,
    });
  });
}

function setupPullToRefresh(elements) {
  let startY = null;
  let triggered = false;
  const threshold = 90;

  const onTouchStart = (event) => {
    if (window.scrollY > 0) {
      startY = null;
      return;
    }
    const touch = event.touches?.[0];
    startY = touch ? touch.clientY : null;
    triggered = false;
  };

  const onTouchMove = (event) => {
    if (startY === null || triggered || window.scrollY > 0) {
      return;
    }
    const touch = event.touches?.[0];
    if (!touch) {
      return;
    }
    const delta = touch.clientY - startY;
    if (delta > threshold) {
      triggered = true;
      notificationManager.show("Refreshing trips...", "info");
      startSync(elements, { mode: "recent", trigger_source: "pull" });
    }
  };

  const onTouchEnd = () => {
    startY = null;
    triggered = false;
  };

  window.addEventListener("touchstart", onTouchStart, { passive: true });
  window.addEventListener("touchmove", onTouchMove, { passive: true });
  window.addEventListener("touchend", onTouchEnd, { passive: true });
}

function connectSse(elements, onSyncComplete) {
  if (eventSource) {
    eventSource.close();
  }

  try {
    eventSource = new EventSource(CONFIG.API.tripSyncSse);
  } catch {
    eventSource = null;
  }

  if (!eventSource) {
    startPolling(elements, onSyncComplete);
    return;
  }

  eventSource.onmessage = (event) => {
    try {
      const status = JSON.parse(event.data);
      handleStatusUpdate(status, elements, onSyncComplete);
    } catch {
      // ignore parse failures
    }
  };

  eventSource.onerror = () => {
    eventSource.close();
    eventSource = null;
    startPolling(elements, onSyncComplete);
  };
}

function startPolling(elements, onSyncComplete) {
  if (pollingInterval) {
    clearInterval(pollingInterval);
  }
  pollingInterval = setInterval(async () => {
    const status = await fetchStatus(elements);
    if (status) {
      handleStatusUpdate(status, elements, onSyncComplete);
    }
  }, POLL_INTERVAL_MS);
}

function handleStatusUpdate(status, elements, onSyncComplete) {
  const wasSyncing = currentStatus?.state === "syncing";
  currentStatus = status;
  if (!navigator.onLine) {
    updateOfflineUI(elements);
    return;
  }
  updateStatusUI(status, elements);
  if (shouldAutoSync(status)) {
    autoSyncTriggered = true;
    setTimeout(() => {
      startSync(elements, { mode: "recent", trigger_source: "auto" });
    }, 1200);
  }
  if (wasSyncing && status.state !== "syncing") {
    if (status.state === "idle") {
      notificationManager.show("Trips updated.", "success");
      onSyncComplete?.();
    } else if (status.state === "error") {
      notificationManager.show("Trip sync failed.", "danger");
    }
  }
}

export function initTripSync({ onSyncComplete } = {}) {
  const elements = {
    pill: getElement("trip-sync-pill"),
    statusText: getElement("trip-sync-status-text"),
    lastSuccess: getElement("trip-sync-last-success"),
    lastAttempt: getElement("trip-sync-last-attempt"),
    errorBanner: getElement("trip-sync-error"),
    errorMessage: getElement("trip-sync-error-message"),
    errorCta: getElement("trip-sync-error-cta"),
    emptyState: getElement("trip-sync-empty"),
    emptyButton: getElement("trip-sync-empty-btn"),
    syncButton: getElement("sync-trips-btn"),
    historyButton: getElement("sync-history-btn"),
  };

  if (!elements.pill) {
    return;
  }

  elements.syncButton?.addEventListener("click", () => {
    startSync(elements, { mode: "recent" });
  });

  elements.emptyButton?.addEventListener("click", () => {
    startSync(elements, { mode: "recent" });
  });

  setupHistoryModal(elements);
  setupPullToRefresh(elements);

  window.addEventListener("online", () => {
    fetchStatus(elements, { showError: true }).then((status) => {
      if (status) {
        handleStatusUpdate(status, elements, onSyncComplete);
      }
    });
  });
  window.addEventListener("offline", () => updateOfflineUI(elements));

  fetchStatus(elements, { showError: true }).then((status) => {
    if (status) {
      handleStatusUpdate(status, elements, onSyncComplete);
    }
  });
  connectSse(elements, onSyncComplete);
}

export default initTripSync;
