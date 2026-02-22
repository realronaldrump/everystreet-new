import {
  createExportJob,
  fetchCoverageAreas,
  fetchExportStatus,
  fetchVehicles,
} from "../../export/api.js";
import { announce, showNotification } from "../../utils.js";

const ENTITY_LABELS = {
  trips: "Trips",
  matched_trips: "Matched Trips",
  streets: "Streets",
  boundaries: "Boundary",
  undriven_streets: "Undriven Streets",
};

const DEFAULT_RANGE_DAYS = 30;
const POLL_INTERVAL_MS = 2000;
let activePoll = null;

function cacheElements() {
  return {
    form: document.getElementById("export-form"),
    exportTrips: document.getElementById("export-trips"),
    exportMatchedTrips: document.getElementById("export-matched-trips"),
    tripFormatSelect: document.getElementById("trip-format"),
    includeTripGeometry: document.getElementById("include-trip-geometry"),
    tripStartDate: document.getElementById("trip-start-date"),
    tripEndDate: document.getElementById("trip-end-date"),
    tripAllTime: document.getElementById("trip-all-time"),
    tripStatus: document.getElementById("trip-status"),
    tripVehicle: document.getElementById("trip-vehicle"),
    tripIncludeInvalid: document.getElementById("trip-include-invalid"),
    exportStreets: document.getElementById("export-streets"),
    exportBoundaries: document.getElementById("export-boundaries"),
    exportUndriven: document.getElementById("export-undriven"),
    coverageArea: document.getElementById("coverage-area"),
    exportError: document.getElementById("export-error"),
    exportSummary: document.getElementById("export-summary"),
    exportSummaryList: document.getElementById("export-summary-list"),
    exportProgress: document.getElementById("export-progress"),
    exportStatusText: document.getElementById("export-status-text"),
    exportProgressBar: document.getElementById("export-progress-bar"),
    exportProgressPercent: document.getElementById("export-progress-percent"),
    exportResult: document.getElementById("export-result"),
    exportResultDetails: document.getElementById("export-result-details"),
    exportDownload: document.getElementById("export-download"),
    exportReset: document.getElementById("export-reset"),
  };
}

function getTripFormat(elements) {
  return elements.tripFormatSelect?.value || "json";
}

function getSelectedItems(elements) {
  const items = [];
  const format = getTripFormat(elements);
  const includeGeometry = elements.includeTripGeometry?.checked ?? true;

  if (elements.exportTrips?.checked) {
    items.push({
      entity: "trips",
      format,
      include_geometry: includeGeometry,
    });
  }

  if (elements.exportMatchedTrips?.checked) {
    items.push({
      entity: "matched_trips",
      format,
      include_geometry: includeGeometry,
    });
  }

  if (elements.exportStreets?.checked) {
    items.push({ entity: "streets", format: "geojson" });
  }

  if (elements.exportBoundaries?.checked) {
    items.push({ entity: "boundaries", format: "geojson" });
  }

  if (elements.exportUndriven?.checked) {
    items.push({ entity: "undriven_streets", format: "geojson" });
  }

  return items;
}

function updateGeometryToggle(elements) {
  const format = getTripFormat(elements);
  const hasTripExports =
    elements.exportTrips?.checked || elements.exportMatchedTrips?.checked;

  if (!hasTripExports || !elements.tripFormatSelect) {
    if (elements.tripFormatSelect) {
      elements.tripFormatSelect.disabled = true;
    }
    if (elements.includeTripGeometry) {
      elements.includeTripGeometry.disabled = true;
    }
    return;
  }

  if (elements.tripFormatSelect) {
    elements.tripFormatSelect.disabled = false;
  }
  if (elements.includeTripGeometry) {
    elements.includeTripGeometry.disabled = format === "geojson" || format === "gpx";
  }
}

function setDateDefaults(elements) {
  const today = new Date();
  const endValue = today.toISOString().slice(0, 10);
  const start = new Date();
  start.setDate(today.getDate() - DEFAULT_RANGE_DAYS);
  const startValue = start.toISOString().slice(0, 10);

  if (elements.tripStartDate) {
    elements.tripStartDate.value = startValue;
  }
  if (elements.tripEndDate) {
    elements.tripEndDate.value = endValue;
  }
}

