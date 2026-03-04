import { CONFIG } from "../../core/config.js";
import { resolveMapTypeHint } from "./map-type-hint.js";

const MAP_INTERACTION_EVENTS = ["dragstart", "zoomstart", "rotatestart", "pitchstart"];
const DOM_INTERACTION_EVENTS = ["mousedown", "touchstart", "wheel", "keydown"];

const noopController = Object.freeze({
  isActive() {
    return false;
  },
  destroy() {},
});

function normalizeStyleType(value) {
  return typeof value === "string" ? value.trim().toLowerCase() : "";
}

function getCinematicConfig() {
  return CONFIG?.MAP?.cinematicIntro || {};
}

function getStorageKey() {
  return CONFIG?.STORAGE_KEYS?.mapCinematicIntroSeen || "mapCinematicIntroSeen";
}

function isGoogleProvider() {
  return normalizeStyleType(globalThis?.window?.MAP_PROVIDER) === "google";
}

function getRequestFrame() {
  if (typeof globalThis.requestAnimationFrame === "function") {
    return globalThis.requestAnimationFrame.bind(globalThis);
  }

  return (callback) =>
    setTimeout(() => {
      callback(Date.now());
    }, 16);
}

function getCancelFrame() {
  if (typeof globalThis.cancelAnimationFrame === "function") {
    return globalThis.cancelAnimationFrame.bind(globalThis);
  }

  return clearTimeout;
}

function nowMs() {
  if (typeof performance !== "undefined" && typeof performance.now === "function") {
    return performance.now();
  }
  return Date.now();
}

function getCurrentMapTypeHint() {
  return resolveMapTypeHint({
    storageKey: CONFIG.STORAGE_KEYS.mapType,
    normalizeStyleType,
  });
}

function styleHasCompositeSource(map) {
  if (!map || typeof map.getStyle !== "function") {
    return false;
  }

  try {
    const style = map.getStyle();
    return Boolean(style?.sources?.composite);
  } catch {
    return false;
  }
}

function hasSeenIntro(config) {
  if (!config.firstVisitOnly || typeof localStorage === "undefined") {
    return false;
  }

  try {
    const value = localStorage.getItem(getStorageKey());
    return value === "true";
  } catch {
    return false;
  }
}

function markIntroSeen(config) {
  if (!config.firstVisitOnly || typeof localStorage === "undefined") {
    return;
  }

  try {
    localStorage.setItem(getStorageKey(), "true");
  } catch {
    // Ignore storage write failures.
  }
}

function normalizeBearing(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) {
    return 0;
  }
  return ((numeric % 360) + 360) % 360;
}

export function isDesktopViewport() {
  if (typeof window === "undefined") {
    return false;
  }

  const coarsePointer = window.matchMedia?.("(pointer: coarse)")?.matches;
  if (coarsePointer) {
    return false;
  }

  return Number(window.innerWidth || 0) >= 1024;
}

export function prefersReducedMotion() {
  if (typeof window === "undefined") {
    return false;
  }
  return Boolean(window.matchMedia?.("(prefers-reduced-motion: reduce)")?.matches);
}

export function shouldRunCinematicIntro({ map, config = getCinematicConfig() } = {}) {
  if (!config.enabled) {
    return false;
  }

  if (isGoogleProvider()) {
    return false;
  }

  if (
    !map ||
    typeof map.easeTo !== "function" ||
    typeof map.setBearing !== "function"
  ) {
    return false;
  }

  // Cinematic autoplay is intentionally desktop-only.
  if (!isDesktopViewport()) {
    return false;
  }

  if (prefersReducedMotion()) {
    return false;
  }

  if (!styleHasCompositeSource(map)) {
    return false;
  }

  if (normalizeStyleType(getCurrentMapTypeHint()) === "satellite") {
    return false;
  }

  if (hasSeenIntro(config)) {
    return false;
  }

  return true;
}

function waitForFrames(frameCount, requestFrame, signal) {
  return new Promise((resolve) => {
    let remaining = Math.max(0, Number(frameCount) || 0);

    const step = () => {
      if (signal?.aborted || remaining <= 0) {
        resolve();
        return;
      }
      remaining -= 1;
      requestFrame(step);
    };

    if (remaining === 0) {
      resolve();
      return;
    }

    requestFrame(step);
  });
}

function waitForMoveEnd(map, signal, addCleanup) {
  if (!map || typeof map.on !== "function" || typeof map.off !== "function") {
    return Promise.resolve();
  }

  let isMoving = false;
  if (typeof map.isMoving === "function") {
    try {
      isMoving = Boolean(map.isMoving());
    } catch {
      isMoving = false;
    }
  }

  if (!isMoving) {
    return Promise.resolve();
  }

  return new Promise((resolve) => {
    let settled = false;

    const cleanup = () => {
      if (settled) {
        return;
      }
      settled = true;
      map.off("moveend", handleMoveEnd);
      clearTimeout(timeoutId);
    };

    const handleMoveEnd = () => {
      cleanup();
      resolve();
    };

    const timeoutId = setTimeout(() => {
      cleanup();
      resolve();
    }, 2000);

    map.on("moveend", handleMoveEnd);
    addCleanup(() => {
      cleanup();
      resolve();
    });

    if (signal) {
      const onAbort = () => {
        cleanup();
        resolve();
      };
      signal.addEventListener("abort", onAbort, { once: true });
      addCleanup(() => signal.removeEventListener("abort", onAbort));
    }
  });
}

