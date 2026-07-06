import store from "../../core/store.js";
import tripAnimator from "../../trip-animator.js";
import tripMapRenderer from "../../trip-map-renderer.js";
import initAtlasRail from "./atlas-rail.js";
import initBasemapTreatment from "./basemap-treatment.js";
import initBuildings3D from "./buildings-3d.js";
import destinationBloom from "./destination-bloom.js";
import { initMobileMap } from "./mobile-map.js";
import particleFlow from "./particle-flow.js";
import initPlateNotation from "./plate-notation.js";
import initTerrainRelief from "./terrain-relief.js";
import initViewPopover from "./view-popover.js";

function setupMapViewportSync() {
  const mapElement = document.getElementById("map");
  const mapCanvas = document.getElementById("map-canvas");
  if (!mapElement || !mapCanvas) {
    return () => {};
  }

  let rafId = null;
  const timeoutIds = new Set();
  const teardownFns = [];

  const safeResize = () => {
    const activeMap = store.map || window.map;
    if (!activeMap || typeof activeMap.resize !== "function") {
      return;
    }
    try {
      activeMap.resize();
    } catch (error) {
      console.warn("Map viewport sync resize failed", error);
    }
  };

  const requestResize = () => {
    if (rafId !== null) {
      return;
    }
    rafId = requestAnimationFrame(() => {
      rafId = null;
      safeResize();
    });
  };

  const scheduleResize = (delay = 0) => {
    const timeoutId = window.setTimeout(() => {
      timeoutIds.delete(timeoutId);
      requestResize();
    }, delay);
    timeoutIds.add(timeoutId);
  };

  const runResizeBurst = () => {
    [0, 90, 220].forEach((delay) => scheduleResize(delay));
  };

  const bind = (target, eventName, handler, options = undefined) => {
    if (!target || typeof target.addEventListener !== "function") {
      return;
    }
    target.addEventListener(eventName, handler, options);
    teardownFns.push(() => {
      target.removeEventListener(eventName, handler, options);
    });
  };

  bind(window, "resize", requestResize, { passive: true });
  bind(window, "orientationchange", runResizeBurst);
  bind(document, "mapInitialized", runResizeBurst);
  bind(document, "visibilitychange", () => {
    if (!document.hidden) {
      runResizeBurst();
    }
  });

  const { visualViewport } = window;
  if (visualViewport) {
    bind(visualViewport, "resize", requestResize, { passive: true });
    bind(visualViewport, "scroll", requestResize, { passive: true });
  }

  if (typeof ResizeObserver === "function") {
    const observer = new ResizeObserver(() => requestResize());
    observer.observe(mapElement);
    observer.observe(mapCanvas);
    teardownFns.push(() => observer.disconnect());
  }

  const rail = document.getElementById("atlas-rail");
  if (rail) {
    bind(rail, "transitionend", (event) => {
      const prop = event?.propertyName || "";
      if (prop === "transform" || prop === "margin-left") {
        requestResize();
      }
    });
  }

  runResizeBurst();

  return () => {
    if (rafId !== null) {
      cancelAnimationFrame(rafId);
      rafId = null;
    }
    timeoutIds.forEach((id) => clearTimeout(id));
    timeoutIds.clear();
    teardownFns.forEach((fn) => {
      try {
        fn();
      } catch (error) {
        console.warn("Map viewport sync cleanup failed", error);
      }
    });
  };
}

function deactivateExclusiveModes(except) {
  if (except !== "particleFlow" && particleFlow.isActive()) {
    particleFlow.destroy();
  }
  if (except !== "destinationBloom" && destinationBloom.isActive()) {
    destinationBloom.destroy();
  }
}

function repairExclusiveSceneMode(preferredMode = null) {
  const nextMode =
    preferredMode ||
    (destinationBloom.isActive()
      ? "destinationBloom"
      : particleFlow.isActive()
        ? "particleFlow"
        : null);

  if (!nextMode) {
    return;
  }

  deactivateExclusiveModes(nextMode);

  if (nextMode === "particleFlow") {
    particleFlow.ensureTripLayersHidden?.();
    return;
  }

  if (nextMode === "destinationBloom") {
    destinationBloom.ensureTripLayersHidden?.();
  }
}

