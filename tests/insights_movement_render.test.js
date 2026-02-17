import assert from "node:assert/strict";
import test from "node:test";

class FakeClassList {
  constructor(initial = []) {
    this._values = new Set(initial);
  }

  add(...values) {
    values.forEach((value) => this._values.add(value));
  }

  remove(...values) {
    values.forEach((value) => this._values.delete(value));
  }

  contains(value) {
    return this._values.has(value);
  }

  toggle(value, force) {
    if (force === true) {
      this._values.add(value);
      return true;
    }
    if (force === false) {
      this._values.delete(value);
      return false;
    }
    if (this._values.has(value)) {
      this._values.delete(value);
      return false;
    }
    this._values.add(value);
    return true;
  }
}

class FakeElement {
  constructor(id = "") {
    this.id = id;
    this.innerHTML = "";
    this.textContent = "";
    this.hidden = false;
    this.disabled = false;
    this.dataset = {};
    this.clientWidth = 900;
    this.clientHeight = 520;
    this.classList = new FakeClassList();
    this._attrs = new Map();
    this._listeners = new Map();
    this._querySelectors = new Map();
  }

  addEventListener(type, handler) {
    const existing = this._listeners.get(type) || [];
    existing.push(handler);
    this._listeners.set(type, existing);
  }

  dispatch(type, event = {}) {
    const handlers = this._listeners.get(type) || [];
    const payload = {
      target: event.target || this,
      currentTarget: event.currentTarget || this,
      preventDefault() {},
      stopPropagation() {},
      ...event,
    };
    handlers.forEach((handler) => handler(payload));
  }

  setAttribute(name, value) {
    this._attrs.set(name, String(value));
  }

  getAttribute(name) {
    return this._attrs.get(name) || null;
  }

  querySelectorAll(selector) {
    return this._querySelectors.get(selector) || [];
  }

  setQuerySelectorAll(selector, value) {
    this._querySelectors.set(selector, value);
  }
}

class FakeDeck {
  static instances = [];

  constructor(props) {
    this.props = props;
    this.finalized = false;
    FakeDeck.instances.push(this);
  }

  setProps(nextProps) {
    this.props = {
      ...this.props,
      ...nextProps,
    };
  }

  finalize() {
    this.finalized = true;
  }
}

class FakeLayer {
  constructor(props = {}) {
    this.props = props;
    this.id = props.id || "";
  }
}

class FakePathLayer extends FakeLayer {
  constructor(props = {}) {
    super(props);
    this.kind = "PathLayer";
  }
}

class FakeTileLayer extends FakeLayer {
  constructor(props = {}) {
    super(props);
    this.kind = "TileLayer";
  }
}

class FakeBitmapLayer extends FakeLayer {
  constructor(props = {}) {
    super(props);
    this.kind = "BitmapLayer";
  }
}

class FakeMapView {
  constructor(props = {}) {
    this.props = props;
  }
}

class FakeWebMercatorViewport {
  constructor(props = {}) {
    this.props = props;
  }

  fitBounds(bounds) {
    const [[west, south], [east, north]] = bounds;
    return {
      longitude: (west + east) / 2,
      latitude: (south + north) / 2,
      zoom: 12,
    };
  }
}

function createPayload() {
  const topStreets = Array.from({ length: 12 }, (_, index) => {
    const idx = index + 1;
    return {
      street_name: `Street ${idx}`,
      street_key: `street-${idx}`,
      traversals: 30 - idx,
      times_driven: 30 - idx,
      trip_count: 4 + (idx % 3),
      distance_miles: 1.2 + idx * 0.1,
      paths: [
        [
          [-97.75 + idx * 0.001, 30.26 + idx * 0.001],
          [-97.73 + idx * 0.001, 30.27 + idx * 0.001],
        ],
      ],
    };
  });

  return {
    analyzed_trip_count: 24,
    trip_count: 24,
    profiled_trip_count: 24,
    synced_trips_this_request: 0,
    pending_trip_sync_count: 0,
    analysis_scope: {
      geometry_source: "matchedGps",
      street_ranking: "times_driven",
      segment_ranking: "times_driven",
    },
    validation: {
      warnings: [],
      errors: [],
      consistency: {},
    },
    map_center: {
      lon: -97.743,
      lat: 30.267,
      zoom: 11.8,
    },
    top_streets: topStreets,
    top_segments: [
      {
        segment_key: "segment-1",
        label: "Segment 1",
        traversals: 18,
        times_driven: 18,
        trip_count: 7,
        distance_miles: 0.8,
        paths: [
          [
            [-97.77, 30.26],
            [-97.74, 30.28],
          ],
        ],
      },
    ],
  };
}

