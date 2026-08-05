import { createMap } from "../../map-core.js";
import { ensureLibraries } from "../../core/library-loader.js";
import { getGoogleMapsApi, waitForGoogleMaps } from "../../maps/google_maps_loader.js";
import confirmationDialog from "../../ui/confirmation-dialog.js";
import notificationManager from "../../ui/notifications.js";
import { escapeHtml, isAbortError } from "../../utils.js";

const PREVIEW_ENDPOINT = "/api/trips/manual-import/preview";
const COMMIT_ENDPOINT = "/api/trips/manual-import/commit";
const FALLBACK_BATCH_SIZE = 5;
const MAX_UPLOAD_CONTAINERS = 1000;
const MAX_SINGLE_BYTES = 25 * 1024 * 1024;
const MAX_TOTAL_BYTES = 50 * 1024 * 1024;
const MAP_SOURCE_ID = "manual-import-trips";
const MAP_LINE_LAYER_ID = "manual-import-trip-lines";
const MAP_ACTIVE_LAYER_ID = "manual-import-active-trip";
const STATUS_COLORS = {
  ready: "#43d7a1",
  imported: "#43d7a1",
  warning: "#f2b84b",
  invalid: "#ff6f73",
  existing: "#8d9aa9",
};

let pageSignal = null;
let featureApi = null;
let selectedFiles = [];
let analysis = null;
let selectedIds = new Set();
let activeFilter = "all";
let activeRecordKey = null;
let importMap = null;
let mapMode = null;
let mapReady = false;
let googlePolylines = [];
let uploadLocked = false;

const byId = (id) => document.getElementById(id);

function listen(target, type, handler, options = {}) {
  if (!target) {
    return;
  }
  const eventOptions = pageSignal ? { ...options, signal: pageSignal } : options;
  target.addEventListener(type, handler, eventOptions);
}

function setStatus(message = "", tone = "neutral") {
  const element = byId("trip-import-status");
  if (!element) {
    return;
  }
  element.textContent = message;
  element.dataset.tone = tone;
}

function uploadWithinLimits() {
  const totalBytes = selectedFiles.reduce((total, file) => total + file.size, 0);
  return (
    selectedFiles.length > 0 &&
    selectedFiles.length <= MAX_UPLOAD_CONTAINERS &&
    selectedFiles.every(
      (file) =>
        file.size <= MAX_SINGLE_BYTES && /\.(?:json|zip)$/i.test(String(file.name || "")),
    ) &&
    totalBytes <= MAX_TOTAL_BYTES
  );
}

function setUploadLocked(locked) {
  uploadLocked = locked;
  ["trip-import-file-input", "trip-import-browse", "trip-import-clear-files"].forEach(
    (id) => {
      const element = byId(id);
      if (element) {
        element.disabled = locked;
      }
    },
  );
  const dropZone = byId("trip-import-drop-zone");
  dropZone?.classList.toggle("is-disabled", locked);
  dropZone?.setAttribute("aria-disabled", locked ? "true" : "false");
}

function formatBytes(value) {
  const bytes = Number(value) || 0;
  if (bytes < 1024) {
    return `${bytes} B`;
  }
  if (bytes < 1024 * 1024) {
    return `${(bytes / 1024).toFixed(1)} KB`;
  }
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function formatDate(value) {
  if (!value) {
    return "—";
  }
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return "—";
  }
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(date);
}

function formatDuration(value) {
  const seconds = Number(value);
  if (!Number.isFinite(seconds) || seconds < 0) {
    return "—";
  }
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  if (hours) {
    return `${hours}h ${minutes}m`;
  }
  const remainingSeconds = Math.round(seconds % 60);
  return minutes ? `${minutes}m ${remainingSeconds}s` : `${remainingSeconds}s`;
}

function formatDistance(value) {
  const distance = Number(value);
  return Number.isFinite(distance) ? `${distance.toFixed(2)} mi` : "—";
}

function statusLabel(status) {
  return (
    {
      ready: "Ready",
      warning: "Warning",
      invalid: "Blocked",
      existing: "Already here",
      imported: "Imported",
    }[status] || "Unknown"
  );
}

function displaySourceName(value) {
  const source = String(value || "Unknown file");
  const archiveSeparator = source.lastIndexOf(":");
  return archiveSeparator >= 0 ? source.slice(archiveSeparator + 1) : source;
}

