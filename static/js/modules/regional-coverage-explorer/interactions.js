/**
 * County Map Interactions Module
 * Handles tooltip and hover interactions for county/state/city levels.
 */

import { getInteractiveLayerId, setHoverHighlight } from "./map-layers.js";
import * as RegionalCoverageExplorerState from "./state.js";
import { formatDate } from "./ui.js";

let boundMap = null;
let boundLayerId = null;
let moveHandler = null;
let leaveHandler = null;

function formatDateRange(label, firstIso, lastIso) {
  const firstDate = formatDate(firstIso);
  const lastDate = formatDate(lastIso);

  if (firstDate === "Unknown" && lastDate === "Unknown") {
    return "";
  }

  if (firstDate === lastDate || lastDate === "Unknown") {
    return `<div class="tooltip-date"><span class="date-label">${label}:</span> ${firstDate}</div>`;
  }

  if (firstDate === "Unknown") {
    return `<div class="tooltip-date"><span class="date-label">${label}:</span> ${lastDate}</div>`;
  }

  return `<div class="tooltip-date"><span class="date-label">${label}:</span> ${firstDate} to ${lastDate}</div>`;
}

function teardownInteractions() {
  if (!boundMap || !boundLayerId) {
    return;
  }
  if (moveHandler) {
    boundMap.off("mousemove", boundLayerId, moveHandler);
  }
  if (leaveHandler) {
    boundMap.off("mouseleave", boundLayerId, leaveHandler);
  }

  boundMap = null;
  boundLayerId = null;
  moveHandler = null;
  leaveHandler = null;
}

function getStateRollupMap() {
  const map = new Map();
  RegionalCoverageExplorerState.getStateRollups().forEach((row) => {
    if (row?.stateFips) {
      map.set(row.stateFips, row);
    }
  });
  return map;
}

function buildTooltipData(feature) {
  const activeLevel = RegionalCoverageExplorerState.getActiveLevel();
  const props = feature?.properties || {};

  if (activeLevel === "state") {
    const stateFips = String(props.stateFips || feature.id || "").padStart(2, "0");
    const stateName = props.name || props.stateName || "Unknown State";
    const rollup = getStateRollupMap().get(stateFips) || {};
    const countyStats = rollup.county || {};

    const visited = Number(countyStats.visited || 0);
    const total = Number(countyStats.total || 0);
    const percent = Number(countyStats.percent || 0);

    return {
      highlightId: stateFips,
      title: stateName,
      subtitle: `State FIPS: ${stateFips}`,
      status:
        visited > 0
          ? `${visited} / ${total} counties (${percent.toFixed(1)}%)`
          : `0 / ${total} counties`,
      statusClass:
        visited > 0 ? "tooltip-status--visited" : "tooltip-status--unvisited",
      datesHtml: formatDateRange(
        "Visited",
        countyStats.firstVisit,
        countyStats.lastVisit
      ),
    };
  }

  if (activeLevel === "city") {
    const cityId = props.cityId || feature.id;
    const cityName = props.name || "Unknown City";
    const stateName = props.stateName || "";
    const visits = RegionalCoverageExplorerState.getCityVisitsForState(
      RegionalCoverageExplorerState.getSelectedStateFips()
    );
    const stops = RegionalCoverageExplorerState.getCityStopsForState(
      RegionalCoverageExplorerState.getSelectedStateFips()
    );
    const cityVisit = visits[cityId];
    const cityStop = stops[cityId];
    const isVisited = Boolean(cityVisit);
    const isStopped = Boolean(cityStop);

    const dateLines = [];
    if (isVisited) {
      dateLines.push(
        formatDateRange("Driven", cityVisit.firstVisit, cityVisit.lastVisit)
      );
    }
    if (isStopped) {
      dateLines.push(formatDateRange("Stopped", cityStop.firstStop, cityStop.lastStop));
    }

    return {
      highlightId: cityId,
      title: cityName,
      subtitle: stateName,
      status: isStopped
        ? isVisited
          ? "Stopped In + Driven Through"
          : "Stopped In"
        : isVisited
          ? "Driven Through"
          : "Not yet visited",
      statusClass: isStopped
        ? "tooltip-status--stopped"
        : isVisited
          ? "tooltip-status--visited"
          : "tooltip-status--unvisited",
      datesHtml: dateLines.filter(Boolean).join(""),
    };
  }

  const countyVisits = RegionalCoverageExplorerState.getCountyVisits();
  const countyStops = RegionalCoverageExplorerState.getCountyStops();

  const { fips } = props;
  const countyName = props.name || "Unknown County";
  const stateName = props.stateName || "Unknown State";
  const isVisited = Boolean(countyVisits[fips]);
  const isStopped = Boolean(countyStops[fips]);

  const dateLines = [];
  if (isVisited && countyVisits[fips]) {
    dateLines.push(
      formatDateRange(
        "Driven",
        countyVisits[fips].firstVisit,
        countyVisits[fips].lastVisit
      )
    );
  }
  if (isStopped && countyStops[fips]) {
    dateLines.push(
      formatDateRange(
        "Stopped",
        countyStops[fips].firstStop,
        countyStops[fips].lastStop
      )
    );
  }

  const status = isStopped
    ? isVisited
      ? "Stopped In + Driven Through"
      : "Stopped In"
    : isVisited
      ? "Driven Through"
      : "Not yet visited";

  const statusClass = isStopped
    ? "tooltip-status--stopped"
    : isVisited
      ? "tooltip-status--visited"
      : "tooltip-status--unvisited";

  return {
    highlightId: fips,
    title: countyName,
    subtitle: stateName,
    status,
    statusClass,
    datesHtml: dateLines.filter(Boolean).join(""),
  };
}

