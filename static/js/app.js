import AppController from "./modules/app-controller.js";
import { initNavigation } from "./modules/core/navigation.js";
import store from "./modules/core/store.js";
import "./modules/ui/ui-init.js";
import "./modules/ui/loading-manager.js";
import "./modules/ui/notifications.js";
import "./modules/ui/confirmation-dialog.js";
import "./modules/ui/global-job-tracker.js";

const start = async () => {
  store.init(window.location.href);
  await initNavigation();
  await AppController.initialize();
};

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", start);
} else {
  start();
}
