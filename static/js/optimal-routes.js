import { OptimalRoutesManager } from "./modules/optimal-route/manager.js";

// Initialize on DOM ready
document.addEventListener("DOMContentLoaded", () => {
  window.optimalRoutesManager = new OptimalRoutesManager();
});
