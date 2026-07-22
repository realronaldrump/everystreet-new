function initBottomNavInsets({ signal, onCleanup }) {
  const root = document.querySelector(".coverage-route-planner");
  if (!root) {
    return;
  }

  const bottomNav = document.getElementById("bottom-nav");
  if (!bottomNav) {
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
      root.style.setProperty("--bottom-nav-offset", "0px");
      return;
    }

    const navHeight = Math.round(bottomNav.getBoundingClientRect().height);
    const paddingTop = Number.parseFloat(styles.paddingTop) || 0;
    const paddingBottom = Number.parseFloat(styles.paddingBottom) || 0;
    const safeArea = Math.max(0, paddingBottom - paddingTop);
    const offset = Math.max(0, navHeight - safeArea);

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

    const storageKey = `coverage-route-planner-${toggleId}`;
    const saved = localStorage.getItem(storageKey);
    const isDefaultCollapsed = header.hasAttribute("data-default-collapsed");
    const isCollapsed = saved === "collapsed" || (saved === null && isDefaultCollapsed);
    content.classList.toggle("is-collapsed", isCollapsed);
    collapseBtn.setAttribute("aria-expanded", String(!isCollapsed));

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
        localStorage.setItem(storageKey, "collapsed");
      } else {
        content.classList.remove("is-collapsed");
        collapseBtn.setAttribute("aria-expanded", "true");
        localStorage.setItem(storageKey, "expanded");
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

function initTemplateActions({ signal }) {
  const algoInfoBtn = document.getElementById("algo-explainer-toggle");
  const generateBtn = document.getElementById("generate-route-btn");

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

  generateBtn?.addEventListener(
    "click",
    () => {
      requestAnimationFrame(() => {
        document.getElementById("route-progress-inline")?.scrollIntoView({
          behavior: "smooth",
          block: "nearest",
        });
      });
    },
    signal ? { signal } : false
  );
}

function initCoverageNavigatorUi(context = {}) {
  const { signal = null, onCleanup = () => {} } = context;

  initBottomNavInsets({ signal, onCleanup });
  initCollapsibleSections({ signal });
  initMobilePanelToggle({ signal });
  initLayerControls({ signal });
  initSmoothScroll();
  handleResponsiveLayout({ signal });
  initKeyboardShortcuts({ signal });
  enhanceAccessibility();
  initTemplateActions({ signal });
}

export default initCoverageNavigatorUi;
