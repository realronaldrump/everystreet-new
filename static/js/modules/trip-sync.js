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
let actionInFlight = false;

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

function getButtonList(elements) {
  const buttons = [];
  const addButtons = (value) => {
    if (!value) {
      return;
    }
    if (Array.isArray(value)) {
      value.forEach((btn) => {
        if (btn) {
          buttons.push(btn);
        }
      });
    } else {
      buttons.push(value);
    }
  };

  addButtons(elements.syncButtons);
  addButtons(elements.emptyButtons);
  return buttons;
}

function setButtonsDisabled(disabled, elements) {
  getButtonList(elements).forEach((btn) => {
    btn.disabled = disabled;
  });
}

function updateActionButtons(status, elements) {
  const isSyncing = status?.state === "syncing";
  const canCancel = Boolean(status?.current_job_id);

  (elements.syncButtons || []).forEach((btn) => {
    const icon = btn.querySelector("i");
    if (icon) {
      icon.className = isSyncing ? "fas fa-stop" : "fas fa-sync-alt";
    }
    btn.dataset.action = isSyncing ? "cancel" : "start";
    btn.title = isSyncing ? "Cancel sync" : "Sync now";
    btn.setAttribute("aria-label", btn.title);

    // If we're syncing but don't have a job id to cancel, keep the button disabled.
    if (isSyncing && !canCancel) {
      btn.disabled = true;
      btn.title = "Sync is running (cancel unavailable)";
    }
  });
}

function setSyncingState(state, elements) {
  const isSyncing = state === "syncing";
  (elements.syncButtons || []).forEach((btn) => {
    const isCancel = btn.dataset.action === "cancel";
    btn.classList.toggle("syncing", isSyncing && !isCancel);
  });
}

function updateStatusUI(status, elements) {
  const meta = STATE_META[status.state] || STATE_META.idle;

  if (elements.pill) {
    elements.pill.dataset.state = status.state;
    elements.pill.dataset.tone = meta.tone;
    elements.pill.innerHTML = `<i class="${meta.icon}"></i><span>${meta.label}</span>`;
  }

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

  if (elements.miniIndicator) {
    const indicatorState =
      status.state === "syncing"
        ? "syncing"
        : status.state === "error"
          ? "error"
          : "idle";
    elements.miniIndicator.setAttribute("data-state", indicatorState);
  }

  if (elements.miniText) {
    const text =
      status.state === "syncing"
        ? "Syncing..."
        : status.state === "error"
          ? "Sync failed"
          : status.last_success_at
            ? `Updated ${formatTimestamp(status.last_success_at)}`
            : "Up to date";
    setText(elements.miniText, text);
  }

  updateActionButtons(status, elements);
  setSyncingState(status.state, elements);
  // While syncing, buttons can act as "cancel" (if job id is available).
  // Always disable while paused and while an action request is in flight.
  const shouldDisable =
    actionInFlight ||
    status.state === "paused" ||
    (status.state === "syncing" && !status.current_job_id);
  setButtonsDisabled(shouldDisable, elements);
}

function updateOfflineUI(elements) {
  const meta = STATE_META.offline;
  if (elements.pill) {
    elements.pill.dataset.state = "offline";
    elements.pill.dataset.tone = meta.tone;
    elements.pill.innerHTML = `<i class="${meta.icon}"></i><span>${meta.label}</span>`;
  }
  if (elements.miniIndicator) {
    elements.miniIndicator.setAttribute("data-state", "error");
  }
  if (elements.miniText) {
    setText(elements.miniText, "Offline");
  }
  setText(elements.statusText, "You appear to be offline. Sync will resume online.");
  setSyncingState("idle", elements);
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

async function fetchStatus(_elements, { showError = false } = {}) {
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
  { mode = "recent", startDate, endDate, trigger_source, onSyncError } = {}
) {
  if (!navigator.onLine) {
    notificationManager.show("You are offline. Connect to sync trips.", "warning");
    updateOfflineUI(elements);
    return null;
  }
  try {
    actionInFlight = true;
    setButtonsDisabled(true, elements);
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
      handleStatusUpdate(status, elements, null, onSyncError);
    }
    return result;
  } catch (error) {
    notificationManager.show(error.message, "danger");
    onSyncError?.(error);
    return null;
  } finally {
    actionInFlight = false;
    const status = currentStatus || (await fetchStatus(elements));
    if (status) {
      updateStatusUI(status, elements);
    }
  }
}

async function cancelSync(elements, { onSyncError } = {}) {
  const jobId = currentStatus?.current_job_id;
  if (!jobId) {
    notificationManager.show("Unable to cancel sync (missing job id).", "warning");
    return null;
  }
  try {
    actionInFlight = true;
    setButtonsDisabled(true, elements);
    await apiClient.delete(CONFIG.API.tripSyncCancel(jobId));
    notificationManager.show("Cancelling trip sync...", "info");
    const status = await fetchStatus(elements);
    if (status) {
      handleStatusUpdate(status, elements, null, onSyncError);
    }
    return { status: "success" };
  } catch (error) {
    notificationManager.show(error.message, "danger");
    onSyncError?.(error);
    return null;
  } finally {
    actionInFlight = false;
    const status = currentStatus || (await fetchStatus(elements));
    if (status) {
      updateStatusUI(status, elements);
    }
  }
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

  return () => {
    window.removeEventListener("touchstart", onTouchStart);
    window.removeEventListener("touchmove", onTouchMove);
    window.removeEventListener("touchend", onTouchEnd);
  };
}

