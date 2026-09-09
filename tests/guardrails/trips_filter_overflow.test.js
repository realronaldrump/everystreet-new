import assert from "node:assert/strict";
import test from "node:test";

import { readRepoFile } from "../helpers/fs-smoke.js";

const tripsCss = readRepoFile("static", "css", "trips.css");

function cssRule(selector) {
  const start = tripsCss.indexOf(`${selector} {`);
  assert.notEqual(start, -1, `missing CSS rule for ${selector}`);

  const end = tripsCss.indexOf("}", start);
  assert.notEqual(end, -1, `unterminated CSS rule for ${selector}`);
  return tripsCss.slice(start, end + 1);
}

test("open trips vehicle filter can escape its clipping ancestors", () => {
  const searchSection = cssRule(".trips-search-section");
  const filtersPanel = cssRule("#trips-filters-panel");
  const openFiltersPanel = cssRule("#trips-filters-panel.is-open");

  assert.match(
    searchSection,
    /overflow:\s*visible;/,
    "the search section must not clip the native vehicle menu"
  );
  assert.match(
    filtersPanel,
    /overflow:\s*hidden;/,
    "the collapsed panel must still hide its contents"
  );
  assert.match(
    openFiltersPanel,
    /overflow:\s*visible;/,
    "the open panel must let the native vehicle menu expand past its box"
  );
});