function resetMap() {
  googlePolylines.forEach(({ polyline, listener }) => {
    listener?.remove?.();
    polyline?.setMap?.(null);
  });
  googlePolylines = [];
  if (importMap && mapMode === "mapbox") {
    try {
      importMap.remove();
    } catch {
      // The route may already have removed the canvas.
    }
  } else if (importMap && mapMode === "google") {
    getGoogleMapsApi()?.event?.clearInstanceListeners?.(importMap);
  }
  importMap = null;
  mapMode = null;
  mapReady = false;
  const mapElement = byId("trip-import-map");
  mapElement?.replaceChildren();
}

function resetReview() {
  analysis = null;
  selectedIds = new Set();
  activeFilter = "all";
  activeRecordKey = null;
  byId("trip-import-review")?.setAttribute("hidden", "");
  byId("trip-import-progress")?.setAttribute("hidden", "");
  byId("trip-import-complete")?.setAttribute("hidden", "");
  document.querySelectorAll("[data-import-filter]").forEach((button) => {
    const active = button.dataset.importFilter === "all";
    button.classList.toggle("active", active);
    button.setAttribute("aria-pressed", active ? "true" : "false");
  });
  resetMap();
}

function clearFiles() {
  selectedFiles = [];
  const input = byId("trip-import-file-input");
  if (input) {
    input.value = "";
  }
  byId("trip-import-file-selection")?.setAttribute("hidden", "");
  const list = byId("trip-import-file-list");
  list?.replaceChildren();
  const scan = byId("trip-import-scan");
  if (scan) {
    scan.disabled = true;
  }
  setStatus();
  resetReview();
}

function renderSelectedFiles() {
  const selection = byId("trip-import-file-selection");
  const list = byId("trip-import-file-list");
  const summary = byId("trip-import-file-summary");
  const scan = byId("trip-import-scan");
  if (!selection || !list || !summary || !scan) {
    return;
  }

  const totalBytes = selectedFiles.reduce((total, file) => total + file.size, 0);
  const oversizedFile = selectedFiles.find((file) => file.size > MAX_SINGLE_BYTES);
  const unsupportedFile = selectedFiles.find(
    (file) => !/\.(?:json|zip)$/i.test(String(file.name || "")),
  );
  summary.textContent = `${selectedFiles.length} file${selectedFiles.length === 1 ? "" : "s"} · ${formatBytes(totalBytes)}`;
  const visibleFiles = selectedFiles.slice(0, 8);
  list.innerHTML = visibleFiles
    .map(
      (file) => `
        <li>
          <span title="${escapeHtml(file.name)}">${escapeHtml(file.name)}</span>
          <span>${escapeHtml(formatBytes(file.size))}</span>
        </li>`,
    )
    .join("");
  if (selectedFiles.length > visibleFiles.length) {
    list.insertAdjacentHTML(
      "beforeend",
      `<li><span>+ ${selectedFiles.length - visibleFiles.length} more files</span></li>`,
    );
  }
  selection.removeAttribute("hidden");
  scan.disabled = !uploadWithinLimits();
  if (selectedFiles.length > MAX_UPLOAD_CONTAINERS) {
    setStatus("Select no more than 1,000 ZIP or JSON files at once.", "error");
  } else if (oversizedFile) {
    setStatus(`${oversizedFile.name} exceeds the 25 MB per-file limit.`, "error");
  } else if (unsupportedFile) {
    setStatus(`${unsupportedFile.name} is not a ZIP or JSON file.`, "error");
  } else if (totalBytes > MAX_TOTAL_BYTES) {
    setStatus("The selected files exceed the 50 MB total limit.", "error");
  } else {
    setStatus("Ready to scan. No trip data has been written.");
  }
}

function chooseFiles(files) {
  if (uploadLocked) {
    return;
  }
  selectedFiles = Array.from(files || []).filter((file) => file instanceof File);
  resetReview();
  if (!selectedFiles.length) {
    clearFiles();
    return;
  }
  renderSelectedFiles();
}

function buildUploadForm(extra = {}) {
  const form = new FormData();
  selectedFiles.forEach((file) => form.append("files", file, file.name));
  Object.entries(extra).forEach(([key, value]) => form.append(key, value));
  return form;
}

async function postUpload(endpoint, extra = {}, timeout = 120000) {
  return featureApi.rawJson(endpoint, {
    method: "POST",
    body: buildUploadForm(extra),
    retry: false,
    timeout,
  });
}

