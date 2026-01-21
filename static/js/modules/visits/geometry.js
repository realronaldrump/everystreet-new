function collectCoordinates(geometry) {
  if (!geometry?.type) {
    return [];
  }

  switch (geometry.type) {
    case "Point":
      return geometry.coordinates ? [geometry.coordinates] : [];
    case "LineString":
      return geometry.coordinates || [];
    case "Polygon":
      return geometry.coordinates?.flat(1) || [];
    case "MultiPolygon":
      return geometry.coordinates?.flat(2) || [];
    case "GeometryCollection":
      return (geometry.geometries || []).flatMap((geom) => collectCoordinates(geom));
    default:
      return [];
  }
}

function computeBounds(geometry) {
  const coords = collectCoordinates(geometry);
  if (coords.length === 0) {
    return null;
  }

  return coords.reduce(
    (acc, [lng, lat]) => {
      if (typeof lng !== "number" || typeof lat !== "number") {
        return acc;
      }
      return {
        minLng: Math.min(acc.minLng, lng),
        minLat: Math.min(acc.minLat, lat),
        maxLng: Math.max(acc.maxLng, lng),
        maxLat: Math.max(acc.maxLat, lat),
      };
    },
    {
      minLng: coords[0][0],
      minLat: coords[0][1],
      maxLng: coords[0][0],
      maxLat: coords[0][1],
    }
  );
}

function fitMapToGeometry(map, geometry, options = {}) {
  const bounds = computeBounds(geometry);
  if (!map || !bounds) {
    return;
  }

  map.fitBounds(
    [
      [bounds.minLng, bounds.minLat],
      [bounds.maxLng, bounds.maxLat],
    ],
    options
  );
}

const VisitsGeometry = {
  collectCoordinates,
  computeBounds,
  fitMapToGeometry,
};

export { VisitsGeometry, collectCoordinates, computeBounds, fitMapToGeometry };
export default VisitsGeometry;
