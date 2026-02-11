import { swupReady } from "../core/navigation.js";

const MetricAnimator = {
  counters: new Map(),
  initialized: false,

  init() {
    if (this.initialized) {
      return;
    }

    if (typeof window !== "undefined") {
      window.CountUp = window.CountUp || window.countUp?.CountUp;
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
    const duration = Number.isFinite(options.duration) ? options.duration : 1.4;
    const suffix = typeof options.suffix === "string" ? options.suffix : "";

    const elementId = element.id || element.dataset.metricId;
    const hasCountUp = typeof window !== "undefined" && window.CountUp;

    if (hasCountUp) {
      const CountUpConstructor = window.CountUp;
      const existing = elementId ? this.counters.get(elementId) : null;
      const counter =
        existing ||
        new CountUpConstructor(element, 0, numericValue, decimals, duration, {
          useEasing: true,
          useGrouping: true,
          separator: ",",
          decimal: ".",
          suffix,
        });

      if (!counter.error) {
        if (!existing && elementId) {
          this.counters.set(elementId, counter);
        }
        counter.update(numericValue);
      } else {
        element.textContent = `${numericValue.toFixed(decimals)}${suffix}`;
      }
      return;
    }

    const startValue = Number(element.textContent.replace(/[^0-9.-]/g, "")) || 0;
    const startTime = performance.now();
    const targetDuration = duration * 1000;

    const step = (now) => {
      const elapsed = Math.min((now - startTime) / targetDuration, 1);
      const eased = 1 - (1 - elapsed) ** 3;
      const current = startValue + (numericValue - startValue) * eased;
      element.textContent = `${current.toFixed(decimals)}${suffix}`;
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
