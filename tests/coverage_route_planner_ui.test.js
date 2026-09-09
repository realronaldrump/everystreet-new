import assert from "node:assert/strict";
import test from "node:test";
import { OptimalRouteUI } from "../static/js/modules/optimal-route/ui.js";
import {
  setPlannerView,
  revealPlannerSection,
} from "../static/js/modules/features/coverage-route-planner/ui-scaffold.js";

// A bounded in-memory DOM: no app startup, map SDK, network or services.
class Element {
  constructor() {
    this.style = {};
    this.dataset = {};
    this.attributes = {};
    this.children = [];
    this.hidden = false;
    this.disabled = false;
    this.textContent = "";
    this.classes = new Set();
    this.classList = {
      toggle: (name, on) => (on ? this.classes.add(name) : this.classes.delete(name)),
      remove: (name) => this.classes.delete(name),
      contains: (name) => this.classes.has(name),
    };
  }
  setAttribute(name, value) {
    this.attributes[name] = value;
  }
  getAttribute(name) {
    return this.attributes[name];
  }
  querySelector() {
    return null;
  }
  querySelectorAll() {
    return [];
  }
  appendChild(child) {
    this.children.push(child);
  }
  replaceChildren(...children) {
    this.children = children;
  }
  scrollIntoView() {
    this.scrolled = true;
  }
  focus() {
    this.focused = true;
  }
}
let nodes;
let ui;
let previous;
test.beforeEach(() => {
  previous = {
    document: global.document,
    window: global.window,
    CustomEvent: global.CustomEvent,
  };
  nodes = new Map();
  global.document = {
    getElementById: (id) => {
      if (!nodes.has(id)) nodes.set(id, new Element());
      return nodes.get(id);
    },
    querySelector: (selector) =>
      selector === ".coverage-route-planner" ? null : document.getElementById(selector),
    createElement: () => new Element(),
    dispatchEvent: () => {},
  };
  global.window = { matchMedia: () => ({ matches: true }) };
  global.CustomEvent = class {
    constructor(type, init) {
      this.type = type;
      this.detail = init?.detail;
    }
  };
  ui = new OptimalRouteUI({ areaSelectId: "area-select", populateAreaSelect: true });
});
test.afterEach(() => {
  ui.stopElapsedTimer();
  Object.assign(global, previous);
});
const node = (id) => document.getElementById(id);

test("area loading distinguishes retryable errors from an empty account", () => {
  ui.setAreaLoadState("error");
  assert.equal(node("area-load-feedback").hidden, false);
  assert.equal(node("retry-areas-btn").hidden, false);
  assert.equal(node("create-area-link").hidden, true);
  assert.equal(ui.areaSelect.disabled, true);
  ui.populateAreaSelect([]);
  assert.equal(node("retry-areas-btn").hidden, true);
  assert.equal(node("create-area-link").hidden, false);
  ui.populateAreaSelect([
    { id: "a", display_name: "Aspen, Pitkin County", coverage_percentage: 25 },
  ]);
  assert.equal(node("area-load-feedback").hidden, true);
  assert.equal(ui.areaSelect.disabled, false);
  assert.match(ui.areaSelect.children[0].textContent, /25.0% driven/);
});

test("selection updates map context, real coverage, and clears cleanly", () => {
  ui.updateAreaStats({
    display_name: "Aspen, Pitkin County",
    coverage_percentage: 25,
    driven_length_miles: 5,
    driveable_length_miles: 20,
    total_segments: 120,
  });
  assert.equal(node("map-area-name").textContent, "Aspen");
  assert.equal(node("map-empty-state").hidden, true);
  assert.equal(node("area-remaining").textContent, "15.00 mi");
  assert.equal(node("area-coverage").textContent, "25.0%");
  assert.equal(node("donut-driven-arc").style.strokeDashoffset, String(201.06 * 0.75));
  ui.updateAreaStats(null);
  ui.setGenerateState("idle");
  assert.equal(node("map-empty-state").hidden, false);
  assert.equal(node("fit-area-btn").disabled, true);
  assert.equal(node("generate-route-btn").disabled, true);
});

test("complete areas cannot generate a route and active work has a distinct state", () => {
  ui.updateAreaStats({
    display_name: "Done",
    is_complete: true,
    coverage_percentage: 100,
  });
  ui.setGenerateState("ready");
  assert.equal(node("generate-route-btn").dataset.state, "complete");
  assert.equal(node("generate-route-btn").disabled, true);
  ui.updateAreaStats({ display_name: "Working", is_complete: false });
  ui.showProgressSection();
  assert.equal(node("generate-route-btn").dataset.state, "working");
  assert.equal(node("generate-route-btn").disabled, true);
  assert.equal(node("section-planner").scrolled, true);
  ui.showError("Try again");
  assert.equal(node("route-progress-inline").style.display, "none");
  assert.equal(node("error-message").textContent, "Try again");
});

test("results identify selected streets, disclose changed coverage, and offer the exact route", () => {
  ui.showResults({
    route_id: "cluster-1",
    kind: "cluster",
    coverage_changed: true,
    total_distance_m: 1609.344,
    required_distance_m: 1207.008,
    deadhead_distance_m: 402.336,
    deadhead_percentage: 25,
  });
  assert.equal(node("stat-total-distance").textContent, "1.00 mi");
  assert.equal(node("stat-deadhead-percent").textContent, "75.0%");
  assert.match(node("route-result-meta").textContent, /Selected street route/);
  assert.equal(node("route-coverage-note").hidden, false);
  assert.equal(node("start-live-navigation-btn").disabled, false);
  assert.equal(node("section-results").scrolled, true);
});

test("saved routes are keyboard buttons and escape area names", () => {
  ui.updateSavedRoutes(
    [{ id: "1", display_name: "<Town>", has_optimal_route: true }],
    () => {}
  );
  assert.match(node("route-history").innerHTML, /<button type="button"/);
  assert.match(node("route-history").innerHTML, /&lt;Town&gt;/);
  assert.equal(node("saved-route-count").textContent, "1");
});

test("mobile plan/map switching removes obscured controls from keyboard access", () => {
  const root = new Element();
  const map = new Element();
  root.querySelector = () => map;
  document.querySelector = () => root;
  const toggle = node("mobile-panel-toggle");
  const label = new Element();
  toggle.querySelector = () => label;
  setPlannerView("map");
  assert.equal(root.dataset.view, "map");
  assert.equal(node("control-panel").inert, true);
  assert.equal(map.inert, false);
  assert.equal(toggle.getAttribute("aria-label"), "Back to plan");
  revealPlannerSection("section-results", { focus: true });
  assert.equal(root.dataset.view, "plan");
  assert.equal(node("control-panel").inert, false);
  assert.equal(map.inert, true);
  assert.equal(node("section-results").focused, true);
  window.matchMedia = () => ({ matches: false });
  setPlannerView("map");
  assert.equal(node("control-panel").inert, false);
  assert.equal(map.inert, false);
});
