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

export function onPageLoad(callback, options = {}) {
  let cleanup = null;
  let controller = null;
  let activeRoute = null;

  const run = () => {
    if (options.route && document.body?.dataset?.route !== options.route) {
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
    activeRoute = options.route || document.body?.dataset?.route || null;

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

  const handleUnload = (event) => {
    if (options.route && event?.detail?.path && event.detail.path !== options.route) {
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
    document.addEventListener("DOMContentLoaded", run, { once: true });
  } else {
    run();
  }

  document.addEventListener("es:page-load", run);
  document.addEventListener("es:page-unload", handleUnload);

  return () => {
    document.removeEventListener("es:page-load", run);
    document.removeEventListener("es:page-unload", handleUnload);
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

document.addEventListener("es:page-load", () => {
  store.clearElementCache();
});

document.addEventListener("es:page-unload", () => {
  store.clearElementCache();
});

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
  const announcer
    = document.getElementById("map-announcements")
    || document.querySelector('[aria-live="polite"]');

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
