/**
 * Map Styles Configuration
 * Centralized color and style definitions for map layers and UI elements
 * Uses CSS variables where possible for theme consistency
 * Works in both module and non-module contexts
 */

(function (window) {
  'use strict';

  /**
   * Get a CSS variable value from the document root
   * @param {string} varName - CSS variable name (e.g., '--primary')
   * @param {string} fallback - Fallback value if variable not found
   * @returns {string} The CSS variable value or fallback
   */
  function getCSSVariable(varName, fallback = '') {
    if (typeof window === 'undefined' || typeof document === 'undefined') {
      return fallback;
    }
    try {
      const value = getComputedStyle(document.documentElement)
        .getPropertyValue(varName)
        .trim();
      return value || fallback;
    } catch (e) {
      return fallback;
    }
  }

  /**
   * Map layer color configuration
   * Colors are defined here but should reference CSS variables when possible
   */
  const MAP_LAYER_COLORS = {
    // Trip layers
    trips: {
      default: '#331107',
      selected: '#FFD700',
      recent: {
        light: '#FFEFC1',
        dark: '#FFB703'
      }
    },
    matchedTrips: {
      default: '#CF6679',
      highlight: '#40E0D0'
    },
    
    // Street layers
    streets: {
      undriven: '#00BFFF',
      driven: getCSSVariable('--success', '#059669'),
      all: getCSSVariable('--primary-light', '#818cf8')
    },
    
    // Route colors
    routes: {
      calculated: '#76ff03',
      target: '#ffab00'
    },
    
    // Cluster colors (for driving navigation)
    clusters: [
      getCSSVariable('--primary', '#6366f1'),
      getCSSVariable('--secondary', '#64748b'),
      '#3f8cff',
      '#ff5470',
      '#faae2b',
      getCSSVariable('--primary-light', '#818cf8'),
      '#22c55e',
      '#d946ef',
      getCSSVariable('--secondary-light', '#94a3b8'),
      '#7dd3fc'
    ],
    
    // Live tracking speed colors
    liveTracking: {
      slow: '#10b981',    // Green
      medium: '#2196f3',  // Blue
      fast: getCSSVariable('--primary-dark', '#4f46e5')  // Indigo
    },
    
    // Custom places (visits)
    customPlaces: {
      fill: getCSSVariable('--primary-light', '#818cf8'),
      outline: getCSSVariable('--primary-light', '#818cf8'),
      highlight: '#F59E0B'
    }
  };

  /**
   * Map layer style configurations
   * Used for Leaflet polyline styles
   */
  const MAP_LAYER_STYLES = {
    trip: {
      default: {
        color: getCSSVariable('--primary-light', '#818cf8'),
        weight: 3,
        opacity: 0.8
      },
      selected: {
        color: '#FFD700',
        weight: 5,
        opacity: 1
      },
      reset: {
        color: getCSSVariable('--primary-light', '#818cf8'),
        weight: 3,
        opacity: 0.6
      }
    }
  };

  /**
   * Get cluster color by index
   * @param {number} index - Cluster index
   * @returns {string} Color hex value
   */
  function getClusterColor(index) {
    const colors = MAP_LAYER_COLORS.clusters;
    return colors[index % colors.length];
  }

  /**
   * Get trip style configuration
   * @param {string} state - Style state: 'default', 'selected', or 'reset'
   * @returns {Object} Style object with color, weight, opacity
   */
  function getTripStyle(state = 'default') {
    return MAP_LAYER_STYLES.trip[state] || MAP_LAYER_STYLES.trip.default;
  }

  // Export for both module and global contexts
  const mapStyles = {
    MAP_LAYER_COLORS,
    MAP_LAYER_STYLES,
    getClusterColor,
    getTripStyle,
    getCSSVariable
  };

  // Global export
  window.MapStyles = mapStyles;

  // Module export (if supported)
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = mapStyles;
  }
  if (typeof exports !== 'undefined') {
    exports.MapStyles = mapStyles;
  }
})(window);


