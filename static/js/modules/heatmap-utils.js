/**
 * Heatmap utility module for creating Strava-style line-based heatmap visualization.
 *
 * Unlike point-based heatmaps, this maintains LINE geometry and creates the heat
 * effect through:
 * 1. Stacked semi-transparent layers that blend where routes overlap
 * 2. Glow effect using multiple line layers with decreasing width/opacity
 * 3. Proper Strava-inspired color gradients
 */

const heatmapUtils = {
  /**
   * Strava-style color configuration.
   * The gradient goes from dark/invisible → purple → red → orange → yellow
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
   * Calculate adaptive line width based on trip count.
   * More trips = thinner base lines (they stack to create brightness).
   * Fewer trips = slightly thicker lines so they're visible.
   * @param {number} tripCount - Number of trips
   * @returns {number} Base line width
   */
  getAdaptiveLineWidth(tripCount) {
    if (tripCount <= 1) return 3;
    if (tripCount <= 10) return 2.5;
    if (tripCount <= 50) return 2;
    if (tripCount <= 200) return 1.8;
    if (tripCount <= 500) return 1.5;
    if (tripCount <= 1000) return 1.2;
    if (tripCount <= 3000) return 1;
    return 0.8;
  },

  /**
   * Calculate adaptive opacity based on trip count.
   * More trips = lower individual opacity (prevents oversaturation).
   * @param {number} tripCount - Number of trips
   * @returns {number} Base opacity (0-1)
   */
  getAdaptiveOpacity(tripCount) {
    if (tripCount <= 1) return 0.9;
    if (tripCount <= 5) return 0.8;
    if (tripCount <= 20) return 0.6;
    if (tripCount <= 50) return 0.45;
    if (tripCount <= 100) return 0.35;
    if (tripCount <= 300) return 0.25;
    if (tripCount <= 700) return 0.18;
    if (tripCount <= 1500) return 0.12;
    if (tripCount <= 3000) return 0.08;
    if (tripCount <= 5000) return 0.05;
    return 0.03;
  },

  /**
   * Generate the glow layer configurations for Strava-style visualization.
   * Creates multiple stacked layers that produce a glowing line effect.
   *
   * @param {number} tripCount - Number of trips for adaptive sizing
   * @param {number} userOpacity - User-configured opacity (0-1)
   * @param {string} theme - 'dark' or 'light'
   * @returns {Array} Array of layer paint configurations (outer to inner)
   */
  generateGlowLayers(tripCount, userOpacity = 0.85, theme = "dark") {
    const colors = this.COLORS[theme] || this.COLORS.dark;
    const baseWidth = this.getAdaptiveLineWidth(tripCount);
    const baseOpacity = this.getAdaptiveOpacity(tripCount);

    // Apply user opacity as a multiplier
    const opacityMultiplier = userOpacity;

    // Glow layers from outermost (widest, most transparent) to innermost (narrow, bright)
    // Each layer stacks on top, and where routes overlap, the effect compounds
    return [
      // Layer 0: Outer glow (widest, most transparent)
      {
        name: "glow-outer",
        paint: {
          "line-color": colors.glow,
          "line-width": this._zoomInterpolate(baseWidth * 6),
          "line-opacity": baseOpacity * 0.15 * opacityMultiplier,
          "line-blur": baseWidth * 2,
        },
      },
      // Layer 1: Middle glow
      {
        name: "glow-middle",
        paint: {
          "line-color": colors.outer,
          "line-width": this._zoomInterpolate(baseWidth * 3.5),
          "line-opacity": baseOpacity * 0.3 * opacityMultiplier,
          "line-blur": baseWidth * 1,
        },
      },
      // Layer 2: Inner glow
      {
        name: "glow-inner",
        paint: {
          "line-color": colors.middle,
          "line-width": this._zoomInterpolate(baseWidth * 2),
          "line-opacity": baseOpacity * 0.5 * opacityMultiplier,
          "line-blur": baseWidth * 0.5,
        },
      },
      // Layer 3: Core line (narrowest, brightest)
      {
        name: "core",
        paint: {
          "line-color": colors.inner,
          "line-width": this._zoomInterpolate(baseWidth),
          "line-opacity": baseOpacity * 0.8 * opacityMultiplier,
          "line-blur": 0,
        },
      },
      // Layer 4: Hot center (very narrow, white-hot for high overlap)
      {
        name: "hot-center",
        paint: {
          "line-color": colors.core,
          "line-width": this._zoomInterpolate(baseWidth * 0.5),
          "line-opacity": baseOpacity * 0.6 * opacityMultiplier,
          "line-blur": 0,
        },
      },
    ];
  },

  /**
   * Create a zoom-interpolated width expression.
   * Lines get wider as you zoom in for better visibility.
   * @param {number} baseWidth - Base width at zoom level 12
   * @returns {Array} Mapbox interpolate expression
   */
  _zoomInterpolate(baseWidth) {
    return [
      "interpolate",
      ["exponential", 1.5],
      ["zoom"],
      5,
      baseWidth * 0.3,
      10,
      baseWidth * 0.6,
      12,
      baseWidth,
      15,
      baseWidth * 1.8,
      18,
      baseWidth * 3,
      22,
      baseWidth * 5,
    ];
  },

  /**
   * Generate complete heatmap configuration for the layer manager.
   * @param {Object} tripsGeoJSON - GeoJSON FeatureCollection with trip LineStrings
   * @param {Object} options - Configuration options
   * @returns {Object} Configuration object with layer specs
   */
  generateHeatmapConfig(tripsGeoJSON, options = {}) {
    const { theme = "dark", opacity = 0.85, densifyDistance = 30 } = options;

    const tripCount = tripsGeoJSON?.features?.length || 0;
    const glowLayers = this.generateGlowLayers(tripCount, opacity, theme);

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
      tripCount,
      glowLayers,
      // We use the original trip data directly - no conversion needed
      data: tripsGeoJSON,
    };
  },

  /**
   * Get updated opacity expressions for all glow layers.
   * Used when user adjusts the opacity slider.
   * @param {number} tripCount - Number of trips
   * @param {number} userOpacity - User-configured opacity
   * @param {string} theme - Theme name
   * @returns {Array} Array of opacity values for each layer
   */
  getUpdatedOpacities(tripCount, userOpacity, theme = "dark") {
    const baseOpacity = this.getAdaptiveOpacity(tripCount);
    const multipliers = [0.15, 0.3, 0.5, 0.8, 0.6]; // Matches generateGlowLayers order
    return multipliers.map((m) => baseOpacity * m * userOpacity);
  },
};

export default heatmapUtils;
