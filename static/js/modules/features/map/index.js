import store from "../../core/store.js";
import initMapControls from "./map-controls.js";
import { initMobileMap } from "./mobile-map.js";

function setupMapTilt(signal) {
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

  initMapControls({ signal, cleanup: registerCleanup });
  initMobileMap({ cleanup: registerCleanup });

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
