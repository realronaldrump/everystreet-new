export const FILM_SECONDS = 12;
export const REVEAL_START = 0.8;
export const REVEAL_SECONDS = 8;
export const TRACE_SECONDS = 0.45;

export const clamp = (value, min = 0, max = 1) => Math.max(min, Math.min(max, value));
export const ease = (value) => {
  const t = clamp(value);
  return t * t * (3 - 2 * t);
};

function validLine(line) {
  return (
    Array.isArray(line) &&
    line.length >= 2 &&
    line.some((p) => p?.[0] !== line[0]?.[0] || p?.[1] !== line[0]?.[1]) &&
    line.every(
      (p) =>
        Array.isArray(p) &&
        Number.isFinite(p[0]) &&
        Number.isFinite(p[1]) &&
        Math.abs(p[0]) <= 180 &&
        Math.abs(p[1]) < 90
    )
  );
}

export function buildShareModel(area, streets) {
  if (streets?.type !== "FeatureCollection" || !streets.features?.length) {
    throw new Error("This area has no street geometry to share yet.");
  }
  const ids = new Set();
  const roads = streets.features.map((feature) => {
    const props = feature.properties || {};
    const geometry = feature.geometry;
    const lines =
      geometry?.type === "LineString"
        ? [geometry.coordinates]
        : geometry?.type === "MultiLineString"
          ? geometry.coordinates
          : [];
    if (
      !lines.length ||
      !lines.every(validLine) ||
      !["driven", "undriven", "undriveable"].includes(props.status) ||
      !Number.isFinite(props.length_miles) ||
      props.length_miles < 0 ||
      typeof props.segment_id !== "string" ||
      !props.segment_id ||
      ids.has(props.segment_id)
    ) {
      throw new Error("The street data is incomplete. Refresh the area and try again.");
    }
    ids.add(props.segment_id);
    const timestamp = props.first_driven_at
      ? Date.parse(String(props.first_driven_at).replace(" ", "T"))
      : NaN;
    return {
      feature,
      lines,
      miles: props.length_miles,
      driven: props.status === "driven",
      driveable: props.status !== "undriveable",
      date: Number.isFinite(timestamp) ? timestamp : null,
      id: props.segment_id,
    };
  });
  const totalMiles = roads.reduce((sum, r) => sum + (r.driveable ? r.miles : 0), 0);
  if (totalMiles <= 0) {
    throw new Error("This area has no drivable street mileage to share yet.");
  }
  const driven = roads.filter((r) => r.driven);
  const dates = driven.filter((r) => r.date !== null).map((r) => r.date);
  const firstDate = dates.length ? dates.reduce((a, b) => Math.min(a, b)) : null;
  const lastDate = dates.length ? dates.reduce((a, b) => Math.max(a, b)) : null;
  for (const road of driven) {
    // Undated coverage is present from the first frame; never invent a date.
    road.start =
      road.date === null
        ? -TRACE_SECONDS
        : REVEAL_START +
          (lastDate === firstDate
            ? 0
            : ((road.date - firstDate) / (lastDate - firstDate)) * REVEAL_SECONDS);
    road.end = road.start + TRACE_SECONDS;
  }
  driven.sort((a, b) => a.start - b.start || a.id.localeCompare(b.id));
  const cumulativeMiles = [0];
  for (const road of driven) {
    cumulativeMiles.push(cumulativeMiles.at(-1) + road.miles);
  }
  const nameParts = (area.display_name || "My coverage")
    .split(",")
    .map((s) => s.trim());
  return {
    name: nameParts[0],
    subtitle: nameParts
      .slice(area.area_type === "city" && nameParts.length > 3 ? -2 : 1)
      .join(" · "),
    fullName: area.display_name || "My coverage",
    roads,
    driven,
    totalMiles,
    drivenMiles: cumulativeMiles.at(-1),
    cumulativeMiles,
    firstDate,
    lastDate,
    undatedCount: driven.filter((r) => r.date === null).length,
    filename:
      nameParts[0]
        .normalize("NFKD")
        .replace(/[\u0300-\u036f]/g, "")
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-|-$/g, "") || "coverage",
  };
}

export function frameAt(model, seconds) {
  const time = clamp(seconds, 0, FILM_SECONDS);
  let lo = 0;
  let hi = model.driven.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (model.driven[mid].end <= time) lo = mid + 1;
    else hi = mid;
  }
  let miles = model.cumulativeMiles[lo];
  const active = [];
  for (let i = lo; i < model.driven.length && model.driven[i].start <= time; i++) {
    const progress = ease((time - model.driven[i].start) / TRACE_SECONDS);
    active.push({ index: i, progress });
    miles += model.driven[i].miles * progress;
  }
  const date =
    model.firstDate === null || time < REVEAL_START
      ? null
      : model.firstDate +
        clamp((time - REVEAL_START) / REVEAL_SECONDS) *
          (model.lastDate - model.firstDate);
  return {
    time,
    completed: lo,
    active,
    miles,
    percent: (miles / model.totalMiles) * 100,
    date,
  };
}
