import assert from "node:assert/strict";
import test from "node:test";
import { mergeStreetFeatures } from "../static/js/modules/features/coverage-journal/map-features.js";

const part = (street, portion, status) => ({
  id: `${street}-${portion}`,
  properties: { segment_id: street, status },
});

test("viewport merges retain every covered and uncovered portion", () => {
  const incoming = [part("A", 0, "driven"), part("A", 1, "undriven")];
  const previous = [part("B", 0, "driven")];
  assert.deepEqual(mergeStreetFeatures(previous, incoming), [...previous, ...incoming]);
});

test("fresh street coverage replaces obsolete portions without losing other selections", () => {
  const previous = [
    part("A", 0, "driven"),
    part("A", 1, "undriven"),
    part("B", 0, "driven"),
  ];
  const incoming = [part("A", 0, "driven")];
  assert.deepEqual(mergeStreetFeatures(previous, incoming), [previous[2], ...incoming]);
  assert.equal(previous.length, 3);
});
