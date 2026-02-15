import assert from "node:assert/strict";
import test from "node:test";

import geolocationService from "../static/js/modules/geolocation-service.js";
import confirmationDialog from "../static/js/modules/ui/confirmation-dialog.js";
import loadingManager from "../static/js/modules/ui/loading-manager.js";

test("UI singletons are safe without a DOM", async () => {
  assert.equal(loadingManager.hasDom, false);
  assert.equal(loadingManager.show("Working..."), loadingManager);
  assert.equal(loadingManager.hide(), loadingManager);
  assert.equal(loadingManager.forceHide(), loadingManager);

  assert.equal(await confirmationDialog.show({ title: "Test" }), false);
  assert.equal(await confirmationDialog.prompt({}), null);
  await confirmationDialog.alert("Test");

  assert.equal(geolocationService.isSupported(), false);
  assert.equal(await geolocationService.requestPermission(), "prompt");
});
