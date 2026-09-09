import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const landingHtml = readFileSync(join(root, "templates/landing.html"), "utf8");

function blockContents(template, blockName) {
  const match = template.match(
    new RegExp(`{%\\s*block\\s+${blockName}\\s*%}([\\s\\S]*?){%\\s*endblock\\s*%}`)
  );
  assert.ok(match, `${blockName} block should exist`);
  return match[1];
}

test("homepage browser title stays name-free while SEO metadata names the creator", () => {
  const titleBlock = blockContents(landingHtml, "title");
  const seoBlock = blockContents(landingHtml, "seo_head");

  assert.match(titleBlock, /Every Street/);
  assert.doesNotMatch(titleBlock, /Davis Deaton/i);
  assert.match(seoBlock, /og:title" content="Every Street \| A Project by Davis Deaton/);
  assert.match(seoBlock, /meta name="description"[\s\S]*Davis Deaton/);
  assert.match(seoBlock, /application\/ld\+json/);
});
