import initCoverageNavigatorPage from "../modules/features/coverage-navigator/index.js";
import { onPageLoad } from "../modules/utils.js";

/**
 * Initialize collapsible sections in the control panel
 */
function initCollapsibleSections() {
  const headers = document.querySelectorAll(".widget-header.collapsible");

  headers.forEach((header) => {
    const toggleId = header.dataset.toggle;
    const content = document.getElementById(toggleId);
    const collapseBtn = header.querySelector(".btn-collapse");

    if (!content || !collapseBtn) return;

    // Initialize state from localStorage
    const isCollapsed =
      localStorage.getItem(`coverage-navigator-${toggleId}`) === "collapsed";
    if (isCollapsed) {
      content.classList.add("is-collapsed");
      collapseBtn.setAttribute("aria-expanded", "false");
    }

    // Click handler for both header and button
    const toggleHandler = (e) => {
      // Don't toggle if clicking on interactive elements
      if (e.target.closest(".form-switch, .form-check-input, .header-actions")) {
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

  // Check initial state
  const isPanelVisible = !panel.classList.contains("is-hidden");
  toggle.setAttribute("aria-expanded", isPanelVisible.toString());

  toggle.addEventListener("click", () => {
    const isExpanded = toggle.getAttribute("aria-expanded") === "true";

    if (isExpanded) {
      panel.classList.add("is-hidden");
      toggle.setAttribute("aria-expanded", "false");
    } else {
      panel.classList.remove("is-hidden");
      toggle.setAttribute("aria-expanded", "true");
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
function initPage() {
  // Initialize UI components
  initCollapsibleSections();
  initMobilePanelToggle();
  initLayerControls();
  initSmoothScroll();
  handleResponsiveLayout();
  initKeyboardShortcuts();
  enhanceAccessibility();

  // Initialize the main coverage navigator functionality
  initCoverageNavigatorPage({
    cleanup: (teardown) => {
      // Store teardown function for SPA navigation
      window.coverageNavigatorTeardown = teardown;
    },
  });
}

// Initialize on page load
onPageLoad(initPage, { route: "/coverage-navigator" });
