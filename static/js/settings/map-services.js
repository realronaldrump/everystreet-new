/**
 * Map Services Tab - Settings Page
 *
 * Provides map coverage selection and unified status display.
 */

import apiClient from "../modules/core/api-client.js";
import notificationManager from "../modules/ui/notifications.js";

const MAP_SERVICES_API = "/api/map-services";

let stateCatalog = null;
let selectedStates = new Set();
let mapStatus = null;
let pollTimer = null;

export function initMapServicesTab() {
  bindEvents();
  loadStateCatalog();
  refreshMapStatus();
}

export function cleanupMapServicesTab() {
  if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
  }
}

export default {
  initMapServicesTab,
  cleanupMapServicesTab,
};

function bindEvents() {
  document
    .getElementById("map-coverage-change-btn")
    ?.addEventListener("click", toggleCoverageEditor);
  document
    .getElementById("map-coverage-rebuild-btn")
    ?.addEventListener("click", rebuildCoverage);
  document
    .getElementById("map-coverage-save-btn")
    ?.addEventListener("click", saveCoverage);
  document
    .getElementById("map-coverage-cancel-btn")
    ?.addEventListener("click", cancelCoverageSetup);
}

async function loadStateCatalog() {
  try {
    const response = await apiClient.raw(`${MAP_SERVICES_API}/states`);
    const data = await response.json();
    if (!response.ok) {
      throw new Error(data?.detail || "Unable to load state catalog.");
    }
    stateCatalog = data;
    renderStateSelector();
  } catch (error) {
    const container = document.getElementById("map-coverage-state-selector");
    if (container) {
      container.innerHTML = `<div class="text-danger">${error.message}</div>`;
    }
  }
}

async function refreshMapStatus() {
  try {
    const response = await apiClient.raw(`${MAP_SERVICES_API}/status`);
    const data = await response.json();
    if (!response.ok) {
      throw new Error(data?.detail || "Unable to load map status.");
    }
    mapStatus = data;
    applySelectedStatesFromStatus();
    updateMapSummary();
    updateProgress();
    maybeStartPolling();
  } catch (error) {
    notificationManager.show(error.message, "danger");
  }
}

function renderStateSelector() {
  const container = document.getElementById("map-coverage-state-selector");
  if (!container || !stateCatalog?.regions || !stateCatalog?.states) {
    return;
  }

  const stateMap = new Map();
  stateCatalog.states.forEach((state) => {
    stateMap.set(state.code, state);
  });

  container.innerHTML = Object.entries(stateCatalog.regions)
    .map(([regionName, codes]) => {
      const items = codes
        .map((code) => {
          const state = stateMap.get(code);
          if (!state) {
            return "";
          }
          const size = Number(state.size_mb || 0);
          return `
            <label class="state-option">
              <input type="checkbox" value="${state.code}" data-size="${size}" />
              <span class="state-name">${state.name}</span>
              <span class="state-size">${size ? `${size} MB` : "--"}</span>
            </label>
          `;
        })
        .join("");
      return `
        <div class="state-region">
          <div class="state-region-title">${regionName}</div>
          <div class="state-region-grid">${items}</div>
        </div>
      `;
    })
    .join("");

  container.querySelectorAll('input[type="checkbox"]').forEach((input) => {
    input.addEventListener("change", () => {
      const code = input.value;
      if (input.checked) {
        selectedStates.add(code);
      } else {
        selectedStates.delete(code);
      }
      updateStateSelectionUI();
      updateSelectionSummary();
    });
  });

  applySelectedStatesFromStatus();
  updateSelectionSummary();
  updateStateSelectionUI();
}

function applySelectedStatesFromStatus() {
  const configured = mapStatus?.config?.selected_states || [];
  selectedStates = new Set(configured);
  updateStateSelectionUI();
  updateSelectionSummary();
}

function updateStateSelectionUI() {
  const container = document.getElementById("map-coverage-state-selector");
  if (!container) {
    return;
  }
  container.querySelectorAll('input[type="checkbox"]').forEach((input) => {
    const selected = selectedStates.has(input.value);
    input.checked = selected;
    input.closest(".state-option")?.classList.toggle("is-selected", selected);
  });
}

