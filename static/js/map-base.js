// Factory for creating maps using Leaflet or Mapbox
(function (window, document, L, mapboxgl) {
  function createMap(containerId, options = {}) {
    const {
      library = "leaflet",
      center = [0, 0],
      zoom = 2,
      attributionControl = true,
      zoomControl = true,
      tileLayer,
      tileOptions = {},
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

    if (library === "mapbox") {
      if (!mapboxgl) throw new Error("Mapbox GL JS is not loaded");
      if (typeof mapboxgl.setTelemetryEnabled === "function") {
        mapboxgl.setTelemetryEnabled(false);
      }
      mapboxgl.accessToken = accessToken || window.MAPBOX_ACCESS_TOKEN;
      const map = new mapboxgl.Map({
        container: containerId,
        style: style || "mapbox://styles/mapbox/light-v10",
        center,
        zoom,
        attributionControl,
        ...mapOptions,
      });
      map.addControl(new mapboxgl.NavigationControl());
      map.on("error", (err) => console.error("Mapbox error:", err));
      return map;
    } else {
      if (!L) throw new Error("Leaflet is not loaded");
      const map = L.map(containerId, {
        center,
        zoom,
        zoomControl,
        attributionControl,
        ...mapOptions,
      });
      const defaultTileLayer =
        tileLayer || "https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png";
      L.tileLayer(defaultTileLayer, tileOptions).addTo(map);
      return map;
    }
  }

  window.mapBase = window.mapBase || {};
  window.mapBase.createMap = createMap;
})(window, document, window.L, window.mapboxgl);
