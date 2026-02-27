import apiClient from "../core/api-client.js";
import { onPageLoad } from "../utils.js";

const SETUP_STATUS_API = "/api/setup/status";
const SETUP_ROUTE = "/setup-wizard";
const CACHE_WINDOW_MS = 30000;
const COLLAPSE_KEY = "es:setup-modal-collapsed";
const REFRESH_KEY = "es:setup-status-refresh";

let lastFetchAt = 0;
let cachedStatus = null;
let inFlight = null;
let boundToggle = false;
let refreshListenerBound = false;

const SELF_HOSTED_STEP_META = [
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

const GOOGLE_STEP_META = [
  {
    key: "bouncie",
    title: "Connect Bouncie",
    detail: "Client ID, secret, redirect, and authorized devices",
  },
  {
    key: "google_maps",
    title: "Add Google Maps API key",
    detail: "Required for maps and geocoding",
  },
];

function resolveProvider(status) {
  const provider = String(
    status?.map_provider ||
      status?.steps?.provider?.selected ||
      window.MAP_PROVIDER ||
      "self_hosted"
  )
    .trim()
    .toLowerCase();
  return provider === "google" ? "google" : "self_hosted";
}

function checklistMetaForProvider(status) {
  return resolveProvider(status) === "google"
    ? GOOGLE_STEP_META
    : SELF_HOSTED_STEP_META;
}

function shouldSkipBanner() {
  return document.body?.dataset?.route === SETUP_ROUTE;
}

function fetchSetupStatus(signal, { force = false } = {}) {
  const now = Date.now();
  if (!force && cachedStatus && now - lastFetchAt < CACHE_WINDOW_MS) {
    return Promise.resolve(cachedStatus);
  }

  if (!force && inFlight) {
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

function renderChecklist(listEl, status) {
  if (!listEl) {
    return;
  }
  listEl.innerHTML = "";
  const steps = status?.steps || {};
  const stepMeta = checklistMetaForProvider(status);
  stepMeta.forEach((meta) => {
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
      const missing =
        Array.isArray(step.missing) && step.missing.length
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

function updateUI(status) {
  const modal = document.getElementById("setup-required-modal");
  const fab = document.getElementById("setup-required-fab");
  if (!modal || !fab) {
    return;
  }
  if (shouldSkipBanner() || !shouldShowBanner(status)) {
    modal.classList.add("d-none");
    fab.classList.add("d-none");
    return;
  }

  const listEl = document.getElementById("setup-required-list");
  const messageEl = document.getElementById("setup-required-message");
  if (messageEl) {
    messageEl.textContent =
      resolveProvider(status) === "google"
        ? "Run the setup wizard to connect Bouncie and Google Maps."
        : "Run the setup wizard to connect Bouncie and your self-hosted services.";
  }
  renderChecklist(listEl, status);
  applyCollapsedState(modal, fab);
}

function getCollapsedPreference() {
  try {
    return window.localStorage.getItem(COLLAPSE_KEY) === "true";
  } catch {
    return false;
  }
}

function setCollapsedPreference(value) {
  try {
    window.localStorage.setItem(COLLAPSE_KEY, value ? "true" : "false");
  } catch {
    // Ignore storage errors
  }
}

function consumeRefreshFlag() {
  try {
    const flag = window.localStorage.getItem(REFRESH_KEY);
    if (!flag) {
      return false;
    }
    window.localStorage.removeItem(REFRESH_KEY);
    return true;
  } catch {
    return false;
  }
}

function applyCollapsedState(modal, fab) {
  const collapsed = getCollapsedPreference();
  modal.classList.toggle("d-none", collapsed);
  fab.classList.toggle("d-none", !collapsed);
  const toggle = document.getElementById("setup-required-toggle");
  if (!toggle) {
    return;
  }
  toggle.setAttribute("aria-expanded", collapsed ? "false" : "true");
  toggle.setAttribute(
    "aria-label",
    collapsed ? "Expand setup modal" : "Minimize setup modal"
  );
  toggle.setAttribute("title", collapsed ? "Expand" : "Minimize");
  toggle.textContent = collapsed ? "+" : "-";
}

function bindToggleHandler() {
  if (boundToggle) {
    return;
  }
  const modal = document.getElementById("setup-required-modal");
  const toggle = document.getElementById("setup-required-toggle");
  const fab = document.getElementById("setup-required-fab");
  if (!modal || !toggle || !fab) {
    return;
  }
  toggle.addEventListener("click", () => {
    const collapsed = !getCollapsedPreference();
    setCollapsedPreference(collapsed);
    applyCollapsedState(modal, fab);
  });
  fab.addEventListener("click", () => {
    setCollapsedPreference(false);
    applyCollapsedState(modal, fab);
  });
  boundToggle = true;
}

async function refreshStatus({ signal, force = false } = {}) {
  try {
    const status = await fetchSetupStatus(signal, { force });
    updateUI(status);
  } catch (error) {
    console.warn("Setup status check failed", error);
    updateUI(null);
  }
}

function initSetupRequiredBanner() {
  onPageLoad(async ({ signal } = {}) => {
    if (shouldSkipBanner()) {
      updateUI(null);
      return;
    }
    bindToggleHandler();
    const force = consumeRefreshFlag();
    await refreshStatus({ signal, force });
  });

  if (refreshListenerBound) {
    return;
  }
  document.addEventListener("es:setup-status-refresh", () => {
    lastFetchAt = 0;
    cachedStatus = null;
    inFlight = null;
    refreshStatus({ force: true });
  });
  refreshListenerBound = true;
}

export default { init: initSetupRequiredBanner };
