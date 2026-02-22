import initCoverageNavigatorPage from "../modules/features/coverage-navigator/index.js";
import { onPageLoad } from "../modules/utils.js";

/**
 * Measure the mobile bottom nav (if present) so fixed UI on this page
 * (panel toggle, legend, Mapbox attribution) doesn't get covered.
 */
function initBottomNavInsets({ signal } = {}) {
  const root = document.querySelector(".coverage-navigator");
  if (!root) {
    return;
  }

  const bottomNav = document.getElementById("bottom-nav");
  if (!bottomNav) {
    root.style.setProperty("--bottom-nav-height", "0px");
    root.style.setProperty("--bottom-nav-offset", "0px");
    return;
  }

  let rafId = null;

  const apply = () => {
    rafId = null;

    const styles = window.getComputedStyle(bottomNav);
    const isDisplayed = styles.display !== "none";
    const isHidden = bottomNav.classList.contains("hidden");

    if (!isDisplayed || isHidden) {
      root.style.setProperty("--bottom-nav-height", "0px");
      root.style.setProperty("--bottom-nav-offset", "0px");
      return;
    }

    const navHeight = Math.round(bottomNav.getBoundingClientRect().height);
    const paddingTop = Number.parseFloat(styles.paddingTop) || 0;
    const paddingBottom = Number.parseFloat(styles.paddingBottom) || 0;
    const safeArea = Math.max(0, paddingBottom - paddingTop);
    const offset = Math.max(0, navHeight - safeArea);

    root.style.setProperty("--bottom-nav-height", `${navHeight}px`);
    root.style.setProperty("--bottom-nav-offset", `${Math.round(offset)}px`);
  };

  const schedule = () => {
    if (rafId != null) {
      return;
    }
    rafId = requestAnimationFrame(apply);
  };

  schedule();

  window.addEventListener("resize", schedule, { passive: true, signal });
  if (window.visualViewport) {
    window.visualViewport.addEventListener("resize", schedule, {
      passive: true,
      signal,
    });
    window.visualViewport.addEventListener("scroll", schedule, {
      passive: true,
      signal,
    });
  }

  const observer = new MutationObserver(schedule);
  observer.observe(bottomNav, {
    attributes: true,
    attributeFilter: ["class", "style"],
  });
  signal?.addEventListener(
    "abort",
    () => {
      observer.disconnect();
      if (rafId != null) {
        cancelAnimationFrame(rafId);
      }
    },
    { once: true }
  );
}

/**
 * Initialize collapsible sections in the control panel
 */
function initCollapsibleSections({ signal } = {}) {
  const headers = document.querySelectorAll(".widget-header.collapsible");
  const eventOptions = signal ? { signal } : false;

  headers.forEach((header) => {
    const toggleId = header.dataset.toggle;
    const content = document.getElementById(toggleId);
    const collapseBtn = header.querySelector(".btn-collapse");

    if (!content || !collapseBtn) {
      return;
    }

    // Initialize state from localStorage
    const saved = localStorage.getItem(`coverage-navigator-${toggleId}`);
    if (saved === "collapsed") {
      content.classList.add("is-collapsed");
      collapseBtn.setAttribute("aria-expanded", "false");
    }

    const toggleHandler = (e) => {
      const isFormControl = e.target.closest(".form-switch, .form-check-input");
      const inHeaderActions = e.target.closest(".header-actions");
      const isCollapseButton = e.target.closest(".btn-collapse");
      if (isFormControl || (inHeaderActions && !isCollapseButton)) {
        return;
      }

      const isNowCollapsed = !content.classList.contains("is-collapsed");

      if (isNowCollapsed) {
        content.classList.add("is-collapsed");
        collapseBtn.setAttribute("aria-expanded", "false");
        localStorage.setItem(`coverage-navigator-${toggleId}`, "collapsed");
      } else {
        content.classList.remove("is-collapsed");
        collapseBtn.setAttribute("aria-expanded", "true");
        localStorage.setItem(`coverage-navigator-${toggleId}`, "expanded");
      }
    };

    header.addEventListener("click", toggleHandler, eventOptions);
  });
}

/**
 * Initialize mobile panel toggle
 */
