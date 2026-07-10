import apiClient from "../../core/api-client.js";
import { CONFIG } from "../../core/config.js";
import { setMap3dBuildingsPreference } from "../map/buildings-3d.js";
import { setTerrainReliefPreference } from "../map/terrain-relief.js";
import { setTripLayerHeatmapPreference } from "../map/trip-layer-render-mode.js";

const TAB_STORAGE_KEY = "es:settings-active-tab";
export const SETTINGS_TAB_CHANGED_EVENT = "settings:tab-changed";
const TAB_ALIASES = {
  overview: "system",
  status: "system",
  sync: "system",
  "sync-settings": "system",
  "data-management": "system",
  storage: "system",
  logs: "system",
  "server-logs": "system",
  "map-services": "system",
  credentials: "connections",
  profile: "account",
};

function normalizeTabName(value) {
  const name = String(value || "")
    .replace(/^#/, "")
    .replace(/-tab$/, "")
    .trim();
  return TAB_ALIASES[name] || name;
}

export function setActiveTab(tabName, { persist = true, updateHash = false } = {}) {
  const normalized = normalizeTabName(tabName);
  const button = document.querySelector(`.settings-tab[data-tab="${normalized}"]`);
  const panel = document.getElementById(`${normalized}-tab`);
  if (!button || !panel) {
    return false;
  }

  document.querySelectorAll(".settings-tab").forEach((tab) => {
    const active = tab === button;
    tab.classList.toggle("active", active);
    tab.setAttribute("aria-selected", String(active));
  });
  document.querySelectorAll(".settings-panel").forEach((candidate) => {
    const active = candidate === panel;
    candidate.classList.toggle("active", active);
    candidate.hidden = !active;
  });

  if (persist) {
    localStorage.setItem(TAB_STORAGE_KEY, normalized);
  }
  if (updateHash) {
    const url = new URL(window.location.href);
    url.hash = normalized;
    window.history.replaceState(window.history.state, document.title, url);
  }
  document.dispatchEvent(
    new CustomEvent(SETTINGS_TAB_CHANGED_EVENT, { detail: { tabName: normalized } })
  );
  return true;
}

function setupTabs(signal) {
  const options = signal ? { signal } : undefined;
  const initial =
    normalizeTabName(window.location.hash) ||
    normalizeTabName(localStorage.getItem(TAB_STORAGE_KEY)) ||
    "system";
  if (!setActiveTab(initial)) {
    setActiveTab("system");
  }

  document.querySelectorAll(".settings-tab").forEach((tab) => {
    tab.addEventListener(
      "click",
      () => setActiveTab(tab.dataset.tab, { updateHash: true }),
      options
    );
  });
  window.addEventListener(
    "hashchange",
    () => setActiveTab(normalizeTabName(window.location.hash)),
    options
  );
}

function readStoredBoolean(key) {
  const raw = localStorage.getItem(key);
  return raw === "true" ? true : raw === "false" ? false : null;
}

function setupPreferences(signal) {
  const form = document.getElementById("app-settings-form");
  if (!form) {
    return;
  }
  const fields = {
    mapProvider: document.getElementById("map-provider-select"),
    darkMode: document.getElementById("dark-mode-toggle"),
    highlightRecent: document.getElementById("highlight-recent-trips"),
    autoCenter: document.getElementById("auto-center-toggle"),
    buildings: document.getElementById("map-3d-buildings-toggle"),
    terrain: document.getElementById("map-terrain-relief-toggle"),
    coverageOnly: document.getElementById("map-trips-within-coverage-only"),
    heatmap: document.getElementById("trip-layers-use-heatmap"),
    accent: document.getElementById("accent-color-picker"),
    saveState: document.getElementById("preferences-save-state"),
  };
  const densityInputs = [...form.querySelectorAll("input[name='ui-density']")];
  const headerThemeToggle = document.getElementById("theme-toggle-checkbox");
  let saveTimer = null;
  let previousProvider = null;

  const setSaveState = (label, state = "saved") => {
    if (!fields.saveState) {
      return;
    }
    fields.saveState.textContent = label;
    fields.saveState.dataset.state = state;
  };

  const applyLocalPreferences = (payload) => {
    localStorage.setItem("highlightRecentTrips", String(payload.highlightRecentTrips));
    localStorage.setItem("autoCenter", String(payload.autoCenter));
    localStorage.setItem("es:accent-color", payload.accentColor);
    localStorage.setItem("es:ui-density", payload.uiDensity);
    localStorage.setItem(
      CONFIG.STORAGE_KEYS.mapTripsWithinCoverageOnly,
      String(payload.mapTripsWithinCoverageOnly)
    );
    setMap3dBuildingsPreference(payload.map3dBuildingsEnabled);
    setTerrainReliefPreference(payload.mapTerrainReliefEnabled);
    setTripLayerHeatmapPreference(payload.tripLayersUseHeatmap);
    window.personalization?.applyPreferences?.({
      accentColor: payload.accentColor,
      density: payload.uiDensity,
      persist: false,
    });
    window.densityManager?.apply?.(payload.uiDensity, { persist: false });
  };

  const collect = () => ({
    map_provider: fields.mapProvider?.value || "self_hosted",
    highlightRecentTrips: fields.highlightRecent?.checked ?? true,
    autoCenter: fields.autoCenter?.checked ?? true,
    map3dBuildingsEnabled: fields.buildings?.checked ?? true,
    mapTerrainReliefEnabled: fields.terrain?.checked ?? false,
    mapTripsWithinCoverageOnly: fields.coverageOnly?.checked ?? false,
    tripLayersUseHeatmap: fields.heatmap?.checked ?? true,
    accentColor: fields.accent?.value || "#b87a4a",
    uiDensity: densityInputs.find((input) => input.checked)?.value || "comfortable",
  });

  const save = async () => {
    const payload = collect();
    applyLocalPreferences(payload);
    setSaveState("Saving…", "saving");
    try {
      await apiClient.post("/api/app_settings", payload, { signal });
      setSaveState("Saved automatically");
      if (previousProvider && previousProvider !== payload.map_provider) {
        window.location.reload();
      }
      previousProvider = payload.map_provider;
    } catch (error) {
      if (signal?.aborted) {
        return;
      }
      setSaveState("Couldn’t save — retrying on next change", "error");
    }
  };

  const scheduleSave = () => {
    if (saveTimer) {
      clearTimeout(saveTimer);
    }
    setSaveState("Saving…", "saving");
    saveTimer = setTimeout(save, 450);
  };

  const applySettings = (settings = {}) => {
    previousProvider = settings.map_provider || "self_hosted";
    if (fields.mapProvider) fields.mapProvider.value = previousProvider;
    if (fields.darkMode) {
      fields.darkMode.checked =
        document.documentElement.getAttribute("data-bs-theme") === "dark";
    }
    if (fields.highlightRecent) {
      fields.highlightRecent.checked = settings.highlightRecentTrips !== false;
    }
    if (fields.autoCenter) fields.autoCenter.checked = settings.autoCenter !== false;

    const buildings =
      typeof settings.map3dBuildingsEnabled === "boolean"
        ? settings.map3dBuildingsEnabled
        : (readStoredBoolean(CONFIG.STORAGE_KEYS.map3dBuildingsEnabled) ?? true);
    const terrain =
      typeof settings.mapTerrainReliefEnabled === "boolean"
        ? settings.mapTerrainReliefEnabled
        : (readStoredBoolean(CONFIG.STORAGE_KEYS.mapTerrainReliefEnabled) ?? false);
    const coverageOnly =
      typeof settings.mapTripsWithinCoverageOnly === "boolean"
        ? settings.mapTripsWithinCoverageOnly
        : (readStoredBoolean(CONFIG.STORAGE_KEYS.mapTripsWithinCoverageOnly) ?? false);
    const heatmap =
      typeof settings.tripLayersUseHeatmap === "boolean"
        ? settings.tripLayersUseHeatmap
        : (readStoredBoolean(CONFIG.STORAGE_KEYS.tripLayersUseHeatmap) ?? true);
    if (fields.buildings) fields.buildings.checked = buildings;
    if (fields.terrain) fields.terrain.checked = terrain;
    if (fields.coverageOnly) fields.coverageOnly.checked = coverageOnly;
    if (fields.heatmap) fields.heatmap.checked = heatmap;
    if (fields.accent) {
      fields.accent.value = localStorage.getItem("es:accent-color") || "#b87a4a";
    }
    const density = localStorage.getItem("es:ui-density") || "comfortable";
    densityInputs.forEach((input) => {
      input.checked = input.value === density;
    });
    applyLocalPreferences(collect());
  };

  apiClient
    .get("/api/app_settings", { signal })
    .then(applySettings)
    .catch(() => applySettings());

  const options = signal ? { signal } : undefined;
  form.addEventListener("change", scheduleSave, options);
  fields.accent?.addEventListener("input", scheduleSave, options);
  fields.darkMode?.addEventListener(
    "change",
    () => {
      if (headerThemeToggle) {
        headerThemeToggle.checked = !fields.darkMode.checked;
        headerThemeToggle.dispatchEvent(new Event("change"));
      } else {
        document.documentElement.setAttribute(
          "data-bs-theme",
          fields.darkMode.checked ? "dark" : "light"
        );
      }
    },
    options
  );
  signal?.addEventListener("abort", () => clearTimeout(saveTimer), { once: true });
}

export function initAppSettings({ signal } = {}) {
  setupTabs(signal);
  setupPreferences(signal);
}
