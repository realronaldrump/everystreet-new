const TAB_STORAGE_KEY = "coverage-route-planner-active-tab";

function initBottomNavInsets({ signal, onCleanup }) {
  const root = document.querySelector(".coverage-route-planner");
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
  window.visualViewport?.addEventListener("resize", schedule, {
    passive: true,
    signal,
  });
  window.visualViewport?.addEventListener("scroll", schedule, {
    passive: true,
    signal,
  });

  const observer = new MutationObserver(schedule);
  observer.observe(bottomNav, {
    attributes: true,
    attributeFilter: ["class", "style"],
  });

  onCleanup(() => {
    observer.disconnect();
    if (rafId != null) {
      cancelAnimationFrame(rafId);
      rafId = null;
    }
  });
}

function initCollapsibleSections({ signal }) {
  const headers = document.querySelectorAll(".widget-header.collapsible");
  const eventOptions = signal ? { signal } : false;

  headers.forEach((header) => {
    const toggleId = header.dataset.toggle;
    const content = document.getElementById(toggleId);
    const collapseBtn = header.querySelector(".btn-collapse");
    if (!content || !collapseBtn) {
      return;
    }

    const saved = localStorage.getItem(`coverage-route-planner-${toggleId}`);
    if (saved === "collapsed") {
      content.classList.add("is-collapsed");
      collapseBtn.setAttribute("aria-expanded", "false");
    }

    const toggleHandler = (event) => {
      const isFormControl = event.target.closest(".form-switch, .form-check-input");
      const inHeaderActions = event.target.closest(".header-actions");
      const isCollapseButton = event.target.closest(".btn-collapse");
      if (isFormControl || (inHeaderActions && !isCollapseButton)) {
        return;
      }

      const isNowCollapsed = !content.classList.contains("is-collapsed");
      if (isNowCollapsed) {
        content.classList.add("is-collapsed");
        collapseBtn.setAttribute("aria-expanded", "false");
        localStorage.setItem(`coverage-route-planner-${toggleId}`, "collapsed");
      } else {
        content.classList.remove("is-collapsed");
        collapseBtn.setAttribute("aria-expanded", "true");
        localStorage.setItem(`coverage-route-planner-${toggleId}`, "expanded");
      }
    };

    header.addEventListener("click", toggleHandler, eventOptions);
  });
}

function initMobilePanelToggle({ signal }) {
  const toggle = document.getElementById("mobile-panel-toggle");
  const panel = document.getElementById("control-panel");
  const eventOptions = signal ? { signal } : false;
  if (!toggle || !panel) {
    return;
  }

  const storageKey = "coverage-route-planner-mobile-panel";
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
  mapContainer?.addEventListener(
    "click",
    (event) => {
      if (window.innerWidth < 1024) {
        const isExpanded = toggle.getAttribute("aria-expanded") === "true";
        if (isExpanded && !event.target.closest(".map-legend")) {
          panel.classList.add("is-hidden");
          toggle.setAttribute("aria-expanded", "false");
          localStorage.setItem(storageKey, "hidden");
        }
      }
    },
    eventOptions
  );
}

function initLayerControls({ signal }) {
  const layerItems = document.querySelectorAll(".layer-item");
  const eventOptions = signal ? { signal } : false;
  layerItems.forEach((item) => {
    const range = item.querySelector('input[type="range"]');
    const valueDisplay = item.querySelector(".opacity-value");
    if (!range || !valueDisplay) {
      return;
    }
    range.addEventListener(
      "input",
      (event) => {
        valueDisplay.textContent = `${event.target.value}%`;
      },
      eventOptions
    );
  });
}

function initSmoothScroll() {
  const panel = document.querySelector(".control-panel");
  if (panel) {
    panel.style.scrollBehavior = "smooth";
  }
}

function handleResponsiveLayout({ signal }) {
  const panel = document.getElementById("control-panel");
  const toggle = document.getElementById("mobile-panel-toggle");
  if (!panel || !toggle) {
    return;
  }

  const mediaQuery = window.matchMedia("(min-width: 1024px)");
  const handleChange = (event) => {
    if (event.matches) {
      panel.classList.remove("is-hidden");
      panel.style.transform = "";
      return;
    }
    const isExpanded = toggle.getAttribute("aria-expanded") === "true";
    if (!isExpanded) {
      panel.classList.add("is-hidden");
    }
  };

  mediaQuery.addEventListener("change", handleChange, signal ? { signal } : false);
  handleChange(mediaQuery);
}

