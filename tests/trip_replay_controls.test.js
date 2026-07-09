import assert from "node:assert/strict";
import test from "node:test";

import tripAnimator from "../static/js/modules/trip-animator.js";
import { haversineDistance } from "../static/js/modules/utils/geo-math.js";
import { readRepoFile, readStaticJs } from "./helpers/fs-smoke.js";

const originalAnimationFrame = global.requestAnimationFrame;
const originalCancelAnimationFrame = global.cancelAnimationFrame;

function createMapStub() {
  const sources = new Map();
  const layers = new Set();

  return {
    addLayer(layer) {
      layers.add(layer.id);
    },
    addSource(id, definition) {
      const source = {
        data: definition.data,
        setData(data) {
          this.data = data;
        },
      };
      sources.set(id, source);
    },
    easeTo() {},
    getLayer(id) {
      return layers.has(id) ? { id } : null;
    },
    getSource(id) {
      return sources.get(id) || null;
    },
  };
}

test.beforeEach(() => {
  tripAnimator._destroyed = false;
  global.requestAnimationFrame = () => 1;
  global.cancelAnimationFrame = () => {};
});

test.afterEach(() => {
  tripAnimator.stopDraw();
  tripAnimator.stopReplay();
  global.requestAnimationFrame = originalAnimationFrame;
  global.cancelAnimationFrame = originalCancelAnimationFrame;
});

test("trip replay duration uses slower meter-based timing", () => {
  const map = createMapStub();
  const coords = [
    [0, 0],
    [0.05, 0],
  ];

  tripAnimator.startReplay(map, coords);

  const totalDistance = haversineDistance(0, 0, 0, 0.05);
  const expectedDuration = Math.min(Math.max(totalDistance * 3, 8000), 60000);

  assert.ok(tripAnimator._replayState);
  assert.ok(Math.abs(tripAnimator._replayState.duration - expectedDuration) < 1);
  assert.ok(tripAnimator._replayState.duration > 15000);
});

test("trip selection controls keep default draw animation but remove redraw button", () => {
  const source = readStaticJs("modules", "features", "map", "index.js");

  assert.match(source, /animateRouteDraw\(mapInstance, coords, \{ duration: 2000 \}\)/);
  assert.match(source, /data-action="replay"/);
  assert.doesNotMatch(source, /data-action="draw"/);
  assert.doesNotMatch(source, /fa-pen-nib/);
});

test("trip replay shares the responsive map action tray with the view control", () => {
  const source = readStaticJs("modules", "features", "map", "index.js");
  const template = readRepoFile("templates", "partials", "_map_shell.html");
  const replayCss = readRepoFile("static", "css", "features", "map", "trip-replay.css");

  assert.match(
    template,
    /class="map-topbar-actions"[\s\S]*id="trip-replay-controls-slot"[\s\S]*class="map-view-control"/
  );
  assert.match(source, /getElementById\("trip-replay-controls-slot"\)/);
  assert.match(source, /replayControlsSlot\.appendChild\(el\)/);
  assert.doesNotMatch(replayCss, /\.replay-controls\s*\{[^}]*position:\s*absolute/s);
  assert.match(replayCss, /\.replay-btn\s*\{[^}]*min-height:\s*var\(--touch-target\)/s);
});
