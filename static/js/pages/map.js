import AppController from "../modules/app-controller.js";
import bootstrapPage from "../modules/core/page-bootstrap.js";
import store from "../modules/core/store.js";
import initMapPage from "../modules/features/map/index.js";

bootstrapPage(async (context = {}) => {
  if (!store.mapInitialized || !store.map) {
    await AppController.initialize();
  }
  if (context.signal?.aborted) {
    return;
  }
  initMapPage(context);
}, "/map");