export function setupExclusiveSceneModeGuard(registerCleanup) {
  const handleParticleFlowActivated = () => repairExclusiveSceneMode("particleFlow");
  const handleDestinationBloomActivated = () =>
    repairExclusiveSceneMode("destinationBloom");
  const handleSceneRepair = () => repairExclusiveSceneMode();

  document.addEventListener("particleFlow:activated", handleParticleFlowActivated);
  document.addEventListener(
    "destinationBloom:activated",
    handleDestinationBloomActivated
  );
  document.addEventListener("tripsDataLoaded", handleSceneRepair);
  document.addEventListener("matchedTripsDataLoaded", handleSceneRepair);
  document.addEventListener("es:filters-change", handleSceneRepair);
  document.addEventListener("es:layers-change", handleSceneRepair);
  document.addEventListener("mapStyleLoaded", handleSceneRepair);

  registerCleanup(() =>
    document.removeEventListener("particleFlow:activated", handleParticleFlowActivated)
  );
  registerCleanup(() =>
    document.removeEventListener(
      "destinationBloom:activated",
      handleDestinationBloomActivated
    )
  );
  registerCleanup(() =>
    document.removeEventListener("tripsDataLoaded", handleSceneRepair)
  );
  registerCleanup(() =>
    document.removeEventListener("matchedTripsDataLoaded", handleSceneRepair)
  );
  registerCleanup(() =>
    document.removeEventListener("es:filters-change", handleSceneRepair)
  );
  registerCleanup(() =>
    document.removeEventListener("es:layers-change", handleSceneRepair)
  );
  registerCleanup(() =>
    document.removeEventListener("mapStyleLoaded", handleSceneRepair)
  );

  repairExclusiveSceneMode();
}

export default function initMapPage({ signal, cleanup } = {}) {
  const cleanupFns = [];
  const registerCleanup = (fn) => {
    if (typeof fn === "function") {
      cleanupFns.push(fn);
    }
  };

  registerCleanup(setupMapViewportSync());

  const mapInstance = store.map || window.map;
  const terrainRelief = initTerrainRelief({ map: mapInstance });
  registerCleanup(() => terrainRelief.destroy?.());

  const buildings3d = initBuildings3D({ map: mapInstance });
  registerCleanup(() => buildings3d.destroy?.());

  initAtlasRail({ registerCleanup });
  initPlateNotation({ registerCleanup });
  initViewPopover({ registerCleanup });
  initBasemapTreatment({ registerCleanup });
  initMobileMap({ cleanup: registerCleanup });

  // Trip animation on selection — draw route with glow when a trip is selected
  setupTripSelectionAnimation(mapInstance, signal, registerCleanup);

  setupExclusiveSceneModeGuard(registerCleanup);

  // Bouncie Simulator — lazy-loaded on toggle click
  const simToggle = document.getElementById("sim-toggle");
  if (simToggle) {
    let simulator = null;
    const handleSimToggle = async () => {
      if (simulator) {
        simulator.toggle();
        return;
      }
      try {
        const { BouncieSimulator } = await import("../simulator/index.js");
        const simulatorMapInstance = store.map || window.map;
        simulator = new BouncieSimulator(simulatorMapInstance);
        simulator.show();
        registerCleanup(() => {
          simulator.destroy();
          simulator = null;
        });
      } catch (err) {
        console.error("Failed to load Bouncie Simulator:", err);
      }
    };
    simToggle.addEventListener("click", handleSimToggle);
    registerCleanup(() => simToggle.removeEventListener("click", handleSimToggle));
  }

  const teardown = () => {
    cleanupFns.forEach((fn) => {
      try {
        fn();
      } catch (error) {
        console.warn("Map cleanup error", error);
      }
    });
  };

  if (typeof cleanup === "function") {
    cleanup(teardown);
  } else {
    return teardown;
  }

  return teardown;
}

/**
 * Set up trip selection animation and replay controls.
 * When a trip is selected on the map, its route draws itself with a glow.
 * A replay button allows re-playing the route with an animated marker.
 */
