import assert from "node:assert/strict";
import test from "node:test";

import { readStaticJs, readTemplate } from "./helpers/fs-smoke.js";

test("settings toggles stay wired from template to bootstrap state", () => {
  const settingsHtml = readTemplate("control_center.html");
  const baseTemplate = readTemplate("base.html");
  const configSource = readStaticJs("modules", "core", "config.js");
  const appSettingsSource = readStaticJs(
    "modules",
    "features",
    "settings",
    "app-settings.js"
  );
  const appControllerSource = readStaticJs("modules", "app-controller.js");
  const layerManagerSource = readStaticJs("modules", "layer-manager.js");

  assert.match(settingsHtml, /id="map-trips-within-coverage-only"/);
  assert.match(settingsHtml, /id="trip-layers-use-heatmap"/);
  assert.match(settingsHtml, /Show Only Trips Inside Selected Coverage Area/);
  assert.match(settingsHtml, /Use Heatmap Style for Trips & Matched Trips/);

  assert.match(configSource, /mapTripsWithinCoverageOnly:\s*"mapTripsWithinCoverageOnly"/);
  assert.match(configSource, /tripLayersUseHeatmap:\s*"tripLayersUseHeatmap"/);

  assert.match(
    appSettingsSource,
    /document\.getElementById\(\s*"map-trips-within-coverage-only"\s*\)/
  );
  assert.match(
    appSettingsSource,
    /document\.getElementById\(\s*"trip-layers-use-heatmap"\s*\)/
  );
  assert.match(
    appSettingsSource,
    /localStorage\.setItem\(\s*CONFIG\.STORAGE_KEYS\.mapTripsWithinCoverageOnly,/
  );
  assert.match(
    appSettingsSource,
    /setTripLayerHeatmapPreference\(resolvedTripLayersUseHeatmap\)/
  );

  assert.match(baseTemplate, /APP_SETTINGS_FLAGS[\s\S]*mapTripsWithinCoverageOnly:/);
  assert.match(baseTemplate, /APP_SETTINGS_FLAGS[\s\S]*tripLayersUseHeatmap:/);
  assert.match(baseTemplate, /GOOGLE_MAPS_BOOTSTRAP/);
  assert.match(baseTemplate, /callback=__esGoogleMapsLoaded/);
  assert.match(baseTemplate, /data-google-maps-loader="true"/);

  assert.match(
    appControllerSource,
    /dataManager\.isCoverageTripClipPreferenceEnabled\(\)\s*\?\s*this\.refreshTripLayersForCoverageSelectionChange/
  );
  assert.match(
    appControllerSource,
    /layerManager\.setTripLayerRenderMode\(useHeatmap\)/
  );
  assert.match(layerManagerSource, /async setTripLayerRenderMode\(useHeatmap\)/);
});

test("trip fetching stays coverage-aware without wasting metric requests", () => {
  const source = readStaticJs("modules", "data-manager.js");

  assert.match(source, /_readCoverageTripClipPreference\(\)/);
  assert.match(source, /APP_SETTINGS_FLAGS\?\.mapTripsWithinCoverageOnly/);
  assert.match(
    source,
    /async fetchMetrics\(\)\s*\{\s*if\s*\(this\.getCoverageTripClipState\(\)\.enabled\)\s*\{\s*return null;\s*\}/s
  );

  const coverageAreaParamHits = (source.match(/params\.set\("coverage_area_id",/g) || [])
    .length;
  const clipFlagHits = (
    source.match(/params\.set\("clip_to_coverage",\s*"true"\)/g) || []
  ).length;

  assert.ok(
    coverageAreaParamHits >= 2,
    "coverage_area_id should be applied to both trip fetch methods"
  );
  assert.ok(
    clipFlagHits >= 2,
    "clip_to_coverage should be applied to both trip fetch methods"
  );
});

test("swup visit URLs are always treated as strings", () => {
  const navigationSource = readStaticJs("modules", "core", "navigation.js");
  const domUtilsSource = readStaticJs("modules", "utils", "dom.js");

  assert.match(navigationSource, /pathnameFromSwupUrl\(/);
  assert.doesNotMatch(navigationSource, /visit\?\.to\?\.url\?\.pathname/);
  assert.doesNotMatch(navigationSource, /visit\?\.to\?\.url\?\.href/);

  assert.match(domUtilsSource, /pathnameFromSwupUrl\(visit\?\.from\?\.url\)/);
  assert.doesNotMatch(domUtilsSource, /visit\?\.from\?\.url\?\.pathname/);
});