function initMobilePanelToggle({ signal } = {}) {
  const toggle = document.getElementById("mobile-panel-toggle");
  const panel = document.getElementById("control-panel");
  const eventOptions = signal ? { signal } : false;

  if (!toggle || !panel) {
    return;
  }

  const storageKey = "coverage-navigator-mobile-panel";

  if (window.innerWidth < 1024) {
    const saved = localStorage.getItem(storageKey);
    if (saved === "hidden") {
      panel.classList.add("is-hidden");
    } else if (saved === "visible") {
      panel.classList.remove("is-hidden");
    }
  }

  const isPanelVisible = !panel.classList.contains("is-hidden");
  toggle.setAttribute("aria-expanded", isPanelVisible.toString());

  toggle.addEventListener(
    "click",
    () => {
      const isExpanded = toggle.getAttribute("aria-expanded") === "true";

      if (isExpanded) {
        panel.classList.add("is-hidden");
        toggle.setAttribute("aria-expanded", "false");
        localStorage.setItem(storageKey, "hidden");
      } else {
        panel.classList.remove("is-hidden");
        toggle.setAttribute("aria-expanded", "true");
        localStorage.setItem(storageKey, "visible");
      }
    },
    eventOptions
  );

  const mapContainer = document.querySelector(".map-container");
  if (mapContainer) {
    mapContainer.addEventListener(
      "click",
      (e) => {
        if (window.innerWidth < 1024) {
          const isExpanded = toggle.getAttribute("aria-expanded") === "true";
          if (isExpanded && !e.target.closest(".map-legend")) {
            panel.classList.add("is-hidden");
            toggle.setAttribute("aria-expanded", "false");
            localStorage.setItem(storageKey, "hidden");
          }
        }
      },
      eventOptions
    );
  }
}

/**
 * Initialize layer opacity controls
 */
function initLayerControls({ signal } = {}) {
  const layerItems = document.querySelectorAll(".layer-item");
  const eventOptions = signal ? { signal } : false;

  layerItems.forEach((item) => {
    const range = item.querySelector('input[type="range"]');
    const valueDisplay = item.querySelector(".opacity-value");

    if (range && valueDisplay) {
      range.addEventListener(
        "input",
        (e) => {
          valueDisplay.textContent = `${e.target.value}%`;
        },
        eventOptions
      );
    }
  });
}

/**
 * Initialize smooth scroll for control panel
 */
function initSmoothScroll() {
  const panel = document.querySelector(".control-panel");
  if (!panel) {
    return;
  }

  panel.style.scrollBehavior = "smooth";
}

/**
 * Handle responsive layout changes
 */
function handleResponsiveLayout({ signal } = {}) {
  const panel = document.getElementById("control-panel");
  const toggle = document.getElementById("mobile-panel-toggle");

  if (!panel || !toggle) {
    return;
  }

  const mediaQuery = window.matchMedia("(min-width: 1024px)");

  const handleChange = (e) => {
    if (e.matches) {
      panel.classList.remove("is-hidden");
      panel.style.transform = "";
    } else {
      const isExpanded = toggle.getAttribute("aria-expanded") === "true";
      if (!isExpanded) {
        panel.classList.add("is-hidden");
      }
    }
  };

  mediaQuery.addEventListener("change", handleChange, signal ? { signal } : false);
  handleChange(mediaQuery);
}

/**
 * Initialize keyboard shortcuts
 */
function initKeyboardShortcuts({ signal } = {}) {
  document.addEventListener(
    "keydown",
    (e) => {
      const { target } = e;
      if (target instanceof Element && target.matches("input, select, textarea")) {
        return;
      }

      if (e.key === "Escape") {
        const toggle = document.getElementById("mobile-panel-toggle");
        const panel = document.getElementById("control-panel");

        if (toggle && panel && window.innerWidth < 1024) {
          const isExpanded = toggle.getAttribute("aria-expanded") === "true";
          if (isExpanded) {
            panel.classList.add("is-hidden");
            toggle.setAttribute("aria-expanded", "false");
          } else {
            panel.classList.remove("is-hidden");
            toggle.setAttribute("aria-expanded", "true");
          }
        }
      }
    },
    signal ? { signal } : false
  );
}

/**
 * Enhance accessibility attributes
 */
function enhanceAccessibility() {
  const statusMessage = document.getElementById("status-message");
  if (statusMessage) {
    statusMessage.setAttribute("aria-live", "polite");
    statusMessage.setAttribute("aria-atomic", "true");
  }

  const buttons = document.querySelectorAll(".btn-action, .btn-generate");
  buttons.forEach((btn) => {
    if (!btn.hasAttribute("tabindex")) {
      btn.setAttribute("tabindex", "0");
    }
  });
}

/* ==========================================================================
   Tab Navigation System
   ========================================================================== */

const TAB_STORAGE_KEY = "coverage-navigator-active-tab";

/**
 * Switch to a tab by name, updating ARIA state and panel visibility.
 */
function switchTab(tabName) {
  const tabs = document.querySelectorAll(".sidebar-tab");
  const panels = document.querySelectorAll(".tab-panel");

  tabs.forEach((tab) => {
    const isActive = tab.dataset.tab === tabName;
    tab.classList.toggle("active", isActive);
    tab.setAttribute("aria-selected", isActive.toString());
  });

  panels.forEach((panel) => {
    panel.classList.toggle("active", panel.dataset.tab === tabName);
  });

  localStorage.setItem(TAB_STORAGE_KEY, tabName);
  updateModeIndicator();
}

/**
 * Initialize tab click handlers and restore persisted tab.
 */
