const CALENDAR_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

export function journalDateKey(value, timeZone) {
  const dateText = String(value || "").trim();
  if (CALENDAR_DATE_PATTERN.test(dateText)) {
    return dateText;
  }
  const timestamp = Date.parse(value || "");
  if (!Number.isFinite(timestamp)) {
    return "";
  }
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: timeZone || undefined,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  })
    .formatToParts(new Date(timestamp))
    .reduce((result, part) => ({ ...result, [part.type]: part.value }), {});
  return `${parts.year}-${parts.month}-${parts.day}`;
}

export function isAtOrBeforeJournalBoundary(value, boundary, timeZone) {
  const boundaryText = String(boundary || "").trim();
  if (CALENDAR_DATE_PATTERN.test(boundaryText)) {
    const valueKey = journalDateKey(value, timeZone);
    return Boolean(valueKey && valueKey <= boundaryText);
  }
  const valueTimestamp = Date.parse(value || "");
  const boundaryTimestamp = Date.parse(boundaryText);
  return (
    Number.isFinite(valueTimestamp) &&
    Number.isFinite(boundaryTimestamp) &&
    valueTimestamp <= boundaryTimestamp
  );
}

export function createTimelineScale(series) {
  const dates = series.map((point) => Date.parse(`${point.date}T00:00:00Z`));
  const start = dates[0] || 0;
  const span = Math.max(1, (dates.at(-1) || start) - start);
  return {
    ratio(index) {
      return ((dates[index] || start) - start) / span;
    },
    nearest(ratio) {
      const target = start + Math.max(0, Math.min(1, ratio)) * span;
      let low = 0,
        high = dates.length;
      while (low < high) {
        const middle = (low + high) >>> 1;
        if (dates[middle] < target) low = middle + 1;
        else high = middle;
      }
      if (low >= dates.length) return Math.max(0, dates.length - 1);
      return low > 0 && target - dates[low - 1] < dates[low] - target ? low - 1 : low;
    },
  };
}