function connectSse(elements, onSyncComplete, onSyncError) {
  if (eventSource) {
    eventSource.close();
  }

  try {
    eventSource = new EventSource(CONFIG.API.tripSyncSse);
  } catch {
    eventSource = null;
  }

  if (!eventSource) {
    startPolling(elements, onSyncComplete, onSyncError);
    return;
  }

  eventSource.onmessage = (event) => {
    try {
      const status = JSON.parse(event.data);
      handleStatusUpdate(status, elements, onSyncComplete, onSyncError);
    } catch {
      // ignore parse failures
    }
  };

  eventSource.onerror = () => {
    eventSource.close();
    eventSource = null;
    startPolling(elements, onSyncComplete, onSyncError);
  };
}

function stopSse() {
  if (eventSource) {
    eventSource.close();
    eventSource = null;
  }
}

function startPolling(elements, onSyncComplete, onSyncError) {
  if (pollingInterval) {
    clearInterval(pollingInterval);
  }
  pollingInterval = setInterval(async () => {
    const status = await fetchStatus(elements);
    if (status) {
      handleStatusUpdate(status, elements, onSyncComplete, onSyncError);
    }
  }, POLL_INTERVAL_MS);
}

function stopPolling() {
  if (pollingInterval) {
    clearInterval(pollingInterval);
    pollingInterval = null;
  }
}

function handleStatusUpdate(status, elements, onSyncComplete, onSyncError) {
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
      startSync(elements, {
        mode: "recent",
        trigger_source: "auto",
        onSyncError,
      });
    }, 1200);
  }
  if (wasSyncing && status.state !== "syncing") {
    if (status.state === "idle") {
      notificationManager.show("Trips updated.", "success");
      onSyncComplete?.();
    } else if (status.state === "error") {
      notificationManager.show("Trip sync failed.", "danger");
      onSyncError?.(status);
    }
  }
}

export function initTripSync({ onSyncComplete, onSyncError, cleanup } = {}) {
  const noopTeardown = () => {};
  const elements = {
    pill: getElement("trip-sync-pill"),
    statusText: getElement("trip-sync-status-text"),
    lastSuccess: getElement("trip-sync-last-success"),
    lastAttempt: getElement("trip-sync-last-attempt"),
    errorBanner: getElement("trip-sync-error"),
    errorMessage: getElement("trip-sync-error-message"),
    errorCta: getElement("trip-sync-error-cta"),
    emptyState: getElement("trip-sync-empty"),
    emptyButtons: [
      getElement("trip-sync-empty-btn"),
      getElement("empty-sync-btn"),
    ].filter(Boolean),
    syncButtons: [getElement("sync-trips-btn"), getElement("sync-now-btn")].filter(
      Boolean
    ),
    miniIndicator: document.querySelector(".sync-indicator"),
    miniText: document.querySelector(".sync-text"),
  };

  const hasUi = Boolean(
    elements.pill ||
      elements.miniIndicator ||
      elements.miniText ||
      elements.syncButtons.length ||
      elements.emptyButtons.length
  );

  if (!hasUi) {
    if (typeof cleanup === "function") {
      cleanup(noopTeardown);
    }
    return noopTeardown;
  }

  const cleanupHandlers = [];
  const handleSyncClick = () => {
    if (actionInFlight) {
      return;
    }
    if (currentStatus?.state === "syncing") {
      cancelSync(elements, { onSyncError });
      return;
    }

    startSync(elements, {
      mode: "recent",
      trigger_source: "manual",
      onSyncError,
    });
  };

  elements.syncButtons.forEach((btn) => {
    btn.addEventListener("click", handleSyncClick);
  });
  elements.emptyButtons.forEach((btn) => {
    btn.addEventListener("click", handleSyncClick);
  });
  cleanupHandlers.push(() => {
    elements.syncButtons.forEach((btn) => {
      btn.removeEventListener("click", handleSyncClick);
    });
    elements.emptyButtons.forEach((btn) => {
      btn.removeEventListener("click", handleSyncClick);
    });
  });

  const pullCleanup = setupPullToRefresh(elements);
  if (pullCleanup) {
    cleanupHandlers.push(pullCleanup);
  }

  const handleOnline = () => {
    fetchStatus(elements, { showError: true }).then((status) => {
      if (status) {
        handleStatusUpdate(status, elements, onSyncComplete, onSyncError);
      }
    });
  };
  const handleOffline = () => updateOfflineUI(elements);
  window.addEventListener("online", handleOnline);
  window.addEventListener("offline", handleOffline);
  cleanupHandlers.push(() => {
    window.removeEventListener("online", handleOnline);
    window.removeEventListener("offline", handleOffline);
  });

  fetchStatus(elements, { showError: true }).then((status) => {
    if (status) {
      handleStatusUpdate(status, elements, onSyncComplete, onSyncError);
    }
  });
  connectSse(elements, onSyncComplete, onSyncError);

  const cleanupFn = () => {
    cleanupHandlers.forEach((handler) => handler());
    stopSse();
    stopPolling();
    autoSyncTriggered = false;
  };

  if (typeof cleanup === "function") {
    cleanup(cleanupFn);
  }

  return cleanupFn;
}

export default initTripSync;
