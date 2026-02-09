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

export function createMarkerFeature(coords, heading = null) {
  if (coords.length === 0) {
    return null;
  }
  const last = coords[coords.length - 1];
  const props = {};
  if (typeof heading === "number") {
    props.heading = heading;
  }
  return {
    type: "Feature",
    properties: props,
    geometry: {
      type: "Point",
      coordinates: [last.lon, last.lat],
    },
  };
}
