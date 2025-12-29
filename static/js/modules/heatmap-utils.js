/**
 * Heatmap utility module for converting trip LineStrings to dense points
 * and providing Strava-inspired heatmap configuration.
 */

const heatmapUtils = {
  /**
   * Calculate distance between two coordinates in meters using Haversine formula.
   * @param {number[]} coord1 - [lng, lat]
   * @param {number[]} coord2 - [lng, lat]
   * @returns {number} Distance in meters
   */
  haversineDistance(coord1, coord2) {
    const R = 6371000; // Earth's radius in meters
    const lat1 = (coord1[1] * Math.PI) / 180;
    const lat2 = (coord2[1] * Math.PI) / 180;
    const deltaLat = ((coord2[1] - coord1[1]) * Math.PI) / 180;
    const deltaLng = ((coord2[0] - coord1[0]) * Math.PI) / 180;

    const a =
      Math.sin(deltaLat / 2) * Math.sin(deltaLat / 2) +
      Math.cos(lat1) *
        Math.cos(lat2) *
        Math.sin(deltaLng / 2) *
        Math.sin(deltaLng / 2);
    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));

    return R * c;
  },

  /**
   * Interpolate a point between two coordinates at a given fraction.
   * @param {number[]} coord1 - [lng, lat]
   * @param {number[]} coord2 - [lng, lat]
   * @param {number} fraction - Value between 0 and 1
   * @returns {number[]} Interpolated [lng, lat]
   */
  interpolate(coord1, coord2, fraction) {
    return [
      coord1[0] + (coord2[0] - coord1[0]) * fraction,
      coord1[1] + (coord2[1] - coord1[1]) * fraction,
    ];
  },

  /**
   * Densify a LineString by adding points at regular intervals.
   * @param {number[][]} coordinates - Array of [lng, lat] coordinates
   * @param {number} maxDistanceMeters - Maximum distance between points in meters
   * @returns {number[][]} Densified coordinates
   */
  densifyLine(coordinates, maxDistanceMeters = 50) {
    if (!coordinates || coordinates.length < 2) {
      return coordinates || [];
    }

    const result = [coordinates[0]];

    for (let i = 1; i < coordinates.length; i++) {
      const prev = coordinates[i - 1];
      const curr = coordinates[i];
      const distance = this.haversineDistance(prev, curr);

      if (distance > maxDistanceMeters) {
        const numSegments = Math.ceil(distance / maxDistanceMeters);
        for (let j = 1; j <= numSegments; j++) {
          const fraction = j / numSegments;
          result.push(this.interpolate(prev, curr, fraction));
        }
      } else {
        result.push(curr);
      }
    }

    return result;
  },

  /**
   * Convert trip LineString features to Point features for heatmap visualization.
   * @param {Object} tripsGeoJSON - GeoJSON FeatureCollection with LineString features
   * @param {Object} options - Configuration options
   * @param {number} options.densifyDistance - Distance between points in meters (default: 30)
   * @param {boolean} options.includeWeight - Whether to include weight property (default: true)
   * @returns {Object} GeoJSON FeatureCollection with Point features
   */
  tripsToHeatmapPoints(tripsGeoJSON, options = {}) {
    const { densifyDistance = 30, includeWeight = true } = options;

    if (!tripsGeoJSON?.features?.length) {
      return { type: "FeatureCollection", features: [] };
    }

    const points = [];

    for (const feature of tripsGeoJSON.features) {
      if (!feature?.geometry?.coordinates) continue;

      const { type, coordinates } = feature.geometry;

      if (type === "LineString") {
        const denseCoords = this.densifyLine(coordinates, densifyDistance);
        for (const coord of denseCoords) {
          if (
            Array.isArray(coord) &&
            coord.length >= 2 &&
            !Number.isNaN(coord[0]) &&
            !Number.isNaN(coord[1])
          ) {
            const pointFeature = {
              type: "Feature",
              geometry: {
                type: "Point",
                coordinates: coord.slice(0, 2),
              },
              properties: includeWeight ? { weight: 1 } : {},
            };
            points.push(pointFeature);
          }
        }
      } else if (type === "MultiLineString") {
        for (const line of coordinates) {
          const denseCoords = this.densifyLine(line, densifyDistance);
          for (const coord of denseCoords) {
            if (
              Array.isArray(coord) &&
              coord.length >= 2 &&
              !Number.isNaN(coord[0]) &&
              !Number.isNaN(coord[1])
            ) {
              const pointFeature = {
                type: "Feature",
                geometry: {
                  type: "Point",
                  coordinates: coord.slice(0, 2),
                },
                properties: includeWeight ? { weight: 1 } : {},
              };
              points.push(pointFeature);
            }
          }
        }
      } else if (type === "Point") {
        // Already a point, just add it
        if (
          Array.isArray(coordinates) &&
          coordinates.length >= 2 &&
          !Number.isNaN(coordinates[0]) &&
          !Number.isNaN(coordinates[1])
        ) {
          points.push({
            type: "Feature",
            geometry: {
              type: "Point",
              coordinates: coordinates.slice(0, 2),
            },
            properties: includeWeight ? { weight: 1 } : {},
          });
        }
      }
    }

    return { type: "FeatureCollection", features: points };
  },

  /**
   * Calculate adaptive heatmap intensity based on point count.
   * This ensures the heatmap looks good whether there's 1 trip or 7000+ trips.
   * @param {number} pointCount - Total number of heatmap points
   * @param {number} tripCount - Number of original trips
   * @returns {Object} Intensity configuration for different zoom levels
   */
  calculateAdaptiveIntensity(pointCount, tripCount) {
    // Base intensity inversely proportional to point density
    // For few trips, we want higher intensity so they're visible
    // For many trips, lower intensity to prevent oversaturation

    let baseIntensity;
    if (tripCount <= 1) {
      baseIntensity = 1.5;
    } else if (tripCount <= 10) {
      baseIntensity = 1.2;
    } else if (tripCount <= 50) {
      baseIntensity = 0.8;
    } else if (tripCount <= 200) {
      baseIntensity = 0.5;
    } else if (tripCount <= 500) {
      baseIntensity = 0.3;
    } else if (tripCount <= 1000) {
      baseIntensity = 0.2;
    } else if (tripCount <= 3000) {
      baseIntensity = 0.12;
    } else if (tripCount <= 5000) {
      baseIntensity = 0.08;
    } else {
      // 5000+ trips
      baseIntensity = 0.05;
    }

    // Zoom-based intensity multipliers
    // At lower zooms, we need higher intensity because points are clustered
    // At higher zooms, points spread out so we need lower base intensity
    return {
      base: baseIntensity,
      zoomStops: [
        [0, baseIntensity * 2],
        [5, baseIntensity * 1.5],
        [10, baseIntensity],
        [15, baseIntensity * 0.8],
        [20, baseIntensity * 0.5],
      ],
    };
  },

  /**
   * Get the Strava-inspired heatmap color ramp.
   * Uses a gradient from transparent dark to bright white/yellow/orange/red.
   * @param {string} theme - 'dark' or 'light' theme
   * @returns {Array} Mapbox heatmap-color expression
   */
  getHeatmapColorRamp(theme = "dark") {
    // Strava-style heatmap: dark background with glowing hot colors
    // The gradient goes from transparent → purple → blue → cyan → green → yellow → orange → red → white
    if (theme === "dark") {
      return [
        "interpolate",
        ["linear"],
        ["heatmap-density"],
        0,
        "rgba(0, 0, 0, 0)",
        0.1,
        "rgba(103, 0, 160, 0.5)", // Deep purple
        0.2,
        "rgba(46, 7, 163, 0.6)", // Purple-blue
        0.3,
        "rgba(0, 68, 160, 0.7)", // Deep blue
        0.4,
        "rgba(0, 128, 164, 0.8)", // Teal
        0.5,
        "rgba(0, 180, 80, 0.85)", // Green
        0.6,
        "rgba(165, 220, 0, 0.9)", // Yellow-green
        0.7,
        "rgba(255, 220, 0, 0.92)", // Yellow
        0.8,
        "rgba(255, 160, 0, 0.95)", // Orange
        0.9,
        "rgba(255, 80, 20, 0.98)", // Red-orange
        1,
        "rgba(255, 255, 255, 1)", // White hot center
      ];
    } else {
      // Light theme - more saturated colors that work on light backgrounds
      return [
        "interpolate",
        ["linear"],
        ["heatmap-density"],
        0,
        "rgba(0, 0, 0, 0)",
        0.1,
        "rgba(128, 0, 180, 0.4)",
        0.2,
        "rgba(80, 20, 200, 0.5)",
        0.3,
        "rgba(0, 80, 180, 0.6)",
        0.4,
        "rgba(0, 150, 180, 0.7)",
        0.5,
        "rgba(0, 200, 100, 0.75)",
        0.6,
        "rgba(180, 230, 0, 0.8)",
        0.7,
        "rgba(255, 230, 0, 0.85)",
        0.8,
        "rgba(255, 170, 0, 0.9)",
        0.9,
        "rgba(255, 100, 30, 0.95)",
        1,
        "rgba(255, 60, 0, 1)",
      ];
    }
  },

  /**
   * Get zoom-responsive radius configuration.
   * Radius increases with zoom to maintain visual consistency.
   * @param {number} tripCount - Number of trips for adaptive sizing
   * @returns {Array} Mapbox interpolate expression for heatmap-radius
   */
  getHeatmapRadius(tripCount) {
    // Base radius adjusts based on data density
    let baseRadius;
    if (tripCount <= 10) {
      baseRadius = 8;
    } else if (tripCount <= 100) {
      baseRadius = 6;
    } else if (tripCount <= 500) {
      baseRadius = 5;
    } else if (tripCount <= 2000) {
      baseRadius = 4;
    } else {
      baseRadius = 3;
    }

    return [
      "interpolate",
      ["exponential", 1.5],
      ["zoom"],
      0,
      baseRadius * 0.5,
      5,
      baseRadius,
      10,
      baseRadius * 2,
      15,
      baseRadius * 4,
      20,
      baseRadius * 8,
    ];
  },

  /**
   * Get zoom-responsive opacity configuration.
   * Opacity adjusts to keep the heatmap visible at all zoom levels.
   * @param {number} baseOpacity - Base opacity value (0-1)
   * @returns {Array} Mapbox interpolate expression for heatmap-opacity
   */
  getHeatmapOpacity(baseOpacity = 0.8) {
    return [
      "interpolate",
      ["linear"],
      ["zoom"],
      0,
      baseOpacity * 0.6,
      5,
      baseOpacity * 0.8,
      10,
      baseOpacity,
      15,
      baseOpacity * 0.9,
      20,
      baseOpacity * 0.7,
    ];
  },

  /**
   * Generate complete heatmap layer configuration.
   * @param {Object} tripsGeoJSON - Original trips GeoJSON
   * @param {Object} options - Configuration options
   * @returns {Object} Object containing heatmapData and layerConfig
   */
  generateHeatmapConfig(tripsGeoJSON, options = {}) {
    const { theme = "dark", opacity = 0.85, densifyDistance = 30 } = options;

    const tripCount = tripsGeoJSON?.features?.length || 0;

    // Convert trips to heatmap points
    const heatmapData = this.tripsToHeatmapPoints(tripsGeoJSON, {
      densifyDistance,
      includeWeight: true,
    });

    const pointCount = heatmapData.features.length;

    // Calculate adaptive intensity
    const intensityConfig = this.calculateAdaptiveIntensity(
      pointCount,
      tripCount,
    );

    // Build the layer paint configuration
    const paint = {
      "heatmap-weight": ["coalesce", ["get", "weight"], 1],
      "heatmap-intensity": [
        "interpolate",
        ["linear"],
        ["zoom"],
        ...intensityConfig.zoomStops.flat(),
      ],
      "heatmap-color": this.getHeatmapColorRamp(theme),
      "heatmap-radius": this.getHeatmapRadius(tripCount),
      "heatmap-opacity": this.getHeatmapOpacity(opacity),
    };

    return {
      heatmapData,
      paint,
      tripCount,
      pointCount,
      intensityConfig,
    };
  },
};

export default heatmapUtils;
