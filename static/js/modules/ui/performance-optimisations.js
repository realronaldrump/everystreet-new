import utils from "../ui-utils.js";

const perfOptim = {
  init() {
    // Pause CSS animations/transitions when the tab is not visible to save CPU
    document.addEventListener("visibilitychange", () => {
      const root = document.documentElement;
      if (document.hidden) {
        root.style.setProperty("--transition-duration", "0ms");
      } else {
        root.style.removeProperty("--transition-duration");
      }
    });

    // Throttle window resize events
    let last = 0;
    window.addEventListener("resize", () => {
      const now = Date.now();
      if (now - last < 300) return;
      last = now;
      utils.debounceFn?.(() => {
        const evt = new Event("appResized");
        window.dispatchEvent(evt);
      }, 50)();
    });
  },
};

if (!window.performanceOptimisations) window.performanceOptimisations = perfOptim;
export { perfOptim as default };
