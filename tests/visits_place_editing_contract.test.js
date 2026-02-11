import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..");

const controllerPath = path.join(
  root,
  "static",
  "js",
  "modules",
  "features",
  "visits",
  "visits-controller.js"
);

const managerPath = path.join(
  root,
  "static",
  "js",
  "modules",
  "visits",
  "visits-manager.js"
);

const drawingPath = path.join(
  root,
  "static",
  "js",
  "modules",
  "visits",
  "visits-drawing.js"
);

test("Visits detail modal wires edit/delete actions for selected place", () => {
  const controllerSource = fs.readFileSync(controllerPath, "utf8");

  assert.match(
    controllerSource,
    /getElementById\("modal-edit-place"\)\?\.addEventListener\("click"/,
    "visits-controller.js should register an edit handler on the place-detail modal"
  );

  assert.match(
    controllerSource,
    /getElementById\("modal-delete-place"\)\?\.addEventListener\("click"/,
    "visits-controller.js should register a delete handler on the place-detail modal"
  );

  assert.match(
    controllerSource,
    /this\.activePlaceId\s*=\s*String\(placeId\)/,
    "visits-controller.js should track which place is currently open in the detail modal"
  );
});

test("Visits map editing flow supports adjusting an existing place boundary", () => {
  const managerSource = fs.readFileSync(managerPath, "utf8");
  const drawingSource = fs.readFileSync(drawingPath, "utf8");

  assert.match(
    managerSource,
    /const placeBeingEdited = this\.drawing\.getPlaceBeingEdited\(\);/,
    "visits-manager.js should inspect drawing edit state when saving from map form"
  );

  assert.match(
    managerSource,
    /if\s*\(placeBeingEdited\)\s*{\s*return this\._saveEditedPlaceFromMap\(/s,
    "visits-manager.js should route map-form save actions to update when editing existing places"
  );

  assert.match(
    managerSource,
    /getElementById\("edit-place-modal"\)/,
    "visits-manager.js should interact with the edit modal when starting boundary edits"
  );

  assert.match(
    managerSource,
    /scrollIntoView\?\.\(\{\s*behavior:\s*"smooth"/s,
    "visits-manager.js should move the user to the map while editing place boundaries"
  );

  assert.match(
    drawingSource,
    /_setSavePlaceFormVisible\(true\)/,
    "visits-drawing.js should expose the save form during place-boundary editing"
  );
});