function recordMatchesFilter(record) {
  if (activeFilter === "all") {
    return true;
  }
  if (activeFilter === "importable") {
    return Boolean(record.importable);
  }
  return record.status === activeFilter;
}

function renderSummary() {
  const summary = analysis?.summary || {};
  const assignments = {
    "trip-import-total":
      summary.review_records ?? summary.unique_trips ?? summary.records_found ?? 0,
    "trip-import-ready": summary.ready ?? 0,
    "trip-import-warnings": summary.warnings ?? 0,
    "trip-import-invalid": summary.invalid ?? 0,
    "trip-import-existing": summary.existing ?? 0,
  };
  Object.entries(assignments).forEach(([id, value]) => {
    const element = byId(id);
    if (element) {
      element.textContent = String(value);
    }
  });

  const note = byId("trip-import-validation-note");
  const title = byId("trip-import-validation-title");
  const copy = byId("trip-import-validation-copy");
  const importable = Number(summary.importable) || 0;
  const warnings = Number(summary.warnings) || 0;
  const invalid = Number(summary.invalid) || 0;
  const existing = Number(summary.existing) || 0;
  const duplicateCopies = Number(summary.duplicate_copies) || 0;
  const normalizedPoints = Number(summary.repeated_points_removed) || 0;
  if (note) {
    note.dataset.tone = importable
      ? invalid || warnings
        ? "warning"
        : "neutral"
      : "error";
  }
  if (title) {
    title.textContent = importable
      ? `${importable} trip${importable === 1 ? " is" : "s are"} eligible to import`
      : "No trips can be imported from this upload";
  }
  if (copy) {
    const parts = [];
    if (warnings) {
      parts.push(`${warnings} need explicit review before selection`);
    }
    if (invalid) {
      parts.push(`${invalid} blocked by validation`);
    }
    if (existing) {
      parts.push(`${existing} already in history`);
    }
    if (duplicateCopies) {
      parts.push(`${duplicateCopies} duplicate file cop${duplicateCopies === 1 ? "y" : "ies"} collapsed`);
    }
    if (normalizedPoints) {
      parts.push(`${normalizedPoints.toLocaleString()} repeated GPS samples safely normalized`);
    }
    copy.textContent = parts.length
      ? `${parts.join("; ")}. Select a row for exact findings.`
      : "Every trip passed the file, identity, time, metric, geometry, and duplicate checks.";
  }
}

function renderIssue(issue) {
  const severity = ["error", "warning", "info"].includes(issue?.severity)
    ? issue.severity
    : "info";
  const label = {
    error: "Blocks import",
    warning: "Review",
    info: "Note",
  }[severity];
  return `<li class="import-issue-${severity}"><strong>${label}:</strong> ${escapeHtml(issue?.message || "Validation finding")}</li>`;
}

function renderIssues(record) {
  const issues = Array.isArray(record.issues) ? record.issues : [];
  if (!issues.length) {
    return '<span class="import-no-issues">Passed all checks</span>';
  }
  const label = `${issues.length} finding${issues.length === 1 ? "" : "s"}`;
  return `
    <details>
      <summary>${escapeHtml(label)}</summary>
      <ul>
        ${issues.map(renderIssue).join("")}
      </ul>
    </details>`;
}

function renderTable() {
  const body = byId("trip-import-table-body");
  const count = byId("trip-import-table-count");
  if (!body || !analysis) {
    return;
  }
  const records = (analysis.records || []).filter(recordMatchesFilter);
  if (count) {
    count.textContent = `${records.length} trip${records.length === 1 ? "" : "s"}`;
  }
  if (!records.length) {
    body.innerHTML = '<tr class="import-table-empty"><td colspan="9">No trips match this filter.</td></tr>';
    return;
  }

  body.innerHTML = records
    .map((record) => {
      const transactionId = record.transaction_id || "No transaction ID";
      const checked = record.transaction_id && selectedIds.has(record.transaction_id);
      const disabled = !record.importable;
      const focused = record.key === activeRecordKey;
      return `
        <tr data-record-key="${escapeHtml(record.key)}" class="${focused ? "is-focused" : ""}">
          <td class="import-select-column">
            <input class="import-row-checkbox"
                   type="checkbox"
                   data-import-id="${escapeHtml(record.transaction_id || "")}"
                   aria-label="Import ${escapeHtml(transactionId)}"
                   ${checked ? "checked" : ""}
                   ${disabled ? "disabled" : ""} />
          </td>
          <td><span class="import-status-pill ${escapeHtml(record.status)}">${escapeHtml(statusLabel(record.status))}</span></td>
          <td>
            <button class="import-trip-button" type="button" data-focus-record="${escapeHtml(record.key)}" title="${escapeHtml(transactionId)}">
              ${escapeHtml(transactionId)}
            </button>
            <span class="import-source-file" title="${escapeHtml(record.source_file || "")}">${escapeHtml(displaySourceName(record.source_file))}</span>
          </td>
          <td>${escapeHtml(formatDate(record.start_time))}</td>
          <td>${escapeHtml(record.vehicle_label || record.imei || "Unknown")}</td>
          <td class="is-number">${escapeHtml(formatDistance(record.distance))}</td>
          <td class="is-number">${escapeHtml(formatDuration(record.duration_seconds))}</td>
          <td class="is-number">${Number(record.point_count || 0).toLocaleString()}</td>
          <td class="import-issues-cell">${renderIssues(record)}</td>
        </tr>`;
    })
    .join("");
}

