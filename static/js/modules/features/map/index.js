import store from "../../core/store.js";
import initMapControls from "./map-controls.js";
import { initMobileMap } from "./mobile-map.js";

function setupMapTilt(signal) {
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

  const visualViewport = window.visualViewport;
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

  setupMapTilt(signal);
  registerCleanup(setupMapViewportSync());

  initMapControls({ signal, cleanup: registerCleanup });
  initMobileMap({ cleanup: registerCleanup });

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
        const mapInstance = store.map || window.map;
        simulator = new BouncieSimulator(mapInstance);
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
    registerCleanup(() =>
      simToggle.removeEventListener("mousedown", handleSimToggle),
    );
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
