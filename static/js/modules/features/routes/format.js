/**
 * Formatting helpers shared by the Routes page, its insights, and its charts.
 */

export function formatDateShort(v) {
  if (!v) {
    return "--";
  }
  const d = new Date(v);
  return Number.isNaN(d.getTime())
    ? "--"
    : d.toLocaleDateString(undefined, {
        month: "short",
        day: "numeric",
        year: "numeric",
      });
}

export function formatMonthLabel(ym) {
  if (!ym) {
    return "";
  }
  const [y, m] = ym.split("-");
  const months = [
    "Jan",
    "Feb",
    "Mar",
    "Apr",
    "May",
    "Jun",
    "Jul",
    "Aug",
    "Sep",
    "Oct",
    "Nov",
    "Dec",
  ];
  return `${months[Number(m) - 1] || m} '${y.slice(2)}`;
}

export function formatHourLabel(h) {
  if (h === 0) {
    return "12a";
  }
  if (h < 12) {
    return `${h}a`;
  }
  if (h === 12) {
    return "12p";
  }
  return `${h - 12}p`;
}

export function parseDate(value) {
  if (!value) {
    return null;
  }
  const dt = new Date(value);
  return Number.isNaN(dt.getTime()) ? null : dt;
}

export function formatDateCompact(value) {
  const d = value instanceof Date ? value : parseDate(value);
  if (!d) {
    return "--";
  }
  const includeYear = d.getFullYear() !== new Date().getFullYear();
  return d.toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    ...(includeYear ? { year: "numeric" } : {}),
  });
}

export function formatTripCount(value) {
  const count = Math.max(0, Math.round(Number(value) || 0));
  return `${count.toLocaleString()} trip${count === 1 ? "" : "s"}`;
}

export function formatWeekCount(value) {
  const count = Math.max(1, Math.round(Number(value) || 0));
  return `${count.toLocaleString()} week${count === 1 ? "" : "s"}`;
}

export function formatTripsPerWeekLabel(value) {
  const rate = Number(value);
  if (!Number.isFinite(rate) || rate <= 0) {
    return null;
  }
  const digits = rate >= 10 ? 0 : 1;
  return `${rate.toFixed(digits)}/week`;
}

export function routeStrokeColor(route) {
  const raw = (route?.color || "").trim();
  return raw.startsWith("#") && raw.length === 7 ? raw : "#5f82a0";
}
