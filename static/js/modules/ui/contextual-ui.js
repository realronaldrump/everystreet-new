import { swupReady } from "../core/navigation.js";

const COVERAGE_SELECTORS = [
  "[data-coverage-percent]",
  "#dashboard-coverage-percentage",
  "#coverage-percent",
  "#area-coverage",
  "#nav-coverage-progress-value",
  "#preview-coverage",
];

const contextualUI = {
  coverageTone: null,
  timeTone: null,
  observers: new Map(),
  initialized: false,
  _styleCache: null,
  _styleCacheTime: 0,

  init() {
    if (this.initialized) {
      return;
    }
    this.applyTimeTone();
    this.observeCoverage();
    document.addEventListener("contextual:refresh", () => this.applyAccentTone());
    swupReady
      .then((swup) => {
        swup.hooks.on("page:view", () => {
          this.applyTimeTone();
          this.observeCoverage();
        });
      })
      .catch(() => {});
    this.initialized = true;
  },

  applyTimeTone() {
    const hour = new Date().getHours();
    let tone = "day";
    if (hour < 6) {
      tone = "night";
    } else if (hour < 10) {
      tone = "morning";
    } else if (hour < 17) {
      tone = "day";
    } else if (hour < 20) {
      tone = "evening";
    } else {
      tone = "night";
    }
    this.timeTone = tone;
    this._styleCache = null;
    document.body?.setAttribute("data-time-of-day", tone);
    this.applyAccentTone();
  },

  observeCoverage() {
    const elements = COVERAGE_SELECTORS.flatMap((selector) =>
      Array.from(document.querySelectorAll(selector))
    );

    if (elements.length === 0 && this.coverageTone) {
      this.coverageTone = null;
      this.applyAccentTone();
    }

    elements.forEach((element) => {
      if (this.observers.has(element)) {
        return;
      }
      let debounceTimer = null;
      const observer = new MutationObserver(() => {
        if (debounceTimer) {
          return;
        }
        debounceTimer = setTimeout(() => {
          debounceTimer = null;
          const percent = this.parsePercent(element.textContent || "");
          if (Number.isFinite(percent)) {
            this.setCoverageTone(percent);
          }
        }, 300);
      });
      observer.observe(element, {
        childList: true,
        characterData: true,
        subtree: true,
      });
      this.observers.set(element, observer);

      const initial = this.parsePercent(element.textContent || "");
      if (Number.isFinite(initial)) {
        this.setCoverageTone(initial);
      }
    });
  },

  setCoverageTone(percent) {
    if (!Number.isFinite(percent)) {
      return;
    }
    let tone = "balanced";
    if (percent >= 75) {
      tone = "warm";
    } else if (percent <= 35) {
      tone = "cool";
    }
    this.coverageTone = tone;
    document.body?.setAttribute("data-coverage-tone", tone);
    this.applyAccentTone();
  },

  applyAccentTone() {
    const root = document.documentElement;
    const tone = this.coverageTone || this.toneFromTime();
    const rgb = this.getToneRgb(tone);
    if (rgb) {
      root.style.setProperty("--section-accent-rgb", rgb);
      root.style.setProperty("--section-accent", `rgb(${rgb})`);
      root.style.setProperty("--ambient-tint", this.formatAmbient(rgb, this.timeTone));
    }
  },

  toneFromTime() {
    if (this.timeTone === "morning") {
      return "warm";
    }
    if (this.timeTone === "evening" || this.timeTone === "night") {
      return "cool";
    }
    return "balanced";
  },

  getToneRgb(tone) {
    const now = Date.now();
    if (!this._styleCache || now - this._styleCacheTime > 5000) {
      this._styleCache = getComputedStyle(document.documentElement);
      this._styleCacheTime = now;
    }
    const style = this._styleCache;
    if (tone === "warm") {
      return style.getPropertyValue("--warning-rgb").trim();
    }
    if (tone === "cool") {
      return style.getPropertyValue("--info-rgb").trim();
    }
    return style.getPropertyValue("--accent-rgb").trim();
  },

  formatAmbient(rgb, timeTone) {
    const alpha = timeTone === "night" ? 12 : timeTone === "evening" ? 10 : 8;
    return `rgb(${rgb} / ${alpha}%)`;
  },

  parsePercent(value) {
    if (!value) {
      return Number.NaN;
    }
    const normalized = value.toString().replace(/[^0-9.]/g, "");
    return Number.parseFloat(normalized);
  },
};

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", () => contextualUI.init());
} else {
  contextualUI.init();
}

export default contextualUI;
