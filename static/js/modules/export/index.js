import { announce, onPageLoad, showNotification } from "../utils.js";
import {
  createExportJob,
  fetchCoverageAreas,
  fetchExportStatus,
  fetchVehicles,
} from "./api.js";

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
    tripFormat: document.getElementById("trip-format"),
    includeTripGeometry: document.getElementById("include-trip-geometry"),
    tripStartDate: document.getElementById("trip-start-date"),
    tripEndDate: document.getElementById("trip-end-date"),
    tripAllTime: document.getElementById("trip-all-time"),
    tripStatus: document.getElementById("trip-status"),
    tripVehicle: document.getElementById("trip-vehicle"),
    vehicleOptions: document.getElementById("vehicle-options"),
    tripIncludeInvalid: document.getElementById("trip-include-invalid"),
    exportStreets: document.getElementById("export-streets"),
    exportBoundaries: document.getElementById("export-boundaries"),
    exportUndriven: document.getElementById("export-undriven"),
    coverageArea: document.getElementById("coverage-area"),
    exportError: document.getElementById("export-error"),
    exportSummaryList: document.getElementById("export-summary-list"),
    exportStatusText: document.getElementById("export-status-text"),
    exportProgressBar: document.getElementById("export-progress-bar"),
    exportProgressPercent: document.getElementById("export-progress-percent"),
    exportResultDetails: document.getElementById("export-result-details"),
    exportDownload: document.getElementById("export-download"),
    exportReset: document.getElementById("export-reset"),
  };
}

function getSelectedItems(elements) {
  const items = [];
  const format = elements.tripFormat.value;
  const includeGeometry = elements.includeTripGeometry.checked;

  if (elements.exportTrips.checked) {
    items.push({
      entity: "trips",
      format,
      include_geometry: includeGeometry,
    });
  }

  if (elements.exportMatchedTrips.checked) {
    items.push({
      entity: "matched_trips",
      format,
      include_geometry: includeGeometry,
    });
  }

  if (elements.exportStreets.checked) {
    items.push({ entity: "streets", format: "geojson" });
  }

  if (elements.exportBoundaries.checked) {
    items.push({ entity: "boundaries", format: "geojson" });
  }

  if (elements.exportUndriven.checked) {
    items.push({ entity: "undriven_streets", format: "geojson" });
  }

  return items;
}

function updateGeometryToggle(elements) {
  const format = elements.tripFormat.value;
  const hasTripExports
    = elements.exportTrips.checked || elements.exportMatchedTrips.checked;

  if (!hasTripExports) {
    elements.tripFormat.disabled = true;
    elements.includeTripGeometry.disabled = true;
    return;
  }

  elements.tripFormat.disabled = false;
  elements.includeTripGeometry.disabled = format === "geojson";
}

function setDateDefaults(elements) {
  const today = new Date();
  const endValue = today.toISOString().slice(0, 10);
  const start = new Date();
  start.setDate(today.getDate() - DEFAULT_RANGE_DAYS);
  const startValue = start.toISOString().slice(0, 10);

  elements.tripStartDate.value = startValue;
  elements.tripEndDate.value = endValue;
}

function toggleDateInputs(elements) {
  const disabled = elements.tripAllTime.checked;
  elements.tripStartDate.disabled = disabled;
  elements.tripEndDate.disabled = disabled;
}

function setError(elements, message) {
  if (!message) {
    elements.exportError.classList.add("d-none");
    elements.exportError.textContent = "";
    return;
  }
  elements.exportError.textContent = message;
  elements.exportError.classList.remove("d-none");
}

function updateSummary(elements) {
  const items = getSelectedItems(elements);
  elements.exportSummaryList.innerHTML = "";

  if (!items.length) {
    const li = document.createElement("li");
    li.className = "text-secondary";
    li.textContent = "No items selected yet.";
    elements.exportSummaryList.appendChild(li);
    return;
  }

  items.forEach((item) => {
    const li = document.createElement("li");
    const label = ENTITY_LABELS[item.entity] || item.entity;
    li.textContent = `${label} (${item.format.toUpperCase()})`;
    elements.exportSummaryList.appendChild(li);
  });
}

function buildTripFilters(elements) {
  const filters = {
    include_invalid: elements.tripIncludeInvalid.checked,
  };

  if (!elements.tripAllTime.checked) {
    if (elements.tripStartDate.value) {
      filters.start_date = elements.tripStartDate.value;
    }
    if (elements.tripEndDate.value) {
      filters.end_date = elements.tripEndDate.value;
    }
  }

  if (elements.tripStatus.value) {
    filters.status = [elements.tripStatus.value];
  }

  const imei = elements.tripVehicle.value.trim();
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
    area_id: elements.coverageArea.value || null,
    trip_filters: hasTrips ? buildTripFilters(elements) : null,
  };

  return payload;
}

function validateSelection(elements) {
  const items = getSelectedItems(elements);
  if (!items.length) {
    return "Select at least one export item.";
  }

  const needsArea = items.some((item) =>
    ["streets", "boundaries", "undriven_streets"].includes(item.entity)
  );
  if (needsArea && !elements.coverageArea.value) {
    return "Select a coverage area for coverage exports.";
  }

  return null;
}