function renderSelection() {
  const count = selectedIds.size;
  const label = byId("trip-import-selection-count");
  const button = byId("trip-import-commit");
  const buttonLabel = byId("trip-import-commit-label");
  if (label) {
    label.textContent = `${count} trip${count === 1 ? "" : "s"} selected`;
  }
  if (button) {
    button.disabled = count === 0;
  }
  if (buttonLabel) {
    buttonLabel.textContent = count
      ? `Import ${count} selected trip${count === 1 ? "" : "s"}`
      : "Import selected trips";
  }
}

function findRecord(key) {
  return (analysis?.records || []).find((record) => record.key === key) || null;
}

function renderDetail(record) {
  const detail = byId("trip-import-detail");
  if (!detail || !record) {
    return;
  }
  const issues = Array.isArray(record.issues) ? record.issues : [];
  detail.innerHTML = `
    <span class="import-detail-kicker">${escapeHtml(statusLabel(record.status))}</span>
    <strong>${escapeHtml(record.transaction_id || "Trip without transaction ID")}</strong>
    <div class="import-detail-grid">
      <span>${escapeHtml(formatDate(record.start_time))}</span>
      <span>${escapeHtml(formatDistance(record.distance))}</span>
      <span>${Number(record.point_count || 0).toLocaleString()} GPS points</span>
      <span>${escapeHtml(record.vehicle_label || record.imei || "Unknown vehicle")}</span>
      <span>${escapeHtml(displaySourceName(record.source_file))}</span>
    </div>
    ${
      issues.length
        ? `<ul class="import-detail-issues">${issues.map(renderIssue).join("")}</ul>`
        : '<span class="import-no-issues">No validation findings.</span>'
    }`;
}

function coordinatesForRecord(record) {
  const gps = record?.gps;
  if (gps?.type !== "LineString" || !Array.isArray(gps.coordinates)) {
    return [];
  }
  return gps.coordinates.filter(
    (coord) =>
      Array.isArray(coord) &&
      coord.length >= 2 &&
      Number.isFinite(Number(coord[0])) &&
      Number.isFinite(Number(coord[1])),
  );
}

function recordsWithGeometry() {
  return (analysis?.records || []).filter(
    (record) => coordinatesForRecord(record).length >= 2,
  );
}

function featureCollection() {
  return {
    type: "FeatureCollection",
    features: recordsWithGeometry().map((record) => ({
      type: "Feature",
      geometry: { type: "LineString", coordinates: coordinatesForRecord(record) },
      properties: { key: record.key, status: record.status },
    })),
  };
}

function mapboxColorExpression() {
  return [
    "match",
    ["get", "status"],
    "ready",
    STATUS_COLORS.ready,
    "imported",
    STATUS_COLORS.imported,
    "warning",
    STATUS_COLORS.warning,
    "invalid",
    STATUS_COLORS.invalid,
    "existing",
    STATUS_COLORS.existing,
    STATUS_COLORS.existing,
  ];
}

