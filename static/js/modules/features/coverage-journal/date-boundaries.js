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
