import AppController from "../modules/app-controller.js";
import store from "../modules/core/store.js";
import initMapPage from "../modules/features/map/index.js";
import { onPageLoad } from "../modules/utils.js";

onPageLoad(
  async ({ signal, cleanup } = {}) => {
    if (!store.mapInitialized || !store.map) {
      await AppController.initialize();
    }
    if (signal?.aborted) {
      return;
    }
    initMapPage({ signal, cleanup });
  },
  { route: "/map" }
);
