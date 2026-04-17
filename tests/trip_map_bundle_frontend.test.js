import assert from "node:assert/strict";
import test from "node:test";
import { decodeBundle } from "../static/js/modules/trip-map-worker.js";
import { readStaticJs } from "./helpers/fs-smoke.js";

function encodeDelta(value) {
  let normalized = value < 0 ? ~(value << 1) : value << 1;
  let output = "";
  while (normalized >= 0x20) {
    output += String.fromCharCode((0x20 | (normalized & 0x1f)) + 63);
    normalized >>= 5;
  }
  output += String.fromCharCode(normalized + 63);
  return output;
}

function encodePolyline6ForTest(coords) {
  let prevLat = 0;
  let prevLon = 0;
  let output = "";
  coords.forEach(([lon, lat]) => {
    const latInt = Math.round(lat * 1_000_000);
    const lonInt = Math.round(lon * 1_000_000);
    output += encodeDelta(latInt - prevLat);
    output += encodeDelta(lonInt - prevLon);
    prevLat = latInt;
    prevLon = lonInt;
  });
  return output;
}

test("trip map worker decodes full-detail bundle paths into binary buffers", () => {
  const path = encodePolyline6ForTest([
    [-97.1467, 31.5493],
    [-97.1461, 31.5499],
    [-97.1455, 31.5504],
  ]);

  const decoded = decodeBundle([
    {
      id: "trip-1",
      path,
    },
  ]);

  assert.equal(decoded.length, 1);
  assert.deepEqual([...decoded.startIndices], [0, 3]);
  assert.deepEqual([...decoded.tripIndices], [0]);
  assert.equal(decoded.positions.length, 6);
  assert.ok(Math.abs(decoded.positions[0] - -97.1467) < 1e-6);
  assert.ok(Math.abs(decoded.positions[1] - 31.5493) < 1e-6);
  assert.ok(Math.abs(decoded.positions[4] - -97.1455) < 1e-6);
  assert.ok(Math.abs(decoded.positions[5] - 31.5504) < 1e-6);
});

test("map route and data manager use deck-backed trip map bundles", () => {
  const routeLoader = readStaticJs("modules", "core", "route-loader.js");
  const dataManager = readStaticJs("modules", "data-manager.js");
  const config = readStaticJs("modules", "core", "config.js");
  const layerManager = readStaticJs("modules", "layer-manager.js");

  assert.match(
    routeLoader,
    /\["\/map",\s*"\.\.\/\.\.\/pages\/map\.js",\s*\["map",\s*"deck"\]\]/
  );
  assert.match(config, /tripMapBundle:\s*"\/api\/map\/trips\/bundle"/);
  assert.match(dataManager, /tripMapRenderer\.setLayerData\("trips",\s*bundle\)/);
  assert.match(
    readStaticJs("modules", "trip-map-renderer.js"),
    /id:\s*`\$\{layerName\}-trip-map-pick`/
  );
  assert.match(
    dataManager,
    /new URLSearchParams\(\{\s*start_date:\s*start,\s*end_date:\s*end,\s*mode:\s*"display"/s
  );
  assert.match(
    dataManager,
    /new URLSearchParams\(\{\s*start_date:\s*start,\s*end_date:\s*end,\s*mode:\s*"matched"/s
  );
  assert.doesNotMatch(dataManager, /updateMapLayer\("trips",\s*tripData\)/);
  assert.match(layerManager, /TripMapBundle/);
});