export default function initCinematicIntro({
  map = null,
  signal,
  config = getCinematicConfig(),
} = {}) {
  const mergedConfig = {
    enabled: true,
    desktopOnly: true,
    firstVisitOnly: true,
    initialPitch: 60,
    rotationDegPerSec: 0.25,
    maxDurationMs: 12000,
    ...config,
  };

  const activeMap = map || globalThis?.window?.map || null;
  if (!shouldRunCinematicIntro({ map: activeMap, config: mergedConfig })) {
    return noopController;
  }

  const requestFrame = getRequestFrame();
  const cancelFrame = getCancelFrame();

  let rafId = null;
  let active = false;
  let started = false;
  let destroyed = false;
  const cleanupFns = [];

  const addCleanup = (fn) => {
    if (typeof fn === "function") {
      cleanupFns.push(fn);
    }
  };

  const cleanup = () => {
    while (cleanupFns.length > 0) {
      const fn = cleanupFns.pop();
      try {
        fn();
      } catch {
        // Ignore cleanup errors.
      }
    }
  };

  const stop = () => {
    if (destroyed) {
      return;
    }
    destroyed = true;
    active = false;

    if (rafId !== null) {
      cancelFrame(rafId);
      rafId = null;
    }

    cleanup();

    if ((started || active) && typeof activeMap?.stop === "function") {
      try {
        activeMap.stop();
      } catch {
        // Ignore map stop errors.
      }
    }
  };

  const stopOnInteraction = () => {
    stop();
  };

  if (typeof activeMap.on === "function" && typeof activeMap.off === "function") {
    MAP_INTERACTION_EVENTS.forEach((eventName) => {
      activeMap.on(eventName, stopOnInteraction);
      addCleanup(() => activeMap.off(eventName, stopOnInteraction));
    });
  }

  const registerDomListener = (target, eventName, handler, options = undefined) => {
    if (!target || typeof target.addEventListener !== "function") {
      return;
    }
    target.addEventListener(eventName, handler, options);
    addCleanup(() => target.removeEventListener(eventName, handler, options));
  };

  DOM_INTERACTION_EVENTS.forEach((eventName) => {
    registerDomListener(window, eventName, stopOnInteraction, { passive: true });
  });

  registerDomListener(document, "visibilitychange", () => {
    if (document.hidden) {
      stop();
    }
  });

  registerDomListener(document, "mapStyleChanged", (event) => {
    const styleType = normalizeStyleType(event?.detail?.styleType);
    if (styleType === "satellite") {
      stop();
    }
  });

  if (signal) {
    const onAbort = () => stop();
    signal.addEventListener("abort", onAbort, { once: true });
    addCleanup(() => signal.removeEventListener("abort", onAbort));
  }

  void (async () => {
    await waitForFrames(2, requestFrame, signal);
    if (destroyed || signal?.aborted) {
      stop();
      return;
    }

    await waitForMoveEnd(activeMap, signal, addCleanup);
    if (destroyed || signal?.aborted) {
      stop();
      return;
    }

    if (!styleHasCompositeSource(activeMap)) {
      stop();
      return;
    }

    if (normalizeStyleType(getCurrentMapTypeHint()) === "satellite") {
      stop();
      return;
    }

    markIntroSeen(mergedConfig);

    started = true;
    active = true;

    const pitchDurationMs = 1400;
    try {
      activeMap.easeTo({
        pitch: Number(mergedConfig.initialPitch) || 60,
        duration: pitchDurationMs,
        essential: true,
      });
    } catch {
      // Keep going even if pitch easing fails.
    }

    const initialBearing = normalizeBearing(activeMap.getBearing?.());
    const startTime = nowMs();

    const tick = () => {
      if (destroyed) {
        return;
      }

      const elapsedMs = nowMs() - startTime;
      if (elapsedMs >= mergedConfig.maxDurationMs) {
        stop();
        return;
      }

      const nextBearing = normalizeBearing(
        initialBearing + (elapsedMs / 1000) * Number(mergedConfig.rotationDegPerSec)
      );

      try {
        activeMap.setBearing(nextBearing);
      } catch {
        stop();
        return;
      }

      rafId = requestFrame(tick);
    };

    rafId = requestFrame(tick);
  })();

  return {
    isActive() {
      return active;
    },
    destroy() {
      stop();
    },
  };
}
