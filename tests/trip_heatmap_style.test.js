import assert from "node:assert/strict";
import test from "node:test";

import heatmapUtils from "../static/js/modules/heatmap-utils.js";

test("trip heatmap uses a three-stage thermal hierarchy", () => {
  const layers = heatmapUtils.generateTripHeatLayers(7_500, 1, "dark");

  assert.deepEqual(
    layers.map((layer) => layer.name),
    ["atmosphere", "body", "core"]
  );
  assert.equal(layers[0].paint["line-color"], heatmapUtils.COLORS.dark.halo);
  assert.equal(layers[1].paint["line-color"], heatmapUtils.COLORS.dark.glow);
  assert.equal(layers[2].paint["line-color"], heatmapUtils.COLORS.dark.core);
  assert.ok(
    layers[0].paint["line-width"].at(-1) > layers[1].paint["line-width"].at(-1)
  );
  assert.ok(
    layers[1].paint["line-width"].at(-1) > layers[2].paint["line-width"].at(-1)
  );
});