function setActiveMapRoute() {
  if (!mapReady || !importMap) {
    return;
  }
  if (mapMode === "mapbox") {
    importMap.setFilter(MAP_ACTIVE_LAYER_ID, [
      "==",
      ["get", "key"],
      activeRecordKey || "__none__",
    ]);
    return;
  }
  googlePolylines.forEach(({ key, polyline, status }) => {
    const active = key === activeRecordKey;
    polyline.setOptions({
      strokeColor: active ? "#ffffff" : STATUS_COLORS[status] || STATUS_COLORS.existing,
      strokeOpacity: active ? 1 : 0.78,
      strokeWeight: active ? 7 : 4,
      zIndex: active ? 50 : 1,
    });
  });
}

function updateMapData() {
  if (!mapReady || !importMap) {
    return;
  }
  if (mapMode === "mapbox") {
    importMap.getSource(MAP_SOURCE_ID)?.setData(featureCollection());
  } else {
    renderGoogleRoutes();
  }
  setActiveMapRoute();
}

function fitMapToRecords(records) {
  const usable = records.filter((record) => coordinatesForRecord(record).length >= 2);
  if (!mapReady || !importMap || !usable.length) {
    return;
  }
  if (mapMode === "mapbox") {
    const bounds = new mapboxgl.LngLatBounds();
    usable.forEach((record) => {
      coordinatesForRecord(record).forEach((coord) => bounds.extend(coord));
    });
    if (!bounds.isEmpty()) {
      importMap.fitBounds(bounds, { padding: 54, maxZoom: 15, duration: 400 });
    }
    return;
  }
  const maps = getGoogleMapsApi();
  if (!maps) {
    return;
  }
  const bounds = new maps.LatLngBounds();
  usable.forEach((record) => {
    coordinatesForRecord(record).forEach(([lng, lat]) => bounds.extend({ lng, lat }));
  });
  importMap.fitBounds(bounds, 54);
}

function renderGoogleRoutes() {
  const maps = getGoogleMapsApi();
  if (!maps || !importMap) {
    return;
  }
  googlePolylines.forEach(({ polyline, listener }) => {
    listener?.remove?.();
    polyline.setMap(null);
  });
  googlePolylines = recordsWithGeometry().map((record) => {
    const polyline = new maps.Polyline({
      map: importMap,
      path: coordinatesForRecord(record).map(([lng, lat]) => ({ lng, lat })),
      strokeColor: STATUS_COLORS[record.status] || STATUS_COLORS.existing,
      strokeOpacity: 0.78,
      strokeWeight: 4,
      clickable: true,
      zIndex: 1,
    });
    const listener = polyline.addListener("click", () => focusRecord(record.key));
    return { key: record.key, polyline, listener, status: record.status };
  });
}

async function initializeMap() {
  resetMap();
  const records = recordsWithGeometry();
  const empty = byId("trip-import-map-empty");
  if (empty) {
    empty.textContent = "No usable route geometry was found.";
  }
  if (!records.length) {
    empty?.removeAttribute("hidden");
    return;
  }
  empty?.setAttribute("hidden", "");
  await ensureLibraries(["map"]);

  if (String(window.MAP_PROVIDER || "").toLowerCase() === "google") {
    await waitForGoogleMaps();
    const maps = getGoogleMapsApi();
    if (!maps) {
      throw new Error("Google Maps is not available");
    }
    importMap = new maps.Map(byId("trip-import-map"), {
      center: { lat: 39.82, lng: -98.57 },
      zoom: 3,
      mapTypeControl: false,
      streetViewControl: false,
      fullscreenControl: false,
    });
    mapMode = "google";
    mapReady = true;
    renderGoogleRoutes();
    fitMapToRecords(records);
    setActiveMapRoute();
    return;
  }

  importMap = createMap("trip-import-map", {
    center: [-98.57, 39.82],
    zoom: 3,
  });
  mapMode = "mapbox";
  await waitForStandaloneMapLoad(importMap);
  importMap.addSource(MAP_SOURCE_ID, {
    type: "geojson",
    data: featureCollection(),
  });
  importMap.addLayer({
    id: MAP_LINE_LAYER_ID,
    type: "line",
    source: MAP_SOURCE_ID,
    paint: {
      "line-color": mapboxColorExpression(),
      "line-opacity": 0.76,
      "line-width": ["interpolate", ["linear"], ["zoom"], 4, 2, 12, 5],
    },
    layout: { "line-cap": "round", "line-join": "round" },
  });
  importMap.addLayer({
    id: MAP_ACTIVE_LAYER_ID,
    type: "line",
    source: MAP_SOURCE_ID,
    filter: ["==", ["get", "key"], activeRecordKey || "__none__"],
    paint: {
      "line-color": "#ffffff",
      "line-opacity": 1,
      "line-width": ["interpolate", ["linear"], ["zoom"], 4, 5, 12, 9],
    },
    layout: { "line-cap": "round", "line-join": "round" },
  });
  const handleRouteClick = (event) => {
    const key = event.features?.[0]?.properties?.key;
    if (key) {
      focusRecord(key);
    }
  };
  importMap.on("click", MAP_LINE_LAYER_ID, handleRouteClick);
  importMap.on("mouseenter", MAP_LINE_LAYER_ID, () => {
    importMap.getCanvas().style.cursor = "pointer";
  });
  importMap.on("mouseleave", MAP_LINE_LAYER_ID, () => {
    importMap.getCanvas().style.cursor = "";
  });
  mapReady = true;
  fitMapToRecords(records);
}

