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
});
