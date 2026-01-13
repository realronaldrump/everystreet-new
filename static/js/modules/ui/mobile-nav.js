const mobileNav = {
  init() {
    this.nav = document.getElementById("bottom-nav");
    if (!this.nav) {
      return;
    }
    this.lastScrollY = window.scrollY || 0;
    this.hideThreshold = 12;

    const moreBtn = document.getElementById("bottom-nav-more");
    if (moreBtn) {
      moreBtn.addEventListener("click", () => {
        document.getElementById("menu-toggle")?.click();
      });
    }

    this.updateActive();
    this.bindScroll();

    document.addEventListener("es:page-load", () => this.updateActive());
  },

  updateActive() {
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
    window.addEventListener(
      "scroll",
      () => {
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
      },
      { passive: true }
    );
  },
};

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", () => mobileNav.init());
} else {
  mobileNav.init();
}

export default mobileNav;
