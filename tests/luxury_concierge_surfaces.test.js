import assert from "node:assert/strict";
import test from "node:test";

import { readStaticJs, readTemplate } from "./helpers/fs-smoke.js";

test("concierge status is the default control-center surface", () => {
  const html = readTemplate("control_center.html");
  const source = readStaticJs(
    "modules",
    "features",
    "settings",
    "control-center-overview.js"
  );

  assert.match(html, /Cartographic Concierge/);
  assert.match(html, /id="concierge-overall-label"/);
  assert.match(
    html,
    /<details class="diagnostics-drawer owner-only" id="diagnostics">/
  );
  assert.match(source, /\/api\/concierge\/status/);
});

test("atlas default surface hides coverage internals behind exception tools", () => {
  const html = readTemplate("coverage_management.html");
  const source = readStaticJs("modules", "features", "coverage-management", "index.js");

  assert.match(html, /Street Atlas/);
  assert.match(html, /id="atlas-next-action-title"/);
  assert.match(html, /class="sidebar-actions atlas-admin-tools owner-only"/);
  assert.match(html, /class="street-detail-actions atlas-edit-tools owner-only"/);
  assert.match(source, /\/atlas/);
});

test("journey garage and fuel pages lead with concierge surfaces", () => {
  const trips = readTemplate("trips.html");
  const vehicles = readTemplate("vehicles.html");
  const gas = readTemplate("gas_tracking.html");
  const tripsJs = readStaticJs("modules", "features", "trips", "index.js");
  const vehiclesJs = readStaticJs("modules", "features", "vehicles", "index.js");
  const gasJs = readStaticJs("modules", "features", "gas-tracking", "index.js");

  assert.match(trips, /class="journey-concierge"/);
  assert.match(trips, /<details class="journey-find-trip" id="journey-find-trip">/);
  assert.match(tripsJs, /\/api\/journey\/feed/);

  assert.match(vehicles, /Private Garage/);
  assert.match(vehicles, /class="garage-advanced owner-only"/);
  assert.match(vehiclesJs, /\/api\/garage\/summary/);

  assert.match(gas, /Fuel Concierge/);
  assert.match(gas, /class="form-section fuel-manual-entry"/);
  assert.match(gasJs, /\/api\/fuel\/suggestions/);
});
