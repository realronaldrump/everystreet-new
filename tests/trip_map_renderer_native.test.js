import assert from "node:assert/strict";
import test from "node:test";

import store from "../static/js/modules/core/store.js";
import tripMapRenderer, {
  describeRoadTrips,
} from "../static/js/modules/trip-map-renderer.js";

const originalLayers = {
  trips: structuredClone(store.mapLayers.trips),
  matchedTrips: structuredClone(store.mapLayers.matchedTrips),
};

function createMap(events) {
  const sources = new Map();
  const layers = [];
  const find = (id) => layers.find((layer) => layer.id === id) || null;
  return {
    layers,
    addSource(id, source) {
      const record = {
        ...source,
        setData(data) {
          record.data = data;
          events.push({ type: "setData", id });
        },
      };
      sources.set(id, record);
      events.push({ type: "addSource", id });
    },
    getSource(id) {
      return sources.get(id) || null;
    },
    removeSource(id) {
      sources.delete(id);
    },
    addLayer(layer, beforeId) {
      const record = { ...layer, layout: { ...layer.layout }, paint: { ...layer.paint } };
      const index = beforeId ? layers.findIndex((entry) => entry.id === beforeId) : -1;
      layers.splice(index >= 0 ? index : layers.length, 0, record);
      events.push({ type: "addLayer", id: layer.id });
    },
    getLayer: find,
    removeLayer(id) {
      layers.splice(layers.indexOf(find(id)), 1);
      events.push({ type: "removeLayer", id });
    },
    moveLayer(id, beforeId) {
      const layer = find(id);
      layers.splice(layers.indexOf(layer), 1);
      const index = beforeId ? layers.findIndex((entry) => entry.id === beforeId) : -1;
      layers.splice(index >= 0 ? index : layers.length, 0, layer);
    },
    setPaintProperty(id, property, value) {
      find(id).paint[property] = value;
    },
    setLayoutProperty(id, property, value) {
      find(id).layout[property] = value;
    },
    setFilter(id, filter) {
      find(id).filter = filter;
    },
    getStyle() {
      return { layers: [...layers] };
    },
    on(eventName, layerId, handler) {
      events.push({ type: "on", eventName, layerId, handler });
    },
    off(eventName, layerId) {
      events.push({ type: "off", eventName, layerId });
    },
    getCanvas() {
      return { style: {} };
    },
  };
}

function visible(map, id) {
  const layer = map.getLayer(id);
  return Boolean(layer) && layer.layout.visibility !== "none";
}

function tripState(trips = [{ id: "trip-1", start_time: "2026-01-01T12:00:00Z" }]) {
  return {
    bundle: { trip_count: trips.length, trips },
    decoded: {
      length: 1,
      positions: new Float64Array([-97.15, 31.55, -97.14, 31.55, -97.13, 31.56]),
      startIndices: new Uint32Array([0, 3]),
      tripIndices: new Uint32Array([0]),
    },
    heat: {
      length: 2,
      paths: new Uint32Array([0, 0]),
      starts: new Uint32Array([0, 1]),
      ends: new Uint32Array([1, 2]),
      frequencies: new Uint32Array([1, 64]),
      reference: 64,
    },
    pathIndicesByTrip: new Map([[0, [0]]]),
    tripById: new Map(trips.map((trip, index) => [trip.id, { trip, index }])),
    featureCollection: null,
    heatCollection: null,
  };
}

let events;

test.beforeEach(() => {
  events = [];
  tripMapRenderer.layers.clear();
  tripMapRenderer._suppressedBy.clear();
  tripMapRenderer._handlers.clear();
  tripMapRenderer._sourceData.clear();
  store.map = createMap(events);
  store.selectedTripId = null;
  store.selectedTripLayer = null;
  store.mapLayers.trips = { ...structuredClone(originalLayers.trips), visible: true };
  store.mapLayers.matchedTrips = {
    ...structuredClone(originalLayers.matchedTrips),
    visible: false,
  };
});

test.afterEach(() => {
  tripMapRenderer.layers.clear();
  store.map = null;
  store.selectedTripId = null;
  store.selectedTripLayer = null;
  store.mapLayers.trips = structuredClone(originalLayers.trips);
  store.mapLayers.matchedTrips = structuredClone(originalLayers.matchedTrips);
});

test("heat draws each run of a road in its trip count's colour", () => {
  store.mapLayers.trips.isHeatmap = true;
  tripMapRenderer.layers.set("trips", tripState());

  tripMapRenderer.render();

  const heat = store.map.getLayer("trips-layer-heat");
  assert.equal(heat.source, "trips-heat-source");
  assert.deepEqual(heat.layout["line-sort-key"], ["get", "h"]);
  const { features } = store.map.getSource("trips-heat-source").data;
  assert.deepEqual(
    features.map((feature) => feature.properties),
    [
      { transactionId: "trip-1", n: 1, h: 0 },
      { transactionId: "trip-1", n: 64, h: 1 },
    ]
  );
  assert.deepEqual(features[1].geometry.coordinates, [
    [-97.14, 31.55],
    [-97.13, 31.56],
  ]);
  assert.equal(store.map.getLayer("trips-layer"), null);
  assert.equal(store.map.getLayer("trips-hitbox").source, "trips-heat-source");
});

