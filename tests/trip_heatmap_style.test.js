import assert from "node:assert/strict";
import test from "node:test";

import store from "../static/js/modules/core/store.js";
import heatmapUtils from "../static/js/modules/heatmap-utils.js";
import tripMapRenderer from "../static/js/modules/trip-map-renderer.js";

function zoomStop(expression, zoom) {
  const index = expression.indexOf(zoom);
  assert.notEqual(index, -1, `missing zoom ${zoom} stop`);
  return expression[index + 1];
}

function stopValues(expression) {
  return expression.slice(3).filter((_value, index) => index % 2 === 1);
}

/** Coverage reached after `passes` trips composite over the same road. */
function saturation(alpha, passes) {
  return 1 - (1 - alpha) ** passes;
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

test("tier alphas stay far enough apart to read as a ramp", () => {
  const [atmosphere, body, core] = heatmapUtils.generateTripHeatLayers(
    7_500,
    1,
    "dark"
  );

  // Tiers that saturate together collapse into one flat slab of colour.
  assert.ok(
    zoomStop(atmosphere.paint["line-opacity"], 12) >
      zoomStop(body.paint["line-opacity"], 12) * 1.5
  );
  assert.ok(
    zoomStop(body.paint["line-opacity"], 12) >
      zoomStop(core.paint["line-opacity"], 12) * 1.5
  );
});

test("a busy bundle keeps headroom for often-repeated roads", () => {
  const [, , core] = heatmapUtils.generateTripHeatLayers(7_500, 1, "dark");
  const alpha = zoomStop(core.paint["line-opacity"], 12);

  // A handful of passes must stay cool, or every driven street blows out to
  // the same pale core and the map stops showing frequency at all.
  assert.ok(saturation(alpha, 10) < 0.3, "ten passes already saturate the core");
  assert.ok(saturation(alpha, 120) > 0.6, "the hottest roads never reach the core");
});

test("a sparse bundle is legible on a single pass", () => {
  const layers = heatmapUtils.generateTripHeatLayers(3, 1, "dark");
  const combined = layers.reduce(
    (coverage, layer) =>
      coverage + (1 - coverage) * zoomStop(layer.paint["line-opacity"], 12),
    0
  );

  assert.ok(combined > 0.45, `one trip renders at ${combined}`);
});

test("heat traces never blur or thin into a dotted smear", () => {
  const layers = heatmapUtils.generateTripHeatLayers(7_500, 1, "dark");

  layers.forEach((layer) => {
    assert.equal(layer.paint["line-blur"], 0, `${layer.name} still blurs`);
    stopValues(layer.paint["line-width"]).forEach((width) => {
      assert.ok(
        width >= heatmapUtils.MIN_LINE_WIDTH,
        `${layer.name} drops to ${width}px`
      );
    });
  });
});

test("deck.gl tiers resolve to the values Mapbox interpolates", () => {
  const layers = heatmapUtils.generateTripHeatLayers(400, 0.8, "dark");

  [4, 12, 20].forEach((zoom) => {
    const tiers = heatmapUtils.tripHeatTiersAtZoom(400, 0.8, "dark", null, zoom);
    tiers.forEach((tier, index) => {
      const { paint } = layers[index];
      assert.equal(tier.color, paint["line-color"]);
      assert.equal(tier.width, zoomStop(paint["line-width"], zoom));
      assert.equal(tier.opacity, zoomStop(paint["line-opacity"], zoom));
    });
  });

  // Between stops the evaluator has to stay bracketed by its neighbours.
  const [midAtmosphere] = heatmapUtils.tripHeatTiersAtZoom(400, 0.8, "dark", null, 14);
  const width = layers[0].paint["line-width"];
  assert.ok(midAtmosphere.width > zoomStop(width, 12));
  assert.ok(midAtmosphere.width < zoomStop(width, 16));
});

test("deck.gl heat tiers mitre their joints instead of rounding them", () => {
  const originalDeck = globalThis.deck;
  const originalMap = store.map;
  globalThis.deck = {
    PathLayer: class PathLayer {
      constructor(props) {
        this.props = props;
      }
    },
  };
  store.map = null;

  try {
    const layers = tripMapRenderer.buildLayersForTripLayer(
      "trips",
      { ...store.mapLayers.trips, visible: true, isHeatmap: true, opacity: 1 },
      {
        bundle: { trip_count: 40, trips: [] },
        decoded: {
          length: 1,
          positions: new Float64Array([-97.1, 31.5, -97.2, 31.6]),
          startIndices: new Uint32Array([0, 2]),
          tripIndices: new Uint32Array([0]),
        },
        tripById: new Map(),
        featureCollection: null,
      }
    );

    assert.equal(layers.length, heatmapUtils.TRIP_HEAT_TIERS.length);
    layers.forEach((layer) => {
      // Rounded joints double the alpha at every GPS vertex, which is what
      // beads a translucent trace at regional zoom.
      assert.equal(layer.props.jointRounded, false);
      assert.equal(layer.props.capRounded, false);
      assert.equal(layer.props.widthMinPixels, heatmapUtils.MIN_LINE_WIDTH);
      // User opacity is already folded into each tier's alpha.
      assert.equal(layer.props.opacity, undefined);
    });

    // The widest tier carries picking; a 1px core is not a click target.
    assert.equal(layers[0].props.pickable, true);
    assert.equal(layers.at(-1).props.pickable, false);
  } finally {
    globalThis.deck = originalDeck;
    store.map = originalMap;
  }
});
