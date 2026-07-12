const EARTH_RADIUS_M = 6_378_137;
const MAX_MERCATOR_LAT = 85.05112878;
const TILE_SIZE = 256;

export function decodeTerrainRgb(red, green, blue) {
  return -10_000 + (red * 256 * 256 + green * 256 + blue) * 0.1;
}

export function padBounds(bounds, ratio = 0.05) {
  assertBounds(bounds);
  const [minLon, minLat, maxLon, maxLat] = bounds.map(Number);
  const lonPad = Math.max((maxLon - minLon) * ratio, 0.0001);
  const latPad = Math.max((maxLat - minLat) * ratio, 0.0001);
  return [minLon - lonPad, minLat - latPad, maxLon + lonPad, maxLat + latPad];
}

export function lonLatToTileFraction(lon, lat, zoom) {
  const scale = 2 ** zoom;
  const safeLat = Math.max(-MAX_MERCATOR_LAT, Math.min(MAX_MERCATOR_LAT, lat));
  const latRad = (safeLat * Math.PI) / 180;
  return {
    x: ((lon + 180) / 360) * scale,
    y: ((1 - Math.log(Math.tan(latRad) + 1 / Math.cos(latRad)) / Math.PI) / 2) * scale,
  };
}

export function selectTerrainTiles(
  bounds,
  { minZoom = 8, maxZoom = 14, maxAxis = 4, maxTiles = 16, padding = 0.05 } = {}
) {
  const paddedBounds = padBounds(bounds, padding);
  const [minLon, minLat, maxLon, maxLat] = paddedBounds;

  for (let zoom = maxZoom; zoom >= minZoom; zoom -= 1) {
    const northWest = lonLatToTileFraction(minLon, maxLat, zoom);
    const southEast = lonLatToTileFraction(maxLon, minLat, zoom);
    const minX = Math.floor(northWest.x);
    const maxX = Math.floor(southEast.x);
    const minY = Math.floor(northWest.y);
    const maxY = Math.floor(southEast.y);
    const columns = maxX - minX + 1;
    const rows = maxY - minY + 1;

    if (columns <= maxAxis && rows <= maxAxis && columns * rows <= maxTiles) {
      return {
        zoom,
        minX,
        maxX,
        minY,
        maxY,
        columns,
        rows,
        tileCount: columns * rows,
        bounds: paddedBounds,
      };
    }
  }

  throw new Error("Coverage area is too large for the 3D terrain tile budget.");
}

export function mercatorMeters(lon, lat) {
  const safeLat = Math.max(-MAX_MERCATOR_LAT, Math.min(MAX_MERCATOR_LAT, lat));
  const lonRad = (lon * Math.PI) / 180;
  const latRad = (safeLat * Math.PI) / 180;
  return {
    x: EARTH_RADIUS_M * lonRad,
    y: EARTH_RADIUS_M * Math.log(Math.tan(Math.PI / 4 + latRad / 2)),
  };
}

export function createLocalProjection(bounds) {
  assertBounds(bounds);
  const centerLon = (Number(bounds[0]) + Number(bounds[2])) / 2;
  const centerLat = (Number(bounds[1]) + Number(bounds[3])) / 2;
  const origin = mercatorMeters(centerLon, centerLat);
  return { centerLon, centerLat, originX: origin.x, originY: origin.y };
}

export function projectLonLat(lon, lat, projection) {
  const point = mercatorMeters(Number(lon), Number(lat));
  return {
    x: point.x - projection.originX,
    z: -(point.y - projection.originY),
  };
}

export function bilinearSampleGrid(values, width, height, x, y) {
  const safeX = Math.max(0, Math.min(width - 1, x));
  const safeY = Math.max(0, Math.min(height - 1, y));
  const x0 = Math.floor(safeX);
  const y0 = Math.floor(safeY);
  const x1 = Math.min(width - 1, x0 + 1);
  const y1 = Math.min(height - 1, y0 + 1);
  const tx = safeX - x0;
  const ty = safeY - y0;
  const top = values[y0 * width + x0] * (1 - tx) + values[y0 * width + x1] * tx;
  const bottom = values[y1 * width + x0] * (1 - tx) + values[y1 * width + x1] * tx;
  return top * (1 - ty) + bottom * ty;
}

