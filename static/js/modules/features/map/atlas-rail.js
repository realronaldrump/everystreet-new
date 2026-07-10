/**
 * Atlas rail — the docked editorial panel beside the map.
 *
 * Owns: rail collapse/expand (desktop), the lens tab strip, the
 * masthead (title + date-range context), the figure band, and the
 * per-lens inline legend. Each lens module owns its own panel
 * content and its map scene (layers / exclusive visualizations).
 */

import { CONFIG } from "../../core/config.js";
import store from "../../core/store.js";
import { DateUtils, utils } from "../../utils.js";
import createCoverageLens from "./lens-coverage.js";
import createFlowLens from "./lens-flow.js";
import createPlacesLens from "./lens-places.js";
import createTripsLens from "./lens-trips.js";
import {
  getTripLayerHeatmapPreference,
  TRIP_LAYER_RENDER_MODE_EVENT,
} from "./trip-layer-render-mode.js";

const LENS_ORDER = ["trips", "coverage", "places", "flow"];
const LENS_STORAGE_KEY = CONFIG.STORAGE_KEYS.atlasLens;
const RAIL_COLLAPSED_KEY = CONFIG.STORAGE_KEYS.atlasRailCollapsed;

const LEGEND_PRESETS = {
  tripPaths: [
    {
      label: "Recorded paths",
      type: "line",
      color: CONFIG.LAYER_DEFAULTS.trips.color,
    },
  ],
  tripHeat: [
    {
      label: "Frequency · low → high",
      type: "gradient",
      color: "#b93b24",
      color2: "#f06a2a",
      color3: "#fff0c2",
    },
  ],
  tripsMatched: {
    label: "Matched",
    type: "line",
    color: CONFIG.LAYER_DEFAULTS.matchedTrips.color,
  },
  coverage: [
    {
      label: "Undriven",
      type: "dashed",
      color: CONFIG.LAYER_DEFAULTS.undrivenStreets.color,
    },
    {
      label: "Driven",
      type: "line",
      color: CONFIG.LAYER_DEFAULTS.drivenStreets.color,
    },
    {
      label: "All",
      type: "line",
      color: CONFIG.LAYER_DEFAULTS.allStreets.color,
    },
    {
      label: "Boundary",
      type: "line",
      color: CONFIG.LAYER_DEFAULTS.coverageAreaBoundingBox.color,
    },
  ],
  places: [{ label: "Destinations", type: "dot", color: "#6f8fce" }],
  flow: [
    {
      label: "Flow",
      type: "gradient",
      color: CONFIG.LAYER_DEFAULTS.trips.color,
      color2: "#f4d03f",
    },
  ],
};

function announce(message) {
  const region = document.getElementById("map-announcements");
  if (region) {
    region.textContent = message;
  }
}

function formatRangeContext() {
  const start = DateUtils.getStartDate();
  const end = DateUtils.getEndDate();
  if (!start || !end) {
    return "";
  }

  const startDate = new Date(`${start}T00:00:00`);
  const endDate = new Date(`${end}T00:00:00`);
  if (Number.isNaN(startDate.getTime()) || Number.isNaN(endDate.getTime())) {
    return "";
  }

  const dayFmt = new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
  });

  if (start === end) {
    const weekday = new Intl.DateTimeFormat(undefined, {
      weekday: "long",
    }).format(startDate);
    return `${weekday} · ${dayFmt.format(startDate)}`;
  }

  return `${dayFmt.format(startDate)} — ${dayFmt.format(endDate)}`;
}