function initKeyboardShortcuts({ signal }) {
  document.addEventListener(
    "keydown",
    (event) => {
      const { target } = event;
      if (target instanceof Element && target.matches("input, select, textarea")) {
        return;
      }
      if (event.key !== "Escape") {
        return;
      }
      const toggle = document.getElementById("mobile-panel-toggle");
      const panel = document.getElementById("control-panel");
      if (!toggle || !panel || window.innerWidth >= 1024) {
        return;
      }
      const isExpanded = toggle.getAttribute("aria-expanded") === "true";
      if (isExpanded) {
        panel.classList.add("is-hidden");
        toggle.setAttribute("aria-expanded", "false");
      } else {
        panel.classList.remove("is-hidden");
        toggle.setAttribute("aria-expanded", "true");
      }
    },
    signal ? { signal } : false
  );
}

function enhanceAccessibility() {
  const statusMessage = document.getElementById("status-message");
  if (statusMessage) {
    statusMessage.setAttribute("aria-live", "polite");
    statusMessage.setAttribute("aria-atomic", "true");
  }

  document.querySelectorAll(".btn-action, .btn-generate").forEach((btn) => {
    if (!btn.hasAttribute("tabindex")) {
      btn.setAttribute("tabindex", "0");
    }
  });
}

function updateModeIndicator() {
  const root = document.querySelector(".coverage-route-planner");
  const activeTab = document.querySelector(".sidebar-tab.active");
  if (!root || !activeTab) {
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

function initTabNavigation({ signal }) {
  const tabs = document.querySelectorAll(".sidebar-tab");
  if (!tabs.length) {
    return;
  }
  const eventOptions = signal ? { signal } : false;
  tabs.forEach((tab) => {
    tab.addEventListener("click", () => switchTab(tab.dataset.tab), eventOptions);
  });

  const saved = localStorage.getItem(TAB_STORAGE_KEY);
  if (saved && document.querySelector(`.sidebar-tab[data-tab="${saved}"]`)) {
    switchTab(saved);
  }
}

function initAutoTabSwitch({ signal, onCleanup }) {
  const progressSection = document.getElementById("progress-section");
  const routeProgressContainer = document.getElementById("route-progress-container");
  const resultsSection = document.getElementById("results-section");
  const errorSection = document.getElementById("error-section");
  const observers = [];

  const isVisible = (el) => {
    if (!el) {
      return false;
    }
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
    const emptyState = document.getElementById("status-empty-state");
    if (emptyState) {
      emptyState.style.display = hasActivity ? "none" : "";
    }
  };

  const checkResultsActivity = () => {
    const hasResults = isVisible(resultsSection);
    const emptyState = document.getElementById("results-empty-state");
    if (emptyState) {
      emptyState.style.display = hasResults ? "none" : "";
    }
  };

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

  const onResultsVisible = () => {
    if (isVisible(resultsSection)) {
      switchTab("results");
    }
    checkResultsActivity();
  };

  [
    { el: progressSection, cb: onStatusVisible },
    { el: routeProgressContainer, cb: onStatusVisible },
    { el: errorSection, cb: onStatusVisible },
    { el: resultsSection, cb: onResultsVisible },
  ].forEach(({ el, cb }) => {
    if (!el) {
      return;
    }
    const observer = new MutationObserver(cb);
    observer.observe(el, { attributes: true, attributeFilter: ["style", "class"] });
    observers.push(observer);
  });

  onCleanup(() => {
    observers.forEach((observer) => observer.disconnect());
  });

  signal?.addEventListener(
    "abort",
    () => {
      observers.forEach((observer) => observer.disconnect());
    },
    { once: true }
  );

  checkStatusActivity();
  checkResultsActivity();
}

function initTemplateActions({ signal }) {
  const algoInfoBtn = document.getElementById("algo-explainer-toggle");
  const backToPlanBtns = document.querySelectorAll('[data-action="go-to-plan-tab"]');

  algoInfoBtn?.addEventListener(
    "click",
    () => {
      const el = document.getElementById("algo-explainer");
      if (!el) {
        return;
      }
      const expanded = algoInfoBtn.getAttribute("aria-expanded") === "true";
      el.hidden = expanded;
      algoInfoBtn.setAttribute("aria-expanded", String(!expanded));
      const textEl = algoInfoBtn.querySelector(".btn-algo-info-text");
      if (textEl) {
        textEl.textContent = expanded ? "How does this work?" : "Hide explanation";
      }
    },
    signal ? { signal } : false
  );

  backToPlanBtns.forEach((btn) => {
    btn.addEventListener(
      "click",
      () => {
        switchTab("plan");
      },
      signal ? { signal } : false
    );
  });
}

export function initCoverageNavigatorUi(context = {}) {
  const { signal = null, onCleanup = () => {} } = context;

  initBottomNavInsets({ signal, onCleanup });
  initCollapsibleSections({ signal });
  initMobilePanelToggle({ signal });
  initLayerControls({ signal });
  initSmoothScroll();
  handleResponsiveLayout({ signal });
  initKeyboardShortcuts({ signal });
  enhanceAccessibility();
  initTabNavigation({ signal });
  initAutoTabSwitch({ signal, onCleanup });
  initTemplateActions({ signal });
  updateModeIndicator();
}

export default initCoverageNavigatorUi;
