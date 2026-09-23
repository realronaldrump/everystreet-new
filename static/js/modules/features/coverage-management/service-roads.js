/**
 * Coverage filters: whether service roads count toward coverage, and which
 * trips (recorded, matched, or both) mark streets driven.
 */

import apiClient from "../../core/api-client.js";
import notificationManager from "../../ui/notifications.js";
import {
  APP_SETTINGS_API,
  COVERAGE_TRIP_MODE_SELECT_IDS,
  DEFAULT_COVERAGE_TRIP_MODE,
  INCLUDE_SERVICE_TOGGLE_IDS,
  getCoverageTripModeLabel,
  normalizeCoverageTripMode,
  state,
  withSignal,
} from "./context.js";

// =============================================================================
// Service Roads Filter
// =============================================================================

function getIncludeServiceRoadsToggles() {
  return INCLUDE_SERVICE_TOGGLE_IDS.map((id) => document.getElementById(id)).filter(
    Boolean
  );
}

function setIncludeServiceRoadsToggleState({ checked, disabled } = {}) {
  getIncludeServiceRoadsToggles().forEach((t) => {
    if (typeof checked === "boolean") {
      t.checked = checked;
    }
    if (typeof disabled === "boolean") {
      t.disabled = disabled;
    }
  });
}

export function getIncludeServiceRoadsSelection() {
  const toggles = getIncludeServiceRoadsToggles();
  return toggles.length ? Boolean(toggles[0].checked) : true;
}

function getCoverageTripModeSelects() {
  return COVERAGE_TRIP_MODE_SELECT_IDS.map((id) => document.getElementById(id)).filter(
    Boolean
  );
}

function setCoverageTripModeSelectState({ mode, disabled } = {}) {
  const normalizedMode = normalizeCoverageTripMode(mode);
  if (typeof mode === "string") {
    state.coverageTripMode = normalizedMode;
  }
  getCoverageTripModeSelects().forEach((select) => {
    if (typeof mode === "string") {
      select.value = normalizedMode;
    }
    if (typeof disabled === "boolean") {
      select.disabled = disabled;
    }
  });
}

export function getCoverageTripModeSelection() {
  const selects = getCoverageTripModeSelects();
  if (selects.length) {
    return normalizeCoverageTripMode(selects[0].value);
  }
  return normalizeCoverageTripMode(state.coverageTripMode);
}

export function setIncludeServiceRoadsStatus(message, tone = "secondary") {
  const tones = {
    secondary: "text-secondary",
    info: "text-info",
    success: "text-success",
    danger: "text-danger",
  };
  const cls = tones[tone] || tones.secondary;
  document.querySelectorAll("[data-include-service-status]").forEach((el) => {
    el.className = `form-text d-block mt-1 ${cls}`;
    el.textContent = message;
  });
}

function setCoverageTripModeStatus(message, tone = "secondary") {
  const tones = {
    secondary: "text-secondary",
    info: "text-info",
    success: "text-success",
    danger: "text-danger",
  };
  const cls = tones[tone] || tones.secondary;
  document.querySelectorAll("[data-coverage-trip-mode-status]").forEach((el) => {
    el.className = `form-text d-block mt-1 ${cls}`;
    el.textContent = message;
  });
}

function parseIncludeServiceFromFilterSignature(sig) {
  if (typeof sig !== "string" || !sig.trim()) {
    return null;
  }
  const m = sig.match(/(?:^|\|)service=(include|exclude)(?:\||$)/);
  return m ? m[1] === "include" : null;
}

export function shouldRebuildForServiceFilter(areaId, includeServiceRoads) {
  const sig =
    state.areaRoadFilterVersionById.get(areaId) ||
    (state.currentAreaId === areaId ? state.currentAreaRoadFilterVersion : null);
  const areaIncludes = parseIncludeServiceFromFilterSignature(sig);
  if (areaIncludes === null) {
    return true;
  }
  return areaIncludes !== includeServiceRoads;
}

export function describeIncludeServiceRoadsScope(include) {
  const base = include
    ? "Service roads are included by default for new area builds."
    : "Service roads are excluded by default for new area builds.";
  if (state.view !== "area" || !state.currentAreaId) {
    return { message: base, tone: "secondary" };
  }
  const differs = shouldRebuildForServiceFilter(state.currentAreaId, include);
  if (differs) {
    return {
      message: `${base} This area uses a different filter; Recalculate Street Coverage to apply.`,
      tone: "info",
    };
  }
  return {
    message: `${base} This area already matches.`,
    tone: "secondary",
  };
}

