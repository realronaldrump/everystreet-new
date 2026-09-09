import {
  initNavigation,
  navigate,
  swupReady,
} from "/static/js/modules/core/navigation.js";
import { ensureRouteModule } from "/static/js/modules/core/route-loader.js";
import store from "/static/js/modules/core/store.js";
import api from "/static/js/modules/core/api-client.js";

window.mounts = {};
window.unmounts = {};
window.count = 0;
window.AUTH_CONTEXT = { viewerMode: false };
window.ES_CDN = { mapboxGlJs: "/tests/browser/map.js" };
window.mapCreations = 0;
window.mapboxgl = {
  config: {},
  NavigationControl: class {},
  Map: class {
    constructor({ container }) {
      this.container = document.getElementById(container);
      window.mapCreations++;
    }
    on() {}
    once() {}
    off() {}
    stop() {}
    resize() {}
    remove() {}
    addControl() {}
    removeControl() {}
    isStyleLoaded() {
      return true;
    }
  },
};
window.navigate = navigate;
window.api = api;
window.store = store;
store.init();
try {
  await initNavigation();
} catch {
  await ensureRouteModule(location.pathname);
}
store.appReady = true;
document.dispatchEvent(new CustomEvent("appReady"));
window.swup = await swupReady;
window.fixtureReady = true;