function initTabNavigation({ signal } = {}) {
  const tabs = document.querySelectorAll(".sidebar-tab");
  const eventOptions = signal ? { signal } : false;
  if (!tabs.length) {
    return;
  }

  tabs.forEach((tab) => {
    tab.addEventListener(
      "click",
      () => {
        switchTab(tab.dataset.tab);
      },
      eventOptions
    );
  });

  // Restore last active tab
  const saved = localStorage.getItem(TAB_STORAGE_KEY);
  if (saved && document.querySelector(`.sidebar-tab[data-tab="${saved}"]`)) {
    switchTab(saved);
  }
}

/**
 * Watch for visibility changes on status/results elements and auto-switch tabs.
 * Uses MutationObservers on style and class attributes.
 */
function initAutoTabSwitch({ signal } = {}) {
  const progressSection = document.getElementById("progress-section");
  const routeProgressContainer = document.getElementById("route-progress-container");
  const resultsSection = document.getElementById("results-section");
  const errorSection = document.getElementById("error-section");

  const observers = [];

  /**
   * Returns true if the element is visible (not display:none and not hidden by
   * class). Accounts for both inline style and the `.active` class on
   * route-progress-container.
   */
  const isVisible = (el) => {
    if (!el) {
      return false;
    }
    // route-progress-container uses display:none in CSS, overridden by .active class
    if (el.id === "route-progress-container") {
      return el.classList.contains("active");
    }
    return el.style.display !== "none";
  };

  const checkStatusActivity = () => {
    const hasActivity =
      isVisible(progressSection) ||
      isVisible(routeProgressContainer) ||
      isVisible(errorSection);

    const statusTab = document.querySelector('.sidebar-tab[data-tab="status"]');
    if (statusTab) {
      if (hasActivity) {
        statusTab.setAttribute("data-has-activity", "");
      } else {
        statusTab.removeAttribute("data-has-activity");
      }
    }

    // Hide/show the empty state in the Status tab
    const emptyState = document.getElementById("status-empty-state");
    if (emptyState) {
      emptyState.style.display = hasActivity ? "none" : "";
    }
  };

  const checkResultsActivity = () => {
    const hasResults = isVisible(resultsSection);

    // Hide/show the empty state in the Results tab
    const emptyState = document.getElementById("results-empty-state");
    if (emptyState) {
      emptyState.style.display = hasResults ? "none" : "";
    }
  };

  // Auto-switch to Status when processing starts
  const onStatusVisible = () => {
    if (
      isVisible(progressSection) ||
      isVisible(routeProgressContainer) ||
      isVisible(errorSection)
    ) {
      switchTab("status");
    }
    checkStatusActivity();
  };

  // Auto-switch to Results when results appear
  const onResultsVisible = () => {
    if (isVisible(resultsSection)) {
      switchTab("results");
    }
    checkResultsActivity();
  };

  const watchTargets = [
    { el: progressSection, cb: onStatusVisible },
    { el: routeProgressContainer, cb: onStatusVisible },
    { el: errorSection, cb: onStatusVisible },
    { el: resultsSection, cb: onResultsVisible },
  ];

  for (const { el, cb } of watchTargets) {
    if (!el) {
      continue;
    }
    const obs = new MutationObserver(cb);
    obs.observe(el, {
      attributes: true,
      attributeFilter: ["style", "class"],
    });
    observers.push(obs);
  }

  signal?.addEventListener(
    "abort",
    () => {
      for (const obs of observers) {
        obs.disconnect();
      }
    },
    { once: true }
  );

  // Initial check
  checkStatusActivity();
  checkResultsActivity();
}

/**
 * Set data-mode on the root element based on current app state.
 */
function updateModeIndicator() {
  const root = document.querySelector(".coverage-navigator");
  if (!root) {
    return;
  }

  const activeTab = document.querySelector(".sidebar-tab.active");
  if (!activeTab) {
    return;
  }

  const modeMap = {
    plan: "planning",
    navigate: "navigating",
    status: "processing",
    results: "results",
  };

  root.dataset.mode = modeMap[activeTab.dataset.tab] || "planning";
}

/**
 * Main initialization
 */
function initPage({ signal, cleanup } = {}) {
  initBottomNavInsets({ signal });

  // Initialize UI components
  initCollapsibleSections({ signal });
  initMobilePanelToggle({ signal });
  initLayerControls({ signal });
  initSmoothScroll();
  handleResponsiveLayout({ signal });
  initKeyboardShortcuts({ signal });
  enhanceAccessibility();

  // Initialize tab system
  initTabNavigation({ signal });
  initAutoTabSwitch({ signal });
  updateModeIndicator();

  // Initialize the main coverage navigator functionality
  initCoverageNavigatorPage({ cleanup });
}

// Initialize on page load
onPageLoad(initPage, { route: "/coverage-navigator" });