export default function initAtlasRail({ registerCleanup }) {
  const rail = document.getElementById("atlas-rail");
  if (!rail) {
    return null;
  }

  const tabs = [...rail.querySelectorAll(".atlas-lens-tab")];
  const panels = new Map(
    [...rail.querySelectorAll("[data-lens-panel]")].map((panel) => [
      panel.dataset.lensPanel,
      panel,
    ])
  );
  const legendList = document.getElementById("atlas-legend");
  const titleEl = document.getElementById("atlas-title");
  const contextEl = document.getElementById("atlas-context");
  const collapseBtn = document.getElementById("atlas-rail-toggle");
  const reopenBtn = document.getElementById("atlas-rail-reopen");

  const on = (target, eventName, handler, options) => {
    target.addEventListener(eventName, handler, options);
    registerCleanup(() => target.removeEventListener(eventName, handler, options));
  };

  // ---- Lenses -----------------------------------------------------
  const lenses = {
    trips: createTripsLens({ registerCleanup }),
    coverage: createCoverageLens({ registerCleanup }),
    places: createPlacesLens({ registerCleanup }),
    flow: createFlowLens({ registerCleanup }),
  };

  let activeLens = null;

  const getTripLegend = () =>
    getTripLayerHeatmapPreference()
      ? LEGEND_PRESETS.tripHeat
      : LEGEND_PRESETS.tripPaths;

  const renderLegend = () => {
    if (!legendList) {
      return;
    }
    const items = [
      ...(activeLens === "trips" ? getTripLegend() : LEGEND_PRESETS[activeLens] || []),
    ];
    if (activeLens === "trips" && store.mapLayers?.matchedTrips?.visible) {
      items.push(LEGEND_PRESETS.tripsMatched);
    }
    legendList.replaceChildren(
      ...items.map((item) => {
        const li = document.createElement("li");
        li.className = "atlas-legend-item";
        const swatch = document.createElement("span");
        swatch.className = `atlas-legend-swatch atlas-legend-swatch--${item.type}`;
        swatch.style.setProperty("--legend-color", item.color);
        if (item.color2) {
          swatch.style.setProperty("--legend-color-2", item.color2);
        }
        if (item.color3) {
          swatch.style.setProperty("--legend-color-3", item.color3);
        }
        const label = document.createElement("span");
        label.textContent = item.label;
        li.append(swatch, label);
        return li;
      })
    );
  };

  const setLens = (lensId, { announceChange = true } = {}) => {
    if (!LENS_ORDER.includes(lensId) || lensId === activeLens) {
      return;
    }

    const previous = activeLens;
    activeLens = lensId;

    tabs.forEach((tab) => {
      const isActive = tab.dataset.lens === lensId;
      tab.setAttribute("aria-selected", String(isActive));
      tab.tabIndex = isActive ? 0 : -1;
    });
    panels.forEach((panel, id) => {
      panel.hidden = id !== lensId;
    });

    if (previous && lenses[previous]) {
      try {
        lenses[previous].deactivate();
      } catch (error) {
        console.warn(`Lens "${previous}" deactivate failed:`, error);
      }
    }
    try {
      lenses[lensId].activate();
    } catch (error) {
      console.warn(`Lens "${lensId}" activate failed:`, error);
    }

    utils.setStorage(LENS_STORAGE_KEY, lensId);
    renderLegend();
    if (announceChange) {
      const label = tabs.find((tab) => tab.dataset.lens === lensId)?.textContent;
      announce(`${(label || lensId).trim()} lens active`);
    }
  };

  tabs.forEach((tab) => {
    on(tab, "click", () => setLens(tab.dataset.lens));
  });

  // Roving focus for the tablist
  const tablist = rail.querySelector(".atlas-lenses");
  if (tablist) {
    on(tablist, "keydown", (event) => {
      if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) {
        return;
      }
      event.preventDefault();
      const currentIndex = LENS_ORDER.indexOf(activeLens);
      let nextIndex = currentIndex;
      if (event.key === "ArrowLeft") {
        nextIndex = (currentIndex - 1 + LENS_ORDER.length) % LENS_ORDER.length;
      } else if (event.key === "ArrowRight") {
        nextIndex = (currentIndex + 1) % LENS_ORDER.length;
      } else if (event.key === "Home") {
        nextIndex = 0;
      } else {
        nextIndex = LENS_ORDER.length - 1;
      }
      const nextLens = LENS_ORDER[nextIndex];
      setLens(nextLens);
      tabs.find((tab) => tab.dataset.lens === nextLens)?.focus();
    });
  }

  // ---- Desktop collapse ------------------------------------------
  const isMobile = () => window.matchMedia("(max-width: 768px)").matches;

  const applyCollapsed = (collapsed) => {
    if (isMobile()) {
      return;
    }
    rail.classList.toggle("is-collapsed", collapsed);
    if (reopenBtn) {
      reopenBtn.hidden = !collapsed;
    }
    collapseBtn?.setAttribute("aria-expanded", String(!collapsed));
    utils.setStorage(RAIL_COLLAPSED_KEY, collapsed);
    // Let the map absorb the freed space once the transition settles.
    window.setTimeout(() => {
      try {
        (store.map || window.map)?.resize?.();
      } catch {
        /* non-fatal */
      }
    }, 300);
  };

  if (collapseBtn) {
    on(collapseBtn, "click", () => applyCollapsed(true));
  }
  if (reopenBtn) {
    on(reopenBtn, "click", () => applyCollapsed(false));
  }
  if (!isMobile() && utils.getStorage(RAIL_COLLAPSED_KEY) === true) {
    rail.classList.add("is-collapsed");
    if (reopenBtn) {
      reopenBtn.hidden = false;
    }
    collapseBtn?.setAttribute("aria-expanded", "false");
  }

  // ---- Masthead ----------------------------------------------------
  const syncTitle = () => {
    if (!titleEl) {
      return;
    }
    const select = document.getElementById("streets-location");
    const selectedText =
      select?.selectedOptions?.[0]?.value && select.selectedOptions[0].textContent;
    const areaName = (selectedText || "").trim();
    titleEl.textContent = areaName || "Every Street";
  };

  const syncContext = () => {
    if (contextEl) {
      contextEl.textContent = formatRangeContext() || " ";
    }
  };

  on(document, "es:coverage-area-selection-changed", syncTitle);
  on(document, "es:filters-change", syncContext);
  on(document, "filtersApplied", syncContext);
  syncTitle();
  syncContext();

  // ---- Figure band -------------------------------------------------
  const figures = {
    trips: document.getElementById("figure-trips"),
    distance: document.getElementById("figure-distance"),
    avgSpeed: document.getElementById("figure-avg-speed"),
    driveTime: document.getElementById("figure-drive-time"),
  };

  const syncFigures = (event) => {
    const metrics = event?.detail?.metrics;
    if (!metrics) {
      return;
    }
    if (figures.trips) {
      figures.trips.textContent = Number(metrics.totalTrips || 0).toLocaleString();
    }
    if (figures.distance) {
      const miles = Number(metrics.totalDistanceMiles || 0);
      figures.distance.textContent =
        miles >= 100 ? Math.round(miles).toLocaleString() : miles.toFixed(1);
    }
    if (figures.avgSpeed) {
      figures.avgSpeed.textContent = String(Math.round(Number(metrics.avgSpeed || 0)));
    }
    if (figures.driveTime) {
      figures.driveTime.textContent = String(metrics.avgDrivingTime || "--:--");
    }
  };

  on(document, "metricsUpdated", syncFigures);
  // The initial load's metricsUpdated fires before this module exists.
  if (store.lastMetricsDetail) {
    syncFigures({ detail: store.lastMetricsDetail });
  }

  // Matched-trips visibility affects the trips legend
  on(document, "es:layers-change", renderLegend);
  on(document, TRIP_LAYER_RENDER_MODE_EVENT, renderLegend);

  // ---- Boot ---------------------------------------------------------
  const savedLens = utils.getStorage(LENS_STORAGE_KEY);
  const initialLens = LENS_ORDER.includes(savedLens) ? savedLens : "trips";
  // Force activation even for the default tab markup state.
  activeLens = null;
  tabs.forEach((tab) => tab.setAttribute("aria-selected", "false"));
  setLens(initialLens, { announceChange: false });

  registerCleanup(() => {
    if (activeLens && lenses[activeLens]) {
      try {
        lenses[activeLens].deactivate();
      } catch {
        /* teardown is best-effort */
      }
    }
    activeLens = null;
  });

  return { setLens, getActiveLens: () => activeLens };
}
