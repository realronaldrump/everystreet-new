import initCoverageNavigatorPage from "../modules/features/coverage-navigator/index.js";
import { onPageLoad } from "../modules/utils.js";

/**
 * Measure the mobile bottom nav (if present) so fixed UI on this page
 * (panel toggle, legend, Mapbox attribution) doesn't get covered.
 */
function initBottomNavInsets({ signal } = {}) {
  const root = document.querySelector(".coverage-navigator");
  if (!root) return;

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
    // Offset is nav height minus safe-area; CSS adds env(safe-area-inset-bottom) itself.
    root.style.setProperty("--bottom-nav-offset", `${Math.round(offset)}px`);
  };

  const schedule = () => {
    if (rafId != null) return;
    rafId = requestAnimationFrame(apply);
  };

  // Initial measure.
  schedule();

  window.addEventListener("resize", schedule, { passive: true, signal });
  if (window.visualViewport) {
    // Address bar show/hide can change the viewport without a full window resize.
    window.visualViewport.addEventListener("resize", schedule, { passive: true, signal });
    window.visualViewport.addEventListener("scroll", schedule, { passive: true, signal });
  }

  // React to nav show/hide transitions or class toggles.
  const observer = new MutationObserver(schedule);
  observer.observe(bottomNav, { attributes: true, attributeFilter: ["class", "style"] });
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
 * Sections that should start collapsed on mobile to reduce scroll depth.
 * Only applies if the user has no saved preference.
 */
const MOBILE_DEFAULT_COLLAPSED = new Set([
  "section-planner",
  "section-saved",
  "section-results",
]);

/**
 * Initialize collapsible sections in the control panel
 */
function initCollapsibleSections() {
  const headers = document.querySelectorAll(".widget-header.collapsible");
  const isMobile = window.innerWidth < 1024;

  headers.forEach((header) => {
    const toggleId = header.dataset.toggle;
    const content = document.getElementById(toggleId);
    const collapseBtn = header.querySelector(".btn-collapse");

    if (!content || !collapseBtn) return;

    // Initialize state from localStorage, or use mobile defaults
    const saved = localStorage.getItem(`coverage-navigator-${toggleId}`);
    const isCollapsed =
      saved === "collapsed" ||
      (saved === null && isMobile && MOBILE_DEFAULT_COLLAPSED.has(toggleId));

    if (isCollapsed) {
      content.classList.add("is-collapsed");
      collapseBtn.setAttribute("aria-expanded", "false");
    }

    // Click handler for both header and button
    const toggleHandler = (e) => {
      // Don't toggle if clicking on interactive elements (except collapse button)
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

    header.addEventListener("click", toggleHandler);
  });
}

/**
 * Initialize mobile panel toggle
 */
function initMobilePanelToggle() {
  const toggle = document.getElementById("mobile-panel-toggle");
  const panel = document.getElementById("control-panel");

  if (!toggle || !panel) return;

  const storageKey = "coverage-navigator-mobile-panel";

  // Restore last state on mobile to prioritize map visibility.
  if (window.innerWidth < 1024) {
    const saved = localStorage.getItem(storageKey);
    if (saved === "hidden") {
      panel.classList.add("is-hidden");
    } else if (saved === "visible") {
      panel.classList.remove("is-hidden");
    }
  }

  // Check initial state
  const isPanelVisible = !panel.classList.contains("is-hidden");
  toggle.setAttribute("aria-expanded", isPanelVisible.toString());

  toggle.addEventListener("click", () => {
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
  });

  // Auto-hide panel on mobile when clicking map
  const mapContainer = document.querySelector(".map-container");
  if (mapContainer) {
    mapContainer.addEventListener("click", (e) => {
      // Only on mobile
      if (window.innerWidth < 1024) {
        const isExpanded = toggle.getAttribute("aria-expanded") === "true";
        if (isExpanded && !e.target.closest(".map-legend")) {
          panel.classList.add("is-hidden");
          toggle.setAttribute("aria-expanded", "false");
          localStorage.setItem(storageKey, "hidden");
        }
      }
    });
  }
}

/**
 * Initialize layer opacity controls
 */
function initLayerControls() {
  const layerItems = document.querySelectorAll(".layer-item");

  layerItems.forEach((item) => {
    const range = item.querySelector('input[type="range"]');
    const valueDisplay = item.querySelector(".opacity-value");

    if (range && valueDisplay) {
      range.addEventListener("input", (e) => {
        valueDisplay.textContent = `${e.target.value}%`;
      });
    }
  });
}

/**
 * Initialize smooth scroll for control panel
 */
function initSmoothScroll() {
  const panel = document.querySelector(".control-panel");
  if (!panel) return;

  // Add smooth scroll behavior
  panel.style.scrollBehavior = "smooth";
}

/**
 * Handle responsive layout changes
 */
function handleResponsiveLayout() {
  const panel = document.getElementById("control-panel");
  const toggle = document.getElementById("mobile-panel-toggle");

  if (!panel || !toggle) return;

  const mediaQuery = window.matchMedia("(min-width: 1024px)");

  const handleChange = (e) => {
    if (e.matches) {
      // Desktop: Always show panel
      panel.classList.remove("is-hidden");
      panel.style.transform = "";
    } else {
      // Mobile: Check current state
      const isExpanded = toggle.getAttribute("aria-expanded") === "true";
      if (!isExpanded) {
        panel.classList.add("is-hidden");
      }
    }
  };

  mediaQuery.addEventListener("change", handleChange);
  handleChange(mediaQuery); // Initial check
}

/**
 * Initialize keyboard shortcuts
 */
function initKeyboardShortcuts() {
  document.addEventListener("keydown", (e) => {
    // Only handle shortcuts when not in input fields
    if (e.target.matches("input, select, textarea")) return;

    // ESC to toggle panel on mobile
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
  });
}

/**
 * Enhance accessibility attributes
 */
function enhanceAccessibility() {
  // Add aria-live regions for dynamic content
  const statusMessage = document.getElementById("status-message");
  if (statusMessage) {
    statusMessage.setAttribute("aria-live", "polite");
    statusMessage.setAttribute("aria-atomic", "true");
  }

  // Ensure all interactive elements have proper focus states
  const buttons = document.querySelectorAll(".btn-action, .btn-generate");
  buttons.forEach((btn) => {
    if (!btn.hasAttribute("tabindex")) {
      btn.setAttribute("tabindex", "0");
    }
  });
}

/**
 * Main initialization
 */
function initPage({ signal, cleanup } = {}) {
  initBottomNavInsets({ signal });

  // Initialize UI components
  initCollapsibleSections();
  initMobilePanelToggle();
  initLayerControls();
  initSmoothScroll();
  handleResponsiveLayout();
  initKeyboardShortcuts();
  enhanceAccessibility();

  // Initialize the main coverage navigator functionality
  initCoverageNavigatorPage({ cleanup });
}

// Initialize on page load
onPageLoad(initPage, { route: "/coverage-navigator" });
