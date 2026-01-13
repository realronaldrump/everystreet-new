import uiState from "../ui-state.js";
import { utils } from "../utils.js";
import contextualUI from "./contextual-ui.js";
import dateManager from "./date-manager.js";
import filterIndicatorManager from "./filter-indicator-manager.js";
import interactions from "./interactions.js";
import mapControlsManager from "./map-controls-manager.js";
import metricAnimator from "./metric-animator.js";
import mobileNav from "./mobile-nav.js";
import modalEffects from "./modal-effects.js";
import panelManager from "./panel-manager.js";
import perf from "./performance-optimisations.js";
import personalization from "./personalization.js";
import pullToRefresh from "./pull-to-refresh.js";
import swipeActions from "./swipe-actions.js";
import swipeDismiss from "./swipe-dismiss.js";
import themeManager from "./theme-manager.js";
import widgetManager from "./widget-manager.js";

function init() {
  if (uiState.initialized) {
    return;
  }

  try {
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
    perf.init?.();

    // Defer heavier init (date pickers & events)
    const runDeferred = () => {
      dateManager.init?.();
    };
    if ("requestIdleCallback" in window) {
      requestIdleCallback(runDeferred, { timeout: 1000 });
    } else {
      setTimeout(runDeferred, 100);
    }

    uiState.initialized = true;
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