function createEnvironment() {
  const elements = new Map();
  const movementPanels = [new FakeElement(), new FakeElement()];
  movementPanels[0].dataset.rankPanel = "streets";
  movementPanels[0].classList.add("movement-rank-card", "is-active");
  movementPanels[1].dataset.rankPanel = "segments";
  movementPanels[1].classList.add("movement-rank-card");

  const movementToggle = new FakeElement("movement-layer-toggle");
  const streetsToggle = new FakeElement();
  streetsToggle.dataset.movementLayer = "streets";
  streetsToggle.classList.add("toggle-btn", "active");
  const segmentsToggle = new FakeElement();
  segmentsToggle.dataset.movementLayer = "segments";
  segmentsToggle.classList.add("toggle-btn");
  movementToggle.setQuerySelectorAll("[data-movement-layer]", [streetsToggle, segmentsToggle]);

  const requiredIds = [
    "movement-layer-toggle",
    "movement-top-streets",
    "movement-top-segments",
    "movement-trip-count",
    "movement-feature-count",
    "movement-sync-state",
    "movement-map-caption",
    "movement-map",
    "movement-map-empty",
    "movement-streets-more",
    "movement-segments-more",
    "movement-detail-panel",
  ];

  requiredIds.forEach((id) => {
    elements.set(id, new FakeElement(id));
  });
  elements.set("movement-layer-toggle", movementToggle);

  const fakeDocument = {
    documentElement: {
      getAttribute() {
        return null;
      },
    },
    getElementById(id) {
      return elements.get(id) || null;
    },
    querySelector(selector) {
      if (selector === 'meta[name="mapbox-access-token"]') {
        return null;
      }
      return null;
    },
    querySelectorAll(selector) {
      if (selector === ".movement-rank-card[data-rank-panel]") {
        return movementPanels;
      }
      return [];
    },
    addEventListener() {},
  };

  const fakeWindow = {
    deck: {
      Deck: FakeDeck,
      PathLayer: FakePathLayer,
      TileLayer: FakeTileLayer,
      BitmapLayer: FakeBitmapLayer,
      MapView: FakeMapView,
      WebMercatorViewport: FakeWebMercatorViewport,
    },
  };

  return {
    elements,
    movementPanels,
    streetsToggle,
    segmentsToggle,
    document: fakeDocument,
    window: fakeWindow,
  };
}

const originalGlobals = {
  document: global.document,
  window: global.window,
};

let movementModule;

test.before(async () => {
  movementModule = await import("../static/js/modules/insights/movement.js");
});

test.after(() => {
  global.document = originalGlobals.document;
  global.window = originalGlobals.window;
});

test.afterEach(() => {
  movementModule.destroyMovementInsights();
  FakeDeck.instances.length = 0;
});

test("movement renders top 10 streets with progressive view-more and updates detail panel", () => {
  const env = createEnvironment();
  global.document = env.document;
  global.window = env.window;

  movementModule.bindMovementControls();
  movementModule.renderMovementInsights(createPayload());

  const streetsList = env.elements.get("movement-top-streets");
  const streetsMore = env.elements.get("movement-streets-more");
  const detailPanel = env.elements.get("movement-detail-panel");

  assert.equal((streetsList.innerHTML.match(/movement-rank-btn/g) || []).length, 10);
  assert.equal(streetsMore.hidden, false);

  streetsMore.dispatch("click");
  assert.equal((streetsList.innerHTML.match(/movement-rank-btn/g) || []).length, 12);

  streetsList.dispatch("click", {
    target: {
      closest(selector) {
        if (selector.includes("data-street-key")) {
          return {
            dataset: {
              streetKey: "street-1",
            },
          };
        }
        return null;
      },
    },
  });

  assert.match(detailPanel.innerHTML, /Street 1/);
  assert.match(detailPanel.innerHTML, /Times driven/);

  env.segmentsToggle.dispatch("click");
  assert.equal(env.movementPanels[0].classList.contains("is-active"), false);
  assert.equal(env.movementPanels[1].classList.contains("is-active"), true);
});

test("movement map creates path layers and keeps selection-linked layer updates", () => {
  const env = createEnvironment();
  global.document = env.document;
  global.window = env.window;

  movementModule.bindMovementControls();
  movementModule.renderMovementInsights(createPayload());

  assert.equal(FakeDeck.instances.length, 1);
  const deckInstance = FakeDeck.instances[0];
  assert.ok(
    deckInstance.props.layers.some((layer) => layer.kind === "PathLayer"),
    "expected at least one path layer"
  );

  env.segmentsToggle.dispatch("click");

  const segmentsList = env.elements.get("movement-top-segments");
  segmentsList.dispatch("click", {
    target: {
      closest(selector) {
        if (selector.includes("data-segment-key")) {
          return {
            dataset: {
              segmentKey: "segment-1",
            },
          };
        }
        return null;
      },
    },
  });

  const updatedLayers = deckInstance.props.layers || [];
  assert.ok(
    updatedLayers.some((layer) =>
      typeof layer.id === "string" ? layer.id.includes("selected") : false
    ),
    "expected selected highlight layer"
  );
  assert.match(env.elements.get("movement-detail-panel").innerHTML, /Segment 1/);
});
