/* global bootstrap */

import apiClient from "../../core/api-client.js";
import { CONFIG } from "../../core/config.js";
import notificationManager from "../../ui/notifications.js";

const TERMINAL_STATUSES = new Set(["completed", "failed", "cancelled"]);

function getEl(id) {
  return document.getElementById(id);
}

function toLocalInputValue(date) {
  if (!(date instanceof Date) || Number.isNaN(date.getTime())) {
    return "";
  }
  const local = new Date(date.getTime() - date.getTimezoneOffset() * 60 * 1000);
  return local.toISOString().slice(0, 16);
}

function parseLocalDateTime(value) {
  if (!value) {
    return null;
  }
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    return null;
  }
  return parsed;
}

function setText(el, value) {
  if (!el) {
    return;
  }
  el.textContent = value ?? "";
}

function clampPct(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) {
    return 0;
  }
  return Math.max(0, Math.min(100, n));
}

function formatIsoToLocal(value) {
  if (!value) {
    return "";
  }
  try {
    const dt = new Date(value);
    if (Number.isNaN(dt.getTime())) {
      return String(value);
    }
    return dt.toLocaleString();
  } catch {
    return String(value);
  }
}

function renderDevicesList(
  container,
  devices,
  { selectedImeis = new Set(), onToggle = null } = {}
) {
  if (!container) {
    return;
  }
  container.innerHTML = "";

  if (!Array.isArray(devices) || devices.length === 0) {
    container.innerHTML = '<div class="text-muted small">No devices found.</div>';
    return;
  }

  const frag = document.createDocumentFragment();
  devices.forEach((device, index) => {
    const imei = device?.imei || "";
    const name = device?.name || "Unknown vehicle";
    const isSelected = Boolean(imei && selectedImeis.has(imei));
    const row = document.createElement("div");
    row.className = "trip-import-device";
    row.classList.toggle("is-disabled", !isSelected);
    row.setAttribute("role", "listitem");

    const label = document.createElement("label");
    label.className = "trip-import-device-toggle";
    label.setAttribute("for", `trip-import-device-checkbox-${index}`);

    const input = document.createElement("input");
    input.type = "checkbox";
    input.id = `trip-import-device-checkbox-${index}`;
    input.className = "form-check-input trip-import-device-check";
    input.checked = isSelected;
    input.disabled = !imei;

    const body = document.createElement("div");
    body.className = "trip-import-device-body";

    const nameEl = document.createElement("div");
    nameEl.className = "trip-import-device-name";
    nameEl.textContent = name;

    const metaEl = document.createElement("div");
    metaEl.className = "trip-import-device-meta";
    metaEl.textContent = imei;

    body.append(nameEl, metaEl);
    label.append(input, body);
    row.appendChild(label);

    input.addEventListener("change", () => {
      if (!imei || typeof onToggle !== "function") {
        return;
      }
      onToggle(imei, input.checked);
      row.classList.toggle("is-disabled", !input.checked);
    });

    frag.appendChild(row);
  });
  container.appendChild(frag);
}