function updateStatus(elements, status) {
  if (!status) {
    elements.exportStatusText.textContent = "No export running";
    elements.exportProgressPercent.textContent = "0%";
    elements.exportProgressBar.style.width = "0%";
    return;
  }

  const percent = Math.round(status.progress || 0);
  elements.exportStatusText.textContent = status.message || status.status;
  elements.exportProgressPercent.textContent = `${percent}%`;
  elements.exportProgressBar.style.width = `${percent}%`;
}

function updateResult(elements, status) {
  if (!status || status.status !== "completed") {
    elements.exportResultDetails.textContent = "No export generated yet.";
    elements.exportDownload.classList.add("d-none");
    elements.exportDownload.removeAttribute("href");
    return;
  }

  const records = status.result?.records || {};
  const parts = Object.entries(records).map(
    ([entity, count]) => `${ENTITY_LABELS[entity] || entity}: ${count}`
  );

  elements.exportResultDetails.textContent = parts.length
    ? parts.join(" | ")
    : "Export completed.";

  if (status.download_url) {
    elements.exportDownload.href = status.download_url;
    elements.exportDownload.classList.remove("d-none");
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
      updateStatus(elements, status);
      updateResult(elements, status);

      if (["completed", "failed"].includes(status.status)) {
        polling = false;
        activePoll = null;
        if (status.status === "failed") {
          showNotification(`Export failed: ${status.error}`, "danger");
        } else {
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
      setError(elements, error.message || "Failed to check export status.");
      showNotification("Export status check failed", "danger");
      return;
    }

    setTimeout(poll, POLL_INTERVAL_MS);
  };

  poll();
}

async function loadCoverageAreas(elements, signal) {
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
    placeholder.textContent = "Select an area";
    elements.coverageArea.appendChild(placeholder);

    let selectedReady = false;
    areas.forEach((area) => {
      const option = document.createElement("option");
      option.value = area.id;
      option.textContent
        = area.status && area.status !== "ready"
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
  const vehicles = await fetchVehicles(signal);
  elements.vehicleOptions.innerHTML = "";

  vehicles.forEach((vehicle) => {
    if (!vehicle?.imei) {
      return;
    }
    const option = document.createElement("option");
    const label = vehicle.custom_name || vehicle.vin || vehicle.imei;
    option.value = vehicle.imei;
    option.textContent = label;
    elements.vehicleOptions.appendChild(option);
  });
}

function resetForm(elements) {
  elements.exportTrips.checked = true;
  elements.exportMatchedTrips.checked = false;
  elements.exportStreets.checked = false;
  elements.exportBoundaries.checked = false;
  elements.exportUndriven.checked = false;
  elements.tripFormat.value = "json";
  elements.includeTripGeometry.checked = true;
  elements.tripAllTime.checked = false;
  setDateDefaults(elements);
  toggleDateInputs(elements);
  elements.tripStatus.value = "";
  elements.tripVehicle.value = "";
  elements.tripIncludeInvalid.checked = false;
  setError(elements, null);
  updateSummary(elements);
  updateStatus(elements, null);
  updateResult(elements, null);
  updateGeometryToggle(elements);
}

function registerEventListeners(elements, signal) {
  const inputs = [
    elements.exportTrips,
    elements.exportMatchedTrips,
    elements.exportStreets,
    elements.exportBoundaries,
    elements.exportUndriven,
    elements.tripFormat,
    elements.includeTripGeometry,
    elements.tripAllTime,
  ];

  inputs.forEach((input) => {
    if (!input) {
      return;
    }
    input.addEventListener("change", () => {
      updateGeometryToggle(elements);
      toggleDateInputs(elements);
      updateSummary(elements);
    });
  });

  elements.exportReset.addEventListener("click", () => resetForm(elements));

  elements.form.addEventListener("submit", async (event) => {
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
    submitButton.disabled = true;
    submitButton.textContent = "Starting export...";

    try {
      const job = await createExportJob(payload, signal);
      updateStatus(elements, {
        status: job.status,
        progress: job.progress,
        message: job.message,
      });
      updateResult(elements, null);
      announce("Export started", "polite");
      showNotification("Export started", "info");
      startPolling(elements, job.id, signal);
    } catch (error) {
      setError(elements, error.message || "Failed to start export.");
      showNotification("Failed to start export", "danger");
    } finally {
      submitButton.disabled = false;
      submitButton.innerHTML = '<i class="fas fa-download me-2"></i>Create Export';
    }
  });
}

function initExportPage({ signal }) {
  const elements = cacheElements();
  if (!elements.form) {
    return;
  }

  setDateDefaults(elements);
  toggleDateInputs(elements);
  updateGeometryToggle(elements);
  updateSummary(elements);

  loadCoverageAreas(elements, signal);
  loadVehicles(elements, signal);
  registerEventListeners(elements, signal);
}

onPageLoad(initExportPage, { route: "/export" });
