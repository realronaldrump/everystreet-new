import { CONFIG } from "../core/config.js";
import store from "../core/store.js";
import { swupReady } from "../core/navigation.js";
import { utils } from "../utils.js";
import eventManager from "./event-manager.js";

const panelManager = {
  transitionDuration: CONFIG.UI.transitions.normal,

  async close(type) {
    if (type !== "mobile") {
      return;
    }
    const panel = store.getElement(CONFIG.UI.selectors.mobileDrawer);
    const overlay = store.getElement(CONFIG.UI.selectors.contentOverlay);
    if (!panel || !panel.classList.contains(CONFIG.UI.classes.open)) {
      return;
    }
    panel.style.transition = `transform ${this.transitionDuration}ms ease-in-out`;
    panel.classList.remove(CONFIG.UI.classes.open);
    if (overlay) {
      await utils.fadeOut(overlay, this.transitionDuration);
    }
    document.body.style.overflow = "";
    document.body.style.paddingRight = "";
    setTimeout(() => {
      panel.style.transition = "";
    }, this.transitionDuration);
  },

  async open(type) {
    if (type !== "mobile") {
      return;
    }
    const panel = store.getElement(CONFIG.UI.selectors.mobileDrawer);
    const overlay = store.getElement(CONFIG.UI.selectors.contentOverlay);
    if (!panel || panel.classList.contains(CONFIG.UI.classes.open)) {
      return;
    }
    panel.style.transition = `transform ${this.transitionDuration}ms ease-in-out`;
    const scrollbarW = utils.measureScrollbarWidth();
    document.body.style.overflow = "hidden";
    if (scrollbarW > 0) {
      document.body.style.paddingRight = `${scrollbarW}px`;
    }
    if (overlay) {
      overlay.style.display = "block";
      await utils.fadeIn(overlay, this.transitionDuration / 2);
    }
    panel.classList.add(CONFIG.UI.classes.open);
  },

  toggle(type) {
    if (type !== "mobile") {
      return;
    }
    const panel = store.getElement(CONFIG.UI.selectors.mobileDrawer);
    panel?.classList.contains(CONFIG.UI.classes.open)
      ? this.close(type)
      : this.open(type);
  },

  init() {
    const mobileDrawer = store.getElement(CONFIG.UI.selectors.mobileDrawer);
    if (mobileDrawer && "ontouchstart" in window) {
      this.initSwipeGestures(mobileDrawer, "mobile");
    }

    // Initialize collapsible drawer nav sections
    this.initDrawerSections();

    eventManager.add(CONFIG.UI.selectors.menuToggle, "click", (e) => {
      e.stopPropagation();
      this.open("mobile");
    });
    eventManager.add(CONFIG.UI.selectors.closeBtn, "click", () => this.close("mobile"));
    eventManager.add(CONFIG.UI.selectors.contentOverlay, "click", () => {
      this.close("mobile");
    });

    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape" && !e.defaultPrevented) {
        this.close("mobile");
      }
    });

    if (mobileDrawer) {
      mobileDrawer.addEventListener("click", (event) => {
        const link = event.target.closest("a[href]");
        if (!link) {
          return;
        }
        const href = link.getAttribute("href") || "";
        if (!href || href.startsWith("#")) {
          return;
        }
        if (link.getAttribute("data-bs-toggle")) {
          return;
        }
        this.close("mobile");
      });
    }

    swupReady
      .then((swup) => {
        swup.hooks.on("page:view", () => this.close("mobile"));
      })
      .catch(() => {});
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
      if (!isDragging) {
        return;
      }
      currentX = e.touches[0].clientX;
      const diff = currentX - startX;
      if (type === "mobile" && diff < 0) {
        const tx = Math.max(diff, -element.offsetWidth);
        element.style.transform = `translateX(${tx}px)`;
      }
    };
    const onEnd = () => {
      if (!isDragging) {
        return;
      }
      isDragging = false;
      element.style.transition = "";
      element.style.transform = "";
      const diff = currentX - startX;
      if (Math.abs(diff) > element.offsetWidth * 0.3) {
        this.close(type);
      }
    };
    element.addEventListener("touchstart", onStart, { passive: true });
    element.addEventListener("touchmove", onMove, { passive: true });
    element.addEventListener("touchend", onEnd, { passive: true });
  },
};

export default panelManager;