export function sampleTerrainMosaic(mosaic, lon, lat) {
  const tilePoint = lonLatToTileFraction(lon, lat, mosaic.zoom);
  const pixelX = (tilePoint.x - mosaic.minX) * TILE_SIZE - 0.5;
  const pixelY = (tilePoint.y - mosaic.minY) * TILE_SIZE - 0.5;
  return bilinearSampleGrid(
    mosaic.elevations,
    mosaic.width,
    mosaic.height,
    pixelX,
    pixelY
  );
}

export async function loadTerrainMosaic(tilePlan, accessToken, signal) {
  if (!accessToken) {
    throw new Error("A Mapbox public token is required to load real elevation.");
  }
  if (typeof createImageBitmap !== "function") {
    throw new Error("This browser cannot decode terrain tiles for the 3D view.");
  }

  const width = tilePlan.columns * TILE_SIZE;
  const height = tilePlan.rows * TILE_SIZE;
  const elevations = new Float32Array(width * height);
  const requests = [];

  for (let y = tilePlan.minY; y <= tilePlan.maxY; y += 1) {
    for (let x = tilePlan.minX; x <= tilePlan.maxX; x += 1) {
      requests.push(loadTerrainTile(tilePlan.zoom, x, y, accessToken, signal));
    }
  }

  const tiles = await Promise.all(requests);
  for (const tile of tiles) {
    const offsetX = (tile.x - tilePlan.minX) * TILE_SIZE;
    const offsetY = (tile.y - tilePlan.minY) * TILE_SIZE;
    for (let row = 0; row < TILE_SIZE; row += 1) {
      const sourceStart = row * TILE_SIZE;
      const destinationStart = (offsetY + row) * width + offsetX;
      elevations.set(
        tile.elevations.subarray(sourceStart, sourceStart + TILE_SIZE),
        destinationStart
      );
    }
  }

  return {
    zoom: tilePlan.zoom,
    minX: tilePlan.minX,
    minY: tilePlan.minY,
    width,
    height,
    elevations,
  };
}

async function loadTerrainTile(zoom, x, y, accessToken, signal) {
  const token = encodeURIComponent(accessToken);
  const url = `https://api.mapbox.com/v4/mapbox.terrain-rgb/${zoom}/${x}/${y}.pngraw?access_token=${token}`;
  const response = await fetch(url, { signal });
  if (!response.ok) {
    throw new Error(`Terrain tile request failed (${response.status}).`);
  }

  const bitmap = await createImageBitmap(await response.blob());
  try {
    const canvas = document.createElement("canvas");
    canvas.width = TILE_SIZE;
    canvas.height = TILE_SIZE;
    const context = canvas.getContext("2d", { willReadFrequently: true });
    if (!context) {
      throw new Error("Terrain tile canvas could not be created.");
    }
    context.drawImage(bitmap, 0, 0, TILE_SIZE, TILE_SIZE);
    const pixels = context.getImageData(0, 0, TILE_SIZE, TILE_SIZE).data;
    const elevations = new Float32Array(TILE_SIZE * TILE_SIZE);
    for (let index = 0, pixel = 0; index < elevations.length; index += 1, pixel += 4) {
      elevations[index] = decodeTerrainRgb(
        pixels[pixel],
        pixels[pixel + 1],
        pixels[pixel + 2]
      );
    }
    return { x, y, elevations };
  } finally {
    bitmap.close();
  }
}

export function pointInBoundary(lon, lat, boundary) {
  if (!boundary || !Array.isArray(boundary.coordinates)) {
    return false;
  }
  if (boundary.type === "Polygon") {
    return pointInPolygon(lon, lat, boundary.coordinates);
  }
  if (boundary.type === "MultiPolygon") {
    return boundary.coordinates.some((polygon) => pointInPolygon(lon, lat, polygon));
  }
  return false;
}

function pointInPolygon(lon, lat, rings) {
  if (!Array.isArray(rings) || rings.length === 0 || !pointInRing(lon, lat, rings[0])) {
    return false;
  }
  return !rings.slice(1).some((hole) => pointInRing(lon, lat, hole));
}