function updateSelectionSummary() {
  const totalSize = Array.from(selectedStates).reduce((sum, code) => {
    const state = stateCatalog?.states?.find((item) => item.code === code);
    return sum + Number(state?.size_mb || 0);
  }, 0);
  const sizeEl = document.getElementById("map-coverage-total-size");
  if (sizeEl) {
    sizeEl.textContent = totalSize ? `${totalSize.toLocaleString()} MB` : "--";
  }
}

function updateMapSummary() {
  const status = mapStatus?.config;
  const summary = document.getElementById("map-coverage-summary");
  if (!summary) {
    return;
  }
  const states = status?.selected_state_names?.length
    ? status.selected_state_names.join(", ")
    : "None selected";
  const statusText = status?.status
    ? status.status.replace("_", " ")
    : "not configured";
  const lastUpdated = status?.last_updated
    ? new Date(status.last_updated).toLocaleString()
    : "--";

  summary.innerHTML = `
    <div class="map-coverage-line"><strong>Coverage:</strong> ${states}</div>
    <div class="map-coverage-line"><strong>Status:</strong> ${statusText}</div>
    <div class="map-coverage-line"><strong>Last updated:</strong> ${lastUpdated}</div>
  `;
}

function updateProgress() {
  const status = mapStatus?.config;
  const progressWrap = document.getElementById("map-coverage-progress");
  const progressBar = document.getElementById("map-coverage-progress-bar");
  const progressText = document.getElementById("map-coverage-progress-text");
  const messageEl = document.getElementById("map-coverage-message");
  const cancelBtn = document.getElementById("map-coverage-cancel-btn");

  if (progressBar) {
    const percent = Number(status?.progress || 0);
    progressBar.style.width = `${Math.min(100, percent)}%`;
  }
  if (progressText) {
    const percent = Number(status?.progress || 0);
    progressText.textContent = percent ? `${percent.toFixed(0)}%` : "";
  }
  if (messageEl) {
    messageEl.textContent = status?.message || "Select states to begin.";
  }
  const showProgress =
    status?.status === "downloading" ||
    status?.status === "building" ||
    status?.status === "error";
  if (progressWrap) {
    progressWrap.classList.toggle("d-none", !showProgress);
  }
  if (cancelBtn) {
    cancelBtn.classList.toggle("d-none", !showProgress);
  }
}

function maybeStartPolling() {
  const status = mapStatus?.config?.status;
  const shouldPoll = status === "downloading" || status === "building";
  if (shouldPoll && !pollTimer) {
    pollTimer = setInterval(refreshMapStatus, 4000);
  } else if (!shouldPoll && pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
  }
}

function toggleCoverageEditor() {
  const editor = document.getElementById("map-coverage-editor");
  if (!editor) {
    return;
  }
  editor.classList.toggle("d-none");
}

async function saveCoverage() {
  if (!selectedStates.size) {
    notificationManager.show("Select at least one state.", "warning");
    return;
  }
  try {
    await apiClient.raw(`${MAP_SERVICES_API}/configure`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ states: Array.from(selectedStates) }),
    });
    notificationManager.show("Map setup started.", "success");
    await refreshMapStatus();
    toggleCoverageEditor();
  } catch (error) {
    notificationManager.show(error.message || "Unable to start setup.", "danger");
  }
}

async function rebuildCoverage() {
  const currentStates = mapStatus?.config?.selected_states || [];
  if (!currentStates.length) {
    notificationManager.show("Select coverage before rebuilding.", "warning");
    return;
  }
  try {
    await apiClient.raw(`${MAP_SERVICES_API}/configure`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ states: currentStates, force: true }),
    });
    notificationManager.show("Rebuild started.", "success");
    await refreshMapStatus();
  } catch (error) {
    notificationManager.show(error.message || "Unable to rebuild.", "danger");
  }
}

async function cancelCoverageSetup() {
  try {
    await apiClient.raw(`${MAP_SERVICES_API}/cancel`, { method: "POST" });
    notificationManager.show("Setup cancelled.", "success");
    await refreshMapStatus();
  } catch (error) {
    notificationManager.show(error.message || "Unable to cancel.", "danger");
  }
}