/**
 * Setup hover interactions for active map level.
 */
export function setupInteractions() {
  const map = RegionalCoverageExplorerState.getMap();
  if (!map) {
    return;
  }

  const tooltip = document.getElementById("county-tooltip");
  if (!tooltip) {
    return;
  }

  const layerId = getInteractiveLayerId();
  if (!map.getLayer(layerId)) {
    teardownInteractions();
    return;
  }

  teardownInteractions();

  const tooltipCounty = tooltip.querySelector(".tooltip-county-name");
  const tooltipState = tooltip.querySelector(".tooltip-state-name");
  const tooltipStatus = tooltip.querySelector(".tooltip-status");
  const tooltipDates = tooltip.querySelector(".tooltip-dates");

  moveHandler = (e) => {
    if (!e.features || e.features.length === 0) {
      return;
    }

    const feature = e.features[0];
    const data = buildTooltipData(feature);

    setHoverHighlight(data.highlightId || "");

    tooltipCounty.textContent = data.title || "";
    tooltipState.textContent = data.subtitle || "";
    tooltipStatus.textContent = data.status || "";
    tooltipStatus.className = `tooltip-status ${data.statusClass}`;

    if (data.datesHtml) {
      tooltipDates.innerHTML = data.datesHtml;
      tooltipDates.style.display = "block";
    } else {
      tooltipDates.innerHTML = "";
      tooltipDates.style.display = "none";
    }

    tooltip.style.display = "block";
    tooltip.style.left = `${e.point.x}px`;
    tooltip.style.top = `${e.point.y}px`;
    map.getCanvas().style.cursor = "pointer";
  };

  leaveHandler = () => {
    tooltip.style.display = "none";
    setHoverHighlight("");
    map.getCanvas().style.cursor = "";
  };

  map.on("mousemove", layerId, moveHandler);
  map.on("mouseleave", layerId, leaveHandler);

  boundMap = map;
  boundLayerId = layerId;
}

export function cleanupInteractions() {
  teardownInteractions();
}
