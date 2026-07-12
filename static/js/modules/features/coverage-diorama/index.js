import apiClient from "../../core/api-client.js";
import { swupReady } from "../../core/navigation.js";
import { escapeHtml, isAbortError } from "../../utils.js";
import { createCoverageRouteDraft, saveCoverageRouteDraft } from "./draft.js";
import CoverageDioramaRenderer from "./renderer.js";
import { loadTerrainMosaic, selectTerrainTiles } from "./terrain.js";

export default async function initCoverageDioramaPage(context = {}) {
  const { signal = null, onCleanup = () => {} } = context;
  const elements = collectElements();
  if (!elements.root || !elements.canvas) {
    return;
  }

  const state = {
    areas: [],
    selectedAreaId: null,
    selectedArea: null,
    selectedFeatures: [],
    renderer: null,
    loadController: null,
    simulationController: null,
    simulationTimer: null,
    simulationSequence: 0,
    mode: "explore",
    verticalScale: 2.5,
  };

  bindEvents();
  setOverlay("loading", "Reading the land…", "Loading coverage areas.");

  try {
    state.renderer = new CoverageDioramaRenderer(elements.canvas, {
      onHover: renderStreetDetail,
      onSelectionChange: onSelectionChange,
      onInteractionError: (error) => {
        console.error("Coverage Diorama render failed", error);
        setOverlay(
          "error",
          "The model stopped rendering",
          error?.message || "WebGL error."
        );
      },
    });
    await loadAreas();
  } catch (error) {
    if (!isAbortError(error) && !signal?.aborted) {
      console.error("Coverage Diorama failed to initialize", error);
      setOverlay(
        "error",
        "Unable to open the diorama",
        error?.message || "Unknown error."
      );
    }
  }

  onCleanup(teardown);

  function bindEvents() {
    const add = (element, type, handler) => {
      element?.addEventListener(type, handler, signal ? { signal } : undefined);
    };
    add(elements.areaSelect, "change", () => loadArea(elements.areaSelect.value));
    add(elements.exploreBtn, "click", () => setMode("explore"));
    add(elements.planBtn, "click", () => setMode("plan"));
    add(elements.resetBtn, "click", () => state.renderer?.resetCamera());
    add(elements.elevationBtn, "click", toggleElevation);
    add(elements.clearBtn, "click", () => state.renderer?.clearSelection());
    add(elements.continueBtn, "click", continueToPlanner);
    add(elements.retryBtn, "click", () => {
      if (state.selectedAreaId) {
        void loadArea(state.selectedAreaId);
      } else {
        void loadAreas();
      }
    });
  }

  async function loadAreas() {
    const data = await apiClient.get("/api/coverage/areas", { signal, cache: false });
    const areas = Array.isArray(data?.areas)
      ? data.areas.filter((area) => String(area.status || "").toLowerCase() === "ready")
      : [];
    state.areas = areas;
    renderAreaOptions(areas);
    if (areas.length === 0) {
      setOverlay(
        "empty",
        "No finished coverage areas yet",
        "Create an area and finish its street calculation before building a diorama."
      );
      return;
    }
    const preferred = areas
      .slice()
      .sort(
        (a, b) =>
          Number(b.driven_length_miles || 0) - Number(a.driven_length_miles || 0)
      )[0];
    elements.areaSelect.value = String(preferred.id);
    await loadArea(preferred.id);
  }

  function renderAreaOptions(areas) {
    elements.areaSelect.replaceChildren();
    if (areas.length === 0) {
      const option = new Option("No ready coverage areas", "", true, true);
      option.disabled = true;
      elements.areaSelect.appendChild(option);
      elements.areaSelect.disabled = true;
      return;
    }
    elements.areaSelect.disabled = false;
    for (const area of areas) {
      const coverage = Number(area.coverage_percentage || 0).toFixed(1);
      elements.areaSelect.appendChild(
        new Option(
          `${area.display_name || "Unnamed area"} · ${coverage}%`,
          String(area.id)
        )
      );
    }
  }

  async function loadArea(areaId) {
    if (!areaId) {
      return;
    }
    state.loadController?.abort();
    state.simulationController?.abort();
    clearTimeout(state.simulationTimer);
    const controller = new AbortController();
    state.loadController = controller;
    const activeSignal = combineSignals(signal, controller.signal);
    state.selectedAreaId = String(areaId);
    state.selectedFeatures = [];
    resetForecast();
    setOverlay("loading", "Reading the land…", "Loading streets and elevation tiles.");

    try {
      const areaPayload = await apiClient.get(
        `/api/coverage/areas/${encodeURIComponent(areaId)}`,
        { signal: activeSignal, cache: false }
      );
      const area = areaPayload?.area;
      const bounds = areaPayload?.bounding_box;
      const boundary = areaPayload?.boundary;
      if (!area || !Array.isArray(bounds) || !boundary) {
        throw new Error(
          "This coverage area does not have the boundary data required for 3D terrain."
        );
      }
      const tilePlan = selectTerrainTiles(bounds);
      const [streetNetwork, mosaic] = await Promise.all([
        apiClient.get(`/api/coverage/areas/${encodeURIComponent(areaId)}/streets/all`, {
          signal: activeSignal,
          cache: false,
        }),
        loadTerrainMosaic(
          tilePlan,
          globalThis.MAPBOX_PUBLIC_ACCESS_TOKEN,
          activeSignal
        ),
      ]);
      if (activeSignal.aborted) {
        return;
      }
      const features = Array.isArray(streetNetwork?.features)
        ? streetNetwork.features
        : [];
      if (features.length === 0) {
        throw new Error("This area has no street geometry to render.");
      }

      state.selectedArea = area;
      renderAreaSummary(area, features, tilePlan);
      await state.renderer.setModel({
        area,
        bounds,
        boundary,
        features,
        mosaic,
        tilePlan,
      });
      state.renderer.setMode(state.mode);
      setOverlay("hidden");
    } catch (error) {
      if (!isAbortError(error) && !activeSignal.aborted) {
        console.error("Coverage Diorama area load failed", error);
        setOverlay(
          "error",
          "The terrain could not be built",
          error?.message || "Load failed."
        );
      }
    } finally {
      if (state.loadController === controller) {
        state.loadController = null;
      }
    }
  }

  function renderAreaSummary(area, features, tilePlan) {
    const drivenMiles = Number(area.driven_length_miles || 0);
    const totalDriveable = Number(
      area.driveable_length_miles || area.total_length_miles || 0
    );
    const remaining = Math.max(0, totalDriveable - drivenMiles);
    setText(elements.title, area.display_name || "Coverage Diorama");
    setText(
      elements.subtitle,
      `${features.length.toLocaleString()} street segments over ${tilePlan.tileCount} terrain tiles.`
    );
    setText(elements.current, `${Number(area.coverage_percentage || 0).toFixed(1)}%`);
    setText(elements.driven, `${drivenMiles.toFixed(1)} mi`);
    setText(elements.remaining, `${remaining.toFixed(1)} mi`);
  }

  function setMode(mode) {
    state.mode = mode === "plan" ? "plan" : "explore";
    elements.root.classList.toggle("is-plan-mode", state.mode === "plan");
    elements.exploreBtn.classList.toggle("is-active", state.mode === "explore");
    elements.planBtn.classList.toggle("is-active", state.mode === "plan");
    elements.exploreBtn.setAttribute("aria-pressed", String(state.mode === "explore"));
    elements.planBtn.setAttribute("aria-pressed", String(state.mode === "plan"));
    elements.planHint.textContent =
      state.mode === "plan"
        ? "Tap or drag across brass streets to paint this run. Drag over selected streets to erase."
        : "Enter Plan mode, then tap or drag across the brass streets.";
    state.renderer?.setMode(state.mode);
  }

  function toggleElevation() {
    state.verticalScale = state.verticalScale === 2.5 ? 1 : 2.5;
    elements.elevationBtn.setAttribute(
      "aria-pressed",
      String(state.verticalScale === 2.5)
    );
    elements.elevationBtn.querySelector("span").textContent = `${state.verticalScale}×`;
    elements.elevationBtn.title = `Terrain elevation ${state.verticalScale} times`;
    state.renderer?.setVerticalScale(state.verticalScale);
  }

  function onSelectionChange(features) {
    state.selectedFeatures = features;
    const count = features.length;
    setText(elements.count, count.toLocaleString());
    elements.clearBtn.disabled = count === 0;
    elements.continueBtn.disabled = count === 0;
    renderSelectedStreetList(features);
    resetForecast({ preserveCount: true });
    clearTimeout(state.simulationTimer);
    state.simulationController?.abort();
    if (count === 0 || !state.selectedAreaId) {
      return;
    }
    state.simulationTimer = setTimeout(() => void simulateSelection(features), 300);
  }

  async function simulateSelection(features) {
    const controller = new AbortController();
    state.simulationController = controller;
    const sequence = ++state.simulationSequence;
    const segmentIds = features.map((feature) => String(feature.properties.segment_id));
    const selectionSignature = segmentIds.slice().sort().join("|");
    setText(elements.addedMiles, "…");
    setText(elements.projected, "…");
    setText(elements.gain, "…");

    try {
      const data = await apiClient.post(
        `/api/coverage/areas/${encodeURIComponent(state.selectedAreaId)}/streets/simulate`,
        { segment_ids: segmentIds },
        { signal: controller.signal, retry: false }
      );
      const currentSignature = state.selectedFeatures
        .map((feature) => String(feature.properties.segment_id))
        .sort()
        .join("|");
      if (
        sequence !== state.simulationSequence ||
        selectionSignature !== currentSignature
      ) {
        return;
      }
      const current = Number(data?.current?.coverage_percentage || 0);
      const projected = Number(data?.projected?.coverage_percentage || current);
      setText(
        elements.addedMiles,
        `${Number(data?.simulated_length_miles || 0).toFixed(2)} mi`
      );
      setText(elements.projected, `${projected.toFixed(2)}%`);
      setText(elements.gain, `+${Math.max(0, projected - current).toFixed(2)}%`);
    } catch (error) {
      if (!isAbortError(error)) {
        console.error("Coverage Diorama simulation failed", error);
        setText(elements.addedMiles, "Error");
        setText(elements.projected, "—");
        setText(elements.gain, "—");
      }
    } finally {
      if (state.simulationController === controller) {
        state.simulationController = null;
      }
    }
  }

  function renderSelectedStreetList(features) {
    elements.selectedList.replaceChildren();
    if (features.length === 0) {
      const empty = document.createElement("span");
      empty.textContent = "No streets selected.";
      elements.selectedList.appendChild(empty);
      return;
    }
    const counts = new Map();
    for (const feature of features) {
      const name = feature.properties?.street_name || "Unnamed street";
      counts.set(name, (counts.get(name) || 0) + 1);
    }
    const visible = Array.from(counts.entries()).slice(0, 6);
    for (const [name, count] of visible) {
      const chip = document.createElement("span");
      chip.className = "coverage-diorama-street-chip";
      chip.textContent = count > 1 ? `${name} ×${count}` : name;
      elements.selectedList.appendChild(chip);
    }
    if (counts.size > visible.length) {
      const more = document.createElement("span");
      more.textContent = `+${counts.size - visible.length} more`;
      elements.selectedList.appendChild(more);
    }
  }

  function renderStreetDetail(feature) {
    if (!feature) {
      elements.detail.innerHTML = `
        <span class="coverage-diorama-detail-kicker">Survey cursor</span>
        <strong>Hover a street to inspect it</strong>
        <span>Switch to Plan to paint undriven streets.</span>
      `;
      return;
    }
    const properties = feature.properties || {};
    const status = String(properties.status || "undriven").toLowerCase();
    const statusLabel = status === "driven" ? "Driven" : "Still to drive";
    elements.detail.innerHTML = `
      <span class="coverage-diorama-detail-kicker">${escapeHtml(statusLabel)}</span>
      <strong>${escapeHtml(properties.street_name || "Unnamed street")}</strong>
      <span>${Number(properties.length_miles || 0).toFixed(3)} mi · ${escapeHtml(properties.highway_type || "road")}</span>
    `;
  }

  function continueToPlanner() {
    if (!state.selectedAreaId || state.selectedFeatures.length === 0) {
      return;
    }
    const draft = createCoverageRouteDraft(
      state.selectedAreaId,
      state.selectedFeatures.map((feature) => feature.properties.segment_id)
    );
    saveCoverageRouteDraft(sessionStorage, draft);
    swupReady.then((swup) => swup.navigate("/coverage-route-planner?draft=diorama"));
  }

  function resetForecast({ preserveCount = false } = {}) {
    if (!preserveCount) {
      setText(elements.count, "0");
    }
    setText(elements.addedMiles, "—");
    setText(elements.projected, "—");
    setText(elements.gain, "—");
    if (!preserveCount) {
      elements.clearBtn.disabled = true;
      elements.continueBtn.disabled = true;
      renderSelectedStreetList([]);
    }
  }

  function setOverlay(kind, title = "", message = "") {
    elements.overlay.classList.toggle("is-hidden", kind === "hidden");
    if (kind === "hidden") {
      return;
    }
    setText(elements.overlayTitle, title);
    setText(elements.overlayMessage, message);
    elements.retryBtn.hidden = kind !== "error";
    elements.overlay.querySelector(".coverage-diorama-loader").hidden =
      kind !== "loading";
  }

  function teardown() {
    state.loadController?.abort();
    state.simulationController?.abort();
    clearTimeout(state.simulationTimer);
    state.renderer?.dispose();
    state.renderer = null;
  }
}

