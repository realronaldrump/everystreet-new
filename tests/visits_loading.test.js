import assert from "node:assert/strict";
import test from "node:test";
import VisitsPageController from "../static/js/modules/features/visits/visits-controller.js";
import { createVisitsDataService } from "../static/js/modules/visits/data-service.js";

function deferred() {
  let resolve;
  const promise = new Promise((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function page(service) {
  const controller = new VisitsPageController({ dataService: service });
  controller.elements = {};
  controller.renderPlaces = () => {};
  controller.renderPatterns = () => {};
  controller.processInitialPlaceDeepLink = () => {};
  controller.loadSuggestions = async () => {};
  controller.loadOtherStops = async () => {};
  controller.showSectionError = () => {};
  controller.clearSectionError = () => {};
  return controller;
}

test("places render before statistics finish and unknown counts are not zero", async () => {
  const stats = deferred();
  const controller = page({
    fetchPlaces: async () => [{ id: "1", name: "Park" }],
    fetchPlaceStatistics: () => stats.promise,
  });
  let rendered = 0;
  controller.renderPlaces = () => {
    rendered++;
  };
  const pending = controller.loadData();
  await new Promise(setImmediate);
  assert.equal(rendered, 1);
  assert.equal(controller.placesStats[0].totalVisits, null);
  stats.resolve([{ id: "1", totalVisits: 8 }]);
  await pending;
  assert.equal(controller.placesStats[0].totalVisits, 8);
});

test("failed statistics leave places usable with an explicit retry state", async () => {
  const controller = page({
    fetchPlaces: async () => [{ id: "1", name: "Park" }],
    fetchPlaceStatistics: async () => {
      throw new Error("offline");
    },
  });
  const errors = [];
  controller.showSectionError = (section) => errors.push(section);
  await controller.loadData();
  assert.equal(controller.places.length, 1);
  assert.equal(controller.placesStats[0].totalVisits, null);
  assert.ok(errors.includes("stats"));
});

test("superseded data and discovery requests cannot replace newer results", async () => {
  const oldPlaces = deferred();
  let calls = 0;
  const controller = page({
    fetchPlaces: () =>
      ++calls === 1 ? oldPlaces.promise : Promise.resolve([{ id: "new" }]),
    fetchPlaceStatistics: async () => [],
  });
  const old = controller.loadData();
  await controller.loadData();
  oldPlaces.resolve([{ id: "old" }]);
  await old;
  assert.equal(controller.places[0].id, "new");

  const stale = deferred();
  let suggestionCalls = 0;
  controller.fetchSuggestions = () =>
    ++suggestionCalls === 1
      ? stale.promise
      : Promise.resolve([{ suggestedName: "new", totalVisits: 6 }]);
  controller.renderSuggestions = () => {};
  const older = VisitsPageController.prototype.loadSuggestions.call(controller);
  await VisitsPageController.prototype.loadSuggestions.call(controller);
  stale.resolve([{ suggestedName: "old", totalVisits: 20 }]);
  await older;
  assert.equal(controller.suggestions[0].suggestedName, "new");
});

test("destroyed page ignores late data", async () => {
  const places = deferred();
  const controller = page({
    fetchPlaces: () => places.promise,
    fetchPlaceStatistics: async () => [],
  });
  const pending = controller.loadData();
  controller.destroyed = true;
  places.resolve([{ id: "late" }]);
  await pending;
  assert.equal(controller.places.length, 0);
});

test("place search and ordering are stable and do not mutate source", () => {
  const controller = page({});
  controller.placesStats = [
    { id: "b", name: "Beach", totalVisits: 2 },
    { id: "a", name: "Park", totalVisits: 8 },
    { id: "c", name: "Park West", totalVisits: null },
  ];
  controller.placeSearch = "park";
  assert.deepEqual(
    controller.getVisiblePlaces().map((x) => x.id),
    ["a", "c"]
  );
  controller.placeSearch = "";
  controller.placeSort = "name";
  assert.deepEqual(
    controller.getVisiblePlaces().map((x) => x.id),
    ["b", "a", "c"]
  );
  assert.equal(controller.placesStats[0].id, "b");
});

test("visit reads have a deadline even with a lifecycle signal and do not retry", async () => {
  let request;
  const service = createVisitsDataService({
    get: (_url, options) => {
      request = options;
      return Promise.resolve([]);
    },
  });
  const lifecycle = new AbortController();
  await service.fetchPlaces({ signal: lifecycle.signal, timeout: 5 });
  assert.equal(request.retry, false);
  await new Promise((resolve) => setTimeout(resolve, 15));
  assert.equal(request.signal.aborted, true);
  assert.equal(lifecycle.signal.aborted, false);
  await service.fetchPlaces({ signal: lifecycle.signal });
  lifecycle.abort();
  assert.equal(request.signal.aborted, true);
});

test("detail opens immediately, ignores an older selection, and never overwrites an edit draft", async (t) => {
  const oldBootstrap = global.bootstrap;
  const oldDocument = global.document;
  const nodes = new Map();
  const node = (id) => {
    if (!nodes.has(id))
      nodes.set(id, {
        textContent: "",
        innerHTML: "",
        style: {},
        value: "draft",
        addEventListener() {},
      });
    return nodes.get(id);
  };
  let opened = 0;
  global.bootstrap = {
    Modal: {
      getOrCreateInstance: () => ({
        show: () => {
          opened++;
        },
      }),
    },
  };
  global.document = { getElementById: node };
  t.after(() => {
    global.bootstrap = oldBootstrap;
    global.document = oldDocument;
  });
  const { default: Controller } = await import(
    "../static/js/modules/features/visits/visits-controller.js?detail-test"
  );
  const first = deferred();
  const controller = new Controller({
    dataService: {
      fetchPlaceDetailStatistics: (id) =>
        id === "first"
          ? first.promise
          : Promise.resolve({
              name: "Second",
              totalVisits: 1,
              averageTimeSpent: "1h",
              averageTimeSinceLastVisit: "N/A",
            }),
      fetchPlaceTrips: async () => ({ trips: [] }),
    },
  });
  controller._cleanupOrphanedModalState = () => {};
  controller._renderTimelineBatch = () => {};
  const pending = controller.showPlaceDetail("first");
  assert.equal(opened, 1);
  assert.match(node("modal-visit-timeline").innerHTML, /Loading/);
  await controller.showPlaceDetail("second");
  first.resolve({ name: "First", totalVisits: 5 });
  await pending;
  assert.equal(node("modal-place-name").textContent, "Second");
  assert.equal(node("edit-place-name").value, "draft");
});
