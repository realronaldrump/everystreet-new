import assert from "node:assert/strict";
import test from "node:test";

import { buildBreadcrumbItems } from "../static/js/modules/core/navigation.js";

test("top-level routes produce only their own breadcrumb item", () => {
  assert.deepEqual(buildBreadcrumbItems("/trips"), [{ path: "/trips", label: "Trips" }]);
  assert.deepEqual(buildBreadcrumbItems("/control-center"), [
    { path: "/control-center", label: "Settings" },
  ]);
});

test("detail routes produce parent and current breadcrumb items", () => {
  assert.deepEqual(buildBreadcrumbItems("/trips/abc123"), [
    { path: "/trips", label: "Trips" },
    { path: "/trips/abc123", label: "Trip Details" },
  ]);

  assert.deepEqual(buildBreadcrumbItems("/routes/route-42"), [
    { path: "/routes", label: "Recurring Routes" },
    { path: "/routes/route-42", label: "Route Details" },
  ]);
});

test("breadcrumb paths are route-derived rather than query or hash derived", () => {
  assert.deepEqual(buildBreadcrumbItems("/trips/abc123?from=/map#details"), [
    { path: "/trips", label: "Trips" },
    { path: "/trips/abc123", label: "Trip Details" },
  ]);
});