test("paths draw every trip, newest on top and oldest faded", () => {
  store.mapLayers.trips.isHeatmap = false;
  tripMapRenderer.layers.set(
    "trips",
    tripState([
      { id: "trip-1", start_time: "2025-01-01T12:00:00Z" },
      { id: "trip-2", start_time: "2026-01-01T12:00:00Z" },
    ])
  );

  tripMapRenderer.render();

  const paths = store.map.getLayer("trips-layer");
  assert.deepEqual(paths.layout["line-sort-key"], ["get", "r"]);
  assert.equal(paths.paint["line-opacity"][2][1], "r");
  const recency = tripMapRenderer
    .getFeatureCollection("trips")
    .features.map((feature) => feature.properties.r);
  assert.deepEqual(recency, [0]);
  assert.equal(tripMapRenderer.getTripFeature("trips", "trip-2").properties.r, 1);
  assert.equal(store.map.getLayer("trips-layer-heat"), null);
});

test("trips from a single outing do not fade", () => {
  tripMapRenderer.layers.set(
    "trips",
    tripState([
      { id: "trip-1", start_time: "2026-01-01T08:00:00Z" },
      { id: "trip-2", start_time: "2026-01-01T18:00:00Z" },
    ])
  );

  assert.equal(tripMapRenderer.getTripFeature("trips", "trip-1").properties.r, 1);
});

test("switching modes hides the other drawing without re-sending geometry", () => {
  store.mapLayers.trips.isHeatmap = true;
  tripMapRenderer.layers.set("trips", tripState());
  tripMapRenderer.render();
  tripMapRenderer.setUseHeatmap(false);
  tripMapRenderer.setUseHeatmap(true);
  tripMapRenderer.setUseHeatmap(false);

  assert.equal(events.filter((entry) => entry.type === "setData").length, 0);
  assert.equal(events.filter((entry) => entry.type === "addSource").length, 2);
  assert.ok(visible(store.map, "trips-layer"));
  assert.ok(!visible(store.map, "trips-layer-heat"));
  // The hitbox follows the drawing it sits on.
  assert.equal(store.map.getLayer("trips-hitbox").source, "trips-source");
});

test("matched trips always draw as paths above recorded heat", () => {
  store.mapLayers.trips.isHeatmap = true;
  store.mapLayers.matchedTrips.isHeatmap = true;
  store.mapLayers.matchedTrips.visible = true;
  tripMapRenderer.layers.set("trips", tripState());
  tripMapRenderer.layers.set("matchedTrips", tripState());

  tripMapRenderer.render();

  assert.ok(visible(store.map, "matchedTrips-layer"));
  assert.equal(store.map.getLayer("matchedTrips-layer-heat"), null);
  const order = store.map.layers.map((layer) => layer.id);
  assert.ok(order.indexOf("trips-layer-heat") < order.indexOf("matchedTrips-layer"));
  assert.equal(order.at(-1).endsWith("-hitbox"), true);
});

test("suppression hides trip layers and keeps their sources", () => {
  store.mapLayers.trips.isHeatmap = true;
  tripMapRenderer.layers.set("trips", tripState());
  tripMapRenderer.render();

  tripMapRenderer.suppressTripLayers("flow");
  assert.ok(!visible(store.map, "trips-layer-heat"));
  assert.ok(!visible(store.map, "trips-hitbox"));
  assert.ok(store.map.getSource("trips-heat-source"));

  tripMapRenderer.restoreTripLayers("flow");
  assert.ok(visible(store.map, "trips-layer-heat"));
  assert.equal(events.filter((entry) => entry.type === "setData").length, 0);
});

test("the selected trip prints above the trips on a paper casing", () => {
  store.mapLayers.trips.isHeatmap = true;
  tripMapRenderer.layers.set("trips", tripState());
  store.selectedTripId = "trip-1";
  store.selectedTripLayer = "trips";

  tripMapRenderer.render();

  const order = store.map.layers.map((layer) => layer.id);
  assert.ok(order.indexOf("trips-layer-heat") < order.indexOf("trip-map-selected-casing"));
  assert.ok(
    order.indexOf("trip-map-selected-casing") < order.indexOf("trip-map-selected-layer")
  );

  store.selectedTripId = null;
  tripMapRenderer.refreshSelection();
  assert.ok(!visible(store.map, "trip-map-selected-layer"));
});

test("a trip click selects the whole trip from the run under the pointer", () => {
  store.mapLayers.trips.isHeatmap = true;
  tripMapRenderer.layers.set("trips", tripState());
  tripMapRenderer.render();

  const click = events.find(
    (entry) => entry.type === "on" && entry.eventName === "click"
  );
  assert.equal(click.layerId, "trips-hitbox");
  const feature = tripMapRenderer.getTripFeature("trips", "trip-1", {
    lightweight: false,
  });
  assert.equal(feature.geometry.coordinates.length, 3);
});

test("the heat legend spans one trip to the reference on a log scale", () => {
  tripMapRenderer.layers.set("trips", tripState());

  assert.deepEqual(tripMapRenderer.getHeatLegend("trips").ticks, ["1", "8", "64+"]);
});

test("road trip counts read plainly", () => {
  assert.equal(describeRoadTrips(1), "1 trip");
  assert.equal(describeRoadTrips(7), "7 trips");
  assert.equal(describeRoadTrips(143), "About 140 trips");
  assert.equal(describeRoadTrips(1_667), "About 1,700 trips");
});

test("a style reload redraws the bundle it already has", async () => {
  const state = tripState();
  tripMapRenderer.layers.set("trips", state);
  let decodes = 0;
  const originalDecode = tripMapRenderer.decodeTrips;
  tripMapRenderer.decodeTrips = async () => {
    decodes += 1;
    return state.decoded;
  };
  try {
    const result = await tripMapRenderer.setLayerData("trips", state.bundle);
    assert.equal(result, state);
    assert.equal(decodes, 0);
  } finally {
    tripMapRenderer.decodeTrips = originalDecode;
  }
});
