import assert from "node:assert/strict";
import test from "node:test";

test("trip popup formats duration from numeric strings", async () => {
  const { default: tripInteractions } = await import(
    "../static/js/modules/trip-interactions.js"
  );

  const html = tripInteractions.createPopupContent({
    properties: {
      transactionId: "trip-1",
      duration: "345",
      distance: 12.5,
      avgSpeed: 42.3,
      maxSpeed: 58,
    },
  });

  assert.match(html, />5m 45s</);
  assert.doesNotMatch(html, /NaN/);
});

test("trip popup falls back to timestamps when duration is invalid", async () => {
  const { default: tripInteractions } = await import(
    "../static/js/modules/trip-interactions.js"
  );

  const html = tripInteractions.createPopupContent({
    properties: {
      transactionId: "trip-2",
      duration: "not-a-number",
      startTime: "2026-03-03T10:00:00Z",
      endTime: "2026-03-03T10:05:00Z",
      distance: 3.2,
    },
  });

  assert.match(html, />5m 0s</);
  assert.doesNotMatch(html, /NaN/);
});