function toggleDateInputs(elements) {
  const disabled = elements.tripAllTime?.checked ?? false;
  if (elements.tripStartDate) {
    elements.tripStartDate.disabled = disabled;
  }
  if (elements.tripEndDate) {
    elements.tripEndDate.disabled = disabled;
  }
}

function setError(elements, message) {
  if (!elements.exportError) {
    return;
  }

  const errorText = document.getElementById("export-error-text");

  if (!message) {
    elements.exportError.classList.add("hidden");
    if (errorText) {
      errorText.textContent = "";
    }
    return;
  }
  if (errorText) {
    errorText.textContent = message;
  }
  elements.exportError.classList.remove("hidden");
}

function updateSummary(elements) {
  const items = getSelectedItems(elements);
  const emptyState = elements.exportSummary?.querySelector(".export-summary-empty");

  if (!elements.exportSummaryList) {
    return;
  }

  elements.exportSummaryList.innerHTML = "";

  if (!items.length) {
    elements.exportSummaryList.classList.add("hidden");
    if (emptyState) {
      emptyState.classList.remove("hidden");
    }
    return;
  }

  if (emptyState) {
    emptyState.classList.add("hidden");
  }
  elements.exportSummaryList.classList.remove("hidden");

  items.forEach((item) => {
    const li = document.createElement("li");
    const label = ENTITY_LABELS[item.entity] || item.entity;
    li.textContent = `${label} (${item.format.toUpperCase()})`;
    elements.exportSummaryList.appendChild(li);
  });
}

function buildTripFilters(elements) {
  const filters = {
    include_invalid: elements.tripIncludeInvalid?.checked ?? false,
  };

  if (!elements.tripAllTime?.checked) {
    if (elements.tripStartDate?.value) {
      filters.start_date = elements.tripStartDate.value;
    }
    if (elements.tripEndDate?.value) {
      filters.end_date = elements.tripEndDate.value;
    }
  }

  if (elements.tripStatus?.value) {
    filters.status = [elements.tripStatus.value];
  }

  const imei = elements.tripVehicle?.value?.trim();
  if (imei) {
    filters.imei = imei;
  }

  return filters;
}

function buildPayload(elements) {
  const items = getSelectedItems(elements);
  const hasTrips = items.some((item) =>
    ["trips", "matched_trips"].includes(item.entity)
  );
  const payload = {
    items,
    area_id: elements.coverageArea?.value || null,
    trip_filters: hasTrips ? buildTripFilters(elements) : null,
  };

  return payload;
}

function validateSelection(elements) {
  const items = getSelectedItems(elements);
  if (!items.length) {
    return "Select at least one item to export.";
  }

  const needsArea = items.some((item) =>
    ["streets", "boundaries", "undriven_streets"].includes(item.entity)
  );
  if (needsArea && !elements.coverageArea?.value) {
    return "Select a coverage area for coverage exports.";
  }

  return null;
}

function showProgress(elements) {
  if (elements.exportProgress) {
    elements.exportProgress.classList.remove("hidden");
  }
  if (elements.exportResult) {
    elements.exportResult.classList.add("hidden");
  }
}

function hideProgress(elements) {
  if (elements.exportProgress) {
    elements.exportProgress.classList.add("hidden");
  }
}

function showResult(elements) {
  if (elements.exportResult) {
    elements.exportResult.classList.remove("hidden");
  }
}

function updateProgress(elements, status) {
  if (!status) {
    if (elements.exportStatusText) {
      elements.exportStatusText.textContent = "Preparing...";
    }
    if (elements.exportProgressPercent) {
      elements.exportProgressPercent.textContent = "0%";
    }
    if (elements.exportProgressBar) {
      elements.exportProgressBar.style.width = "0%";
    }
    return;
  }

  const percent = Math.round(status.progress || 0);
  if (elements.exportStatusText) {
    elements.exportStatusText.textContent =
      status.message || status.status || "Processing...";
  }
  if (elements.exportProgressPercent) {
    elements.exportProgressPercent.textContent = `${percent}%`;
  }
  if (elements.exportProgressBar) {
    elements.exportProgressBar.style.width = `${percent}%`;
  }
}

