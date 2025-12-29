/**
 * Heatmap utility module for creating Strava-style line-based heatmap visualization.
 *
 * The heat effect comes from overlapping semi-transparent lines that compound
 * in brightness. Routes traveled many times appear brighter than routes
 * traveled once.
 */

const heatmapUtils = {
  /**
   * Strava-style colors - bright orange/yellow core with red/purple glow
   */
  COLORS: {
    dark: {
      glow: "#ff4400", // Orange-red outer glow
      core: "#ffaa00", // Bright orange-yellow core
    },
    light: {
      glow: "#ff5500",
      core: "#ff8800",
    },
  },

  /**
   * Calculate line width and opacity based on trip count.
   * The key insight: we want individual lines thin and semi-transparent
   * so that OVERLAP creates the brightness, not the individual line.
   *
   * @param {number} tripCount - Number of trips
   * @returns {Object} Configuration with width and opacity settings
   */
  getAdaptiveSettings(tripCount) {
    // For heatmap effect, we need:
    // - Thin lines so they stack nicely
    // - Moderate opacity so overlapping creates visible brightness
    // - More trips = slightly thinner lines and lower per-line opacity

    let baseWidth, glowWidth, coreOpacity, glowOpacity;

    if (tripCount <= 5) {
      // Very few trips - make them visible
      baseWidth = 2.5;
      glowWidth = 5;
      coreOpacity = 0.8;
      glowOpacity = 0.4;
    } else if (tripCount <= 20) {
      baseWidth = 2;
      glowWidth = 4;
      coreOpacity = 0.6;
      glowOpacity = 0.3;
    } else if (tripCount <= 50) {
      baseWidth = 1.8;
      glowWidth = 3.5;
      coreOpacity = 0.5;
      glowOpacity = 0.25;
    } else if (tripCount <= 100) {
      baseWidth = 1.5;
      glowWidth = 3;
      coreOpacity = 0.4;
      glowOpacity = 0.2;
    } else if (tripCount <= 300) {
      baseWidth = 1.2;
      glowWidth = 2.5;
      coreOpacity = 0.35;
      glowOpacity = 0.15;
    } else if (tripCount <= 700) {
      baseWidth = 1;
      glowWidth = 2;
      coreOpacity = 0.3;
      glowOpacity = 0.12;
    } else if (tripCount <= 1500) {
      baseWidth = 0.8;
      glowWidth = 1.8;
      coreOpacity = 0.25;
      glowOpacity = 0.1;
    } else if (tripCount <= 3000) {
      baseWidth = 0.7;
      glowWidth = 1.5;
      coreOpacity = 0.2;
      glowOpacity = 0.08;
    } else if (tripCount <= 5000) {
      baseWidth = 0.6;
      glowWidth = 1.3;
      coreOpacity = 0.15;
      glowOpacity = 0.06;
    } else {
      // 5000+ trips
      baseWidth = 0.5;
      glowWidth = 1.2;
      coreOpacity = 0.12;
      glowOpacity = 0.05;
    }

    return { baseWidth, glowWidth, coreOpacity, glowOpacity };
  },

  /**
   * Create zoom-interpolated width expression.
   * @param {number} baseWidth - Base width at zoom 12
   * @returns {Array} Mapbox interpolate expression
   */
  _zoomWidth(baseWidth) {
    return [
      "interpolate",
      ["exponential", 1.5],
      ["zoom"],
      4,
      baseWidth * 0.2,
      8,
      baseWidth * 0.5,
      12,
      baseWidth,
      16,
      baseWidth * 2,
      20,
      baseWidth * 4,
    ];
  },

  /**
   * Generate the glow layer configurations.
   * Simple 2-layer approach: outer glow + bright core
   *
   * @param {number} tripCount - Number of trips
   * @param {number} userOpacity - User opacity multiplier (0-1)
   * @param {string} theme - 'dark' or 'light'
   * @returns {Array} Array of layer paint configurations
   */
  generateGlowLayers(tripCount, userOpacity = 0.85, theme = "dark") {
    const colors = this.COLORS[theme] || this.COLORS.dark;
    const settings = this.getAdaptiveSettings(tripCount);

    const opacityMult = userOpacity;

    return [
      // Layer 0: Outer glow (wider, more transparent, orange-red)
      {
        name: "glow",
        paint: {
          "line-color": colors.glow,
          "line-width": this._zoomWidth(settings.glowWidth),
          "line-opacity": settings.glowOpacity * opacityMult,
          "line-blur": settings.baseWidth * 0.5,
        },
      },
      // Layer 1: Core line (narrow, brighter, orange-yellow)
      {
        name: "core",
        paint: {
          "line-color": colors.core,
          "line-width": this._zoomWidth(settings.baseWidth),
          "line-opacity": settings.coreOpacity * opacityMult,
          "line-blur": 0,
        },
      },
    ];
  },

  /**
   * Generate complete heatmap configuration.
   * @param {Object} tripsGeoJSON - GeoJSON FeatureCollection
   * @param {Object} options - Configuration options
   * @returns {Object} Configuration with layers
   */
  generateHeatmapConfig(tripsGeoJSON, options = {}) {
    const { theme = "dark", opacity = 0.85 } = options;
    const tripCount = tripsGeoJSON?.features?.length || 0;
    const glowLayers = this.generateGlowLayers(tripCount, opacity, theme);
    const settings = this.getAdaptiveSettings(tripCount);

    console.log(
      `Heatmap: ${tripCount} trips, core opacity: ${settings.coreOpacity}, ` +
        `glow opacity: ${settings.glowOpacity}, base width: ${settings.baseWidth}`
    );

    return {
      tripCount,
      glowLayers,
      data: tripsGeoJSON,
    };
  },

  /**
   * Get updated opacities when user adjusts slider.
   * @param {number} tripCount - Number of trips
   * @param {number} userOpacity - User opacity (0-1)
   * @returns {Array} Array of opacity values [glow, core]
   */
  getUpdatedOpacities(tripCount, userOpacity) {
    const settings = this.getAdaptiveSettings(tripCount);
    return [settings.glowOpacity * userOpacity, settings.coreOpacity * userOpacity];
  },
};

export default heatmapUtils;
