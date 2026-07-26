/**
 * Heatmap utility module for creating Strava-style line-based heatmap visualization.
 *
 * The heat effect comes from overlapping semi-transparent lines that compound
 * in brightness. Routes traveled many times appear brighter than routes
 * traveled once.
 */

const heatmapUtils = {
  /** Thermal road-atlas palette: ember halo, molten body, pale hot core. */
  COLORS: {
    dark: {
      halo: "#b93b24",
      glow: "#f06a2a",
      core: "#fff0c2",
    },
    light: {
      halo: "#8f2f20",
      glow: "#d85a24",
      core: "#f2a93b",
    },
  },

  _resolveColorPalette(theme = "dark", palette = null) {
    const fallbackPalette = this.COLORS[theme] || this.COLORS.dark;
    if (!palette || typeof palette !== "object") {
      return fallbackPalette;
    }

    const glow =
      typeof palette.glow === "string" && palette.glow.trim()
        ? palette.glow.trim()
        : fallbackPalette.glow;
    const halo =
      typeof palette.halo === "string" && palette.halo.trim()
        ? palette.halo.trim()
        : fallbackPalette.halo;
    const core =
      typeof palette.core === "string" && palette.core.trim()
        ? palette.core.trim()
        : fallbackPalette.core;

    return { halo, glow, core };
  },

  /**
   * Trip heat tiers, widest and coolest first.
   *
   * Each tier is an independent alpha-composited pass over the same geometry,
   * so n trips down one road reach `1 - (1 - alpha)^n`. The three alphas are
   * deliberately far apart: the ember tier saturates within a handful of
   * passes, the pale core needs dozens. That spread is what turns "how often
   * did I drive here" into ember -> molten -> hot core. Tiers with similar
   * alphas all saturate together and collapse into one flat slab of colour.
   */
  TRIP_HEAT_TIERS: [
    { name: "atmosphere", colorKey: "halo", width: 3.2, alphaScale: 1 },
    { name: "body", colorKey: "glow", width: 1.9, alphaScale: 0.55 },
    { name: "core", colorKey: "core", width: 1, alphaScale: 0.22 },
  ],

  /** Hairline traces rasterise into a dashed smear; never go below this. */
  MIN_LINE_WIDTH: 0.75,

  /** Zoom multipliers applied to every heat line width. */
  ZOOM_WIDTH_SCALE: [
    [4, 0.55],
    [8, 0.75],
    [12, 1],
    [16, 1.45],
    [20, 2],
  ],

  /**
   * Zoom multipliers applied to every heat line opacity. Overlap is densest
   * when the whole map fits on screen and thinnest once GPS scatter braids
   * apart, so the ramp leans the opposite way to the width ramp.
   */
  ZOOM_OPACITY_SCALE: [
    [4, 0.7],
    [8, 0.85],
    [12, 1],
    [16, 1.15],
    [20, 1.3],
  ],

  /**
   * Alpha contributed by a single trip passing down a road.
   *
   * One trip has to be visible on its own, and a road driven a hundred times
   * has to still look hotter than one driven ten times. No single alpha does
   * both — the ramp flattens as soon as `n * alpha` passes 1 — so the
   * increment decays with bundle size: sparse bundles get immediate presence,
   * dense ones get a long ramp with headroom left at the top.
   *
   * @param {number} tripCount - Trips in the bundle being drawn
   * @returns {number} Per-trip alpha for the widest tier
   */
  tripHeatBaseAlpha(tripCount) {
    const trips = Math.max(1, Number(tripCount) || 1);
    return Math.min(0.5, Math.max(0.085, 0.5 / trips ** 0.28));
  },

  /**
   * Calculate line width and opacity based on trip count.
   * Retained for the two-layer glow treatment; the trip map builds its
   * tiers from TRIP_HEAT_TIERS directly.
   *
   * @param {number} tripCount - Number of trips
   * @returns {Object} Configuration with width and opacity settings
   */
  getAdaptiveSettings(tripCount) {
    const baseAlpha = this.tripHeatBaseAlpha(tripCount);
    const [, body, core] = this.TRIP_HEAT_TIERS;

    return {
      baseWidth: core.width,
      glowWidth: body.width,
      coreOpacity: baseAlpha * core.alphaScale,
      glowOpacity: baseAlpha * body.alphaScale,
    };
  },

  /**
   * Create zoom-interpolated width expression.
   * @param {number} baseWidth - Base width at zoom 12
   * @returns {Array} Mapbox interpolate expression
   */
  _zoomWidth(baseWidth) {
    const widthStops = [];

    this.ZOOM_WIDTH_SCALE.forEach(([zoom, scale]) => {
      widthStops.push(zoom, Math.max(this.MIN_LINE_WIDTH, baseWidth * scale));
    });

    return ["interpolate", ["exponential", 1.4], ["zoom"], ...widthStops];
  },

  /**
   * Create zoom-interpolated opacity expression.
   * @param {number} baseOpacity - Base opacity at zoom 12
   * @returns {Array} Mapbox interpolate expression
   */
  _zoomOpacity(baseOpacity) {
    const opacityStops = [];
    const clampOpacity = (value) => Math.max(0, Math.min(value, 1));

    this.ZOOM_OPACITY_SCALE.forEach(([zoom, scale]) => {
      opacityStops.push(zoom, clampOpacity(baseOpacity * scale));
    });

    return ["interpolate", ["exponential", 1.2], ["zoom"], ...opacityStops];
  },

  /**
   * Resolve one of the expressions above to a number.
   *
   * deck.gl takes plain values where Mapbox takes an interpolate expression,
   * so this reproduces Mapbox's exponential interpolation. Reading the
   * expression back — rather than keeping a parallel set of formulas — is
   * what keeps the two renderers matched across the bundle-size switchover.
   *
   * @param {Array|number} expression - Mapbox interpolate expression
   * @param {number} zoom - Zoom level to evaluate at
   * @returns {number} Interpolated value
   */
  evaluateZoomExpression(expression, zoom) {
    if (!Array.isArray(expression) || expression[0] !== "interpolate") {
      return Number(expression) || 0;
    }

    const base = Number(expression[1]?.[1]) || 1;
    const stops = [];
    for (let index = 3; index < expression.length; index += 2) {
      stops.push([Number(expression[index]), Number(expression[index + 1])]);
    }
    if (!stops.length) {
      return 0;
    }

    const level = Number(zoom);
    if (!Number.isFinite(level) || level <= stops[0][0]) {
      return stops[0][1];
    }
    const [lastZoom, lastValue] = stops.at(-1);
    if (level >= lastZoom) {
      return lastValue;
    }

    for (let index = 1; index < stops.length; index += 1) {
      const [stopZoom, stopValue] = stops[index];
      if (level > stopZoom) {
        continue;
      }
      const [previousZoom, previousValue] = stops[index - 1];
      const span = stopZoom - previousZoom;
      const progress =
        base === 1
          ? (level - previousZoom) / span
          : (base ** (level - previousZoom) - 1) / (base ** span - 1);
      return previousValue + (stopValue - previousValue) * progress;
    }

    return lastValue;
  },

  /**
   * Create zoom-interpolated blur expression.
   * @param {number} baseBlur - Base blur at zoom 12
   * @returns {Array} Mapbox interpolate expression
   */
  _zoomBlur(baseBlur) {
    return [
      "interpolate",
      ["exponential", 1.3],
      ["zoom"],
      4,
      baseBlur * 0.3,
      8,
      baseBlur * 0.6,
      12,
      baseBlur,
      16,
      baseBlur * 1.6,
      20,
      baseBlur * 2.4,
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
  generateGlowLayers(tripCount, userOpacity = 0.85, theme = "dark", palette = null) {
    const colors = this._resolveColorPalette(theme, palette);
    const settings = this.getAdaptiveSettings(tripCount);

    const opacityMult = userOpacity;
    const glowOpacity = this._zoomOpacity(settings.glowOpacity * opacityMult);
    const coreOpacity = this._zoomOpacity(settings.coreOpacity * opacityMult);
    const glowBlur = this._zoomBlur(settings.glowWidth * 0.6);

    return [
      // Layer 0: Outer glow (wider, more transparent, orange-red)
      {
        name: "glow",
        paint: {
          "line-color": colors.glow,
          "line-width": this._zoomWidth(settings.glowWidth),
          "line-opacity": glowOpacity,
          "line-blur": glowBlur,
        },
      },
      // Layer 1: Core line (narrow, brighter, orange-yellow)
      {
        name: "core",
        paint: {
          "line-color": colors.core,
          "line-width": this._zoomWidth(settings.baseWidth),
          "line-opacity": coreOpacity,
          "line-blur": 0,
        },
      },
    ];
  },

  /**
   * Build the richer trip-frequency treatment used by the main map.
   * Three shared-source layers preserve every route while giving repeated
   * roads a legible progression from ember to warm body to a pale hot core.
   */
  generateTripHeatLayers(
    tripCount,
    userOpacity = 0.85,
    theme = "dark",
    palette = null
  ) {
    const colors = this._resolveColorPalette(theme, palette);
    const baseAlpha = this.tripHeatBaseAlpha(tripCount);
    const opacityMult = Number.isFinite(userOpacity) ? userOpacity : 1;

    return this.TRIP_HEAT_TIERS.map((tier) => ({
      name: tier.name,
      paint: {
        "line-color": colors[tier.colorKey],
        "line-width": this._zoomWidth(tier.width),
        "line-opacity": this._zoomOpacity(baseAlpha * tier.alphaScale * opacityMult),
        // Mapbox fades a blurred line inward from its own edges rather than
        // spreading it outward, so on hairline traces blur only drains
        // brightness — and deck.gl has no equivalent to match it with.
        "line-blur": 0,
      },
    }));
  },

  /**
   * The same tiers resolved to plain numbers for deck.gl, which has no zoom
   * expressions of its own and has to be rebuilt as the camera moves.
   *
   * @param {number} tripCount - Trips in the bundle being drawn
   * @param {number} userOpacity - User opacity multiplier (0-1)
   * @param {string} theme - 'dark' or 'light'
   * @param {Object} palette - Optional palette override
   * @param {number} zoom - Zoom level to resolve the ramps at
   * @returns {Array} Tiers with concrete color, width, and opacity
   */
  tripHeatTiersAtZoom(tripCount, userOpacity, theme, palette, zoom) {
    return this.generateTripHeatLayers(tripCount, userOpacity, theme, palette).map(
      (layer) => ({
        name: layer.name,
        color: layer.paint["line-color"],
        width: this.evaluateZoomExpression(layer.paint["line-width"], zoom),
        opacity: this.evaluateZoomExpression(layer.paint["line-opacity"], zoom),
      })
    );
  },

  /**
   * Generate complete heatmap configuration.
   * @param {Object} tripsGeoJSON - GeoJSON FeatureCollection
   * @param {Object} options - Configuration options
   * @returns {Object} Configuration with layers
   */
  generateHeatmapConfig(tripsGeoJSON, options = {}) {
    const {
      theme = "dark",
      opacity = 0.85,
      visibleTripCount = null,
      palette = null,
    } = options;
    const tripCount = tripsGeoJSON?.features?.length || 0;
    const styleTripCount =
      Number.isFinite(visibleTripCount) && visibleTripCount >= 0
        ? visibleTripCount
        : tripCount;
    const glowLayers = this.generateGlowLayers(styleTripCount, opacity, theme, palette);

    return {
      tripCount,
      styleTripCount,
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
    return [
      this._zoomOpacity(settings.glowOpacity * userOpacity),
      this._zoomOpacity(settings.coreOpacity * userOpacity),
    ];
  },
};

export default heatmapUtils;
