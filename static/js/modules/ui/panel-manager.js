import { UI_CONFIG as CONFIG } from "../config.js";
import { uiState } from "../ui-state.js";
import utils from "../utils.js";
import eventManager from "./event-manager.js";

const panelManager = {
  transitionDuration: CONFIG.transitions.normal,

  async close(type) {
    const panelMap = {
      mobile: CONFIG.selectors.mobileDrawer,
      filters: CONFIG.selectors.filtersPanel,
    };
    const panel = uiState.getElement(panelMap[type]);
    const overlay = uiState.getElement(CONFIG.selectors.contentOverlay);
    if (!panel || !panel.classList.contains(CONFIG.classes.open)) return;
    panel.style.transition = `transform ${this.transitionDuration}ms ease-in-out`;
    panel.classList.remove(CONFIG.classes.open);
    if (overlay) await utils.fadeOut(overlay, this.transitionDuration);
    if (type === "mobile") {
      document.body.style.overflow = "";
      document.body.style.paddingRight = "";
    }
    if (type === "filters") {
      uiState.uiState.filtersOpen = false;
      uiState.saveUIState();
    }
    setTimeout(() => {
      panel.style.transition = "";
    }, this.transitionDuration);
  },

  async open(type) {
    const panelMap = {
      mobile: CONFIG.selectors.mobileDrawer,
      filters: CONFIG.selectors.filtersPanel,
    };
    const panel = uiState.getElement(panelMap[type]);
    const overlay = uiState.getElement(CONFIG.selectors.contentOverlay);
    if (!panel || panel.classList.contains(CONFIG.classes.open)) return;
    panel.style.transition = `transform ${this.transitionDuration}ms ease-in-out`;
    if (type === "mobile") {
      const scrollbarW = utils.measureScrollbarWidth();
      document.body.style.overflow = "hidden";
      if (scrollbarW > 0) document.body.style.paddingRight = `${scrollbarW}px`;
    }
    if (overlay) {
      overlay.style.display = "block";
      await utils.fadeIn(overlay, this.transitionDuration / 2);
    }
    panel.classList.add(CONFIG.classes.open);
    if (type === "filters") {
      uiState.uiState.filtersOpen = true;
      uiState.saveUIState();
      setTimeout(() => {
        const firstInput = panel.querySelector("input, select, button");
        if (firstInput) firstInput.focus();
      }, this.transitionDuration);
    }
  },

  toggle(type) {
    const panelMap = {
      filters: CONFIG.selectors.filtersPanel,
      mobile: CONFIG.selectors.mobileDrawer,
    };
    const panel = uiState.getElement(panelMap[type]);
    panel?.classList.contains(CONFIG.classes.open)
      ? this.close(type)
      : this.open(type);
  },

  init() {
    const mobileDrawer = uiState.getElement(CONFIG.selectors.mobileDrawer);
    if (mobileDrawer && "ontouchstart" in window)
      this.initSwipeGestures(mobileDrawer, "mobile");

    // Initialize collapsible drawer nav sections
    this.initDrawerSections();

    eventManager.add(CONFIG.selectors.menuToggle, "click", (e) => {
      e.stopPropagation();
      this.open("mobile");
    });
    eventManager.add(CONFIG.selectors.closeBtn, "click", () =>
      this.close("mobile"),
    );
    eventManager.add(CONFIG.selectors.contentOverlay, "click", () => {
      this.close("mobile");
      this.close("filters");
    });
    eventManager.add(CONFIG.selectors.filterToggle, "click", (e) => {
      e.stopPropagation();
      this.toggle("filters");
    });
    eventManager.add(CONFIG.selectors.filtersClose, "click", () =>
      this.close("filters"),
    );

    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape" && !e.defaultPrevented) {
        this.close("mobile");
        this.close("filters");
      }
    });

    if (uiState.uiState.filtersOpen)
      setTimeout(() => this.open("filters"), 100);
  },

  initDrawerSections() {
    const headers = document.querySelectorAll(".drawer-nav-section-header");
    headers.forEach((header) => {
      header.addEventListener("click", () => {
        const expanded = header.getAttribute("aria-expanded") === "true";
        const listId = header.getAttribute("aria-controls");
        const list = document.getElementById(listId);

        if (list) {
          header.setAttribute("aria-expanded", !expanded);
          list.classList.toggle("collapsed", expanded);
        }
      });
    });
  },

  initSwipeGestures(element, type) {
    let startX = 0;
    let currentX = 0;
    let isDragging = false;
    const onStart = (e) => {
      startX = e.touches[0].clientX;
      currentX = startX;
      isDragging = true;
      element.style.transition = "none";
    };
    const onMove = (e) => {
      if (!isDragging) return;
      currentX = e.touches[0].clientX;
      const diff = currentX - startX;
      if (type === "mobile" && diff < 0) {
        const tx = Math.max(diff, -element.offsetWidth);
        element.style.transform = `translateX(${tx}px)`;
      }
    };
    const onEnd = () => {
      if (!isDragging) return;
      isDragging = false;
      element.style.transition = "";
      element.style.transform = "";
      const diff = currentX - startX;
      if (Math.abs(diff) > element.offsetWidth * 0.3) this.close(type);
    };
    element.addEventListener("touchstart", onStart, { passive: true });
    element.addEventListener("touchmove", onMove, { passive: true });
    element.addEventListener("touchend", onEnd, { passive: true });
  },
};

export default panelManager;