export async function loadCoverageFilterSettings() {
  setIncludeServiceRoadsToggleState({ disabled: true });
  setCoverageTripModeSelectState({ disabled: true });
  setIncludeServiceRoadsStatus("Loading filter settings…", "info");
  setCoverageTripModeStatus("Loading trip source setting…", "info");

  try {
    const settings = await apiClient.get(APP_SETTINGS_API, withSignal());
    const include = settings?.coverageIncludeServiceRoads !== false;
    const tripMode = normalizeCoverageTripMode(
      settings?.streetCoverageTripMode || DEFAULT_COVERAGE_TRIP_MODE
    );
    setIncludeServiceRoadsToggleState({ checked: include });
    setCoverageTripModeSelectState({ mode: tripMode });
    const scope = describeIncludeServiceRoadsScope(include);
    setIncludeServiceRoadsStatus(scope.message, scope.tone);
    setCoverageTripModeStatus(
      `Street coverage uses ${getCoverageTripModeLabel(tripMode)} by default.`,
      "secondary"
    );
  } catch {
    setIncludeServiceRoadsToggleState({ checked: true });
    setCoverageTripModeSelectState({ mode: DEFAULT_COVERAGE_TRIP_MODE });
    const fallback = describeIncludeServiceRoadsScope(true);
    setIncludeServiceRoadsStatus(fallback.message, fallback.tone);
    setCoverageTripModeStatus(
      "Using default trip source: both regular and matched trips.",
      "secondary"
    );
  } finally {
    setIncludeServiceRoadsToggleState({ disabled: false });
    setCoverageTripModeSelectState({ disabled: false });
  }
}

export async function handleIncludeServiceRoadsToggle(event) {
  const toggle = event?.currentTarget;
  if (!toggle) {
    return;
  }

  const include = Boolean(toggle.checked);
  const prev = !include;
  setIncludeServiceRoadsToggleState({ checked: include, disabled: true });
  setIncludeServiceRoadsStatus("Saving filter setting…", "info");

  try {
    await apiClient.post(
      APP_SETTINGS_API,
      { coverageIncludeServiceRoads: include },
      withSignal()
    );
    const scope = describeIncludeServiceRoadsScope(include);
    setIncludeServiceRoadsStatus(scope.message, "success");
    const onArea = state.view === "area" && state.currentAreaId;
    const differs =
      onArea && shouldRebuildForServiceFilter(state.currentAreaId, include);
    notificationManager.show(
      differs
        ? 'Service road preference saved. Click "Recalculate Street Coverage" to apply it to this area.'
        : "Service road preference saved. Existing areas keep their current filter until rebuilt.",
      "success"
    );
  } catch (error) {
    setIncludeServiceRoadsToggleState({ checked: prev });
    setIncludeServiceRoadsStatus("Save failed. Keeping previous setting.", "danger");
    notificationManager.show(
      `Failed to save filter setting: ${error.message}`,
      "danger"
    );
  } finally {
    setIncludeServiceRoadsToggleState({ disabled: false });
  }
}

export async function handleCoverageTripModeChange(event) {
  const target = event?.currentTarget;
  if (!target) {
    return;
  }

  const nextMode = normalizeCoverageTripMode(target.value);
  const previousMode = normalizeCoverageTripMode(state.coverageTripMode);
  setCoverageTripModeSelectState({ mode: nextMode, disabled: true });
  setCoverageTripModeStatus("Saving trip source setting…", "info");

  try {
    await apiClient.post(
      APP_SETTINGS_API,
      { streetCoverageTripMode: nextMode },
      withSignal()
    );
    setCoverageTripModeStatus(
      `Street coverage now uses ${getCoverageTripModeLabel(nextMode)}.`,
      "success"
    );
    notificationManager.show("Coverage trip source saved.", "success");
  } catch (error) {
    setCoverageTripModeSelectState({ mode: previousMode });
    setCoverageTripModeStatus("Save failed. Keeping previous setting.", "danger");
    notificationManager.show(
      `Failed to save trip source setting: ${error.message}`,
      "danger"
    );
  } finally {
    setCoverageTripModeSelectState({ disabled: false });
  }
}