function updateResult(elements, status) {
  if (!status || status.status !== "completed") {
    return;
  }

  const records = status.result?.records || {};
  const parts = Object.entries(records).map(
    ([entity, count]) => `${ENTITY_LABELS[entity] || entity}: ${count}`
  );

  if (elements.exportResultDetails) {
    elements.exportResultDetails.textContent = parts.length
      ? parts.join(" | ")
      : "Export completed";
  }

  if (status.download_url && elements.exportDownload) {
    elements.exportDownload.href = status.download_url;
  }
}

function startPolling(elements, jobId, signal) {
  if (activePoll) {
    activePoll.stop();
  }

  let polling = true;
  const stop = () => {
    polling = false;
  };
  activePoll = { stop };

  const poll = async () => {
    if (!polling) {
      return;
    }
    if (signal?.aborted) {
      polling = false;
      activePoll = null;
      return;
    }

    try {
      const status = await fetchExportStatus(jobId, signal);
      updateProgress(elements, status);

      if (["completed", "failed"].includes(status.status)) {
        polling = false;
        activePoll = null;
        hideProgress(elements);

        if (status.status === "failed") {
          setError(elements, status.error || "Export failed");
          showNotification(`Export failed: ${status.error}`, "danger");
        } else {
          updateResult(elements, status);
          showResult(elements);
          showNotification("Export ready to download", "success");
        }
        announce(status.message || `Export ${status.status}`, "polite");
        return;
      }
    } catch (error) {
      if (error.name === "AbortError") {
        polling = false;
        activePoll = null;
        return;
      }
      polling = false;
      activePoll = null;
      hideProgress(elements);
      setError(elements, error.message || "Failed to check export status.");
      showNotification("Export status check failed", "danger");
      return;
    }

    setTimeout(poll, POLL_INTERVAL_MS);
  };

  poll();
}

async function loadCoverageAreas(elements, signal) {
  if (!elements.coverageArea) {
    return;
  }

  try {
    const areas = await fetchCoverageAreas(signal);
    elements.coverageArea.innerHTML = "";
    elements.coverageArea.disabled = false;

    if (!areas.length) {
      const option = document.createElement("option");
      option.value = "";
      option.textContent = "No coverage areas found";
      elements.coverageArea.appendChild(option);
      elements.coverageArea.disabled = true;
      return;
    }

    const placeholder = document.createElement("option");
    placeholder.value = "";
    placeholder.textContent = "Select an area...";
    elements.coverageArea.appendChild(placeholder);

    let selectedReady = false;
    areas.forEach((area) => {
      const option = document.createElement("option");
      option.value = area.id;
      option.textContent =
        area.status && area.status !== "ready"
          ? `${area.display_name} (${area.status})`
          : area.display_name;
      if (area.status && area.status !== "ready") {
        option.disabled = true;
      }
      if (!selectedReady && area.status === "ready") {
        option.selected = true;
        selectedReady = true;
      }
      elements.coverageArea.appendChild(option);
    });
  } catch (error) {
    console.warn("Failed to load coverage areas:", error);
    elements.coverageArea.innerHTML = "";
    const option = document.createElement("option");
    option.value = "";
    option.textContent = "Unable to load areas";
    elements.coverageArea.appendChild(option);
    elements.coverageArea.disabled = true;
  }
}

async function loadVehicles(elements, signal) {
  if (!elements.tripVehicle) {
    return;
  }

  const vehicles = await fetchVehicles(signal);
  elements.tripVehicle.innerHTML = "";

  const defaultOption = document.createElement("option");
  defaultOption.value = "";
  defaultOption.textContent = "Any vehicle";
  elements.tripVehicle.appendChild(defaultOption);

  vehicles.forEach((vehicle) => {
    if (!vehicle?.imei) {
      return;
    }
    const option = document.createElement("option");
    const label = vehicle.custom_name || vehicle.vin || vehicle.imei;
    option.value = vehicle.imei;
    option.textContent = label;
    elements.tripVehicle.appendChild(option);
  });
}

