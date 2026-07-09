import assert from "node:assert/strict";
import test from "node:test";

import heatmapUtils from "../static/js/modules/heatmap-utils.js";

function zoomStop(expression, zoom) {
  const index = expression.indexOf(zoom);
  assert.notEqual(index, -1, `missing zoom ${zoom} stop`);
  return expression[index + 1];
}

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

test("large trip heatmaps remain legible at regional zoom", () => {
  const [atmosphere, body, core] = heatmapUtils.generateTripHeatLayers(
    7_500,
    1,
    "dark"
  );

  assert.ok(zoomStop(atmosphere.paint["line-width"], 8) >= 3);
  assert.ok(zoomStop(body.paint["line-width"], 8) >= 1.4);
  assert.ok(zoomStop(core.paint["line-width"], 8) >= 0.7);
  assert.ok(zoomStop(core.paint["line-opacity"], 8) >= 0.2);
});
