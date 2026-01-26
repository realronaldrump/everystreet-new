import apiClient from "../core/api-client.js";
import { onPageLoad } from "../utils.js";

const SETUP_STATUS_API = "/api/setup/status";
const SETUP_ROUTE = "/setup-wizard";
const CACHE_WINDOW_MS = 30000;

let lastFetchAt = 0;
let cachedStatus = null;
let inFlight = null;

const STEP_META = [
  {
    key: "bouncie",
    title: "Connect Bouncie",
    detail: "Client ID, secret, redirect, and authorized devices",
  },
  {
    key: "mapbox",
    title: "Add Mapbox token",
    detail: "Required for maps and geocoding",
  },
  {
    key: "coverage",
    title: "Select coverage area",
    detail: "Choose states and build map data",
  },
];

function shouldSkipBanner() {
  return document.body?.dataset?.route === SETUP_ROUTE;
}

async function fetchSetupStatus(signal) {
  const now = Date.now();
  if (cachedStatus && now - lastFetchAt < CACHE_WINDOW_MS) {
    return cachedStatus;
  }

  if (inFlight) {
    return inFlight;
  }

  inFlight = apiClient
    .get(SETUP_STATUS_API, { signal })
    .then((data) => {
      cachedStatus = data;
      lastFetchAt = Date.now();
      return data;
    })
    .finally(() => {
      inFlight = null;
    });

  return inFlight;
}

function shouldShowBanner(status) {
  if (!status) {
    return false;
  }
  if (status.setup_completed && status.required_complete) {
    return false;
  }
  return true;
}

function renderChecklist(listEl, steps) {
  if (!listEl) {
    return;
  }
  listEl.innerHTML = "";
  STEP_META.forEach((meta) => {
    const step = steps?.[meta.key] || {};
    const complete = Boolean(step.complete);
    const item = document.createElement("li");
    item.className = `setup-required-item${complete ? " is-complete" : ""}`;
    const icon = document.createElement("i");
    icon.className = complete ? "fas fa-check-circle" : "fas fa-circle";
    icon.setAttribute("aria-hidden", "true");
    const text = document.createElement("div");
    const title = document.createElement("div");
    title.textContent = meta.title;
    title.className = "setup-required-item-title";
    const detail = document.createElement("div");
    detail.className = "setup-required-item-detail";
    if (complete) {
      detail.textContent = "Complete";
    } else {
      const missing = Array.isArray(step.missing) && step.missing.length
        ? `Missing: ${step.missing.join(", ")}`
        : meta.detail;
      detail.textContent = missing;
    }
    text.appendChild(title);
    text.appendChild(detail);
    item.appendChild(icon);
    item.appendChild(text);
    listEl.appendChild(item);
  });
}

function updateBanner(status) {
  const banner = document.getElementById("setup-required-banner");
  if (!banner) {
    return;
  }
  if (shouldSkipBanner()) {
    banner.classList.add("d-none");
    return;
  }

  if (!shouldShowBanner(status)) {
    banner.classList.add("d-none");
    return;
  }

  const listEl = document.getElementById("setup-required-list");
  renderChecklist(listEl, status.steps || {});
  banner.classList.remove("d-none");
}

function initSetupRequiredBanner() {
  onPageLoad(async ({ signal } = {}) => {
    if (shouldSkipBanner()) {
      updateBanner(null);
      return;
    }
    try {
      const status = await fetchSetupStatus(signal);
      updateBanner(status);
    } catch (error) {
      console.warn("Setup status check failed", error);
      updateBanner(null);
    }
  });
}

export default { init: initSetupRequiredBanner };
