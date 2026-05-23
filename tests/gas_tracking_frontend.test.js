import assert from "node:assert/strict";
import test from "node:test";

import { readStaticJs } from "./helpers/fs-smoke.js";

test("gas tracking UI keeps missed-fill and odometer provenance workflows intact", () => {
  const source = readStaticJs("modules", "features", "gas-tracking", "index.js");

  assert.doesNotMatch(
    source,
    /missedPrevious\.disabled\s*=\s*disableMissed/,
    "partial fills must still be able to mark a missed previous fill-up"
  );
  assert.match(
    source,
    /clearAutoManagedOdometer\(\{\s*force:\s*true\s*\}\)/,
    "vehicle changes should clear stale auto-filled odometer values"
  );
  assert.match(
    source,
    /odometer_source:/,
    "fill-up saves should include odometer source"
  );
  assert.match(
    source,
    /odometer_is_estimated:/,
    "fill-up saves should include estimated odometer status"
  );
  assert.match(
    source,
    /setOdometerFromSource\(result\.estimated_odometer,\s*"estimated"/,
    "auto-calculated odometers should be marked as estimated"
  );
  assert.doesNotMatch(
    source,
    /setOdometerFromSource\(odoVal/,
    "vehicle-location odometer values should not auto-fill gas odometer"
  );
  assert.match(
    source,
    /Use estimate or enter odometer/,
    "gas form should steer odometer entry through manual input or estimates"
  );
});

test("vehicles UI stores Bouncie odometer overrides as untrusted", () => {
  const source = readStaticJs("modules", "features", "vehicles", "index.js");

  assert.match(
    source,
    /vehicle\.odometer_reading != null/,
    "vehicle odometer rendering should use null checks instead of truthiness"
  );
  assert.match(
    source,
    /data\.odometer != null/,
    "Bouncie odometer fetch should allow zero readings"
  );
  assert.match(
    source,
    /bouncie_untrusted/,
    "Bouncie overrides should use an untrusted source label"
  );
  assert.match(
    source,
    /odometer_is_estimated: isEstimated/,
    "vehicle odometer updates should persist estimated/untrusted status"
  );
});
