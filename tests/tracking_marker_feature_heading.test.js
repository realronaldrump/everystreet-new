import assert from "node:assert/strict";
import test from "node:test";

import { createMarkerFeature } from "../static/js/modules/features/tracking/ui.js";

test("createMarkerFeature always emits numeric heading", () => {
  const featureWithoutHeading = createMarkerFeature(
    [{ lon: -97.1, lat: 32.7 }],
    null,
    12
  );
  assert.equal(featureWithoutHeading.properties.heading, 0);

  const featureWithHeading = createMarkerFeature(
    [{ lon: -97.2, lat: 32.8 }],
    91.5,
    14
  );
  assert.equal(featureWithHeading.properties.heading, 91.5);
});
