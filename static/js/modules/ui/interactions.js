import { utils } from "../utils.js";

const RIPPLE_SELECTOR =
  ".btn, .nav-tile, .action-button, .mobile-fab, .mobile-action-btn, [data-ripple]";

const VALUE_FLASH_SELECTOR =
  "[data-value-flash], .metric-value, .stat-value, .mobile-metric-value, .counter";

const interactions = {
  initialized: false,
  observers: new Map(),

  init() {
    if (this.initialized) {
      return;
    }

    this.bindRipples();
    this.applyStaggeredReveals();
    this.observeValueFlashes();

    document.addEventListener("es:page-load", () => {
      this.applyStaggeredReveals();
      this.observeValueFlashes();
    });

    this.initialized = true;
  },

  bindRipples() {
    const createRipple = (target, event) => {
      if (!target || target.disabled) {
        return;
      }
      if (target.classList.contains("no-ripple")) {
        return;
      }

      const rect = target.getBoundingClientRect();
      const size = Math.max(rect.width, rect.height);
      const ripple = document.createElement("span");
      ripple.className = "es-ripple";

      const x = event?.clientX ?? rect.left + rect.width / 2;
      const y = event?.clientY ?? rect.top + rect.height / 2;

      ripple.style.width = ripple.style.height = `${size}px`;
      ripple.style.left = `${x - rect.left - size / 2}px`;
      ripple.style.top = `${y - rect.top - size / 2}px`;

      target.classList.add("ripple-container");
      target.appendChild(ripple);
      setTimeout(() => ripple.remove(), 650);
    };

    document.addEventListener("pointerdown", (event) => {
      const target = event.target.closest(RIPPLE_SELECTOR);
      if (!target) {
        return;
      }
      createRipple(target, event);
    });

    document.addEventListener("keydown", (event) => {
      if (event.key !== "Enter" && event.key !== " ") {
        return;
      }
      const target = event.target.closest(RIPPLE_SELECTOR);
      if (!target) {
        return;
      }
      createRipple(target);
    });
  },

  applyStaggeredReveals() {
    const containers = document.querySelectorAll("[data-stagger]");
    containers.forEach((container) => {
      const items = Array.from(container.children).filter(
        (child) => child.nodeType === 1,
      );
      items.forEach((item, index) => {
        if (item.classList.contains("stagger-item")) {
          return;
        }
        item.classList.add("stagger-item");
        item.style.animationDelay = `${Math.min(index * 70, 400)}ms`;
      });
    });
  },

  observeValueFlashes() {
    document.querySelectorAll(VALUE_FLASH_SELECTOR).forEach((element) => {
      if (this.observers.has(element)) {
        return;
      }
      const observer = new MutationObserver(() => {
        element.classList.remove("value-flash");
        void element.offsetWidth;
        element.classList.add("value-flash");
      });
      observer.observe(element, {
        characterData: true,
        childList: true,
        subtree: true,
      });
      this.observers.set(element, observer);
    });
  },
};

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", () => interactions.init());
} else {
  interactions.init();
}

export default interactions;
