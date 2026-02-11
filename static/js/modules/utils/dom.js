import { swupReady } from "../core/navigation.js";
import store from "../core/store.js";

/**
 * Create an element with safe text content
 * @param {string} tag - HTML tag name
 * @param {string} text - Text content (will be escaped)
 * @param {string} className - CSS class name
 * @returns {HTMLElement} Created element
 */
export function createElement(tag, text = "", className = "") {
  const el = document.createElement(tag);
  if (text) {
    el.textContent = text;
  }
  if (className) {
    el.className = className;
  }
  return el;
}

/**
 * Get cached DOM element by selector
 * @param {string} selector - CSS selector or element ID
 * @returns {Element|null} Cached element or null
 */
export function getElement(selector) {
  return store.getElement(selector);
}

/**
 * Get all elements matching selector (cached)
 * @param {string} selector - CSS selector
 * @returns {NodeList} Matching elements
 */
export function getAllElements(selector) {
  return store.getAllElements(selector);
}

/**
 * Batch DOM updates using requestAnimationFrame
 * @param {Function[]} updates - Array of update functions
 */
export function batchDOMUpdates(updates) {
  requestAnimationFrame(() => {
    updates.forEach((update) => {
      update();
    });
  });
}

/**
 * Yield control back to the browser for responsive UI
 * @param {number} delay - Optional delay in milliseconds
 * @returns {Promise<void>}
 */
export function yieldToBrowser(delay = 0) {
  return new Promise((resolve) => {
    if (delay > 0) {
      setTimeout(() => requestAnimationFrame(resolve), delay);
    } else {
      requestAnimationFrame(resolve);
    }
  });
}

function routeMatches(route, pathname) {
  if (!route) {
    return true;
  }
  if (typeof route === "string") {
    return pathname === route;
  }
  if (route instanceof RegExp) {
    return route.test(pathname);
  }
  if (typeof route === "function") {
    return Boolean(route(pathname));
  }
  return false;
}

function pathnameFromSwupUrl(urlish) {
  if (!urlish) {
    return null;
  }
  if (typeof urlish === "string") {
    try {
      return new URL(urlish, window.location.origin).pathname || null;
    } catch {
      const trimmed = urlish.trim();
      if (!trimmed) {
        return null;
      }
      return trimmed.split("#")[0].split("?")[0] || null;
    }
  }
  if (typeof urlish === "object") {
    if (typeof urlish.pathname === "string" && urlish.pathname) {
      return urlish.pathname;
    }
    if (typeof urlish.href === "string" && urlish.href) {
      try {
        return new URL(urlish.href, window.location.origin).pathname || null;
      } catch {
        return null;
      }
    }
  }
  return null;
}

export function onPageLoad(callback, options = {}) {
  let cleanup = null;
  let controller = null;
  let activeRoute = null;
  let disposed = false;
  let boundSwup = null;

  const run = () => {
    const currentPath = document.body?.dataset?.route || window.location.pathname;
    if (!routeMatches(options.route, currentPath)) {
      return;
    }

    // Wait for app to be ready if it isn't already
    if (!store.appReady && !options.skipAppReady) {
      document.addEventListener("appReady", run, { once: true });
      return;
    }

    if (cleanup) {
      cleanup();
      cleanup = null;
    }

    if (controller) {
      controller.abort();
    }
    controller = new AbortController();
    activeRoute = currentPath || null;

    const registerCleanup = (fn) => {
      if (typeof fn === "function") {
        cleanup = fn;
      }
    };

    const result = callback({ signal: controller.signal, cleanup: registerCleanup });
    if (typeof result === "function") {
      cleanup = result;
    }
  };

  const handleUnload = (visit) => {
    const fromPath = pathnameFromSwupUrl(visit?.from?.url) || activeRoute;
    if (!routeMatches(options.route, fromPath)) {
      return;
    }
    if (!activeRoute) {
      return;
    }
    if (cleanup) {
      cleanup();
      cleanup = null;
    }
    if (controller) {
      controller.abort();
      controller = null;
    }
    activeRoute = null;
  };

  if (document.readyState === "loading") {
    document.addEventListener(
      "DOMContentLoaded",
      () => {
        // Small delay to allow store to init
        setTimeout(run, 0);
      },
      { once: true }
    );
  } else {
    // Small delay to allow store to init
    setTimeout(run, 0);
  }

  const swupViewHandler = () => run();
  const swupUnloadHandler = (visit) => handleUnload(visit);
  swupReady
    .then((instance) => {
      if (disposed) {
        return;
      }
      boundSwup = instance;
      instance.hooks.on("page:view", swupViewHandler);
      instance.hooks.on("visit:start", swupUnloadHandler);
    })
    .catch(() => {
      // If swup never initializes (or fails), onPageLoad still works for initial load.
    });

  return () => {
    disposed = true;
    if (boundSwup) {
      boundSwup.hooks.off("page:view", swupViewHandler);
      boundSwup.hooks.off("visit:start", swupUnloadHandler);
      boundSwup = null;
    }
    if (cleanup) {
      cleanup();
      cleanup = null;
    }
    if (controller) {
      controller.abort();
      controller = null;
    }
  };
}

