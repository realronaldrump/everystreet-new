import assert from "node:assert/strict";
import test from "node:test";

import {
  createTripsTable,
  createVisitsTable,
} from "../static/js/modules/visits/table-factory.js";

function captureTable(t, factory, options = {}) {
  const element = {};
  const handlers = [];
  let config;
  const jquery = (target) => ({
    DataTable(value) {
      config = value;
      return { destroy() {} };
    },
    on(event, selector, handler) {
      handlers.push({ event, selector, handler });
      return this;
    },
    off() {
      return this;
    },
    addClass() {
      return this;
    },
    attr(name) {
      return target?.getAttribute?.(name);
    },
    closest() {
      return this;
    },
    data(name) {
      return target?.getAttribute?.(`data-${name}`);
    },
  });
  const previous = {
    document: globalThis.document,
    window: globalThis.window,
    $: globalThis.$,
  };
  globalThis.document = { getElementById: () => element };
  globalThis.window = { $: jquery };
  globalThis.$ = jquery;
  t.after(() => Object.assign(globalThis, previous));
  factory(options);
  return { config, handlers };
}

test("visit table sorts counts and durations numerically without display markup", (t) => {
  const { config } = captureTable(t, createVisitsTable);
  const count = config.columns[1].render;
  const duration = config.columns[4].render;
  assert.equal(count(20, "sort"), 20);
  assert.equal(count(3, "type"), 3);
  assert.equal(count(null, "sort"), -1);
  assert.equal(duration("2h 05m", "sort"), 7500);
  assert.equal(duration("50m", "type"), 3000);
  assert.doesNotMatch(duration("2h 05m", "filter"), /<i/);
});

test("visit table distinguishes pending statistics from confirmed zero visits", (t) => {
  const { config } = captureTable(t, createVisitsTable);
  const count = config.columns[1].render;
  assert.equal(count(null, "display"), "—");
  assert.equal(count(undefined, "filter"), "—");
  assert.match(count(0, "display"), />0<\/span>/);
  assert.equal(count(0, "sort"), 0);
  for (const index of [2, 3]) {
    assert.equal(config.columns[index].render(null, "display"), "—");
  }
});

test("visit table escapes place names and identifiers and supports keyboard clicks", (t) => {
  const selected = [];
  const { config, handlers } = captureTable(t, createVisitsTable, {
    onPlaceSelected: (id) => selected.push(id),
  });
  const name = '<img src=x onerror="bad()">';
  const markup = config.columns[0].render(name, "display", { id: '" onclick="bad()' });
  assert.doesNotMatch(markup, /<img|data-place-id="" onclick/);
  assert.match(markup, /&lt;img/);
  assert.match(markup, /<button\b[^>]*type="button"/);
  assert.equal(config.columns[0].render(name, "filter", {}), name);
  const click = handlers.find(({ event }) => event.startsWith("click"));
  assert.ok(click, "native click includes keyboard activation");
  const button = { getAttribute: () => "0012", dataset: { placeId: "0012" } };
  click.handler({ currentTarget: button, target: button, preventDefault() {} });
  assert.deepEqual(selected, ["0012"]);
});

test("visit tables defer off-page rows and avoid queued row animations", (t) => {
  const { config } = captureTable(t, createVisitsTable);
  assert.equal(config.deferRender, true);
  assert.equal(config.drawCallback, undefined);
});

test("trip table sorts arrival, departure and duration by actual values", (t) => {
  const { config } = captureTable(t, createTripsTable);
  const timestamp = "2026-09-21T23:59:00-06:00";
  for (const index of [1, 2, 3]) {
    const render = config.columns[index].render;
    assert.equal(render(timestamp, "sort"), Date.parse(timestamp));
    assert.equal(render(null, "sort"), 0);
    assert.equal(render("invalid", "display"), "N/A");
  }
  assert.equal(config.columns[4].render("1d 2h 05m", "sort"), 93900);
  assert.equal(config.columns[5].render("30m", "sort"), 1800);
  assert.equal(config.columns[6].orderable, false);
  assert.equal(config.columns[6].searchable, false);
});

test("trip table escapes trip identifiers and labels keyboard-operable actions", (t) => {
  const selected = [];
  const { config, handlers } = captureTable(t, createTripsTable, {
    onTripSelected: (id) => selected.push(id),
  });
  const id = '<img src=x onerror="bad()">';
  assert.doesNotMatch(config.columns[0].render(id, "display"), /<img/);
  const action = config.columns[6].render(null, "display", { transactionId: id });
  assert.match(action, /aria-label="View trip on map"/);
  assert.doesNotMatch(action, /data-trip-id="<img/);
  assert.equal(config.columns[6].render(null, "filter", {}), "");
  const click = handlers.find(({ event }) => event.startsWith("click"));
  assert.ok(click);
  const button = { getAttribute: () => "0012", dataset: { tripId: "0012" } };
  click.handler({ currentTarget: button, target: button, preventDefault() {} });
  assert.deepEqual(selected, ["0012"]);
});