function waitForStandaloneMapLoad(map) {
  if (map.loaded?.()) {
    return Promise.resolve();
  }
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (error = null) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timeoutId);
      pageSignal?.removeEventListener("abort", handleAbort);
      if (error) {
        reject(error);
      } else {
        resolve();
      }
    };
    const handleAbort = () => {
      const error = new Error("Page navigation canceled map loading");
      error.name = "AbortError";
      finish(error);
    };
    const timeoutId = setTimeout(
      () => finish(new Error("The route preview map did not finish loading")),
      15000,
    );
    pageSignal?.addEventListener("abort", handleAbort, { once: true });
    map.once("load", () => finish());
  });
}

function focusRecord(key, { fit = true, scroll = true } = {}) {
  const record = findRecord(key);
  if (!record) {
    return;
  }
  activeRecordKey = key;
  renderDetail(record);
  renderTable();
  setActiveMapRoute();
  if (fit && coordinatesForRecord(record).length >= 2) {
    fitMapToRecords([record]);
  }
  if (scroll) {
    const row = document.querySelector(`[data-record-key="${CSS.escape(key)}"]`);
    row?.scrollIntoView({ block: "nearest", behavior: "smooth" });
  }
}

function renderReview() {
  renderSummary();
  renderTable();
  renderSelection();
  const firstRecord =
    findRecord(activeRecordKey) ||
    (analysis?.records || []).find((record) => coordinatesForRecord(record).length >= 2) ||
    analysis?.records?.[0];
  if (firstRecord) {
    activeRecordKey = firstRecord.key;
    renderDetail(firstRecord);
  }
}

async function scanFiles() {
  if (!selectedFiles.length) {
    return;
  }
  const button = byId("trip-import-scan");
  const rescan = byId("trip-import-rescan");
  if (button) {
    button.disabled = true;
  }
  if (rescan) {
    rescan.disabled = true;
  }
  setUploadLocked(true);
  setStatus("Scanning every file and comparing transaction IDs with trip history…", "working");
  try {
    const preview = await postUpload(PREVIEW_ENDPOINT);
    analysis = preview;
    selectedIds = new Set(
      (analysis.records || [])
        .filter((record) => record.status === "ready" && record.transaction_id)
        .map((record) => record.transaction_id),
    );
    activeFilter = "all";
    activeRecordKey = null;
    byId("trip-import-review")?.removeAttribute("hidden");
    byId("trip-import-complete")?.setAttribute("hidden", "");
    renderReview();
    let mapError = null;
    try {
      await initializeMap();
    } catch (error) {
      if (isAbortError(error)) {
        throw error;
      }
      mapError = error;
      console.error("Manual trip map preview failed", error);
      resetMap();
      const empty = byId("trip-import-map-empty");
      if (empty) {
        empty.textContent =
          "The route map could not be loaded. The table review is still available.";
        empty.removeAttribute("hidden");
      }
    }
    const eligible = Number(analysis.summary?.importable) || 0;
    setStatus(
      mapError
        ? `Scan complete: ${eligible} trip${eligible === 1 ? "" : "s"} eligible. The map preview is unavailable; scan again to retry it.`
        : `Scan complete: ${eligible} trip${eligible === 1 ? "" : "s"} eligible.`,
      mapError ? "warning" : "neutral",
    );
    if (mapError) {
      notificationManager.show(
        "Trip scan completed, but the map preview could not load",
        "warning",
      );
    }
    byId("trip-import-review")?.scrollIntoView({ behavior: "smooth", block: "start" });
  } catch (error) {
    if (isAbortError(error)) {
      return;
    }
    console.error("Manual trip preview failed", error);
    setStatus(error.message || "Unable to scan the selected files.", "error");
    notificationManager.show("Unable to scan trip files", "danger");
  } finally {
    setUploadLocked(false);
    if (button) {
      button.disabled = !uploadWithinLimits();
    }
    if (rescan) {
      rescan.disabled = false;
    }
  }
}

