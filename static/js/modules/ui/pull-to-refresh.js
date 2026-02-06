import { swupReady } from "../core/navigation.js";

const pullToRefresh = {
  init() {
    this.indicator = null;
    this.startY = 0;
    this.pullDistance = 0;
    this.isPulling = false;
    this.threshold = 80;
    this.maxPull = 140;

    document.addEventListener("touchstart", (event) => this.onStart(event), {
      passive: true,
    });
    document.addEventListener("touchmove", (event) => this.onMove(event), {
      passive: false,
    });
    document.addEventListener("touchend", () => this.onEnd(), { passive: true });
    swupReady
      .then((swup) => {
        swup.hooks.on("page:view", () => this.reset());
      })
      .catch(() => {});
  },

  isEnabled() {
    const isMobile = window.matchMedia("(max-width: 768px)").matches;
    const isMap = document.body.dataset.route === "/map";
    return isMobile && !isMap;
  },

  createIndicator() {
    let indicator = document.getElementById("pull-to-refresh");
    if (indicator) {
      return indicator;
    }
    indicator = document.createElement("div");
    indicator.id = "pull-to-refresh";
    indicator.className = "pull-to-refresh";
    indicator.innerHTML = `
      <div class="pull-to-refresh-spinner"></div>
      <span class="pull-to-refresh-text">Pull to refresh</span>
    `;
    document.body.appendChild(indicator);
    return indicator;
  },

  onStart(event) {
    if (!this.isEnabled()) {
      return;
    }
    if (!event.touches || event.touches.length !== 1) {
      return;
    }
    if (window.scrollY > 0) {
      return;
    }
    if (event.target.closest("[data-no-pull]")) {
      return;
    }
    this.indicator = this.indicator || this.createIndicator();
    this.startY = event.touches[0].clientY;
    this.isPulling = true;
  },

  onMove(event) {
    if (!this.isPulling || !event.touches || !this.indicator) {
      return;
    }
    const delta = event.touches[0].clientY - this.startY;
    if (delta <= 0) {
      return;
    }
    event.preventDefault();
    this.pullDistance = Math.min(delta, this.maxPull);
    const progress = Math.min(this.pullDistance / this.threshold, 1);
    this.indicator.style.setProperty("--pull-progress", progress.toString());
    this.indicator.classList.add("active");
    const text = this.indicator.querySelector(".pull-to-refresh-text");
    if (text) {
      text.textContent = progress >= 1 ? "Release to refresh" : "Pull to refresh";
    }
  },

  onEnd() {
    if (!this.isPulling || !this.indicator) {
      return;
    }
    const shouldRefresh = this.pullDistance >= this.threshold;
    this.isPulling = false;

    if (shouldRefresh) {
      this.indicator.classList.add("loading");
      this.indicator.querySelector(".pull-to-refresh-text").textContent
        = "Refreshing...";
      swupReady
        .then((swup) => {
          swup.navigate(window.location.href, {
            cache: { read: false, write: true },
            history: "replace",
          });
        })
        .catch(() => {
          window.location.reload();
        });
    } else {
      this.reset();
    }
  },

  reset() {
    this.pullDistance = 0;
    if (this.indicator) {
      this.indicator.classList.remove("active", "loading");
      this.indicator.style.removeProperty("--pull-progress");
      const text = this.indicator.querySelector(".pull-to-refresh-text");
      if (text) {
        text.textContent = "Pull to refresh";
      }
    }
  },
};

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", () => pullToRefresh.init());
} else {
  pullToRefresh.init();
}

export default pullToRefresh;
