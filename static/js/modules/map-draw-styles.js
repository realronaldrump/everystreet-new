import MapStyles from "./map-styles.js";
import { readMapColor } from "./core/theme-tokens.js";

/**
 * Mapbox GL Draw layer styles in the map inks, for drawing place and area
 * boundaries.
 */
export function buildDrawStyles() {
  const colors = MapStyles.MAP_LAYER_COLORS.customPlaces;
  const halo = readMapColor("--basemap-halo");

  return [
    {
      id: "gl-draw-polygon-fill-inactive",
      type: "fill",
      filter: [
        "all",
        ["==", "$type", "Polygon"],
        ["!=", "mode", "static"],
        ["==", "active", "false"],
      ],
      paint: {
        "fill-color": colors.fill,
        "fill-opacity": 0.18,
      },
    },
    {
      id: "gl-draw-polygon-fill-active",
      type: "fill",
      filter: [
        "all",
        ["==", "$type", "Polygon"],
        ["!=", "mode", "static"],
        ["==", "active", "true"],
      ],
      paint: {
        "fill-color": colors.highlight,
        "fill-opacity": 0.2,
      },
    },
    {
      id: "gl-draw-polygon-stroke-inactive",
      type: "line",
      filter: [
        "all",
        ["==", "$type", "Polygon"],
        ["!=", "mode", "static"],
        ["==", "active", "false"],
      ],
      paint: {
        "line-color": colors.outline,
        "line-width": 3,
      },
    },
    {
      id: "gl-draw-polygon-stroke-active",
      type: "line",
      filter: [
        "all",
        ["==", "$type", "Polygon"],
        ["!=", "mode", "static"],
        ["==", "active", "true"],
      ],
      paint: {
        "line-color": colors.highlight,
        "line-width": 3,
      },
    },
    {
      id: "gl-draw-line-inactive",
      type: "line",
      filter: ["all", ["==", "$type", "LineString"], ["==", "active", "false"]],
      layout: {
        "line-cap": "round",
        "line-join": "round",
      },
      paint: {
        "line-color": colors.outline,
        "line-width": 3,
      },
    },
    {
      id: "gl-draw-line-active",
      type: "line",
      filter: ["all", ["==", "$type", "LineString"], ["==", "active", "true"]],
      layout: {
        "line-cap": "round",
        "line-join": "round",
      },
      paint: {
        "line-color": colors.highlight,
        "line-width": 3,
      },
    },
    {
      id: "gl-draw-polygon-midpoint",
      type: "circle",
      filter: ["all", ["==", "meta", "midpoint"], ["==", "$type", "Point"]],
      paint: {
        "circle-radius": 4,
        "circle-color": colors.highlight,
        "circle-stroke-width": 1,
        "circle-stroke-color": halo,
      },
    },
    {
      id: "gl-draw-polygon-vertex-inactive",
      type: "circle",
      filter: ["all", ["==", "meta", "vertex"], ["==", "$type", "Point"]],
      paint: {
        "circle-radius": 5,
        "circle-color": colors.outline,
        "circle-stroke-width": 1.5,
        "circle-stroke-color": halo,
      },
    },
    {
      id: "gl-draw-polygon-vertex-active-halo",
      type: "circle",
      filter: [
        "all",
        ["==", "meta", "vertex"],
        ["==", "$type", "Point"],
        ["==", "active", "true"],
      ],
      paint: {
        "circle-radius": 8,
        "circle-color": colors.highlight,
        "circle-stroke-width": 2,
        "circle-stroke-color": halo,
      },
    },
  ];
}
