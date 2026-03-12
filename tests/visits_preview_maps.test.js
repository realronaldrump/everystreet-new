import assert from "node:assert/strict";
import test from "node:test";

import { buildGeometryPreviewMarkup } from "../static/js/modules/visits/preview-map-renderer.js";
import { readStaticJs } from "./helpers/fs-smoke.js";

test("geometry preview renderer outputs inline svg for polygon boundaries", () => {
  const markup = buildGeometryPreviewMarkup(
    {
      type: "Polygon",
      coordinates: [
        [
          [-97.744, 30.267],
          [-97.742, 30.267],
          [-97.742, 30.269],
          [-97.744, 30.269],
          [-97.744, 30.267],
        ],
      ],
    },
    {
      fill: "#22b7a2",
      line: "#49d7c3",
    }
  );

  assert.match(markup, /<svg/);
  assert.match(markup, /data-preview-geometry="Polygon"/);
  assert.match(markup, /<path/);
  assert.doesNotMatch(markup, /mapboxgl/i);
});

test("visits controller renders preview cards without a hard preview-map cap", () => {
  const controllerSource = readStaticJs(
    "modules",
    "features",
    "visits",
    "visits-controller.js"
  );

  assert.match(controllerSource, /renderGeometryPreview\(/);
  assert.doesNotMatch(controllerSource, /MAX_ACTIVE_PREVIEW_MAPS/);
  assert.doesNotMatch(controllerSource, /Preview paused to keep map stable/);
});
