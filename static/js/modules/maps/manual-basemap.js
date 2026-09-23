/**
 * Prints the Mapbox light and dark basemaps in the manual's inks.
 *
 * The stock styles are grey; the rest of the app is warm paper and ink. When
 * a light or dark style loads, each basemap layer is recoloured by what it
 * draws (land, water, roads, labels) from the --basemap-* tokens, so the map
 * reads like the plates on the home page. Satellite and street styles are
 * left as they are: someone who picks them wants that imagery.
 */

import { readMapColor } from "../core/theme-tokens.js";

const PRINTABLE_STYLE = /\b(light|dark)\b/i;
const UNPRINTABLE_STYLE = /satellite|streets/i;

const WATER = /water|ocean|lake|river|stream|canal|ditch|drain|reservoir/;
const GREEN =
  /park|wood|forest|grass|scrub|landcover|national|cemetery|golf|pitch|garden|wetland|nature|vegetation/;
const BUILDING = /building/;
const BOUNDARY = /admin|boundary/;
const RAIL = /rail|transit/;
const CASING = /case|casing|outline/;
const MAJOR_ROAD = /motorway|trunk|primary|highway|major/;
const ROAD =
  /road|street|bridge|tunnel|link|minor|secondary|tertiary|service|path|track|pedestrian|steps|ferry/;

function readInks() {
  const token = (name) => readMapColor(`--basemap-${name}`);
  return {
    paper: token("paper"),
    land: token("land"),
    green: token("green"),
    water: token("water"),
    waterLine: token("water-line"),
    building: token("building"),
    road: token("road"),
    roadMajor: token("road-major"),
    casing: token("casing"),
    rail: token("rail"),
    boundary: token("boundary"),
    label: token("label"),
    labelStrong: token("label-strong"),
    labelWater: token("label-water"),
    halo: token("halo"),
  };
}

function isPrintable(style) {
  const name = String(style?.name || "");
  if (UNPRINTABLE_STYLE.test(name) || !PRINTABLE_STYLE.test(name)) {
    return false;
  }
  return !Object.values(style?.sources || {}).some((source) =>
    String(source?.url || "").includes("satellite")
  );
}

/** Paint for one layer, or null to leave it alone. */
function paintFor(layer, ink) {
  const id = layer.id.toLowerCase();
  switch (layer.type) {
    case "background":
      return { "background-color": ink.paper };
    case "fill":
      if (WATER.test(id)) {
        return { "fill-color": ink.water };
      }
      if (BUILDING.test(id)) {
        return { "fill-color": ink.building, "fill-outline-color": ink.casing };
      }
      if (GREEN.test(id)) {
        return { "fill-color": ink.green };
      }
      return { "fill-color": ROAD.test(id) ? ink.road : ink.land };
    case "fill-extrusion":
      return { "fill-extrusion-color": ink.building };
    case "line":
      if (WATER.test(id)) {
        return { "line-color": ink.waterLine };
      }
      if (BOUNDARY.test(id)) {
        return { "line-color": ink.boundary };
      }
      if (RAIL.test(id)) {
        return { "line-color": ink.rail };
      }
      if (CASING.test(id)) {
        return { "line-color": ink.casing };
      }
      if (MAJOR_ROAD.test(id)) {
        return { "line-color": ink.roadMajor };
      }
      if (ROAD.test(id)) {
        return { "line-color": ink.road };
      }
      return null;
    case "symbol": {
      const strong = /settlement-major|country|state|city|place/.test(id);
      let color = strong ? ink.labelStrong : ink.label;
      if (WATER.test(id)) {
        color = ink.labelWater;
      }
      return {
        "text-color": color,
        "text-halo-color": ink.halo,
        "text-halo-width": 1.2,
      };
    }
    default:
      return null;
  }
}

/**
 * The layers the published style draws: its background and everything fed
 * by its vector tiles. Layers the app adds (streets, trips, places) come
 * from GeoJSON sources and keep their own inks, even when their ids match
 * a road or outline pattern.
 */
export function basemapLayers(style) {
  const sources = style?.sources || {};
  return (style?.layers || []).filter(
    (layer) => layer.type === "background" || sources[layer.source]?.type === "vector"
  );
}

export function printBasemap(map) {
  const style = map?.getStyle?.();
  if (!style || !isPrintable(style)) {
    return false;
  }
  const ink = readInks();
  if (!ink.paper) {
    return false;
  }
  for (const layer of basemapLayers(style)) {
    const paint = paintFor(layer, ink);
    if (!paint) {
      continue;
    }
    for (const [property, value] of Object.entries(paint)) {
      if (!value && value !== 0) {
        continue;
      }
      try {
        map.setPaintProperty(layer.id, property, value);
      } catch {
        // A layer without this property keeps its own paint.
      }
    }
  }
  return true;
}

function backgroundLayerId(style) {
  return style.layers?.find((layer) => layer.type === "background")?.id || null;
}

/**
 * True when a printable style is showing paint other than the current inks.
 * Paint can be set once the style itself has loaded; waiting for
 * isStyleLoaded() would also wait for every tile and show the stock style
 * first.
 */
function needsPrint(map) {
  try {
    const style = map.getStyle?.();
    if (!style || !isPrintable(style)) {
      return false;
    }
    const id = backgroundLayerId(style);
    if (!id) {
      return false;
    }
    return map.getPaintProperty(id, "background-color") !== readInks().paper;
  } catch {
    // The style is still loading; style.load will check again.
    return false;
  }
}

/**
 * Keep this map printed. Styles can be replaced or diffed back to their
 * stock paint (a theme switch, a style reload), so check again whenever the
 * style changes, the map settles, or the theme flips. The check reads one
 * paint property, so it is cheap enough to run on every idle.
 */
export function attachManualBasemap(map) {
  if (!map?.on) {
    return;
  }
  const refresh = () => {
    if (needsPrint(map)) {
      printBasemap(map);
    }
  };
  map.on("style.load", refresh);
  map.on("styledata", refresh);
  map.on("idle", refresh);
  document.addEventListener("themeChanged", refresh);
  map.on("remove", () => document.removeEventListener("themeChanged", refresh));
  refresh();
}
