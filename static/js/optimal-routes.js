import { OptimalRoutesManager } from "./modules/optimal-route/manager.js";
import { onPageLoad } from "./modules/utils.js";

// Initialize on page load
onPageLoad(
  () => {
    window.optimalRoutesManager = new OptimalRoutesManager();
  },
  { route: "/optimal-routes" },
);
