export function createLineFeature(coords) {
  if (coords.length < 2) {
    return null;
  }
  return {
    type: "Feature",
    properties: {},
    geometry: {
      type: "LineString",
      coordinates: coords.map((c) => [c.lon, c.lat]),
    },
  };
}

export function createMarkerFeature(coords, heading = null, speed = 0) {
  if (coords.length === 0) {
    return null;
  }
  const last = coords[coords.length - 1];
  const normalizedHeading = Number.isFinite(heading) ? Number(heading) : 0;
  const props = {
    speed: typeof speed === "number" ? Math.max(0, speed) : 0,
    heading: normalizedHeading,
  };
  return {
    type: "Feature",
    properties: props,
    geometry: {
      type: "Point",
      coordinates: [last.lon, last.lat],
    },
  };
}
