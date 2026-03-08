import assert from "node:assert/strict";
import test from "node:test";

import { assertHasId, readStaticJs, readTemplate } from "./helpers/fs-smoke.js";

test("visits detail UI keeps its template and manager wiring aligned", () => {
  const templateSource = readTemplate("visits.html");
  const uiManagerSource = readStaticJs("modules", "visits", "visits-ui-manager.js");

  ["trips-section", "trips-for-place-table"].forEach((id) =>
    assertHasId(templateSource, id, "visits.html")
  );

  assert.match(
    uiManagerSource,
    /showTripsForPlace/,
    "visits-ui-manager.js should still open the trips table from the detail view"
  );
  assert.match(
    uiManagerSource,
    /document\.getElementById\("trips-section"\)/,
    "visits-ui-manager.js should keep the fallback trips container lookup"
  );
});

test("visits controller still supports deep links and modal lifecycle cleanup", () => {
  const controllerSource = readStaticJs(
    "modules",
    "features",
    "visits",
    "visits-controller.js"
  );

  assert.match(controllerSource, /get\(\s*["']place["']\s*\)/);
  assert.match(controllerSource, /get\(\s*["']place_name["']\s*\)/);
  assert.match(controllerSource, /this\.showPlaceDetail\(/);

  assert.match(
    controllerSource,
    /getElementById\("modal-edit-place"\)\s*\?\.\s*addEventListener\(\s*"click"/
  );
  assert.match(
    controllerSource,
    /getElementById\("modal-delete-place"\)\s*\?\.\s*addEventListener\(\s*"click"/
  );
  assert.match(controllerSource, /this\.activePlaceId\s*=\s*String\(placeId\)/);
  assert.match(controllerSource, /bootstrap\.Modal\.getOrCreateInstance\(modalEl\)/);
  assert.match(controllerSource, /_cleanupOrphanedModalState\(/);
  assert.match(controllerSource, /listenerAbortController\.abort\(\)/);
});

test("visits map editing flow still supports editing an existing place boundary", () => {
  const managerSource = readStaticJs("modules", "visits", "visits-manager.js");
  const drawingSource = readStaticJs("modules", "visits", "visits-drawing.js");

  assert.match(managerSource, /const placeBeingEdited = this\.drawing\.getPlaceBeingEdited\(\);/);
  assert.match(
    managerSource,
    /if\s*\(placeBeingEdited\)\s*{\s*return this\._saveEditedPlaceFromMap\(/s
  );
  assert.match(managerSource, /getElementById\("edit-place-modal"\)/);
  assert.match(managerSource, /scrollIntoView\?\.\(\{\s*behavior:\s*"smooth"/s);
  assert.match(managerSource, /this\.events\?\.\s*destroy\?\.\(\)/);
  assert.match(drawingSource, /_setSavePlaceFormVisible\(true\)/);
});
