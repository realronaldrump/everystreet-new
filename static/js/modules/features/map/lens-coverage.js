/**
 * Coverage lens — progress and the hunt for undriven streets.
 *
 * Hosts the coverage-area selector (populated by app-controller), the
 * street layer chips (undriven / driven / all — wired through the
 * existing `es:streetModeChange` contract), area progress, and
 * "next streets" suggestions from the driving-navigation API.
 */

import { CONFIG } from "../../core/config.js";
import store from "../../core/store.js";
import { escapeHtml, utils } from "../../utils.js";

const STREET_MODES = ["undriven", "driven", "all"];
const METERS_PER_MILE = 1609.344;

function milesLabel(meters) {
  const miles = Number(meters || 0) / METERS_PER_MILE;
  if (miles >= 10) {
    return `${Math.round(miles)} mi`;
  }
  return `${miles.toFixed(1)} mi`;
}

export default function createCoverageLens({ registerCleanup }) {
  const panel = document.getElementById("lens-panel-coverage");
  const chips = [...document.querySelectorAll(".lens-chip[data-street-mode]")];
  const focusBtn = document.getElementById("focus-coverage-area-btn");
  const emptyNote = document.getElementById("coverage-empty");
  const progressWrap = document.getElementById("coverage-progress");
  const progressValue = document.getElementById("coverage-percent");
  const progressDetail = document.getElementById("coverage-detail");
  const progressBar = document.getElementById("coverage-progressbar");
  const progressFill = document.getElementById("coverage-progress-fill");
  const suggestionsBlock = document.getElementById("coverage-suggestions-block");
  const suggestionsList = document.getElementById("coverage-suggestions");
  const suggestionsHint = document.getElementById("coverage-suggestions-hint");

  let isActive = false;
  let lastStreetMode = "undriven";
  let suggestionsRequestId = 0;

  const on = (target, eventName, handler, options) => {
    target.addEventListener(eventName, handler, options);
    registerCleanup(() => target.removeEventListener(eventName, handler, options));
  };

  const selectedAreaId = () =>
    String(document.getElementById("streets-location")?.value || "").trim();

  // ---- Street chips -------------------------------------------------
  const activeChipMode = () =>
    chips.find((chip) => chip.classList.contains("active"))?.dataset.streetMode || null;

  // app-controller persists the live street-layer state on every
  // es:streetModeChange; read it back so chips always reflect the map.
  const activeModeFromStorage = () => {
    const saved = utils.getStorage(CONFIG.STORAGE_KEYS.streetViewMode);
    if (!saved || typeof saved !== "object") {
      return null;
    }
    return STREET_MODES.find((mode) => saved[mode] === true) || null;
  };

  const setChipStates = (activeMode) => {
    chips.forEach((chip) => {
      chip.classList.toggle("active", chip.dataset.streetMode === activeMode);
    });
  };

  const dispatchStreetMode = (mode, shouldHide) => {
    document.dispatchEvent(
      new CustomEvent("es:streetModeChange", {
        detail: { mode, shouldHide },
        bubbles: true,
      })
    );
  };

  chips.forEach((chip) => {
    on(chip, "click", () => {
      const mode = chip.dataset.streetMode;
      if (!STREET_MODES.includes(mode) || !selectedAreaId()) {
        return;
      }
      const turningOff = chip.classList.contains("active");
      setChipStates(turningOff ? null : mode);
      lastStreetMode = turningOff ? null : mode;
      dispatchStreetMode(mode, turningOff);
    });
  });

  if (focusBtn) {
    on(focusBtn, "click", () => {
      const areaId = selectedAreaId();
      if (!areaId) {
        return;
      }
      document.dispatchEvent(
        new CustomEvent("es:focus-selected-coverage-area", {
          detail: { areaId },
          bubbles: true,
        })
      );
    });
  }

  const syncControlAvailability = () => {
    const hasArea = Boolean(selectedAreaId());
    chips.forEach((chip) => {
      chip.disabled = !hasArea;
    });
    setChipStates(hasArea ? activeModeFromStorage() : null);
    if (focusBtn) {
      focusBtn.disabled = !hasArea;
    }
    if (emptyNote) {
      emptyNote.hidden = hasArea;
    }
    if (!hasArea) {
      if (progressWrap) {
        progressWrap.hidden = true;
      }
      if (suggestionsBlock) {
        suggestionsBlock.hidden = true;
      }
    }
  };

  // ---- Area progress -------------------------------------------------
  const renderProgress = async () => {
    const areaId = selectedAreaId();
    if (!areaId || !progressWrap) {
      return;
    }
    try {
      const response = await utils.fetchWithRetry(CONFIG.API.coverageAreas);
      const areas = response?.areas || [];
      const area = areas.find((a) => String(a.id || a._id) === areaId);
      if (!area || selectedAreaId() !== areaId) {
        return;
      }
      const pct = Math.max(0, Math.min(100, Number(area.coverage_percentage || 0)));
      progressWrap.hidden = false;
      if (progressValue) {
        progressValue.textContent = `${pct.toFixed(1)}%`;
      }
      if (progressDetail) {
        const driven = Number(area.driven_length_miles || 0);
        const total = Number(area.driveable_length_miles || 0);
        progressDetail.textContent = `${driven.toFixed(0)} of ${total.toFixed(0)} driveable miles`;
      }
      if (progressBar) {
        progressBar.setAttribute("aria-valuenow", pct.toFixed(1));
      }
      if (progressFill) {
        progressFill.style.width = `${pct}%`;
      }
    } catch (error) {
      console.warn("Coverage progress unavailable:", error);
    }
  };

  // ---- Next street suggestions ----------------------------------------
  const renderSuggestions = async () => {
    const areaId = selectedAreaId();
    if (!areaId || !suggestionsBlock || !suggestionsList) {
      return;
    }

    const map = store.map || window.map;
    const center = map?.getCenter?.();
    if (!center) {
      return;
    }

    const requestId = ++suggestionsRequestId;
    suggestionsBlock.hidden = false;
    if (suggestionsHint) {
      suggestionsHint.textContent = "Finding nearby undriven streets…";
    }

    try {
      const params = new URLSearchParams({
        current_lat: center.lat.toFixed(6),
        current_lon: center.lng.toFixed(6),
        top_n: "3",
      });
      const data = await utils.fetchWithRetry(
        `/api/driving-navigation/suggest-next-street/${areaId}?${params}`,
        {},
        1,
        30000,
        `next-street:${areaId}`
      );
      if (requestId !== suggestionsRequestId || selectedAreaId() !== areaId) {
        return;
      }

      const clusters = data?.suggested_clusters || [];
      suggestionsList.replaceChildren();

      if (data?.status !== "success" || !clusters.length) {
        if (suggestionsHint) {
          suggestionsHint.textContent =
            data?.message || "No undriven clusters nearby — try panning the map.";
        }
        return;
      }

      clusters.forEach((cluster) => {
        const li = document.createElement("li");
        const button = document.createElement("button");
        button.type = "button";
        button.className = "coverage-suggestion";
        const name = cluster.nearest_segment?.street_name || "Unnamed streets";
        const lengthLabel = milesLabel(cluster.total_length_m);
        const segments = Number(cluster.segment_count || 0);
        button.innerHTML =
          `<span><span class="coverage-suggestion-name">${escapeHtml(name)}</span>` +
          `<span class="coverage-suggestion-meta">${escapeHtml(lengthLabel)} across ${segments} segment${segments === 1 ? "" : "s"}</span></span>` +
          `<span class="coverage-suggestion-distance">${escapeHtml(milesLabel(cluster.distance_to_cluster_m))} away</span>`;
        button.addEventListener("click", () => {
          const [lon, lat] = cluster.centroid || [];
          if (Number.isFinite(lon) && Number.isFinite(lat)) {
            (store.map || window.map)?.flyTo?.({
              center: [lon, lat],
              zoom: 15,
              duration: 1200,
              essential: true,
            });
          }
        });
        li.appendChild(button);
        suggestionsList.appendChild(li);
      });

      if (suggestionsHint) {
        suggestionsHint.textContent =
          "Nearest clusters of undriven streets, measured from the map center.";
      }
    } catch (error) {
      if (requestId === suggestionsRequestId && suggestionsHint) {
        suggestionsHint.textContent = "Street suggestions are unavailable right now.";
      }
      console.warn("Next-street suggestions failed:", error);
    }
  };

  const refreshAreaContent = () => {
    syncControlAvailability();
    if (!isActive || !selectedAreaId()) {
      return;
    }
    renderProgress();
    renderSuggestions();
  };

  on(document, "es:coverage-area-selection-changed", refreshAreaContent);

  syncControlAvailability();

  return {
    id: "coverage",
    activate() {
      isActive = true;
      if (panel) {
        panel.hidden = false;
      }
      syncControlAvailability();
      if (selectedAreaId()) {
        const storedMode = activeModeFromStorage();
        if (storedMode) {
          // Streets already showing (restored by app-controller); just reflect it.
          lastStreetMode = storedMode;
          setChipStates(storedMode);
        } else if (lastStreetMode) {
          // Re-enable the mode this lens was last using. Stays off if the
          // user explicitly cleared the chips (lastStreetMode === null).
          setChipStates(lastStreetMode);
          dispatchStreetMode(lastStreetMode, false);
        }
        renderProgress();
        renderSuggestions();
      }
    },
    deactivate() {
      isActive = false;
      const active = activeChipMode();
      if (active) {
        lastStreetMode = active;
        setChipStates(null);
        dispatchStreetMode(active, true);
      }
    },
  };
}
