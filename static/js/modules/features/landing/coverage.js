/**
 * Coverage on the home page: the recent-area line under the title, the road
 * sign and cartouche on the hero plate, the area count in the index, and
 * the survey scales in section 01.
 */

import { formatNumber } from "../../utils.js";
import { getRemainingDriveableMiles } from "../navigation-core/coverage-areas.js";
import { describeRecentArea, formatAreaFigures } from "./hero.js";

const SVG_NS = "http://www.w3.org/2000/svg";
const REGISTER_ROWS = 3;
const SIGN_TEXT_WIDTH = 134;
const MAP_TITLE_WIDTH = 100;

/** Squeeze an SVG label to fit its frame instead of overflowing it. */
function fitSvgText(el, maxWidth) {
  if (!el?.getComputedTextLength) {
    return;
  }
  el.removeAttribute("textLength");
  el.removeAttribute("lengthAdjust");
  try {
    if (el.getComputedTextLength() > maxWidth) {
      el.setAttribute("textLength", String(maxWidth));
      el.setAttribute("lengthAdjust", "spacingAndGlyphs");
    }
  } catch {
    // Not rendered yet (hidden or detached); the fonts.ready pass retries.
  }
}

function renderAreaLine(line, area) {
  if (!line) {
    return;
  }
  if (!area) {
    line.hidden = true;
    return;
  }
  const name = document.createElement("strong");
  name.textContent = area.name;
  line.replaceChildren(name, formatAreaFigures(area));
  line.hidden = false;
}

function renderHeroPlate({ heroSignName, heroSignMiles, heroMapTitle }, area) {
  if (heroSignName) {
    heroSignName.textContent = area ? area.name.toUpperCase() : "EVERY STREET";
  }
  if (heroSignMiles) {
    let miles = "";
    if (area && !area.done && area.remaining !== null) {
      miles = `${area.remaining.toFixed(1)} MI`;
    } else if (area) {
      miles = `${Math.floor(area.pct)}%`;
    }
    heroSignMiles.textContent = miles;
  }
  if (heroMapTitle) {
    heroMapTitle.textContent = area?.region || area?.name || "Road Map";
  }
  const fit = () => {
    fitSvgText(heroSignName, SIGN_TEXT_WIDTH);
    fitSvgText(heroMapTitle, MAP_TITLE_WIDTH);
  };
  fit();
  document.fonts?.ready?.then(fit).catch(() => {});
}

/**
 * The title line and the hero plate follow the coverage area driven most
 * recently.
 */
export function renderRecentArea(els, areas) {
  const area = describeRecentArea(areas);
  renderAreaLine(els.areaLine, area);
  renderHeroPlate(els, area);
}

export function renderAreaCount(meta, areas) {
  if (!meta) {
    return;
  }
  const count = Array.isArray(areas) ? areas.length : 0;
  const value = meta.querySelector(".meta-value");
  const label = meta.querySelector(".meta-label");
  if (value) {
    value.textContent = formatNumber(count);
  }
  if (label) {
    label.textContent = count === 1 ? "area" : "areas";
  }
  meta.hidden = count === 0;
}

/** A hand-drawn loop in pencil, stretched around a figure. */
function createPencilRing() {
  const svg = document.createElementNS(SVG_NS, "svg");
  svg.setAttribute("class", "pencil-ring");
  svg.setAttribute("viewBox", "0 0 100 40");
  svg.setAttribute("preserveAspectRatio", "none");
  svg.setAttribute("aria-hidden", "true");
  svg.setAttribute("focusable", "false");
  const path = document.createElementNS(SVG_NS, "path");
  path.setAttribute(
    "d",
    "M62 4C38 1 8 6 4 19c-3 11 18 18 44 18s49-6 48-18C95 8 70 3 46 5c-10 1-19 3-26 6"
  );
  path.setAttribute("vector-effect", "non-scaling-stroke");
  svg.appendChild(path);
  return svg;
}

function createRegisterRow(area, fills) {
  const pct = Math.max(0, Math.min(100, Number(area.coverage_percentage)));
  const remaining = getRemainingDriveableMiles(area);
  const name = area.display_name?.split(",")[0]?.trim() || "Unnamed area";
  const done = pct >= 100;

  const item = document.createElement("li");
  item.className = `coverage-register-row${done ? " is-complete" : ""}`;

  const link = document.createElement("a");
  link.className = "coverage-register-link";
  link.href = "/coverage-management";
  link.setAttribute(
    "aria-label",
    `${name}: ${pct.toFixed(1)} percent driven${
      remaining !== null ? `, ${remaining.toFixed(1)} miles left` : ""
    }`
  );

  const nameEl = document.createElement("span");
  nameEl.className = "coverage-register-name";
  nameEl.textContent = name;

  const bar = document.createElement("span");
  bar.className = "survey-bar";
  bar.setAttribute("aria-hidden", "true");
  const fill = document.createElement("span");
  fill.className = "survey-fill";
  bar.appendChild(fill);
  fills.push([fill, pct]);

  const pctEl = document.createElement("span");
  pctEl.className = "coverage-register-pct";
  pctEl.textContent = `${pct.toFixed(1)}%`;
  if (pct >= 80 && !done) {
    pctEl.appendChild(createPencilRing());
  }

  const leftEl = document.createElement("span");
  leftEl.className = "coverage-register-left";
  if (done) {
    leftEl.textContent = "Complete";
  } else if (remaining !== null) {
    leftEl.textContent = `${remaining.toFixed(1)} mi left`;
  }

  link.append(nameEl, bar, pctEl, leftEl);
  item.appendChild(link);
  return item;
}

/** Survey scales for the largest areas, drawn in on the first render only. */
export function renderCoverageRegister({ coverageSection, coverageRegister }, areas) {
  if (!coverageSection || !coverageRegister) {
    return;
  }
  const rows = (Array.isArray(areas) ? areas : [])
    .filter((area) => Number.isFinite(Number(area?.coverage_percentage)))
    .sort(
      (a, b) =>
        (Number(b?.total_length_miles) || 0) - (Number(a?.total_length_miles) || 0)
    )
    .slice(0, REGISTER_ROWS);

  if (rows.length === 0) {
    coverageSection.hidden = true;
    return;
  }

  const fills = [];
  const items = rows.map((area) => createRegisterRow(area, fills));

  // Periodic refreshes update the figures in place; only the first render
  // draws the scales and pencil rings in.
  const redraw = coverageRegister.dataset.drawn === "true";
  coverageRegister.classList.toggle("is-settled", redraw);
  coverageRegister.replaceChildren(...items);
  coverageSection.hidden = false;

  const setWidths = () => {
    fills.forEach(([fill, pct]) => {
      fill.style.width = `${pct}%`;
    });
  };
  if (redraw) {
    setWidths();
    return;
  }
  coverageRegister.dataset.drawn = "true";
  // Let the hatching run out along each scale once the rows are painted.
  requestAnimationFrame(() => requestAnimationFrame(setWidths));
}