function escapeHtml(value) {
  const str = String(value ?? "");
  return str
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function setStep(root, step) {
  if (!root) {
    return;
  }

  root
    .querySelectorAll(".trip-import-step")
    .forEach((el) => el.classList.toggle("is-active", el.dataset.step === step));

  const indicators = [...root.querySelectorAll(".trip-import-step-indicator")];
  const order = ["config", "import", "summary"];
  const activeIndex = order.indexOf(step);

  indicators.forEach((indicator) => {
    const indicatorStep = indicator.dataset.step;
    const idx = order.indexOf(indicatorStep);
    indicator.classList.toggle("is-active", indicatorStep === step);
    indicator.classList.toggle("is-completed", idx !== -1 && idx < activeIndex);
  });

  root
    .querySelectorAll(".trip-import-step-connector")
    .forEach((connector, idx) =>
      connector.classList.toggle("is-active", idx < activeIndex)
    );
}

function updateProgressBar(barEl, pct) {
  if (!barEl) {
    return;
  }
  const safe = clampPct(pct);
  barEl.style.width = `${safe}%`;
  barEl.textContent = `${Math.round(safe)}%`;
}

function renderEvents(container, events) {
  if (!container) {
    return;
  }
  if (!Array.isArray(events) || events.length === 0) {
    container.innerHTML = '<div class="text-muted small">No events yet.</div>';
    return;
  }

  const shouldShowDetails = (data) => {
    if (!data || typeof data !== "object") {
      return false;
    }
    return Boolean(
      data.error ||
        data.reason ||
        data.transactionId ||
        data.imei ||
        data.window_index ||
        data.windowIndex
    );
  };

  const lines = events
    .slice(-60)
    .map((evt) => {
      const level = (evt?.level || "info").toLowerCase();
      const ts = evt?.ts_iso ? new Date(evt.ts_iso).toLocaleTimeString() : "";
      const msg = evt?.message || "";
      const data = evt?.data && typeof evt.data === "object" ? evt.data : null;
      const details = shouldShowDetails(data)
        ? `
          <details class="trip-import-event-details">
            <summary>Details</summary>
            <pre>${escapeHtml(JSON.stringify(data, null, 2))}</pre>
          </details>
        `
        : "";
      return `
        <div class="trip-import-event trip-import-event--${escapeHtml(level)}">
          <span class="trip-import-event-ts">${escapeHtml(ts)}</span>
          <span class="trip-import-event-level">${escapeHtml(level)}</span>
          <span class="trip-import-event-msg">${escapeHtml(msg)}</span>
          ${details}
        </div>
      `;
    })
    .join("");

  container.innerHTML = lines;
  container.scrollTop = container.scrollHeight;
}

function renderFailureSummary(container, failureReasons) {
  if (!container) {
    return;
  }

  if (!failureReasons || typeof failureReasons !== "object") {
    container.innerHTML = "";
    return;
  }

  const entries = Object.entries(failureReasons)
    .map(([reason, count]) => [String(reason), Number(count) || 0])
    .filter(([, count]) => count > 0);

  if (entries.length === 0) {
    container.innerHTML = "";
    return;
  }

  entries.sort((a, b) => b[1] - a[1]);
  const top = entries.slice(0, 6);

  const lines = top
    .map(
      ([reason, count]) => `
        <div class="trip-import-failure-row">
          <span class="trip-import-failure-count">${escapeHtml(count)}</span>
          <span class="trip-import-failure-reason">${escapeHtml(reason)}</span>
        </div>
      `
    )
    .join("");

  container.innerHTML = `
    <div class="trip-import-failure-title">Top failure reasons</div>
    <div class="trip-import-failure-list">${lines}</div>
  `;
}

function renderPerDeviceTable(tbody, devices, perDevice) {
  if (!tbody) {
    return;
  }
  tbody.innerHTML = "";

  const rows = Array.isArray(devices) ? devices : [];
  if (rows.length === 0) {
    tbody.innerHTML = `<tr><td colspan="8" class="text-muted small">No devices.</td></tr>`;
    return;
  }

  const frag = document.createDocumentFragment();
  rows.forEach((device) => {
    const imei = device?.imei || "";
    const name = device?.name || "Unknown vehicle";
    const stats = (perDevice && imei && perDevice[imei]) || {};

    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td>
        <div class="trip-import-device-cell">
          <div class="trip-import-device-cell-name">${escapeHtml(name)}</div>
          <div class="trip-import-device-cell-imei">${escapeHtml(imei)}</div>
        </div>
      </td>
      <td>${stats.windows_completed ?? 0}</td>
      <td>${stats.found_raw ?? 0}</td>
      <td>${stats.found_unique ?? 0}</td>
      <td>${stats.skipped_existing ?? 0}</td>
      <td>${stats.validation_failed ?? 0}</td>
      <td>${stats.new_candidates ?? 0}</td>
      <td>${stats.inserted ?? 0}</td>
      <td>${stats.errors ?? 0}</td>
    `;
    frag.appendChild(tr);
  });

  tbody.appendChild(frag);
}

function jobToCounters(job) {
  const counters = job?.metadata?.counters || job?.result?.counters || {};
  return {
    found_raw: counters.found_raw ?? 0,
    found_unique: counters.found_unique ?? 0,
    skipped_existing: counters.skipped_existing ?? 0,
    new_candidates: counters.new_candidates ?? 0,
    inserted: counters.inserted ?? 0,
    skipped_missing_end_time: counters.skipped_missing_end_time ?? 0,
    validation_failed: counters.validation_failed ?? 0,
    fetch_errors: counters.fetch_errors ?? 0,
    process_errors: counters.process_errors ?? 0,
  };
}

export function initTripHistoryImportWizard({ signal } = {}) {
  const modalEl = getEl("tripHistoryImportWizardModal");
  const openBtn = getEl("sync-import-btn");
  if (!modalEl || !openBtn) {
    return;
  }

  const modal = bootstrap.Modal.getOrCreateInstance(modalEl);
  const eventOptions = signal ? { signal } : false;

  const root = modalEl;
  const startInput = getEl("trip-import-start");
  const startBtn = getEl("trip-import-start-btn");
  const cancelBtn = getEl("trip-import-cancel-btn");
  const goTrips = getEl("trip-import-go-trips");
  const newBtn = getEl("trip-import-new-btn");
  const footerHint = getEl("trip-import-footer-hint");

  const configError = getEl("trip-import-config-error");
  const configActions = getEl("trip-import-config-actions");
  const stopSyncBtn = getEl("trip-import-stop-sync-btn");

  const planWindows = getEl("trip-import-plan-windows");
  const planRequests = getEl("trip-import-plan-requests");
  const planConcurrency = getEl("trip-import-plan-concurrency");
  const devicesCount = getEl("trip-import-devices-count");
  const devicesList = getEl("trip-import-devices-list");
  const selectAllDevicesBtn = getEl("trip-import-select-all-btn");
  const clearAllDevicesBtn = getEl("trip-import-clear-all-btn");

  const stageEl = getEl("trip-import-stage");
  const messageEl = getEl("trip-import-message");
  const windowEl = getEl("trip-import-window");
  const windowsEl = getEl("trip-import-windows");
  const progressBar = getEl("trip-import-progress-bar");
  const eventsEl = getEl("trip-import-events");
  const failureSummaryEl = getEl("trip-import-failure-summary");
  const vehiclesTbody = getEl("trip-import-vehicles-tbody");
  const progressError = getEl("trip-import-progress-error");

  const countFoundRaw = getEl("trip-import-count-found-raw");
  const countFoundUnique = getEl("trip-import-count-found-unique");
  const countSkippedExisting = getEl("trip-import-count-skipped-existing");
  const countNew = getEl("trip-import-count-new-candidates");
  const countInserted = getEl("trip-import-count-inserted");
  const countMissingEnd = getEl("trip-import-count-skipped-missing-end");
  const countValidationFailed = getEl("trip-import-count-validation-failed");
  const countFetchErr = getEl("trip-import-count-fetch-errors");
  const countProcessErr = getEl("trip-import-count-process-errors");

  const summaryTitle = getEl("trip-import-summary-title");
  const summaryBody = getEl("trip-import-summary-body");
  const summaryInserted = getEl("trip-import-summary-inserted");
  const summaryExisting = getEl("trip-import-summary-existing");
  const summaryValidationFailed = getEl("trip-import-summary-validation-failed");
  const summaryFetchErrors = getEl("trip-import-summary-fetch-errors");
  const summaryProcessErrors = getEl("trip-import-summary-process-errors");

  let progressJobId = null;
  let progressSseUrl = null;
  let progressUrl = null;
  let es = null;
  let pollTimer = null;
  let finished = false;
  let lastPlan = null;
  let activeSyncJobId = null;
  let activeSyncTaskId = null;
  let allDevices = [];
  let selectedImeis = new Set();
  let hasLoadedPlan = false;
  let isPlanLoading = false;
  let isStartSubmitting = false;
  let isConfigBlocked = false;

  const getSelectedImeis = () =>
    allDevices
      .map((device) => String(device?.imei || "").trim())
      .filter((imei) => imei && selectedImeis.has(imei));

  const updateStartButtonState = () => {
    if (!startBtn) {
      return;
    }
    const selectedCount = getSelectedImeis().length;
    const hasDevices = allDevices.length > 0;
    const lacksSelection = hasDevices && selectedCount < 1;
    startBtn.disabled =
      isPlanLoading || isStartSubmitting || isConfigBlocked || !hasDevices || lacksSelection;
  };

  const updateDeviceSelectionUi = () => {
    const total = allDevices.length;
    const selectedCount = getSelectedImeis().length;

    if (devicesCount) {
      devicesCount.textContent = total > 0 ? `${selectedCount}/${total} selected` : "--";
    }
    if (selectAllDevicesBtn) {
      selectAllDevicesBtn.disabled = total < 1 || selectedCount === total;
    }
    if (clearAllDevicesBtn) {
      clearAllDevicesBtn.disabled = selectedCount < 1;
    }

    if (lastPlan && Number.isFinite(Number(lastPlan.windows_total))) {
      setText(planRequests, Number(lastPlan.windows_total) * selectedCount);
    } else {
      setText(planRequests, lastPlan?.estimated_requests ?? "--");
    }

    updateStartButtonState();
  };

  const cleanupStreaming = () => {
    if (es) {
      es.close();
      es = null;
    }
    if (pollTimer) {
      clearInterval(pollTimer);
      pollTimer = null;
    }
  };

  const setConfigError = (message) => {
    if (!configError) {
      return;
    }
    configError.classList.toggle("d-none", !message);
    configError.textContent = message || "";
  };

  const setConfigActionsVisible = (visible) => {
    if (!configActions) {
      return;
    }
    configActions.classList.toggle("d-none", !visible);
  };

  const showSyncInProgress = (status) => {
    activeSyncJobId = status?.current_job_id || null;
    activeSyncTaskId = status?.active_task_id || null;
    isConfigBlocked = true;

    const parts = ["Trip sync is already in progress."];
    if (activeSyncTaskId) {
      parts.push(`Task: ${activeSyncTaskId}.`);
    }
    if (activeSyncJobId) {
      parts.push(`Job: ${activeSyncJobId}.`);
    }
    if (status?.started_at) {
      parts.push(`Started: ${formatIsoToLocal(status.started_at)}.`);
    }
    parts.push("Wait for it to finish, or cancel it here.");

    setConfigError(parts.join(" "));
    setConfigActionsVisible(Boolean(activeSyncJobId));
    updateStartButtonState();
  };

  const setProgressError = (message) => {
    if (!progressError) {
      return;
    }
    progressError.classList.toggle("d-none", !message);
    progressError.textContent = message || "";
  };

  const setFooterState = ({ step, running }) => {
    const isConfig = step === "config";
    const isImport = step === "import";
    const isSummary = step === "summary";

    if (startBtn) {
      startBtn.classList.toggle("d-none", !isConfig);
      startBtn.disabled = Boolean(running);
    }
    if (cancelBtn) {
      cancelBtn.classList.toggle("d-none", !isImport);
      cancelBtn.disabled = !running;
    }
    if (goTrips) {
      goTrips.classList.toggle("d-none", !isSummary);
    }
    if (newBtn) {
      newBtn.classList.toggle("d-none", !isSummary);
      newBtn.disabled = Boolean(running);
    }

    if (footerHint) {
      footerHint.textContent = isConfig
        ? "Pick a start date, choose vehicles, review the plan, then start the import."
        : isImport
          ? "You can close this window; the import continues in the background."
          : "";
    }
  };

  const rerenderSelectableDevices = () => {
    renderDevicesList(devicesList, allDevices, {
      selectedImeis,
      onToggle: (imei, checked) => {
        if (checked) {
          selectedImeis.add(imei);
        } else {
          selectedImeis.delete(imei);
        }
        updateDeviceSelectionUi();
      },
    });
    updateDeviceSelectionUi();
  };

  const renderPlan = (plan) => {
    lastPlan = plan;
    allDevices = Array.isArray(plan?.devices) ? [...plan.devices] : [];
    const selectableImeis = allDevices
      .map((device) => String(device?.imei || "").trim())
      .filter(Boolean);
    const allowedImeis = new Set(selectableImeis);

    if (!hasLoadedPlan) {
      selectedImeis = new Set(selectableImeis);
      hasLoadedPlan = true;
    } else {
      const nextSelection = new Set();
      selectedImeis.forEach((imei) => {
        if (allowedImeis.has(imei)) {
          nextSelection.add(imei);
        }
      });
      selectedImeis = nextSelection;
    }

    setText(planWindows, plan?.windows_total ?? "--");
    setText(planConcurrency, plan?.fetch_concurrency ?? "--");
    rerenderSelectableDevices();
  };

  const loadPlan = async () => {
    setConfigError("");
    isPlanLoading = true;
    updateStartButtonState();
    try {
      const startDate = parseLocalDateTime(startInput?.value);
      const qs = startDate
        ? `?start_date=${encodeURIComponent(startDate.toISOString())}`
        : "";
      const plan = await apiClient.get(`${CONFIG.API.tripSyncHistoryImportPlan}${qs}`, {
        signal,
      });
      renderPlan(plan);
    } catch (error) {
      setConfigError(error.message || "Failed to load import plan.");
      allDevices = [];
      selectedImeis = new Set();
      rerenderSelectableDevices();
    } finally {
      isPlanLoading = false;
      updateStartButtonState();
    }
  };

  const renderJob = (job) => {
    setText(stageEl, job?.stage || job?.status || "--");
    setText(messageEl, job?.message || "--");

    const current = job?.metadata?.current_window;
    if (current?.start_iso && current?.end_iso) {
      setText(
        windowEl,
        `${formatIsoToLocal(current.start_iso)} -> ${formatIsoToLocal(current.end_iso)}`
      );
    } else {
      setText(windowEl, "--");
    }
    const total = job?.metadata?.windows_total ?? "--";
    const done = job?.metadata?.windows_completed ?? "--";
    setText(windowsEl, `${done}/${total}`);

    updateProgressBar(progressBar, job?.progress ?? 0);

    const counters = jobToCounters(job);
    setText(countFoundRaw, counters.found_raw);
    setText(countFoundUnique, counters.found_unique);
    setText(countSkippedExisting, counters.skipped_existing);
    setText(countNew, counters.new_candidates);
    setText(countInserted, counters.inserted);
    setText(countMissingEnd, counters.skipped_missing_end_time);
    setText(countValidationFailed, counters.validation_failed);
    setText(countFetchErr, counters.fetch_errors);
    setText(countProcessErr, counters.process_errors);

    const devices = job?.metadata?.devices || lastPlan?.devices || [];
    renderPerDeviceTable(vehiclesTbody, devices, job?.metadata?.per_device || {});
    renderEvents(eventsEl, job?.metadata?.events || []);
    renderFailureSummary(failureSummaryEl, job?.metadata?.failure_reasons || {});

    const terminal = TERMINAL_STATUSES.has(job?.status);
    if (terminal && !finished) {
      finished = true;
      cleanupStreaming();
      renderSummary(job);
      setStep(root, "summary");
      setFooterState({ step: "summary", running: false });
    }
  };

  const renderSummary = (job) => {
    const status = job?.status || "completed";
    const counters = jobToCounters(job);

    const title =
      status === "cancelled"
        ? "Import cancelled"
        : status === "failed"
          ? "Import failed"
          : "Import complete";
    setText(summaryTitle, title);

    const details = [];
    if (job?.metadata?.start_iso) {
      details.push(`Start: ${job.metadata.start_iso}`);
    }
    if (job?.metadata?.end_iso) {
      details.push(`End: ${job.metadata.end_iso}`);
    }
    if (job?.error) {
      details.push(`Error: ${job.error}`);
    }
    setText(summaryBody, details.join("\n") || "--");

    setText(summaryInserted, counters.inserted);
    setText(summaryExisting, counters.skipped_existing);
    setText(summaryValidationFailed, counters.validation_failed);
    setText(summaryFetchErrors, counters.fetch_errors);
    setText(summaryProcessErrors, counters.process_errors);
  };

  const startPolling = () => {
    if (!progressUrl) {
      return;
    }
    cleanupStreaming();
    pollTimer = setInterval(async () => {
      try {
        const job = await apiClient.get(progressUrl, { signal });
        renderJob(job);
      } catch {
        // ignore transient poll errors
      }
    }, 1000);
  };

  const startSse = () => {
    if (!progressSseUrl) {
      startPolling();
      return;
    }

    cleanupStreaming();
    try {
      es = new EventSource(progressSseUrl);
    } catch {
      es = null;
    }

    if (!es) {
      startPolling();
      return;
    }

    es.onmessage = (event) => {
      try {
        const job = JSON.parse(event.data);
        if (job?.job_id) {
          renderJob(job);
        }
      } catch {
        // ignore parse errors
      }
    };

    es.onerror = () => {
      cleanupStreaming();
      startPolling();
    };
  };

  const attachToExistingImport = async (existingProgressJobId) => {
    if (!existingProgressJobId) {
      return;
    }
    progressJobId = existingProgressJobId;
    progressUrl = CONFIG.API.tripSyncHistoryImportJob(progressJobId);
    progressSseUrl = CONFIG.API.tripSyncHistoryImportSse(progressJobId);

    setConfigError("");
    setConfigActionsVisible(false);
    setProgressError("");
    setStep(root, "import");
    setFooterState({ step: "import", running: true });

    try {
      const job = await apiClient.get(progressUrl, { signal });
      renderJob(job);
    } catch {
      // If the first fetch fails, SSE/poll fallback will still try.
    }

    startSse();
  };

  const resetUi = () => {
    progressJobId = null;
    progressSseUrl = null;
    progressUrl = null;
    finished = false;
    activeSyncJobId = null;
    activeSyncTaskId = null;
    allDevices = [];
    selectedImeis = new Set();
    hasLoadedPlan = false;
    isPlanLoading = false;
    isStartSubmitting = false;
    isConfigBlocked = false;
    lastPlan = null;
    setConfigError("");
    setConfigActionsVisible(false);
    setProgressError("");
    setStep(root, "config");
    setFooterState({ step: "config", running: false });
    updateProgressBar(progressBar, 0);
    setText(stageEl, "Queued");
    setText(messageEl, "Waiting to start...");
    setText(windowEl, "--");
    setText(windowsEl, "--");
    setText(planWindows, "--");
    setText(planRequests, "--");
    setText(planConcurrency, "--");
    renderEvents(eventsEl, []);
    rerenderSelectableDevices();
    if (vehiclesTbody) {
      vehiclesTbody.innerHTML = "";
    }
    const zeros = [
      countFoundRaw,
      countFoundUnique,
      countSkippedExisting,
      countNew,
      countInserted,
      countMissingEnd,
      countValidationFailed,
      countFetchErr,
      countProcessErr,
    ];
    zeros.forEach((el) => setText(el, "0"));
    if (failureSummaryEl) {
      failureSummaryEl.innerHTML = "";
    }
    if (goTrips) {
      goTrips.classList.add("d-none");
    }
    updateStartButtonState();
  };

  const openWizard = async () => {
    resetUi();
    modal.show();
    isConfigBlocked = false;
    updateStartButtonState();

    let status = null;
    try {
      status = await apiClient.get(CONFIG.API.tripSyncStatus, { signal });
      if (status?.state === "paused") {
        isConfigBlocked = true;
        setConfigError(status?.error?.message || "Trip sync is paused.");
        updateStartButtonState();
        return;
      }
      if (status?.state === "syncing" && status?.history_import_progress_job_id) {
        await attachToExistingImport(status.history_import_progress_job_id);
        return;
      }
      if (status?.state === "syncing") {
        showSyncInProgress(status);
      } else {
        isConfigBlocked = false;
      }
    } catch {
      // If status fails, still allow user to attempt plan fetch.
    }

    // Default start date from /api/first_trip_date (fallback handled server-side too).
    if (startInput && !startInput.value) {
      try {
        const first = await apiClient.get("/api/first_trip_date", { signal });
        const iso = first?.first_trip_date;
        const dt = iso ? new Date(iso) : null;
        if (dt && !Number.isNaN(dt.getTime())) {
          startInput.value = toLocalInputValue(dt);
        }
      } catch {
        // ignore, plan endpoint can still compute a default
      }
    }

    await loadPlan();
  };

  const handleStart = async () => {
    setConfigError("");
    setConfigActionsVisible(false);
    setProgressError("");
    isStartSubmitting = true;
    updateStartButtonState();

    const startDate = parseLocalDateTime(startInput?.value);
    if (!startDate) {
      setConfigError("Please choose a valid start date.");
      isStartSubmitting = false;
      updateStartButtonState();
      return;
    }

    const selectedForImport = getSelectedImeis();
    if (selectedForImport.length < 1) {
      setConfigError("Select at least one vehicle to import.");
      isStartSubmitting = false;
      updateStartButtonState();
      return;
    }

    try {
      const result = await apiClient.post(
        CONFIG.API.tripSyncStart,
        {
          mode: "history",
          start_date: startDate.toISOString(),
          selected_imeis: selectedForImport,
          trigger_source: "wizard",
        },
        { signal }
      );

      progressJobId = result?.progress_job_id || null;
      progressSseUrl = result?.progress_sse_url || null;
      progressUrl =
        result?.progress_url ||
        (progressJobId ? CONFIG.API.tripSyncHistoryImportJob(progressJobId) : null);

      if (!progressJobId) {
        throw new Error("Missing progress_job_id in response.");
      }

      if (result?.status === "running") {
        notificationManager.show(
          "A history import is already running. Showing progress.",
          "info"
        );
        await attachToExistingImport(progressJobId);
        return;
      }

      setStep(root, "import");
      setFooterState({ step: "import", running: true });

      notificationManager.show("History import started.", "info");

      startSse();
    } catch (error) {
      if (error?.status === 409) {
        try {
          const status = await apiClient.get(CONFIG.API.tripSyncStatus, { signal });
          if (status?.state === "syncing" && status?.history_import_progress_job_id) {
            notificationManager.show(
              "A history import is already running. Showing progress.",
              "info"
            );
            await attachToExistingImport(status.history_import_progress_job_id);
            return;
          }
          if (status?.state === "syncing") {
            showSyncInProgress(status);
            return;
          }
        } catch {
          // fall back to generic error
        }
      }

      setConfigError(error.message || "Failed to start import.");
    } finally {
      isStartSubmitting = false;
      updateStartButtonState();
    }
  };

  const handleCancel = async () => {
    if (!progressJobId) {
      return;
    }
    if (cancelBtn) {
      cancelBtn.disabled = true;
    }
    setProgressError("");
    try {
      await apiClient.delete(CONFIG.API.tripSyncHistoryImportCancel(progressJobId), {
        signal,
      });
      notificationManager.show("Cancelling import...", "info");
      // Force an immediate refresh so the UI transitions promptly.
      if (progressUrl) {
        const job = await apiClient.get(progressUrl, { signal }).catch(() => null);
        if (job) {
          renderJob(job);
        }
      }
    } catch (error) {
      setProgressError(error.message || "Failed to cancel import.");
    } finally {
      if (cancelBtn) {
        cancelBtn.disabled = false;
      }
    }
  };

  const handleStartAnother = async () => {
    cleanupStreaming();
    resetUi();
    await loadPlan();
  };

  const handleSelectAllDevices = () => {
    const imeis = allDevices
      .map((device) => String(device?.imei || "").trim())
      .filter(Boolean);
    selectedImeis = new Set(imeis);
    rerenderSelectableDevices();
  };

  const handleClearAllDevices = () => {
    selectedImeis = new Set();
    rerenderSelectableDevices();
  };

  const handleStopSync = async () => {
    if (!activeSyncJobId) {
      return;
    }
    if (stopSyncBtn) {
      stopSyncBtn.disabled = true;
    }
    setConfigError("");
    setConfigActionsVisible(true);

    try {
      await apiClient.delete(CONFIG.API.tripSyncCancel(activeSyncJobId), { signal });
      notificationManager.show("Cancelling current sync...", "info");

      // Poll briefly until the status clears.
      let cleared = false;
      for (let i = 0; i < 20; i += 1) {
        await new Promise((resolve) => setTimeout(resolve, 500));

        const status = await apiClient
          .get(CONFIG.API.tripSyncStatus, { signal })
          .catch(() => null);
        if (!status || status.state !== "syncing") {
          cleared = true;
          break;
        }
      }

      if (!cleared) {
        const status = await apiClient
          .get(CONFIG.API.tripSyncStatus, { signal })
          .catch(() => null);
        if (status?.state === "syncing") {
          showSyncInProgress(status);
        } else {
          isConfigBlocked = false;
          setConfigActionsVisible(false);
          updateStartButtonState();
        }
      } else {
        activeSyncJobId = null;
        activeSyncTaskId = null;
        isConfigBlocked = false;
        setConfigActionsVisible(false);
        await loadPlan();
      }
    } catch (error) {
      setConfigError(error.message || "Failed to cancel current sync.");
    } finally {
      if (stopSyncBtn) {
        stopSyncBtn.disabled = false;
      }
    }
  };

  let planDebounce = null;
  const handleStartChange = () => {
    if (planDebounce) {
      clearTimeout(planDebounce);
    }
    planDebounce = setTimeout(() => loadPlan(), 250);
  };

  openBtn.addEventListener("click", openWizard, eventOptions);
  startBtn?.addEventListener("click", handleStart, eventOptions);
  cancelBtn?.addEventListener("click", handleCancel, eventOptions);
  newBtn?.addEventListener("click", handleStartAnother, eventOptions);
  selectAllDevicesBtn?.addEventListener("click", handleSelectAllDevices, eventOptions);
  clearAllDevicesBtn?.addEventListener("click", handleClearAllDevices, eventOptions);
  stopSyncBtn?.addEventListener("click", handleStopSync, eventOptions);
  startInput?.addEventListener("change", handleStartChange, eventOptions);
  startInput?.addEventListener("input", handleStartChange, eventOptions);

  modalEl.addEventListener(
    "hidden.bs.modal",
    () => {
      cleanupStreaming();
      setConfigError("");
      setConfigActionsVisible(false);
      setProgressError("");
    },
    eventOptions
  );
}
