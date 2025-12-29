(() => {
  const baseConfig = window.coverageNavigatorConfig || {};
  const mapContainerId = baseConfig.mapContainerId || "coverage-map";

  const drivingDefaults = {
    areaSelectId: "area-select",
    mapContainerId,
    useSharedMap: true,
    populateAreaSelect: false,
  };

  const optimalDefaults = {
    areaSelectId: "area-select",
    mapContainerId,
    useSharedMap: true,
    addNavigationControl: false,
    populateAreaSelect: true,
  };

  window.coverageNavigatorConfig = {
    ...baseConfig,
    mapContainerId,
    drivingNavigation: {
      ...drivingDefaults,
      ...(baseConfig.drivingNavigation || {}),
    },
    optimalRoutes: {
      ...optimalDefaults,
      ...(baseConfig.optimalRoutes || {}),
    },
  };

  document.addEventListener("DOMContentLoaded", () => {
    if (!window.mapBase || typeof mapboxgl === "undefined") {
      console.error("Mapbox GL JS library not found. Coverage map cannot load.");
      return;
    }

    const container = document.getElementById(mapContainerId);
    if (!container || !window.MAPBOX_ACCESS_TOKEN) return;

    if (!window.coverageMasterMap) {
      window.coverageMasterMap = window.mapBase.createMap(mapContainerId, {
        center: [-96, 37.8],
        zoom: 4,
        accessToken: window.MAPBOX_ACCESS_TOKEN,
      });
    }
  });
})();
