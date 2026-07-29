import assert from "node:assert/strict";
import test from "node:test";

import {
  assertHasId,
  readRepoFile,
  readStaticJs,
  readTemplate,
} from "../helpers/fs-smoke.js";

const DATE_PICKER_CSS = ["static", "css", "components", "date-picker.css"];

function sliceBlock(source, startMarker, endMarker) {
  const start = source.indexOf(startMarker);
  assert.notEqual(start, -1, `missing marker: ${startMarker}`);
  const end = source.indexOf(endMarker, start);
  assert.notEqual(end, -1, `missing marker: ${endMarker}`);
  return source.slice(start, end);
}

test("apply action lives outside the scrollable sheet body", () => {
  const baseTemplate = readTemplate("base.html");

  assertHasId(baseTemplate, "dp-body");
  assertHasId(baseTemplate, "dp-footer");
  assertHasId(baseTemplate, "dp-grabber");
  assertHasId(baseTemplate, "dp-range-count");

  const sheet = sliceBlock(
    baseTemplate,
    'id="date-picker-dropdown"',
    'id="date-picker-overlay"'
  );
  const scrollBody = sliceBlock(sheet, 'id="dp-body"', 'id="dp-footer"');

  // The whole point of the mobile fix: Apply is pinned in the footer, never
  // pushed below the fold by the calendar inside the scroll container.
  assert.ok(
    !scrollBody.includes('id="date-picker-apply"'),
    "Apply button must not live inside #dp-body (it scrolls out of reach on phones)"
  );
  assert.ok(
    sheet.indexOf('id="dp-footer"') > sheet.indexOf('id="dp-body"'),
    "#dp-footer must follow #dp-body so the action bar renders below the scroll area"
  );
  assert.ok(
    sheet.indexOf('id="date-picker-apply"') > sheet.indexOf('id="dp-footer"'),
    "Apply button belongs to the pinned footer"
  );
});

test("sheet layout keeps the scroll region and footer separable", () => {
  const css = readRepoFile(...DATE_PICKER_CSS);

  const body = sliceBlock(css, ".dp-body {", "}");
  assert.match(body, /overflow-y:\s*auto/, ".dp-body must be the scroll container");
  assert.match(
    body,
    /min-height:\s*0/,
    ".dp-body needs min-height:0 to shrink in flex"
  );
  assert.match(body, /flex:\s*1 1 auto/, ".dp-body must absorb the leftover height");

  const actions = sliceBlock(css, ".dp-actions {", "}");
  assert.match(actions, /flex:\s*0 0 auto/, "footer must not shrink");
  assert.match(
    actions,
    /env\(safe-area-inset-bottom\)/,
    "footer must clear the home indicator"
  );

  // A shrinking calendar clips the last weeks of the month instead of scrolling.
  const calendarHost = sliceBlock(css, ".dp-calendar-host {", "}");
  assert.match(calendarHost, /flex:\s*0 0 auto/);

  // Flatpickr's absolute month nav is what pushed the year off-screen on iOS.
  // The flex row applies to every calendar in the app, not just the sheet.
  const monthsRow = sliceBlock(
    css,
    "body .flatpickr-calendar .flatpickr-months {",
    "}"
  );
  assert.match(monthsRow, /display:\s*flex/);
  const monthSelect = sliceBlock(
    css,
    "body .flatpickr-calendar .flatpickr-current-month .flatpickr-monthDropdown-months {",
    "}"
  );
  assert.match(monthSelect, /appearance:\s*none/);
  assert.match(monthSelect, /min-width:\s*0/);

  // Side padding on the day grid pushes flatpickr's fixed-width day container
  // past the calendar's clipped edge and cuts off the Saturday column.
  const dayGrid = sliceBlock(css, "body .flatpickr-calendar .flatpickr-days {", "}");
  assert.match(dayGrid, /padding:\s*var\(--space-2\) 0/);
});

test("mobile sheet locks the page scroll and can be swiped away", () => {
  const css = readRepoFile(...DATE_PICKER_CSS);
  const dateManager = readStaticJs("modules", "ui", "date-manager.js");
  const config = readStaticJs("modules", "core", "config.js");

  // `overflow: hidden` alone does not hold on iOS Safari.
  assert.match(css, /body\.date-picker-scroll-locked\s*{[^}]*position:\s*fixed/);
  assert.match(dateManager, /lockPageScroll\(\)/);
  assert.match(dateManager, /date-picker-scroll-locked/);
  assert.match(dateManager, /behavior:\s*"instant"/);

  assert.match(dateManager, /startSheetDrag\(event\)/);
  assert.match(dateManager, /pointermove/);
  assert.match(css, /--dp-drag-y/);

  for (const selector of [
    "dpBody",
    "dpFooter",
    "dpGrabber",
    "dpRangeCount",
    "dpHeader",
  ]) {
    assert.match(
      config,
      new RegExp(`${selector}:\\s*"#`),
      `config missing ${selector}`
    );
  }
});
