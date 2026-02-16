import assert from "node:assert/strict";
import test from "node:test";

const originalGlobals = {
  document: global.document,
  getComputedStyle: global.getComputedStyle,
  localStorage: global.localStorage,
};

let searchManager;
let apiClient;
let utils;

function createStorageMock() {
  const values = new Map();
  return {
    getItem(key) {
      return values.has(key) ? values.get(key) : null;
    },
    setItem(key, value) {
      values.set(key, String(value));
    },
    removeItem(key) {
      values.delete(key);
    },
    clear() {
      values.clear();
    },
    key(index) {
      return [...values.keys()][index] ?? null;
    },
    get length() {
      return values.size;
    },
  };
}

test.before(async () => {
  global.document = {
    documentElement: {},
    body: null,
    addEventListener() {},
    querySelector() {
      return null;
    },
    createElement() {
      return {
        className: "",
        style: {},
        setAttribute() {},
        appendChild() {},
      };
    },
  };
  global.getComputedStyle = () => ({
    getPropertyValue() {
      return "#123456";
    },
  });
  global.localStorage = createStorageMock();

  ({ default: searchManager } = await import("../static/js/modules/search-manager.js"));
  ({ default: apiClient } = await import("../static/js/modules/core/api-client.js"));
  ({ utils } = await import("../static/js/modules/utils.js"));
});

test.after(() => {
  global.document = originalGlobals.document;
  global.getComputedStyle = originalGlobals.getComputedStyle;
  global.localStorage = originalGlobals.localStorage;
});

function resetSearchManagerState() {
  searchManager.searchInput = { value: "" };
  searchManager.streetGeometryCache = new Map();
}

test("street result with geometry highlights directly", async () => {
  resetSearchManagerState();

  const originalHideResults = searchManager.hideResults;
  const originalHighlightStreet = searchManager.highlightStreet;
  const originalPanToLocation = searchManager.panToLocation;
  const originalAnnounce = utils.announce;

  let highlighted = 0;
  let panned = 0;

  searchManager.hideResults = () => {};
  searchManager.highlightStreet = async () => {
    highlighted += 1;
  };
  searchManager.panToLocation = () => {
    panned += 1;
  };
  utils.announce = () => {};

  try {
    await searchManager.selectResult({
      type: "street",
      name: "Main St",
      geometry: { type: "LineString", coordinates: [[-97.2, 31.4], [-97.1, 31.5]] },
    });
  } finally {
    searchManager.hideResults = originalHideResults;
    searchManager.highlightStreet = originalHighlightStreet;
    searchManager.panToLocation = originalPanToLocation;
    utils.announce = originalAnnounce;
  }

  assert.equal(highlighted, 1);
  assert.equal(panned, 0);
});

test("street result without geometry resolves via API, highlights, and caches", async () => {
  resetSearchManagerState();

  const originalHideResults = searchManager.hideResults;
  const originalHighlightStreet = searchManager.highlightStreet;
  const originalPanToLocation = searchManager.panToLocation;
  const originalAnnounce = utils.announce;
  const originalGetStorage = utils.getStorage;
  const originalApiGet = apiClient.get;

  let highlightedGeometryType = null;
  let panned = 0;
  let apiCalls = 0;
  let lastApiUrl = "";

  searchManager.hideResults = () => {};
  searchManager.highlightStreet = async (result) => {
    highlightedGeometryType = result.geometry?.type || null;
  };
  searchManager.panToLocation = () => {
    panned += 1;
  };
  utils.announce = () => {};
  utils.getStorage = () => "507f1f77bcf86cd799439011";
  apiClient.get = async (url) => {
    apiCalls += 1;
    lastApiUrl = url;
    return {
      feature: {
        type: "Feature",
        geometry: {
          type: "LineString",
          coordinates: [[-97.0, 31.0], [-96.9, 31.1]],
        },
        properties: { osm_id: 101, osm_type: "way" },
      },
      available: true,
      clipped: true,
    };
  };

  const result = {
    type: "street",
    name: "Elm Street",
    center: [-97.1, 31.5],
    osm_id: 101,
    osm_type: "way",
  };

  try {
    await searchManager.selectResult(result);
    await searchManager.selectResult(result);
  } finally {
    searchManager.hideResults = originalHideResults;
    searchManager.highlightStreet = originalHighlightStreet;
    searchManager.panToLocation = originalPanToLocation;
    utils.announce = originalAnnounce;
    utils.getStorage = originalGetStorage;
    apiClient.get = originalApiGet;
  }

  assert.equal(highlightedGeometryType, "LineString");
  assert.equal(panned, 0);
  assert.equal(apiCalls, 1);
  assert.ok(lastApiUrl.includes("/api/search/street-geometry"));
  assert.ok(lastApiUrl.includes("location_id=507f1f77bcf86cd799439011"));
});

test("unavailable resolved geometry falls back to silent pin behavior", async () => {
  resetSearchManagerState();

  const originalHideResults = searchManager.hideResults;
  const originalHighlightStreet = searchManager.highlightStreet;
  const originalPanToLocation = searchManager.panToLocation;
  const originalAnnounce = utils.announce;
  const originalGetStorage = utils.getStorage;
  const originalApiGet = apiClient.get;

  let highlighted = 0;
  let panOptions = null;

  searchManager.hideResults = () => {};
  searchManager.highlightStreet = async () => {
    highlighted += 1;
  };
  searchManager.panToLocation = (_result, options) => {
    panOptions = options;
  };
  utils.announce = () => {};
  utils.getStorage = () => "507f1f77bcf86cd799439011";
  apiClient.get = async () => ({
    feature: null,
    available: false,
    clipped: false,
  });

  try {
    await searchManager.selectResult({
      type: "street",
      name: "Fallback Street",
      center: [-97.1, 31.5],
      osm_id: 202,
      osm_type: "way",
    });
  } finally {
    searchManager.hideResults = originalHideResults;
    searchManager.highlightStreet = originalHighlightStreet;
    searchManager.panToLocation = originalPanToLocation;
    utils.announce = originalAnnounce;
    utils.getStorage = originalGetStorage;
    apiClient.get = originalApiGet;
  }

  assert.equal(highlighted, 0);
  assert.deepEqual(panOptions, { showNotification: false });
});

test("non-street place keeps normal pan behavior", async () => {
  resetSearchManagerState();

  const originalHideResults = searchManager.hideResults;
  const originalPanToLocation = searchManager.panToLocation;
  const originalAnnounce = utils.announce;

  let panCalled = false;
  let receivedOptions;

  searchManager.hideResults = () => {};
  searchManager.panToLocation = (_result, options) => {
    panCalled = true;
    receivedOptions = options;
  };
  utils.announce = () => {};

  try {
    await searchManager.selectResult({
      type: "place",
      name: "Austin",
      center: [-97.7431, 30.2672],
    });
  } finally {
    searchManager.hideResults = originalHideResults;
    searchManager.panToLocation = originalPanToLocation;
    utils.announce = originalAnnounce;
  }

  assert.equal(panCalled, true);
  assert.equal(receivedOptions, undefined);
});
