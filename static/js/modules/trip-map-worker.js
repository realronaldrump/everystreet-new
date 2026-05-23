const POLYLINE6_SCALE = 1_000_000;

function decodePolyline6(encoded) {
  const coordinates = [];
  if (!encoded || typeof encoded !== "string") {
    return coordinates;
  }

  let index = 0;
  let lat = 0;
  let lon = 0;

  while (index < encoded.length) {
    let result = 0;
    let shift = 0;
    let byte = null;

    do {
      byte = encoded.charCodeAt(index++) - 63;
      result |= (byte & 0x1f) << shift;
      shift += 5;
    } while (byte >= 0x20 && index < encoded.length);

    const deltaLat = result & 1 ? ~(result >> 1) : result >> 1;
    lat += deltaLat;

    result = 0;
    shift = 0;
    do {
      byte = encoded.charCodeAt(index++) - 63;
      result |= (byte & 0x1f) << shift;
      shift += 5;
    } while (byte >= 0x20 && index < encoded.length);

    const deltaLon = result & 1 ? ~(result >> 1) : result >> 1;
    lon += deltaLon;

    coordinates.push([lon / POLYLINE6_SCALE, lat / POLYLINE6_SCALE]);
  }

  return coordinates;
}

function normalizeEncodedPaths(path) {
  if (Array.isArray(path)) {
    return path.filter((value) => typeof value === "string" && value.length > 0);
  }
  if (typeof path === "string" && path.length > 0) {
    return [path];
  }
  return [];
}

export function decodeBundle(trips = []) {
  const decodedPaths = [];
  const pathTripIndices = [];
  let pointCount = 0;

  trips.forEach((trip, tripIndex) => {
    normalizeEncodedPaths(trip?.path).forEach((encoded) => {
      const coords = decodePolyline6(encoded);
      if (coords.length < 2) {
        return;
      }
      decodedPaths.push(coords);
      pathTripIndices.push(tripIndex);
      pointCount += coords.length;
    });
  });

  const positions = new Float64Array(pointCount * 2);
  const startIndices = new Uint32Array(decodedPaths.length + 1);
  const tripIndices = new Uint32Array(pathTripIndices);
  let cursor = 0;

  decodedPaths.forEach((coords, pathIndex) => {
    startIndices[pathIndex] = cursor;
    coords.forEach((coord) => {
      positions[cursor * 2] = coord[0];
      positions[cursor * 2 + 1] = coord[1];
      cursor += 1;
    });
  });
  startIndices[decodedPaths.length] = cursor;

  return {
    length: decodedPaths.length,
    positions,
    startIndices,
    tripIndices,
  };
}

if (typeof self !== "undefined" && typeof self.postMessage === "function") {
  self.onmessage = (event) => {
    const { id, trips } = event.data || {};
    try {
      const decoded = decodeBundle(Array.isArray(trips) ? trips : []);
      self.postMessage(
        {
          id,
          ok: true,
          decoded,
        },
        [
          decoded.positions.buffer,
          decoded.startIndices.buffer,
          decoded.tripIndices.buffer,
        ]
      );
    } catch (error) {
      self.postMessage({
        id,
        ok: false,
        error: error?.message || "Failed to decode trip map bundle",
      });
    }
  };
}
