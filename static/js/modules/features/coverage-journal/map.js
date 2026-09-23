/**
 * The journal's street map. Every street is loaded once; each view (driven
 * by a date, a milestone's additions, trip frequency, streets left, or a
 * selection) is a paint expression over that data, so switching views
 * never reloads streets.
 */

import { readMapColor } from "../../core/theme-tokens.js";
import { escapeHtml } from "../../utils.js";
import { formatDate } from "./format.js";

const SOURCE = "journal-streets";
const BASE_LAYER = "journal-streets-base";
const HIGHLIGHT_LAYER = "journal-streets-highlight";
// Streets never driven sort after every real timestamp.
const NEVER = 9e15;

function inks() {
  return {
    driven: readMapColor("--map-driven"),
    undriven: readMapColor("--map-undriven"),
    faint: readMapColor("--map-undriveable"),
    highlight: readMapColor("--map-route"),
  };
}

/** Give every portion a numeric first-driven time for paint expressions. */
export function prepareFeatures(geojson) {
  for (const feature of geojson?.features || []) {
    const props = feature.properties || (feature.properties = {});
    const time = Date.parse(props.first_driven_at || "");
    props.t = props.status === "driven" && Number.isFinite(time) ? time : NEVER;
    props.period_trip_count = Number(props.period_trip_count || 0);
  }
  return geojson;
}

export function createJournalMap(map, { onHover } = {}) {
  let view = { mode: "progress", until: NEVER - 1, since: null };
  let highlighted = [];
  let popup = null;

  function paint() {
    if (!map.getLayer(BASE_LAYER)) {
      return;
    }
    const ink = inks();
    const t = ["get", "t"];
    const undriveable = ["==", ["get", "status"], "undriveable"];
    let color;
    let width;
    let opacity;
    if (view.mode === "frequency") {
      const count = ["get", "period_trip_count"];
      color = ["case", [">", count, 0], ink.driven, ink.faint];
      width = [
        "interpolate",
        ["linear"],
        count,
        0,
        0.8,
        1,
        1.4,
        5,
        2.4,
        20,
        3.6,
        100,
        5.5,
      ];
      opacity = ["case", [">", count, 0], 0.95, 0.3];
    } else if (view.mode === "left") {
      const left = ["==", ["get", "status"], "undriven"];
      color = ["case", left, ink.undriven, ink.faint];
      width = ["case", left, 2.2, 1];
      opacity = ["case", left, 0.95, 0.35];
    } else if (view.mode === "selection") {
      color = ink.faint;
      width = 1;
      opacity = 0.4;
    } else {
      const driven = ["<=", t, view.until];
      const earlier = view.since === null ? false : ["<=", t, view.since];
      color = [
        "case",
        undriveable,
        ink.faint,
        earlier,
        ink.driven,
        driven,
        view.since === null ? ink.driven : ink.highlight,
        ink.undriven,
      ];
      width = ["case", undriveable, 1, earlier, 1.8, driven, 2.8, 1.3];
      opacity = ["case", undriveable, 0.35, earlier, 0.7, driven, 1, 0.7];
    }
    map.setPaintProperty(BASE_LAYER, "line-color", color);
    map.setPaintProperty(BASE_LAYER, "line-width", width);
    map.setPaintProperty(BASE_LAYER, "line-opacity", opacity);
    map.setPaintProperty(HIGHLIGHT_LAYER, "line-color", ink.highlight);
    map.setFilter(HIGHLIGHT_LAYER, [
      "in",
      ["get", "segment_id"],
      ["literal", view.mode === "selection" || view.mode === "left" ? highlighted : []],
    ]);
  }

  function install(geojson) {
    if (map.getSource(SOURCE)) {
      map.getSource(SOURCE).setData(geojson);
      paint();
      return;
    }
    map.addSource(SOURCE, { type: "geojson", data: geojson });
    map.addLayer({
      id: BASE_LAYER,
      type: "line",
      source: SOURCE,
      layout: { "line-cap": "round", "line-join": "round" },
    });
    map.addLayer({
      id: HIGHLIGHT_LAYER,
      type: "line",
      source: SOURCE,
      layout: { "line-cap": "round", "line-join": "round" },
      paint: { "line-width": 5, "line-opacity": 1 },
      filter: ["in", ["get", "segment_id"], ["literal", []]],
    });
    paint();
    map.on("mousemove", BASE_LAYER, (event) => {
      const props = event.features?.[0]?.properties;
      if (!props) {
        return;
      }
      map.getCanvas().style.cursor = "pointer";
      const name = props.street_name || "Unnamed road";
      const driven =
        Number(props.t) < NEVER
          ? `First driven ${formatDate(new Date(Number(props.t)).toISOString(), "short")}`
          : props.status === "undriveable"
            ? "Undriveable"
            : "Not driven yet";
      popup ||= new mapboxgl.Popup({
        closeButton: false,
        closeOnClick: false,
        className: "journal-map-popup",
        offset: 8,
      });
      popup
        .setLngLat(event.lngLat)
        .setHTML(`<strong>${escapeHtml(name)}</strong><span>${escapeHtml(driven)}</span>`)
        .addTo(map);
      onHover?.(props);
    });
    map.on("mouseleave", BASE_LAYER, () => {
      map.getCanvas().style.cursor = "";
      popup?.remove();
    });
  }

  return {
    install,
    paint,
    /** Streets driven by `until` (ms); with `since`, earlier ones print quieter. */
    showProgress(until, since = null) {
      view = { mode: "progress", until: until ?? NEVER - 1, since };
      paint();
    },
    showFrequency() {
      view = { mode: "frequency" };
      paint();
    },
    showLeft(ids = []) {
      view = { mode: "left" };
      highlighted = ids;
      paint();
    },
    showSelection(ids) {
      view = { mode: "selection" };
      highlighted = ids;
      paint();
    },
    get mode() {
      return view.mode;
    },
    remove() {
      popup?.remove();
    },
  };
}

/** Bounds of the given segments in a GeoJSON collection, or null. */
export function boundsOf(geojson, ids) {
  const wanted = new Set(ids);
  let bounds = null;
  for (const feature of geojson?.features || []) {
    if (!wanted.has(feature.properties?.segment_id)) {
      continue;
    }
    const geometry = feature.geometry || {};
    const lines =
      geometry.type === "MultiLineString" ? geometry.coordinates : [geometry.coordinates];
    for (const line of lines || []) {
      for (const [lon, lat] of line || []) {
        bounds = bounds
          ? [
              Math.min(bounds[0], lon),
              Math.min(bounds[1], lat),
              Math.max(bounds[2], lon),
              Math.max(bounds[3], lat),
            ]
          : [lon, lat, lon, lat];
      }
    }
  }
  return bounds;
}
