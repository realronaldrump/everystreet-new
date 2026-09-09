import { onNavigation } from "../core/navigation-events.js";
import store from "../core/store.js";
import { moveModalsToContainer, utils } from "../utils.js";
import { initAppSelects } from "./app-select.js";
import dateManager from "./date-manager.js";
import densityManager from "./density-manager.js";
import interactions from "./interactions.js";
import mapControlsManager from "./map-controls-manager.js";
import metricAnimator from "./metric-animator.js";
import mobileNav from "./mobile-nav.js";
import { moveFocusOutOfModal } from "./modal-focus.js";
import panelManager from "./panel-manager.js";
import setupRequired from "./setup-required.js";
import swipeActions from "./swipe-actions.js";
import themeManager from "./theme-manager.js";

function init() {
  if (store.ui.initialized) {
    return;
  }

  try {
    const cleanupModalsForRoute = (route) => {
      const resolvedRoute = route || document.body?.dataset?.route;
      if (!resolvedRoute) {
        return;
      }
      const container = document.getElementById("modals-container");
      if (!container) {
        return;
      }
      container
        .querySelectorAll(`.modal[data-es-modal-route="${resolvedRoute}"]`)
        .forEach((modal) => {
          moveFocusOutOfModal(modal);
          const instance = window.bootstrap?.Modal?.getInstance(modal);
          if (instance && modal.classList.contains("show")) {
            modal.addEventListener("hidden.bs.modal", () => modal.remove(), {
              once: true,
            });
            instance.hide();
            return;
          }
          instance?.dispose?.();
          modal.remove();
        });
    };

    themeManager.init();
    panelManager.init();
    interactions.init();
    initAppSelects();
    metricAnimator.init?.();
    mobileNav.init?.();
    swipeActions.init?.();
    densityManager.init?.();
    mapControlsManager.init?.();
    setupRequired.init?.();

    // Throttled resize event for responsive components
    const debouncedResize = utils.debounce(() => {
      window.dispatchEvent(new Event("appResized"));
    }, 150);
    window.addEventListener("resize", debouncedResize);

    moveModalsToContainer();
    onNavigation("page:view", () => moveModalsToContainer());
    onNavigation("page:leave", (visit) => {
      const fromUrl = visit?.from?.url;
      let fromPath = null;
      if (typeof fromUrl === "string" && fromUrl) {
        try {
          fromPath = new URL(fromUrl, window.location.origin).pathname;
        } catch {
          fromPath = null;
        }
      }
      if (!visit.meta?.detailVisit || fromPath !== visit.meta.backgroundPath)
        cleanupModalsForRoute(fromPath);
      if (!visit.meta?.detailVisit && visit.meta?.backgroundPath)
        cleanupModalsForRoute(visit.meta.backgroundPath);
    });

    // Defer heavier init (date pickers & events)
    const runDeferred = () => {
      dateManager.init?.();
    };
    if ("requestIdleCallback" in window) {
      requestIdleCallback(runDeferred, { timeout: 1000 });
    } else {
      setTimeout(runDeferred, 100);
    }

    store.ui.initialized = true;
    document.dispatchEvent(new CustomEvent("uiReady"));
  } catch (err) {
    console.error("UI init error", err);
    utils.showNotification?.(`Error initializing UI: ${err.message}`, "danger");
  }
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", init);
} else {
  init();
}