function setupTripSelectionAnimation(mapInstance, _signal, registerCleanup) {
  if (!mapInstance) {
    return;
  }

  let replayControlsEl = null;
  let isReplaying = false;
  let activeTripId = null;
  const getLayerSearchOrder = () => {
    const ordered = [];
    if (
      store.selectedTripLayer === "trips" ||
      store.selectedTripLayer === "matchedTrips"
    ) {
      ordered.push(store.selectedTripLayer);
    }
    ["trips", "matchedTrips"].forEach((layerName) => {
      if (!ordered.includes(layerName)) {
        ordered.push(layerName);
      }
    });
    return ordered;
  };
  const getAnimationCoords = (geometry) => {
    if (geometry?.type === "LineString") {
      return geometry.coordinates;
    }
    if (geometry?.type !== "MultiLineString" || !Array.isArray(geometry.coordinates)) {
      return null;
    }
    return geometry.coordinates.reduce((longest, line) => {
      if (!Array.isArray(line) || line.length < 2) {
        return longest;
      }
      return !longest || line.length > longest.length ? line : longest;
    }, null);
  };

  const removeReplayControls = () => {
    if (replayControlsEl?.parentNode) {
      replayControlsEl.remove();
      replayControlsEl = null;
    }
    isReplaying = false;
  };

  const getSelectedCoords = (selectedId = store.selectedTripId) => {
    if (!selectedId) {
      return null;
    }

    if (
      store.selectedTripLayer === "trips" ||
      store.selectedTripLayer === "matchedTrips"
    ) {
      const paths = tripMapRenderer.getTripPaths(store.selectedTripLayer, selectedId);
      if (paths.length) {
        return paths.reduce((longest, path) => {
          if (!Array.isArray(path) || path.length < 2) {
            return longest;
          }
          return !longest || path.length > longest.length ? path : longest;
        }, null);
      }
    }

    for (const layerName of getLayerSearchOrder()) {
      const features = store.mapLayers[layerName]?.layer?.features;
      if (!features) {
        continue;
      }
      const match = features.find((f) => {
        const fId =
          f.properties?.transactionId ||
          f.properties?.id ||
          f.properties?.tripId ||
          f.id;
        return String(fId) === String(selectedId);
      });
      if (match?.geometry) {
        return getAnimationCoords(match.geometry);
      }
    }
    return null;
  };

  const showReplayControls = (coords) => {
    removeReplayControls();

    const mapContainer =
      document.getElementById("map") || document.getElementById("map-canvas");
    if (!mapContainer) {
      return;
    }

    const el = document.createElement("div");
    el.className = "replay-controls";
    el.innerHTML = `
      <button class="replay-btn" data-action="replay" type="button">
        <i class="fas fa-play"></i> Replay
      </button>
    `;

    el.addEventListener("click", (e) => {
      const btn = e.target.closest("[data-action]");
      if (!btn) {
        return;
      }

      if (btn.dataset.action === "replay") {
        if (isReplaying) {
          tripAnimator.stopReplay(mapInstance);
          isReplaying = false;
          btn.innerHTML = '<i class="fas fa-play"></i> Replay';
          btn.classList.remove("active");
        } else {
          tripAnimator.startReplay(mapInstance, coords, {
            speed: 1,
            onComplete: () => {
              isReplaying = false;
              btn.innerHTML = '<i class="fas fa-play"></i> Replay';
              btn.classList.remove("active");
            },
          });
          isReplaying = true;
          btn.innerHTML = '<i class="fas fa-stop"></i> Stop';
          btn.classList.add("active");
        }
      }
    });

    mapContainer.style.position = "relative";
    mapContainer.appendChild(el);
    replayControlsEl = el;
  };

  const syncSelection = () => {
    const selectedId = store.selectedTripId ? String(store.selectedTripId) : null;
    if (selectedId && (selectedId !== activeTripId || !replayControlsEl)) {
      const coords = getSelectedCoords(selectedId);
      tripAnimator.stopDraw(mapInstance);
      tripAnimator.stopReplay(mapInstance);
      removeReplayControls();
      if (coords && coords.length >= 2) {
        activeTripId = selectedId;
        tripAnimator.animateRouteDraw(mapInstance, coords, { duration: 2000 });
        showReplayControls(coords);
      } else {
        activeTripId = null;
      }
    } else if (!selectedId && replayControlsEl) {
      tripAnimator.stopDraw(mapInstance);
      tripAnimator.stopReplay(mapInstance);
      removeReplayControls();
      activeTripId = null;
    }
  };

  // Listen for trip selection changes
  const checkInterval = setInterval(syncSelection, 300);
  syncSelection();

  registerCleanup(() => {
    clearInterval(checkInterval);
    tripAnimator.cleanup(mapInstance);
    removeReplayControls();
  });
}