function pointInRing(lon, lat, ring) {
  let inside = false;
  for (
    let index = 0, previous = ring.length - 1;
    index < ring.length;
    previous = index, index += 1
  ) {
    const currentPoint = ring[index];
    const previousPoint = ring[previous];
    if (!Array.isArray(currentPoint) || !Array.isArray(previousPoint)) {
      continue;
    }
    const xi = Number(currentPoint[0]);
    const yi = Number(currentPoint[1]);
    const xj = Number(previousPoint[0]);
    const yj = Number(previousPoint[1]);
    const intersects =
      yi > lat !== yj > lat && lon < ((xj - xi) * (lat - yi)) / (yj - yi || 1e-12) + xi;
    if (intersects) {
      inside = !inside;
    }
  }
  return inside;
}

export function extractLineParts(geometry) {
  if (!geometry || !Array.isArray(geometry.coordinates)) {
    return [];
  }
  if (geometry.type === "LineString") {
    return geometry.coordinates.length >= 2 ? [geometry.coordinates] : [];
  }
  if (geometry.type === "MultiLineString") {
    return geometry.coordinates.filter(
      (part) => Array.isArray(part) && part.length >= 2
    );
  }
  return [];
}

export function densifyLinePart(part, projection, maxDistanceM = 100) {
  if (!Array.isArray(part) || part.length < 2) {
    return [];
  }
  const result = [part[0]];
  for (let index = 1; index < part.length; index += 1) {
    const start = part[index - 1];
    const end = part[index];
    const startWorld = projectLonLat(start[0], start[1], projection);
    const endWorld = projectLonLat(end[0], end[1], projection);
    const distance = Math.hypot(endWorld.x - startWorld.x, endWorld.z - startWorld.z);
    const steps = Math.max(1, Math.ceil(distance / maxDistanceM));
    for (let step = 1; step <= steps; step += 1) {
      const ratio = step / steps;
      result.push([
        Number(start[0]) + (Number(end[0]) - Number(start[0])) * ratio,
        Number(start[1]) + (Number(end[1]) - Number(start[1])) * ratio,
      ]);
    }
  }
  return result;
}

export function buildStreetPairPositions(
  feature,
  { mosaic, projection, baseElevation, verticalScale, liftM = 2, maxDistanceM = 100 }
) {
  const positions = [];
  for (const rawPart of extractLineParts(feature?.geometry)) {
    const part = densifyLinePart(rawPart, projection, maxDistanceM);
    for (let index = 1; index < part.length; index += 1) {
      appendStreetPoint(positions, part[index - 1]);
      appendStreetPoint(positions, part[index]);
    }
  }
  return positions;

  function appendStreetPoint(target, coordinate) {
    const world = projectLonLat(coordinate[0], coordinate[1], projection);
    const elevation = sampleTerrainMosaic(mosaic, coordinate[0], coordinate[1]);
    target.push(world.x, (elevation - baseElevation) * verticalScale + liftM, world.z);
  }
}

