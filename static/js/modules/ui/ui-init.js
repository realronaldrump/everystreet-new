import store from "../core/store.js";
import { moveModalsToContainer, utils } from "../utils.js";
import contextualUI from "./contextual-ui.js";
import dateManager from "./date-manager.js";
import filterIndicatorManager from "./filter-indicator-manager.js";
import interactions from "./interactions.js";
import mapControlsManager from "./map-controls-manager.js";
import metricAnimator from "./metric-animator.js";
import mobileNav from "./mobile-nav.js";
import modalEffects from "./modal-effects.js";
import panelManager from "./panel-manager.js";
import personalization from "./personalization.js";
import pullToRefresh from "./pull-to-refresh.js";
import setupRequired from "./setup-required.js";
import swipeActions from "./swipe-actions.js";
import swipeDismiss from "./swipe-dismiss.js";
import themeManager from "./theme-manager.js";
import widgetManager from "./widget-manager.js";

function init() {
  if (store.ui.initialized) {
    return;
  }

  try {
    const cleanupModalsForRoute = (event) => {
      const route = event?.detail?.path || document.body?.dataset?.route;
      if (!route) {
        return;
      }
      const container = document.getElementById("modals-container");
      if (!container) {
        return;
      }
      container
        .querySelectorAll(`.modal[data-es-modal-route="${route}"]`)
        .forEach((modal) => {
          const instance = window.bootstrap?.Modal?.getInstance(modal);
          if (instance && modal.classList.contains("show")) {
            modal.addEventListener("hidden.bs.modal", () => modal.remove(), {
              once: true,
            });
            instance.hide();
            return;
          }
          modal.remove();
        });
    };

    themeManager.init();
    panelManager.init();
    interactions.init();
    metricAnimator.init?.();
    modalEffects.init?.();
    mobileNav.init?.();
    pullToRefresh.init?.();
    swipeActions.init?.();
    swipeDismiss.init?.();
    widgetManager.init?.();
    personalization.init?.();
    contextualUI.init?.();
    mapControlsManager.init?.();
    filterIndicatorManager.init?.();
    setupRequired.init?.();

    // Pause animations when tab is hidden (saves CPU)
    document.addEventListener("visibilitychange", () => {
      const root = document.documentElement;
      if (document.hidden) {
        root.style.setProperty("--transition-duration", "0ms");
      } else {
        root.style.removeProperty("--transition-duration");
      }
    });

    // Throttled resize event for responsive components
    const debouncedResize = utils.debounce(() => {
      window.dispatchEvent(new Event("appResized"));
    }, 150);
    window.addEventListener("resize", debouncedResize);

    moveModalsToContainer();
    document.addEventListener("es:page-load", () => moveModalsToContainer());
    document.addEventListener("es:page-unload", cleanupModalsForRoute);

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
    document.dispatchEvent(new CustomEvent("modernUIReady"));
  } catch (err) {
    console.error("Modern UI init error", err);
    utils.showNotification?.(`Error initializing UI: ${err.message}`, "danger");
  }
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", init);
} else {
  init();
}

export default { init };