function setImporting(importing) {
  setUploadLocked(importing);
  [
    "trip-import-scan",
    "trip-import-rescan",
    "trip-import-select-all",
    "trip-import-select-none",
    "trip-import-commit",
  ].forEach((id) => {
    const element = byId(id);
    if (element) {
      element.disabled = importing || (id === "trip-import-commit" && !selectedIds.size);
    }
  });
}

function updateImportProgress(completed, total, message) {
  const percentage = total ? Math.min(100, (completed / total) * 100) : 0;
  const count = byId("trip-import-progress-count");
  const bar = byId("trip-import-progress-bar");
  const track = byId("trip-import-progress-track");
  const copy = byId("trip-import-progress-copy");
  if (count) {
    count.textContent = `${completed} / ${total}`;
  }
  if (bar) {
    bar.style.width = `${percentage}%`;
  }
  track?.setAttribute("aria-valuenow", String(Math.round(percentage)));
  if (copy) {
    copy.textContent = message;
  }
}

function markCompleted(ids) {
  const completed = new Set(ids || []);
  (analysis?.records || []).forEach((record) => {
    if (record.transaction_id && completed.has(record.transaction_id)) {
      record.status = "imported";
      record.importable = false;
      selectedIds.delete(record.transaction_id);
    }
  });
  renderTable();
  renderSelection();
  const activeRecord = findRecord(activeRecordKey);
  if (activeRecord) {
    renderDetail(activeRecord);
  }
  updateMapData();
}

async function commitImport() {
  if (!analysis || !selectedIds.size) {
    return;
  }
  const ids = Array.from(selectedIds);
  const warningCount = (analysis.records || []).filter(
    (record) => selectedIds.has(record.transaction_id) && record.status === "warning",
  ).length;
  const confirmed = await confirmationDialog.show({
    title: `Import ${ids.length} historical trip${ids.length === 1 ? "" : "s"}?`,
    message: `${warningCount ? `${warningCount} selected trip${warningCount === 1 ? " has" : "s have"} warnings. ` : ""}This adds new Bouncie history only; existing trips are never overwritten.`,
    confirmText: "Import trips",
    confirmButtonClass: "btn-primary",
  });
  if (!confirmed) {
    return;
  }

  const batchSize = Math.max(
    1,
    Number(analysis.limits?.max_import_batch_size) || FALLBACK_BATCH_SIZE,
  );
  const batches = [];
  for (let index = 0; index < ids.length; index += batchSize) {
    batches.push(ids.slice(index, index + batchSize));
  }

  let completed = 0;
  let inserted = 0;
  let alreadyPresent = 0;
  const progress = byId("trip-import-progress");
  progress?.removeAttribute("hidden");
  byId("trip-import-complete")?.setAttribute("hidden", "");
  setImporting(true);
  updateImportProgress(0, ids.length, "Revalidating the first batch…");

  try {
    for (const [index, batch] of batches.entries()) {
      updateImportProgress(
        completed,
        ids.length,
        `Processing batch ${index + 1} of ${batches.length}…`,
      );
      const result = await postUpload(
        COMMIT_ENDPOINT,
        {
          fingerprint: analysis.fingerprint,
          selected_ids: JSON.stringify(batch),
        },
        180000,
      );
      const completedIds = result.completed_ids || [];
      inserted += Number(result.inserted) || 0;
      alreadyPresent += Number(result.already_present) || 0;
      completed += completedIds.length;
      markCompleted(completedIds);
      if ((result.failed_ids || []).length) {
        throw new Error(
          `${result.failed_ids.length} trip${result.failed_ids.length === 1 ? "" : "s"} failed in batch ${index + 1}.`,
        );
      }
      updateImportProgress(
        completed,
        ids.length,
        completed < ids.length ? "Batch complete. Continuing…" : "Finalizing trip history…",
      );
    }

    progress?.setAttribute("hidden", "");
    const completePanel = byId("trip-import-complete");
    const title = byId("trip-import-complete-title");
    const copy = byId("trip-import-complete-copy");
    if (title) {
      title.textContent = `${inserted} trip${inserted === 1 ? "" : "s"} added to history`;
    }
    if (copy) {
      copy.textContent = alreadyPresent
        ? `${alreadyPresent} trip${alreadyPresent === 1 ? " was" : "s were"} already present during an idempotent retry. New trips received normal geocoding, coverage, and mobility processing.`
        : "The selected trips are now historical Bouncie data with normal geocoding, coverage, and mobility processing.";
    }
    completePanel?.removeAttribute("hidden");
    completePanel?.scrollIntoView({ behavior: "smooth", block: "center" });
    setStatus("Import complete.");
    notificationManager.show(`Imported ${inserted} historical trip${inserted === 1 ? "" : "s"}`, "success");
  } catch (error) {
    if (isAbortError(error)) {
      return;
    }
    console.error("Manual trip import failed", error);
    updateImportProgress(
      completed,
      ids.length,
      `Import paused: ${error.message || "Unknown error"}. Retry the remaining selection when ready.`,
    );
    setStatus(error.message || "Import paused before every trip completed.", "error");
    notificationManager.show("Trip import paused", "danger");
  } finally {
    setImporting(false);
  }
}

