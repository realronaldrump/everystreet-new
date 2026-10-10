import assert from "node:assert/strict";
import test from "node:test";

import {
  buildCandidateMarkup,
  candidateLabel,
  describeSearchResult,
} from "../static/js/modules/features/coverage-management/validation.js";

const county = {
  display_name: "Garfield County, Colorado, United States",
  name: "Garfield County",
  context: "Colorado",
  kind: "county",
  kind_label: "County",
  has_boundary: true,
  type_match: true,
};

test("candidate cards show the place name, where it is, and its kind", () => {
  const markup = buildCandidateMarkup(county, 0);

  assert.match(markup, /class="candidate-title">Garfield County</);
  assert.match(markup, /class="candidate-context">Colorado</);
  assert.match(markup, /badge-kind">County</);
  assert.doesNotMatch(markup, /relation|way|node/);
  assert.doesNotMatch(markup, /Approximate boundary/);
});

test("candidate cards flag places without a mapped boundary", () => {
  const markup = buildCandidateMarkup(
    { ...county, name: "Cardiff", kind_label: "Hamlet", has_boundary: false },
    2
  );

  assert.match(markup, /data-candidate-index="2"/);
  assert.match(markup, /Approximate boundary/);
});

test("candidate cards escape place names", () => {
  const markup = buildCandidateMarkup({ ...county, name: "<b>X</b>" }, 0);

  assert.doesNotMatch(markup, /<b>X<\/b>/);
});

test("candidateLabel names the place with its state", () => {
  assert.equal(candidateLabel(county), "Garfield County, Colorado");
  assert.equal(
    candidateLabel({ name: "Waco", context: "McLennan County, Texas" }),
    "Waco, Texas"
  );
  assert.equal(candidateLabel({ name: "Texas", context: "" }), "Texas");
});

test("describeSearchResult tells the user what to do next", () => {
  assert.match(describeSearchResult([], "county"), /No areas found/);
  assert.equal(describeSearchResult([county], "county"), "Found 1 county.");
  assert.equal(
    describeSearchResult([county, county], "county"),
    "Found 2 counties. Pick the one you mean."
  );
  assert.match(
    describeSearchResult([{ ...county, type_match: false }], "state"),
    /change the kind of place/
  );
});
