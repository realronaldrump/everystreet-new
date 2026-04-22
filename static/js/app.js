import { initNavigation } from "./modules/core/navigation.js";
import { ensureRouteModule } from "./modules/core/route-loader.js";
import store from "./modules/core/store.js";
import "./modules/ui/ui-init.js";
import "./modules/ui/loading-manager.js";
import "./modules/ui/notifications.js";
import "./modules/ui/notification-bell.js";
import "./modules/ui/confirmation-dialog.js";
import "./modules/ui/global-job-tracker.js";
import "./modules/ui/scroll-reveal.js";
import "./modules/ui/smart-legend.js";

function markAppReady() {
  if (store.appReady) {
    return;
  }
  store.appReady = true;
  document.dispatchEvent(new CustomEvent("appReady"));
}

const start = async () => {
  store.init(window.location.href);
  try {
    await initNavigation();
  } catch (error) {
    console.warn("Navigation init failed; continuing without SPA transitions.", error);
    await ensureRouteModule(window.location.pathname);
  }
  markAppReady();
};

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", start);
} else {
  start();
}