function resetForm(elements) {
  if (elements.exportTrips) {
    elements.exportTrips.checked = true;
  }
  if (elements.exportMatchedTrips) {
    elements.exportMatchedTrips.checked = false;
  }
  if (elements.exportStreets) {
    elements.exportStreets.checked = false;
  }
  if (elements.exportBoundaries) {
    elements.exportBoundaries.checked = false;
  }
  if (elements.exportUndriven) {
    elements.exportUndriven.checked = false;
  }
  if (elements.tripFormatSelect) {
    elements.tripFormatSelect.value = "json";
  }
  if (elements.includeTripGeometry) {
    elements.includeTripGeometry.checked = true;
  }
  if (elements.tripAllTime) {
    elements.tripAllTime.checked = false;
  }
  setDateDefaults(elements);
  toggleDateInputs(elements);
  if (elements.tripStatus) {
    elements.tripStatus.value = "";
  }
  if (elements.tripVehicle) {
    elements.tripVehicle.value = "";
  }
  if (elements.tripIncludeInvalid) {
    elements.tripIncludeInvalid.checked = false;
  }
  setError(elements, null);
  hideProgress(elements);
  if (elements.exportResult) {
    elements.exportResult.classList.add("hidden");
  }
  updateSummary(elements);
  updateGeometryToggle(elements);
}

function bindCollapsibleSections(signal) {
  const eventOptions = signal ? { signal } : false;

  document.querySelectorAll(".export-category-header").forEach((header) => {
    header.addEventListener(
      "click",
      () => {
        const expanded = header.getAttribute("aria-expanded") === "true";
        const targetId = header.dataset.target;
        const body = document.getElementById(targetId);

        if (!body) {
          return;
        }

        header.setAttribute("aria-expanded", !expanded);
        body.classList.toggle("collapsed", expanded);
      },
      eventOptions
    );
  });
}

function registerEventListeners(elements, signal) {
  const eventOptions = signal ? { signal } : false;
  const inputs = [
    elements.exportTrips,
    elements.exportMatchedTrips,
    elements.exportStreets,
    elements.exportBoundaries,
    elements.exportUndriven,
    elements.tripFormatSelect,
    elements.includeTripGeometry,
    elements.tripAllTime,
  ].filter(Boolean);

  inputs.forEach((input) => {
    input.addEventListener(
      "change",
      () => {
        updateGeometryToggle(elements);
        toggleDateInputs(elements);
        updateSummary(elements);
      },
      eventOptions
    );
  });

  elements.exportReset?.addEventListener(
    "click",
    () => resetForm(elements),
    eventOptions
  );

  elements.form?.addEventListener(
    "submit",
    async (event) => {
      event.preventDefault();
      setError(elements, null);

      const validationError = validateSelection(elements);
      if (validationError) {
        setError(elements, validationError);
        showNotification(validationError, "danger");
        return;
      }

      const payload = buildPayload(elements);
      const submitButton = document.getElementById("export-submit");
      if (submitButton) {
        submitButton.disabled = true;
        submitButton.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Starting...';
      }

      try {
        const job = await createExportJob(payload, signal);
        showProgress(elements);
        updateProgress(elements, {
          status: job.status,
          progress: job.progress,
          message: job.message,
        });
        announce("Export started", "polite");
        showNotification("Export started", "info");
        startPolling(elements, job.id, signal);
      } catch (error) {
        setError(elements, error.message || "Failed to start export.");
        showNotification("Failed to start export", "danger");
      } finally {
        if (submitButton) {
          submitButton.disabled = false;
          submitButton.innerHTML = '<i class="fas fa-download"></i> Create Export';
        }
      }
    },
    eventOptions
  );
}

export default function initExportPage({ signal, cleanup } = {}) {
  const noopTeardown = () => {};
  const elements = cacheElements();
  if (!elements.form) {
    if (typeof cleanup === "function") {
      cleanup(noopTeardown);
    }
    return noopTeardown;
  }

  setDateDefaults(elements);
  toggleDateInputs(elements);
  updateGeometryToggle(elements);
  updateSummary(elements);

  loadCoverageAreas(elements, signal);
  loadVehicles(elements, signal);
  registerEventListeners(elements, signal);
  bindCollapsibleSections(signal);

  const teardown = () => {
    if (activePoll) {
      activePoll.stop();
      activePoll = null;
    }
  };

  if (typeof cleanup === "function") {
    cleanup(teardown);
  }

  return teardown;
}
