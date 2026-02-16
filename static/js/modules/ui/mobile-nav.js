import { swupReady } from "../core/navigation.js";

const mobileNav = {
  initialized: false,

  init() {
    if (typeof document === "undefined" || typeof window === "undefined") {
      return;
    }

    this.nav = document.getElementById("bottom-nav");
    if (!this.nav) {
      return;
    }

    if (this.initialized) {
      this.updateActive();
      return;
    }
    this.initialized = true;

    this.lastScrollY = window.scrollY || 0;
    this.hideThreshold = 12;

    const moreBtn = document.getElementById("bottom-nav-more");
    if (moreBtn) {
      this.moreBtnHandler = () => {
        document.getElementById("menu-toggle")?.click();
      };
      moreBtn.addEventListener("click", this.moreBtnHandler);
    }

    this.updateActive();
    this.bindScroll();

    swupReady
      .then((swup) => {
        swup.hooks.on("page:view", () => this.updateActive());
      })
      .catch(() => {});
  },

  updateActive() {
    if (!this.nav?.isConnected) {
      this.nav = document.getElementById("bottom-nav");
    }
    if (!this.nav) {
      return;
    }

    const path = window.location.pathname;
    this.nav.querySelectorAll(".bottom-nav-item").forEach((item) => {
      if (item.tagName !== "A") {
        item.classList.remove("active");
        return;
      }
      const url = new URL(item.href, window.location.origin);
      const isActive = url.pathname === path;
      item.classList.toggle("active", isActive);
    });
  },

  bindScroll() {
    if (this.scrollHandler) {
      return;
    }

    this.scrollHandler = () => {
      if (!this.nav?.isConnected) {
        this.nav = document.getElementById("bottom-nav");
      }
      if (!this.nav) {
        return;
      }

      const current = window.scrollY || 0;
      const delta = current - this.lastScrollY;
      if (Math.abs(delta) < this.hideThreshold) {
        return;
      }
      if (delta > 0 && current > 120) {
        this.nav.classList.add("hidden");
      } else {
        this.nav.classList.remove("hidden");
      }
      this.lastScrollY = current;
    };

    window.addEventListener(
      "scroll",
      this.scrollHandler,
      { passive: true }
    );
  },
};

export default mobileNav;
