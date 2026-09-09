import { createMap } from "../../map-core.js";
import {
  formatDateTime,
  formatDuration,
  formatMiles,
  formatSpeed,
  sanitizeLocation,
} from "../../utils.js";

export function tripGeometry(trip) {
  for (let value of [trip.matchedGps, trip.gps]) {
    try {
      if (typeof value === "string") value = JSON.parse(value);
      if (value?.type === "Feature") value = value.geometry;
      if (["LineString", "Point", "MultiLineString"].includes(value?.type))
        return value;
    } catch {
      /* A malformed optional trace must not hide the trip record. */
    }
  }
  return null;
}

export default async function initTripDetail({ api, signal, cleanup } = {}) {
  const root = document.getElementById("trip-detail");
  if (!root) return;
  const find = (id) => root.querySelector(`#trip-detail-${id}`);
  let map = null;
  const observer = new ResizeObserver(() => map?.resize());
  cleanup?.(() => {
    observer.disconnect();
    map?.remove();
    map = null;
  });
  try {
    const { trip } = await api.get(
      `/api/trips/${encodeURIComponent(root.dataset.tripId)}`,
      { cache: false }
    );
    if (signal?.aborted) return;
    if (!trip) throw new Error("This trip is unavailable.");
    find("date").textContent = formatDateTime(trip.startTime);
    find("journey").textContent =
      `${sanitizeLocation(trip.startLocation)} → ${sanitizeLocation(trip.destination)}`;
    const seconds = Math.max(
      0,
      (new Date(trip.endTime) - new Date(trip.startTime)) / 1000
    );
    for (const [label, value] of [
      ["Distance", formatMiles(trip.distance)],
      ["Duration", formatDuration(seconds)],
      ["Average speed", formatSpeed(trip.avgSpeed)],
      ["Top speed", formatSpeed(trip.maxSpeed)],
    ]) {
      const item = document.createElement("div");
      const term = document.createElement("dt");
      const description = document.createElement("dd");
      term.textContent = label;
      description.textContent = value;
      item.append(term, description);
      find("metrics").append(item);
    }
    find("body").hidden = false;
    find("status").hidden = true;
    find("share").addEventListener(
      "click",
      async () => {
        try {
          await navigator.clipboard.writeText(
            new URL(
              `/trips/${encodeURIComponent(root.dataset.tripId)}`,
              location.origin
            ).href
          );
          if (!signal?.aborted) find("share").textContent = "Link copied";
        } catch {
          if (!signal?.aborted) {
            find("status").hidden = false;
            find("status").textContent = "Copy the trip URL from your address bar.";
          }
        }
      },
      { signal }
    );
    const geometry = tripGeometry(trip);
    if (!geometry) {
      find("map").hidden = true;
      find("map-note").textContent = "No route trace was recorded for this trip.";
      return;
    }
    try {
      map = createMap("trip-detail-map", { center: [-98, 39], zoom: 3 });
      observer.observe(find("map"));
      const render = () => {
        if (signal?.aborted || !map || map.getSource("detail-trip")) return;
        map.addSource("detail-trip", {
          type: "geojson",
          data: { type: "Feature", properties: {}, geometry },
        });
        const isPoint = geometry.type === "Point";
        map.addLayer({
          id: "detail-trip",
          type: isPoint ? "circle" : "line",
          source: "detail-trip",
          paint: isPoint
            ? { "circle-radius": 7, "circle-color": "#c47050" }
            : { "line-width": 4, "line-color": "#c47050" },
        });
        const coordinates = isPoint
          ? [geometry.coordinates]
          : geometry.type === "MultiLineString"
            ? geometry.coordinates.flat()
            : geometry.coordinates;
        const bounds = coordinates.reduce(
          (box, [lng, lat]) => [
            Math.min(box[0], lng),
            Math.min(box[1], lat),
            Math.max(box[2], lng),
            Math.max(box[3], lat),
          ],
          [180, 90, -180, -90]
        );
        if (coordinates.length)
          map.fitBounds(
            [
              [bounds[0], bounds[1]],
              [bounds[2], bounds[3]],
            ],
            { padding: 40, maxZoom: 16, duration: 0 }
          );
        map.resize();
      };
      if (map.isStyleLoaded()) render();
      else map.once("load", render);
    } catch {
      find("map").hidden = true;
      find("map-note").textContent =
        "The map could not load. Your trip information is still available.";
    }
  } catch (error) {
    if (!signal?.aborted)
      find("status").textContent =
        error.status === 404
          ? "This trip no longer exists."
          : "This trip could not load. Close and reopen it to retry.";
  }
}
