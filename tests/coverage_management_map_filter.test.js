import assert from "node:assert/strict";
import test from "node:test";

import {
  getNextActiveMapFilters,
  getStatusFiltersForMapFilters,
  isAllMapFilterActive,
  normalizeActiveMapFilters,
} from "../static/js/modules/features/coverage-management/map-filter.js";

test("normalizeActiveMapFilters keeps all exclusive", () => {
  assert.deepEqual(normalizeActiveMapFilters([]), ["all"]);
  assert.deepEqual(normalizeActiveMapFilters(["driven", "all"]), ["all"]);
  assert.deepEqual(normalizeActiveMapFilters(["undriven", "driven"]), [
    "driven",
    "undriven",
  ]);
});

test("getNextActiveMapFilters switches from all to a single layer", () => {
  assert.deepEqual(getNextActiveMapFilters(["all"], "driven"), ["driven"]);
  assert.deepEqual(getNextActiveMapFilters(["all"], "undriven"), ["undriven"]);
});

test("getNextActiveMapFilters allows driven and undriven together", () => {
  assert.deepEqual(getNextActiveMapFilters(["driven"], "undriven"), [
    "driven",
    "undriven",
  ]);
  assert.deepEqual(getNextActiveMapFilters(["undriven"], "driven"), [
    "driven",
    "undriven",
  ]);
});

test("getNextActiveMapFilters keeps all exclusive and restores it when empty", () => {
  assert.deepEqual(getNextActiveMapFilters(["driven", "undriven"], "all"), ["all"]);
  assert.deepEqual(getNextActiveMapFilters(["driven", "undriven"], "driven"), [
    "undriven",
  ]);
  assert.deepEqual(getNextActiveMapFilters(["driven"], "driven"), ["all"]);
});

test("status helpers reflect all versus combined street-only filters", () => {
  assert.equal(isAllMapFilterActive(["all"]), true);
  assert.equal(isAllMapFilterActive(["driven", "undriven"]), false);
  assert.deepEqual(getStatusFiltersForMapFilters(["all"]), ["driven", "undriven"]);
  assert.deepEqual(getStatusFiltersForMapFilters(["driven", "undriven"]), [
    "driven",
    "undriven",
  ]);
});
