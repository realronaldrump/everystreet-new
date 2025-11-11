// Factory for creating maps using Mapbox GL JS
((window, document, mapboxgl) => {
  function createMap(containerId, options = {}) {
    const {
      center = [0, 0],
      zoom = 2,
      attributionControl = true,
      accessToken,
      style,
      mapOptions = {},
    } = options;

    const container = document.getElementById(containerId);
    if (!container) {
      throw new Error(`Map container '${containerId}' not found`);
    }

    if (container.firstChild) {
      container.replaceChildren();
    }

    if (!mapboxgl) throw new Error("Mapbox GL JS is not loaded");
    if (typeof mapboxgl.setTelemetryEnabled === "function") {
      mapboxgl.setTelemetryEnabled(false);
    }
    mapboxgl.accessToken = accessToken || window.MAPBOX_ACCESS_TOKEN;

    const theme = document.documentElement.getAttribute("data-bs-theme") || "dark";
    const defaultStyle =
      style ||
      (theme === "light"
        ? "mapbox://styles/mapbox/light-v11"
        : "mapbox://styles/mapbox/dark-v11");

    const map = new mapboxgl.Map({
      container: containerId,
      style: defaultStyle,
      center,
      zoom,
      attributionControl,
      ...mapOptions,
    });
    map.addControl(new mapboxgl.NavigationControl());
    map.on("error", (err) => console.error("Mapbox error:", err));
    return map;
  }

  window.mapBase = window.mapBase || {};
  window.mapBase.createMap = createMap;
})(window, document, window.mapboxgl);
