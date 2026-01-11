/* global mapboxgl, confirmationDialog */

/**
 * Preview Map Module
 * Handles the map preview functionality for uploaded files
 */

import { MAP_CONFIG, PREVIEW_LAYER_STYLE } from "./constants.js";

const PREVIEW_SOURCE_ID = "preview-source";
const PREVIEW_LAYER_ID = "preview-layer";

/**
 * Initialize the preview map
 * @param {string} containerId - The DOM element ID for the map container
 * @param {Function} onFeatureClick - Callback when a feature is clicked (receives filename)
 * @returns {Promise<Object>} The initialized map instance
 */
export async function initializePreviewMap(containerId, onFeatureClick) {
  const map = window.mapBase.createMap(containerId, {
    center: MAP_CONFIG.defaultCenter,
    zoom: MAP_CONFIG.defaultZoom,
  });

  // Wait for map style to load before adding sources/layers
  await waitForMapLoad(map);

  // Initialize GeoJSON source
  map.addSource(PREVIEW_SOURCE_ID, {
    type: "geojson",
    data: { type: "FeatureCollection", features: [] },
    generateId: true,
  });

  // Add preview layer
  map.addLayer({
    id: PREVIEW_LAYER_ID,
    type: "line",
    source: PREVIEW_SOURCE_ID,
    paint: {
      "line-color": PREVIEW_LAYER_STYLE.lineColor,
      "line-width": PREVIEW_LAYER_STYLE.lineWidth,
      "line-opacity": PREVIEW_LAYER_STYLE.lineOpacity,
    },
    layout: {
      "line-join": "round",
      "line-cap": "round",
    },
  });

  // Handle clicks on preview lines
  if (onFeatureClick) {
    map.on("click", PREVIEW_LAYER_ID, async (e) => {
      const feature = e.features[0];
      if (feature?.properties?.filename) {
        const confirmed = await confirmationDialog.show({
          title: "Remove File from Preview",
          message: `Remove ${feature.properties.filename} from the upload list?`,
          confirmText: "Remove",
          confirmButtonClass: "btn-danger",
        });

        if (confirmed) {
          onFeatureClick(feature.properties.filename);
        }
      }
    });
  }

  // Change cursor on hover
  map.on("mouseenter", PREVIEW_LAYER_ID, () => {
    map.getCanvas().style.cursor = "pointer";
  });

  map.on("mouseleave", PREVIEW_LAYER_ID, () => {
    map.getCanvas().style.cursor = "";
  });

  return map;
}

/**
 * Wait for the map style to load
 * @param {Object} map - The Mapbox map instance
 * @returns {Promise<void>}
 */
function waitForMapLoad(map) {
  return new Promise((resolve) => {
    if (map.isStyleLoaded()) {
      resolve();
    } else {
      map.once("styledata", resolve);
      // Fallback timeout
      setTimeout(resolve, 1000);
    }
  });
}

/**
 * Update the preview map with file coordinates
 * @param {Object} map - The Mapbox map instance
 * @param {Array<Object>} selectedFiles - Array of file entries with coordinates
 */
export function updatePreviewMap(map, selectedFiles) {
  if (!map) {
    return;
  }

  const features = selectedFiles
    .map((entry) => {
      const validCoords = entry.coordinates.filter(
        (coord) =>
          Array.isArray(coord) &&
          coord.length >= 2 &&
          !Number.isNaN(coord[0]) &&
          !Number.isNaN(coord[1])
      );

      if (validCoords.length < 2) {
        return null;
      }

      return {
        type: "Feature",
        geometry: {
          type: "LineString",
          coordinates: validCoords,
        },
        properties: {
          filename: entry.filename,
        },
      };
    })
    .filter(Boolean);

  const source = map.getSource(PREVIEW_SOURCE_ID);
  if (source) {
    source.setData({
      type: "FeatureCollection",
      features,
    });
  }

  fitMapToBounds(map, features);
}

/**
 * Fit the map to the bounds of the features
 * @param {Object} map - The Mapbox map instance
 * @param {Array<Object>} features - GeoJSON features to fit
 */
function fitMapToBounds(map, features) {
  if (features.length > 0) {
    try {
      const bounds = features.reduce((accBounds, feature) => {
        const coords = feature.geometry.coordinates;
        coords.forEach(([lng, lat]) => {
          accBounds.extend([lng, lat]);
        });
        return accBounds;
      }, new mapboxgl.LngLatBounds());

      map.fitBounds(bounds, {
        padding: MAP_CONFIG.fitBoundsPadding,
        maxZoom: MAP_CONFIG.fitBoundsMaxZoom,
      });
    } catch {
      resetMapView(map);
    }
  } else {
    resetMapView(map);
  }
}

/**
 * Reset the map to the default view
 * @param {Object} map - The Mapbox map instance
 */
export function resetMapView(map) {
  if (map) {
    map.setCenter(MAP_CONFIG.defaultCenter);
    map.setZoom(MAP_CONFIG.defaultZoom);
  }
}

/**
 * Get the preview source and layer IDs
 * @returns {Object} Object with sourceId and layerId
 */
export function getPreviewIds() {
  return {
    sourceId: PREVIEW_SOURCE_ID,
    layerId: PREVIEW_LAYER_ID,
  };
}
