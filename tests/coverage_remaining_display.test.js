import assert from "node:assert/strict";
import test from "node:test";
import metricAnimator from "../static/js/modules/ui/metric-animator.js";
import { setMetricValue } from "../static/js/modules/features/coverage-management/stats.js";

test("small remaining mileage stays visible instead of rounding to zero miles", () => {
  const document = globalThis.document;
  const animate = metricAnimator.animate;
  const element = { textContent: "" };
  globalThis.document = { getElementById: () => element };
  metricAnimator.animate = null;
  try {
    setMetricValue("remaining", 0.005, { decimals: 1, suffix: " mi" });
    assert.equal(element.textContent, "26 ft");
    setMetricValue("remaining", 0, { decimals: 1, suffix: " mi" });
    assert.equal(element.textContent, "0.0 mi");
    setMetricValue("segments", 2);
    assert.equal(element.textContent, "2");
  } finally {
    globalThis.document = document;
    metricAnimator.animate = animate;
  }
});