/**
 * Move modals out of content containers to avoid stacking context issues.
 * @param {Object} options
 * @param {string} options.containerSelector
 * @param {string[]} options.rootSelectors
 * @param {string} options.route
 * @returns {HTMLElement[]} Moved modals
 */
export function moveModalsToContainer(options = {}) {
  const {
    containerSelector = "#modals-container",
    rootSelectors = ["#route-content", "#persistent-shell"],
    route = document.body?.dataset?.route || "",
  } = options;

  const container = document.querySelector(containerSelector);
  if (!container) {
    return [];
  }

  const roots = rootSelectors
    .map((selector) => document.querySelector(selector))
    .filter(Boolean);
  if (!roots.length) {
    return [];
  }

  const moved = [];
  roots.forEach((root) => {
    root.querySelectorAll(".modal").forEach((modal) => {
      if (!(modal instanceof HTMLElement)) {
        return;
      }
      if (modal.id) {
        const existing = container.querySelector(`#${CSS.escape(modal.id)}`);
        if (existing && existing !== modal) {
          existing.remove();
        }
      }
      if (!container.contains(modal)) {
        container.appendChild(modal);
      }
      if (route) {
        modal.dataset.esModalRoute = route;
      } else {
        modal.removeAttribute("data-es-modal-route");
      }
      moved.push(modal);
    });
  });

  return moved;
}

/**
 * Fade in an element
 * @param {HTMLElement} el - Element to fade in
 * @param {number} duration - Animation duration in milliseconds
 * @returns {Promise<void>}
 */
export function fadeIn(el, duration = 200) {
  return new Promise((resolve) => {
    if (!el) {
      resolve();
      return;
    }
    el.style.opacity = 0;
    el.style.display = el.style.display || "block";
    el.style.transition = `opacity ${duration}ms`;
    requestAnimationFrame(() => {
      el.style.opacity = 1;
    });
    setTimeout(resolve, duration);
  });
}

/**
 * Fade out an element
 * @param {HTMLElement} el - Element to fade out
 * @param {number} duration - Animation duration in milliseconds
 * @returns {Promise<void>}
 */
export function fadeOut(el, duration = 200) {
  return new Promise((resolve) => {
    if (!el) {
      resolve();
      return;
    }
    el.style.opacity = 1;
    el.style.transition = `opacity ${duration}ms`;
    requestAnimationFrame(() => {
      el.style.opacity = 0;
    });
    setTimeout(() => {
      el.style.display = "none";
      resolve();
    }, duration);
  });
}

/**
 * Accessibility announcements for screen readers
 * @param {string} message - Message to announce
 * @param {string} priority - Priority ("polite" or "assertive")
 */
export function announce(message, priority = "polite") {
  const announcer =
    document.getElementById("map-announcements") ||
    document.querySelector('[aria-live="polite"]');

  if (!announcer) {
    console.warn("No aria-live region found for announcements");
    return;
  }

  announcer.setAttribute("aria-live", priority);
  announcer.textContent = "";

  requestAnimationFrame(() => {
    announcer.textContent = message;
    setTimeout(() => {
      announcer.textContent = "";
    }, 3000);
  });
}

/**
 * Measure scrollbar width
 * @returns {number} Scrollbar width in pixels
 */
export function measureScrollbarWidth() {
  return window.innerWidth - document.documentElement.clientWidth;
}
