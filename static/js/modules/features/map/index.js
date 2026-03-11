import store from "../../core/store.js";
import initBuildings3D from "./buildings-3d.js";
import initCinematicIntro from "./cinematic-intro.js";
import initMapControls from "./map-controls.js";
import { initMobileMap } from "./mobile-map.js";
import tripAnimator from "../../trip-animator.js";
import routeArt from "../../ui/route-art.js";

function setupMapTilt(signal, isCameraLocked = null) {
  const prefersCoarsePointer = window.matchMedia?.("(pointer: coarse)")?.matches;
  if (prefersCoarsePointer) {
    return;
  }

  const { map } = window;
  if (!map || typeof map.easeTo !== "function") {
    return;
  }
  let ticking = false;
  const maxPitch = 12;
  const maxScroll = 320;

  const applyTilt = () => {
    ticking = false;
    if (store.liveTracker?.followMode) {
      return;
    }
    if (typeof isCameraLocked === "function" && isCameraLocked()) {
      return;
    }
    const scrollY = window.scrollY || 0;
    const ratio = Math.min(scrollY / maxScroll, 1);
    map.easeTo({
      pitch: ratio * maxPitch,
      duration: 300,
      essential: true,
    });
  };

  window.addEventListener(
    "scroll",
    () => {
      if (ticking) {
        return;
      }
      ticking = true;
      requestAnimationFrame(applyTilt);
    },
    signal ? { signal, passive: true } : { passive: true }
  );
}

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

  const controlsPanel = document.getElementById("map-controls");
  if (controlsPanel) {
    bind(controlsPanel, "transitionend", (event) => {
      const prop = event?.propertyName || "";
      if (prop === "transform" || prop === "height" || prop === "max-height") {
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

export default function initMapPage({ signal, cleanup } = {}) {
  const cleanupFns = [];
  const registerCleanup = (fn) => {
    if (typeof fn === "function") {
      cleanupFns.push(fn);
    }
  };

  let perfObserver = null;
  if ("PerformanceObserver" in window) {
    perfObserver = new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) {
        if (entry.entryType === "largest-contentful-paint") {
          // LCP monitoring
        }
      }
    });
    perfObserver.observe({ entryTypes: ["largest-contentful-paint"] });
    registerCleanup(() => perfObserver.disconnect());
  }

  registerCleanup(setupMapViewportSync());

  const mapInstance = store.map || window.map;
  const buildings3d = initBuildings3D({ map: mapInstance });
  registerCleanup(() => buildings3d.destroy?.());

  const cinematicIntro = initCinematicIntro({ map: mapInstance, signal });
  registerCleanup(() => cinematicIntro.destroy?.());

  setupMapTilt(signal, () => cinematicIntro.isActive?.() === true);

  initMapControls({ signal, cleanup: registerCleanup });
  initMobileMap({ cleanup: registerCleanup });

  // Trip animation on selection — draw route with glow when a trip is selected
  setupTripSelectionAnimation(mapInstance, signal, registerCleanup);

  // Route Art toggle
  const routeArtToggle = document.getElementById("route-art-toggle");
  if (routeArtToggle) {
    const handleRouteArt = () => {
      const trips = [];
      for (const layerName of ["trips", "matchedTrips"]) {
        const features = store.mapLayers[layerName]?.layer?.features;
        if (features?.length) {
          trips.push(...features.filter((f) => f.geometry));
        }
      }
      if (trips.length === 0) return;
      routeArt.launch({ trips });
    };
    routeArtToggle.addEventListener("click", handleRouteArt);
    registerCleanup(() => routeArtToggle.removeEventListener("click", handleRouteArt));
  }
  registerCleanup(() => routeArt.close?.());

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
    simToggle.addEventListener("mousedown", handleSimToggle);
    registerCleanup(() => simToggle.removeEventListener("mousedown", handleSimToggle));
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
function setupTripSelectionAnimation(mapInstance, signal, registerCleanup) {
  if (!mapInstance) return;

  let replayControlsEl = null;
  let isReplaying = false;
  let activeTripId = null;
  const getLayerSearchOrder = () => {
    const ordered = [];
    if (store.selectedTripLayer === "trips" || store.selectedTripLayer === "matchedTrips") {
      ordered.push(store.selectedTripLayer);
    }
    ["trips", "matchedTrips"].forEach((layerName) => {
      if (!ordered.includes(layerName)) {
        ordered.push(layerName);
      }
    });
    return ordered;
  };

  const removeReplayControls = () => {
    if (replayControlsEl?.parentNode) {
      replayControlsEl.remove();
      replayControlsEl = null;
    }
    isReplaying = false;
  };

  const getSelectedCoords = (selectedId = store.selectedTripId) => {
    if (!selectedId) return null;

    for (const layerName of getLayerSearchOrder()) {
      const features = store.mapLayers[layerName]?.layer?.features;
      if (!features) continue;
      const match = features.find((f) => {
        const fId =
          f.properties?.transactionId || f.properties?.id || f.properties?.tripId || f.id;
        return String(fId) === String(selectedId);
      });
      if (match?.geometry) {
        if (match.geometry.type === "LineString") return match.geometry.coordinates;
        if (match.geometry.type === "MultiLineString") return match.geometry.coordinates.flat();
      }
    }
    return null;
  };

  const showReplayControls = (coords) => {
    removeReplayControls();

    const mapContainer = document.getElementById("map") || document.getElementById("map-canvas");
    if (!mapContainer) return;

    const el = document.createElement("div");
    el.className = "replay-controls";
    el.innerHTML = `
      <button class="replay-btn" data-action="draw" type="button">
        <i class="fas fa-pen-nib"></i> Draw
      </button>
      <button class="replay-btn" data-action="replay" type="button">
        <i class="fas fa-play"></i> Replay
      </button>
    `;

    el.addEventListener("click", (e) => {
      const btn = e.target.closest("[data-action]");
      if (!btn) return;

      if (btn.dataset.action === "draw") {
        tripAnimator.animateRouteDraw(mapInstance, coords, { duration: 2500 });
      } else if (btn.dataset.action === "replay") {
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
