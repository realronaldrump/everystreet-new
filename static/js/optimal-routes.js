import { OptimalRoutesManager } from "./modules/optimal-route/manager.js";
import { onPageLoad } from "./modules/utils.js";

// Initialize on page load
onPageLoad(
  ({ cleanup } = {}) => {
    window.optimalRoutesManager = new OptimalRoutesManager();
    if (typeof cleanup === "function") {
      cleanup(() => {
        window.optimalRoutesManager?.destroy?.();
        window.optimalRoutesManager = null;
      });
    }
  },
  { route: "/coverage-navigator" }
);
