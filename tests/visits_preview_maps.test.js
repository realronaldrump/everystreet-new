import assert from "node:assert/strict";
import test from "node:test";

import { buildGeometryPreviewMarkup } from "../static/js/modules/visits/preview-map-renderer.js";
import { assertHasId, readStaticJs, readTemplate } from "./helpers/fs-smoke.js";

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
  assert.match(markup, /data-preview-background="grid"/);
  assert.match(markup, /<path/);
  assert.doesNotMatch(markup, /mapboxgl/i);
});

test("geometry preview renderer uses cached image background when available", () => {
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
    },
    {
      backgroundImageUrl: "/api/places/place-1/preview.png?v=abc&mode=card",
      previewBounds: [-97.746, 30.266, -97.74, 30.27],
    }
  );

  assert.match(markup, /data-preview-background="map"/);
  assert.match(markup, /data-layer="map-background"/);
  assert.match(
    markup,
    /href="\/api\/places\/place-1\/preview\.png\?v=abc&amp;mode=card"/
  );
  assert.doesNotMatch(markup, /data-layer="grid"/);
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

test("visits page keeps cached preview refresh controls wired", () => {
  const template = readTemplate("visits.html");
  const controllerSource = readStaticJs(
    "modules",
    "features",
    "visits",
    "visits-controller.js"
  );
  const dataServiceSource = readStaticJs("modules", "visits", "data-service.js");

  assertHasId(template, "refresh-place-previews", "visits template");
  assert.match(controllerSource, /refreshPlacePreviews/);
  assert.match(controllerSource, /previewImageUrl/);
  assert.match(controllerSource, /previewBounds/);
  assert.match(dataServiceSource, /\/api\/places\/previews\/backfill/);
});
