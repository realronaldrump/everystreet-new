import { OptimalRoutesManager } from "./modules/optimal-route/manager.js";
import { onPageLoad } from "./modules/utils.js";

// Initialize on page load
onPageLoad(
  ({ cleanup } = {}) => {
    let optimalRoutesManager = new OptimalRoutesManager();
    if (typeof cleanup === "function") {
      cleanup(() => {
        optimalRoutesManager?.destroy?.();
        optimalRoutesManager = null;
      });
    }
  },
  { route: "/coverage-navigator" }
);
