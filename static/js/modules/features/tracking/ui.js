export function createFeatures(coords, heading = null) {
  const features = [];
  const mapboxCoords = coords.map((c) => [c.lon, c.lat]);

  if (mapboxCoords.length > 1) {
    features.push({
      type: "Feature",
      properties: { type: "line" },
      geometry: { type: "LineString", coordinates: mapboxCoords },
    });
  }

  if (mapboxCoords.length > 0) {
    const markerProps = { type: "marker" };
    if (typeof heading === "number") {
      markerProps.heading = heading;
    }
    features.push({
      type: "Feature",
      properties: markerProps,
      geometry: {
        type: "Point",
        coordinates: mapboxCoords[mapboxCoords.length - 1],
      },
    });
  }

  return features;
}