function setupFileControls() {
  const input = byId("trip-import-file-input");
  const browse = byId("trip-import-browse");
  const dropZone = byId("trip-import-drop-zone");
  listen(input, "change", () => chooseFiles(input.files));
  listen(browse, "click", (event) => {
    event.stopPropagation();
    input?.click();
  });
  listen(dropZone, "click", (event) => {
    if (!event.target.closest("button")) {
      input?.click();
    }
  });
  ["dragenter", "dragover"].forEach((eventName) => {
    listen(dropZone, eventName, (event) => {
      event.preventDefault();
      dropZone?.classList.add("is-dragging");
    });
  });
  ["dragleave", "drop"].forEach((eventName) => {
    listen(dropZone, eventName, (event) => {
      event.preventDefault();
      dropZone?.classList.remove("is-dragging");
    });
  });
  listen(dropZone, "drop", (event) => chooseFiles(event.dataTransfer?.files));
  listen(byId("trip-import-clear-files"), "click", clearFiles);
  listen(byId("trip-import-scan"), "click", scanFiles);
  listen(byId("trip-import-rescan"), "click", scanFiles);
}

function setupReviewControls() {
  document.querySelectorAll("[data-import-filter]").forEach((button) => {
    listen(button, "click", () => {
      activeFilter = button.dataset.importFilter || "all";
      document.querySelectorAll("[data-import-filter]").forEach((candidate) => {
        const active = candidate === button;
        candidate.classList.toggle("active", active);
        candidate.setAttribute("aria-pressed", active ? "true" : "false");
      });
      renderTable();
    });
  });

  listen(byId("trip-import-select-all"), "click", () => {
    selectedIds = new Set(
      (analysis?.records || [])
        .filter((record) => record.importable && record.transaction_id)
        .map((record) => record.transaction_id),
    );
    renderTable();
    renderSelection();
  });
  listen(byId("trip-import-select-none"), "click", () => {
    selectedIds.clear();
    renderTable();
    renderSelection();
  });
  listen(byId("trip-import-fit-map"), "click", () => fitMapToRecords(recordsWithGeometry()));
  listen(byId("trip-import-commit"), "click", commitImport);

  listen(byId("trip-import-table-body"), "change", (event) => {
    const checkbox = event.target.closest("[data-import-id]");
    if (!checkbox) {
      return;
    }
    const transactionId = checkbox.dataset.importId;
    if (checkbox.checked) {
      selectedIds.add(transactionId);
    } else {
      selectedIds.delete(transactionId);
    }
    renderSelection();
  });
  listen(byId("trip-import-table-body"), "click", (event) => {
    const button = event.target.closest("[data-focus-record]");
    if (button) {
      focusRecord(button.dataset.focusRecord);
    }
  });
}

export default async function initManualTripImport({ signal, api, onCleanup } = {}) {
  pageSignal = signal || null;
  featureApi = api;
  selectedFiles = [];
  analysis = null;
  selectedIds = new Set();
  uploadLocked = false;
  setupFileControls();
  setupReviewControls();
  onCleanup?.(() => {
    resetMap();
    pageSignal = null;
    featureApi = null;
    selectedFiles = [];
    analysis = null;
    selectedIds = new Set();
    uploadLocked = false;
  });
}
