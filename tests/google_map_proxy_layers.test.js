import assert from "node:assert/strict";
import test from "node:test";

import { createMapProxy } from "../static/js/modules/maps/google_map.js";

class MockPolyline {
  static instances = [];

  constructor(options = {}) {
    this.options = { ...options };
    this.map = options.map ?? null;
    this.listeners = new Map();
    this.setMapCalls = [];
    this.setOptionsCalls = [];
    MockPolyline.instances.push(this);
  }

  setMap(map) {
    this.map = map;
    this.setMapCalls.push(map);
  }

  setOptions(options = {}) {
    this.options = { ...this.options, ...options };
    this.setOptionsCalls.push(options);
  }

  addListener(eventName, handler) {
    const handlers = this.listeners.get(eventName) || [];
    handlers.push(handler);
    this.listeners.set(eventName, handlers);
    return {
      remove: () => {
        const current = this.listeners.get(eventName) || [];
        this.listeners.set(
          eventName,
          current.filter((candidate) => candidate !== handler)
        );
      },
    };
  }
}

class MockLatLngBounds {
  constructor() {
    this.points = [];
  }

  extend(point) {
    this.points.push(point);
  }
}

const createMockGoogleMap = () => {
  const listeners = new Map();
  return {
    zoom: 12,
    listeners,
    addListener(eventName, handler) {
      const handlers = listeners.get(eventName) || [];
      handlers.push(handler);
      listeners.set(eventName, handlers);
      return {
        remove: () => {
          const current = listeners.get(eventName) || [];
          listeners.set(
            eventName,
            current.filter((candidate) => candidate !== handler)
          );
        },
      };
    },
    getZoom() {
      return this.zoom;
    },
    getDiv() {
      return { style: {} };
    },
    setZoom(nextZoom) {
      this.zoom = nextZoom;
      const handlers = listeners.get("zoom_changed") || [];
      handlers.forEach((handler) => handler());
    },
  };
};

const tripFeatureCollection = {
  type: "FeatureCollection",
  features: [
    {
      type: "Feature",
      properties: { transactionId: "tx-1" },
      geometry: {
        type: "LineString",
        coordinates: [
          [-84.5, 33.7],
          [-84.4, 33.8],
        ],
      },
    },
  ],
};

test.beforeEach(() => {
  MockPolyline.instances = [];
  globalThis.google = {
    maps: {
      Polyline: MockPolyline,
      LatLngBounds: MockLatLngBounds,
      event: {
        addListenerOnce(target, eventName, handler) {
          const listener = target.addListener(eventName, (...args) => {
            handler(...args);
            listener.remove();
          });
          return listener;
        },
        trigger() {},
      },
    },
  };
});

test.afterEach(() => {
  delete globalThis.google;
});

test("google map proxy renders GeoJSON line layers and applies visibility", () => {
  const googleMap = createMockGoogleMap();
  const map = createMapProxy(googleMap);

  map.addSource("trips-source", {
    type: "geojson",
    data: tripFeatureCollection,
  });
  map.addLayer({
    id: "trips-layer",
    type: "line",
    source: "trips-source",
    layout: { visibility: "visible" },
    paint: {
      "line-color": "#ff3300",
      "line-opacity": 0.65,
      "line-width": 3,
    },
  });

  assert.equal(MockPolyline.instances.length, 1);
  const polyline = MockPolyline.instances[0];
  assert.equal(polyline.options.strokeColor, "#ff3300");
  assert.equal(polyline.options.strokeOpacity, 0.65);
  assert.equal(polyline.options.strokeWeight, 3);
  assert.equal(polyline.map, googleMap);

  map.setLayoutProperty("trips-layer", "visibility", "none");
  assert.equal(polyline.map, null);

  map.setLayoutProperty("trips-layer", "visibility", "visible");
  assert.equal(polyline.map, googleMap);
});

test("google map proxy re-renders source updates and evaluates zoom style expressions", () => {
  const googleMap = createMockGoogleMap();
  const map = createMapProxy(googleMap);

  map.addSource("trips-source", {
    type: "geojson",
    data: tripFeatureCollection,
  });
  map.addLayer({
    id: "trips-layer",
    type: "line",
    source: "trips-source",
    layout: { visibility: "visible" },
    paint: {
      "line-color": "#b87a4a",
      "line-width": ["interpolate", ["linear"], ["zoom"], 10, 2, 18, 6],
      "line-opacity": ["interpolate", ["linear"], ["zoom"], 10, 0.3, 18, 0.9],
    },
  });

  assert.equal(MockPolyline.instances.length, 1);
  const firstPolyline = MockPolyline.instances[0];
  assert.equal(firstPolyline.options.strokeWeight, 3);
  assert.equal(firstPolyline.options.strokeOpacity, 0.45);

  googleMap.setZoom(18);
  assert.ok(firstPolyline.options.strokeWeight > 5.9);
  assert.ok(firstPolyline.options.strokeOpacity > 0.89);

  map.getSource("trips-source").setData({
    type: "FeatureCollection",
    features: [
      tripFeatureCollection.features[0],
      {
        type: "Feature",
        properties: { transactionId: "tx-2" },
        geometry: {
          type: "LineString",
          coordinates: [
            [-84.3, 33.9],
            [-84.2, 34.0],
          ],
        },
      },
    ],
  });

  assert.equal(firstPolyline.map, null);
  assert.equal(MockPolyline.instances.length, 3);
});