function collectElements() {
  const byId = (id) => document.getElementById(id);
  return {
    root: byId("coverage-diorama"),
    canvas: byId("coverage-diorama-canvas"),
    areaSelect: byId("coverage-diorama-area-select"),
    title: byId("coverage-diorama-title"),
    subtitle: byId("coverage-diorama-subtitle"),
    exploreBtn: byId("coverage-diorama-explore"),
    planBtn: byId("coverage-diorama-plan"),
    current: byId("coverage-diorama-current"),
    driven: byId("coverage-diorama-driven"),
    remaining: byId("coverage-diorama-remaining"),
    detail: byId("coverage-diorama-detail"),
    count: byId("coverage-diorama-count"),
    planHint: byId("coverage-diorama-plan-hint"),
    addedMiles: byId("coverage-diorama-added-miles"),
    projected: byId("coverage-diorama-projected"),
    gain: byId("coverage-diorama-gain"),
    selectedList: byId("coverage-diorama-selected-list"),
    clearBtn: byId("coverage-diorama-clear"),
    continueBtn: byId("coverage-diorama-continue"),
    resetBtn: byId("coverage-diorama-reset"),
    elevationBtn: byId("coverage-diorama-elevation"),
    overlay: byId("coverage-diorama-state"),
    overlayTitle: byId("coverage-diorama-state-title"),
    overlayMessage: byId("coverage-diorama-state-message"),
    retryBtn: byId("coverage-diorama-retry"),
  };
}

function setText(element, value) {
  if (element) {
    element.textContent = value;
  }
}

function combineSignals(...signals) {
  const active = signals.filter(Boolean);
  if (typeof AbortSignal.any === "function") {
    return AbortSignal.any(active);
  }
  const controller = new AbortController();
  for (const signal of active) {
    if (signal.aborted) {
      controller.abort();
      break;
    }
    signal.addEventListener("abort", () => controller.abort(), { once: true });
  }
  return controller.signal;
}