export function buildTerrainMeshData({
  bounds,
  boundary,
  mosaic,
  projection,
  resolution,
  verticalScale,
}) {
  assertBounds(bounds);
  if (!boundary || !["Polygon", "MultiPolygon"].includes(boundary.type)) {
    throw new Error("Coverage area boundary is required for the terrain cutout.");
  }

  const columns = Math.max(8, Math.floor(resolution));
  const rows = columns;
  const clippingBoundary = simplifyBoundaryForGrid(boundary, columns * 6);
  const [minLon, minLat, maxLon, maxLat] = bounds.map(Number);
  const vertexColumns = columns + 1;
  const heights = new Float32Array(vertexColumns * (rows + 1));
  let minElevation = Number.POSITIVE_INFINITY;
  let maxElevation = Number.NEGATIVE_INFINITY;

  for (let row = 0; row <= rows; row += 1) {
    const lat = maxLat - ((maxLat - minLat) * row) / rows;
    for (let column = 0; column <= columns; column += 1) {
      const lon = minLon + ((maxLon - minLon) * column) / columns;
      const elevation = sampleTerrainMosaic(mosaic, lon, lat);
      heights[row * vertexColumns + column] = elevation;
      minElevation = Math.min(minElevation, elevation);
      maxElevation = Math.max(maxElevation, elevation);
    }
  }

  const included = new Uint8Array(columns * rows);
  for (let row = 0; row < rows; row += 1) {
    const lat = maxLat - ((maxLat - minLat) * (row + 0.5)) / rows;
    for (let column = 0; column < columns; column += 1) {
      const lon = minLon + ((maxLon - minLon) * (column + 0.5)) / columns;
      included[row * columns + column] = pointInBoundary(lon, lat, clippingBoundary)
        ? 1
        : 0;
    }
  }

  if (!included.some((value) => value === 1)) {
    throw new Error("Coverage boundary produced an empty terrain cutout.");
  }

  const northWest = projectLonLat(minLon, maxLat, projection);
  const southEast = projectLonLat(maxLon, minLat, projection);
  const horizontalSpan = Math.max(
    Math.abs(southEast.x - northWest.x),
    Math.abs(southEast.z - northWest.z)
  );
  const bottomY = -Math.max(30, Math.min(180, horizontalSpan * 0.008));
  const positions = [];

  for (let row = 0; row < rows; row += 1) {
    for (let column = 0; column < columns; column += 1) {
      if (!included[row * columns + column]) {
        continue;
      }
      const top = cellCorners(column, row);
      appendQuad(positions, top[0], top[2], top[1], top[1], top[2], top[3]);
      const bottom = top.map((point) => [point[0], bottomY, point[2]]);
      appendQuad(
        positions,
        bottom[0],
        bottom[1],
        bottom[2],
        bottom[1],
        bottom[3],
        bottom[2]
      );

      appendExposedEdge(column, row, 0, -1, top[0], top[1]);
      appendExposedEdge(column, row, 1, 0, top[1], top[3]);
      appendExposedEdge(column, row, 0, 1, top[3], top[2]);
      appendExposedEdge(column, row, -1, 0, top[2], top[0]);
    }
  }

  return {
    positions: new Float32Array(positions),
    minElevation,
    maxElevation,
    bottomY,
    horizontalSpan,
  };

  function cellCorners(column, row) {
    return [
      vertex(column, row),
      vertex(column + 1, row),
      vertex(column, row + 1),
      vertex(column + 1, row + 1),
    ];
  }

  function vertex(column, row) {
    const lon = minLon + ((maxLon - minLon) * column) / columns;
    const lat = maxLat - ((maxLat - minLat) * row) / rows;
    const world = projectLonLat(lon, lat, projection);
    const elevation = heights[row * vertexColumns + column];
    return [world.x, (elevation - minElevation) * verticalScale, world.z];
  }

  function appendExposedEdge(column, row, dx, dy, start, end) {
    const neighborColumn = column + dx;
    const neighborRow = row + dy;
    const neighborIncluded =
      neighborColumn >= 0 &&
      neighborColumn < columns &&
      neighborRow >= 0 &&
      neighborRow < rows &&
      included[neighborRow * columns + neighborColumn];
    if (neighborIncluded) {
      return;
    }
    const startBottom = [start[0], bottomY, start[2]];
    const endBottom = [end[0], bottomY, end[2]];
    appendQuad(positions, start, startBottom, end, end, startBottom, endBottom);
  }
}

function appendQuad(target, ...points) {
  for (const point of points) {
    target.push(point[0], point[1], point[2]);
  }
}

function assertBounds(bounds) {
  if (
    !Array.isArray(bounds) ||
    bounds.length !== 4 ||
    bounds.some((value) => !Number.isFinite(Number(value))) ||
    Number(bounds[0]) >= Number(bounds[2]) ||
    Number(bounds[1]) >= Number(bounds[3])
  ) {
    throw new Error(
      "A valid [minLon, minLat, maxLon, maxLat] bounding box is required."
    );
  }
}

function simplifyBoundaryForGrid(boundary, maxPointsPerRing) {
  const simplifyRing = (ring) => {
    if (!Array.isArray(ring) || ring.length <= maxPointsPerRing) {
      return ring;
    }
    const closed =
      ring.length > 1 &&
      ring[0]?.[0] === ring.at(-1)?.[0] &&
      ring[0]?.[1] === ring.at(-1)?.[1];
    const sourceLength = closed ? ring.length - 1 : ring.length;
    const stride = Math.ceil(sourceLength / Math.max(3, maxPointsPerRing - 1));
    const simplified = [];
    for (let index = 0; index < sourceLength; index += stride) {
      simplified.push(ring[index]);
    }
    if (closed && simplified.length > 0) {
      simplified.push(simplified[0]);
    }
    return simplified;
  };

  if (boundary.type === "Polygon") {
    return {
      ...boundary,
      coordinates: boundary.coordinates.map(simplifyRing),
    };
  }
  return {
    ...boundary,
    coordinates: boundary.coordinates.map((polygon) => polygon.map(simplifyRing)),
  };
}
