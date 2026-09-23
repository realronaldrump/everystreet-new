/**
 * Section 03 of the home page: the recent-trips logbook, plus the heading
 * and wheel-time figure of the "Today" ledger that name the selected range.
 */

import { formatDurationCompact } from "../../utils/formatting.js";
import { DateUtils, formatNumber } from "../../utils.js";

const LOGBOOK_ROWS = 5;

function parseTime(value) {
  if (!value) {
    return null;
  }
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function formatDestination(dest) {
  if (!dest) {
    return "Unknown";
  }
  if (typeof dest === "string") {
    return dest;
  }
  if (dest.name) {
    return dest.name;
  }
  if (dest.formatted_address) {
    return dest.formatted_address.split(",")[0] || dest.formatted_address;
  }
  return "Unknown";
}

function cell(className, content) {
  const td = document.createElement("td");
  td.className = className;
  if (content instanceof Node) {
    td.appendChild(content);
  } else {
    td.textContent = content;
  }
  return td;
}

function logbookRow(trip) {
  const miles = Number.parseFloat(trip.distance);
  const start = parseTime(trip.startTime);
  const end = parseTime(trip.endTime);
  const when = start || end;
  const destination = formatDestination(trip.destination);

  let destContent = destination;
  if (trip.transactionId) {
    const link = document.createElement("a");
    link.href = `/trips/${encodeURIComponent(trip.transactionId)}`;
    link.textContent = destination;
    link.title = destination;
    destContent = link;
  }

  const row = document.createElement("tr");
  row.className = "logbook-row";
  row.append(
    cell(
      "logbook-date",
      when
        ? when.toLocaleDateString(undefined, { month: "short", day: "numeric" })
        : "--"
    ),
    cell(
      "logbook-time",
      when
        ? when.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" })
        : ""
    ),
    cell("logbook-dest", destContent),
    cell(
      "logbook-num logbook-duration",
      start && end ? formatDurationCompact((end - start) / 1000) || "" : ""
    ),
    cell("logbook-num logbook-miles", Number.isFinite(miles) ? miles.toFixed(1) : "--")
  );
  return { row, miles: Number.isFinite(miles) ? miles : 0 };
}

/**
 * Write the most recent trips into the logbook (date, departure time,
 * destination, duration, and miles) with a total underneath.
 */
export function renderLogbook(els, trips) {
  const { activityFeed: feed, logbookFoot, logbookTotal, logbookTotalLabel } = els;
  if (!feed) {
    return;
  }
  const entries = (Array.isArray(trips) ? trips : []).slice(0, LOGBOOK_ROWS);
  if (entries.length === 0) {
    const row = document.createElement("tr");
    row.className = "logbook-empty";
    const empty = cell("", "No trips in this range.");
    empty.colSpan = 5;
    row.appendChild(empty);
    feed.replaceChildren(row);
    if (logbookFoot) {
      logbookFoot.hidden = true;
    }
    return;
  }

  const rows = entries.map(logbookRow);
  feed.replaceChildren(...rows.map(({ row }) => row));

  if (logbookFoot && logbookTotal) {
    const total = rows.reduce((sum, { miles }) => sum + miles, 0);
    logbookTotal.textContent = `${total.toFixed(1)} mi`;
    if (logbookTotalLabel) {
      logbookTotalLabel.textContent = `Total, ${entries.length} ${
        entries.length === 1 ? "trip" : "trips"
      }`;
    }
    logbookFoot.hidden = false;
  }
}

/** Hours at the wheel, as a ledger figure and its unit. */
export function formatWheelTime(seconds) {
  const numeric = Number(seconds);
  if (!Number.isFinite(numeric) || numeric <= 0) {
    return { value: "0", unit: "hr" };
  }
  const hours = numeric / 3600;
  if (hours >= 10) {
    return { value: formatNumber(Math.round(hours)), unit: "hr" };
  }
  if (hours >= 1) {
    return { value: hours.toFixed(1), unit: "hr" };
  }
  return { value: String(Math.max(1, Math.round(numeric / 60))), unit: "min" };
}

/** Name the totals after the selected range, as the date picker labels it. */
export function updateLogHeading(heading) {
  if (!heading) {
    return;
  }
  const today = DateUtils.getCurrentDate();
  const isToday =
    DateUtils.getStartDate() === today && DateUtils.getEndDate() === today;
  const label = document.getElementById("date-display")?.textContent?.trim();
  heading.textContent = isToday ? "Today" : label || "Selected range";
}

/** Keep the heading in step with the header's date-range label. */
export function watchDateRangeLabel(heading) {
  const display = document.getElementById("date-display");
  if (!display || typeof MutationObserver !== "function") {
    return () => {};
  }
  const observer = new MutationObserver(() => updateLogHeading(heading));
  observer.observe(display, { childList: true, characterData: true, subtree: true });
  return () => observer.disconnect();
}
