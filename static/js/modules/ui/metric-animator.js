import { swupReady } from "../core/navigation.js";

const MetricAnimator = {
  initialized: false,

  init() {
    if (this.initialized) {
      return;
    }

    this.animateAll();
    swupReady
      .then((swup) => {
        swup.hooks.on("page:view", () => this.animateAll());
      })
      .catch(() => {});
    this.initialized = true;
  },

  animate(element, endValue, options = {}) {
    if (!element) {
      return;
    }

    const numericValue = Number(endValue) || 0;
    const decimals = Number.isFinite(options.decimals) ? options.decimals : 0;
    const duration = Number.isFinite(options.duration) ? options.duration : 1.8;
    const suffix = typeof options.suffix === "string" ? options.suffix : "";
    const useGrouping = options.grouping !== false;
    const currentText = element.textContent.trim();
    const formatter = new Intl.NumberFormat(undefined, {
      minimumFractionDigits: decimals,
      maximumFractionDigits: decimals,
      useGrouping,
    });
    const finalText = `${formatter.format(numericValue)}${suffix}`;

    const startValue = Number(currentText.replace(/[^0-9.-]/g, "")) || 0;
    if (startValue === numericValue) {
      if (currentText !== finalText) {
        element.textContent = finalText;
      }
      return;
    }
    const startTime = performance.now();
    const targetDuration = duration * 1000;

    const step = (now) => {
      const elapsed = Math.min((now - startTime) / targetDuration, 1);
      const eased = elapsed === 1 ? 1 : 1 - 2 ** (-10 * elapsed);
      const current = startValue + (numericValue - startValue) * eased;
      element.textContent = elapsed === 1 ? finalText : `${formatter.format(current)}${suffix}`;
      if (elapsed < 1) {
        requestAnimationFrame(step);
      }
    };

    requestAnimationFrame(step);
  },

  animateById(elementId, endValue, options = {}) {
    const element = document.getElementById(elementId);
    this.animate(element, endValue, options);
  },

  animateAll() {
    document.querySelectorAll("[data-countup]").forEach((element) => {
      const rawValue = element.dataset.countupValue ?? element.textContent;
      const decimals = Number(element.dataset.countupDecimals || 0);
      const suffix = element.dataset.countupSuffix || "";
      this.animate(element, Number(rawValue) || 0, { decimals, suffix });
    });
  },
};

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", () => MetricAnimator.init());
} else {
  MetricAnimator.init();
}

export default MetricAnimator;
