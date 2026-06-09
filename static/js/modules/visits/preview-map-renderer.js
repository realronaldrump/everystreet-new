import { computeBounds } from "./geometry.js";

const VIEWBOX_WIDTH = 160;
const VIEWBOX_HEIGHT = 120;
const PREVIEW_PADDING = 12;
const MIN_BOUND_SPAN = 0.0025;
const MAX_MERCATOR_LAT = 85.0511;

function isFiniteCoordinate(value) {
  return typeof value === "number" && Number.isFinite(value);
}

function escapeAttribute(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll('"', "&quot;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

function normalizeBounds(bounds) {
  if (!bounds) {
    return null;
  }

  let { minLng, minLat, maxLng, maxLat } = bounds;
  const spanLng = maxLng - minLng;
  const spanLat = maxLat - minLat;

  if (!Number.isFinite(spanLng) || !Number.isFinite(spanLat)) {
    return null;
  }

  if (spanLng < MIN_BOUND_SPAN) {
    const delta = (MIN_BOUND_SPAN - spanLng) / 2;
    minLng -= delta;
    maxLng += delta;
  }

  if (spanLat < MIN_BOUND_SPAN) {
    const delta = (MIN_BOUND_SPAN - spanLat) / 2;
    minLat -= delta;
    maxLat += delta;
  }

  const lngPad = (maxLng - minLng) * 0.14;
  const latPad = (maxLat - minLat) * 0.14;

  return {
    minLng: minLng - lngPad,
    minLat: minLat - latPad,
    maxLng: maxLng + lngPad,
    maxLat: maxLat + latPad,
  };
}

function normalizePreviewBounds(value) {
  const bounds = Array.isArray(value)
    ? {
        minLng: Number(value[0]),
        minLat: Number(value[1]),
        maxLng: Number(value[2]),
        maxLat: Number(value[3]),
      }
    : value;

  if (!bounds || typeof bounds !== "object") {
    return null;
  }

  const normalized = {
    minLng: Number(bounds.minLng),
    minLat: Number(bounds.minLat),
    maxLng: Number(bounds.maxLng),
    maxLat: Number(bounds.maxLat),
  };

  const spanLng = normalized.maxLng - normalized.minLng;
  const spanLat = normalized.maxLat - normalized.minLat;
  if (
    !Number.isFinite(spanLng) ||
    !Number.isFinite(spanLat) ||
    spanLng <= 0 ||
    spanLat <= 0
  ) {
    return null;
  }

  return normalized;
}

function clampMercatorLat(lat) {
  return Math.max(-MAX_MERCATOR_LAT, Math.min(MAX_MERCATOR_LAT, lat));
}

function mercatorY(lat) {
  const radians = (clampMercatorLat(lat) * Math.PI) / 180;
  return Math.log(Math.tan(Math.PI / 4 + radians / 2));
}

function createProjector(bounds, { padding = PREVIEW_PADDING, mercator = false } = {}) {
  const usableWidth = VIEWBOX_WIDTH - padding * 2;
  const usableHeight = VIEWBOX_HEIGHT - padding * 2;
  const spanLng = bounds.maxLng - bounds.minLng;
  const spanLat = bounds.maxLat - bounds.minLat;

  if (mercator) {
    const minY = mercatorY(bounds.minLat);
    const maxY = mercatorY(bounds.maxLat);
    const spanY = maxY - minY;
    return ([lng, lat]) => {
      if (!isFiniteCoordinate(lng) || !isFiniteCoordinate(lat) || spanY <= 0) {
        return null;
      }
      const x = padding + ((lng - bounds.minLng) / spanLng) * usableWidth;
      const y = padding + ((maxY - mercatorY(lat)) / spanY) * usableHeight;
      return [x, y];
    };
  }

  const scale = Math.min(usableWidth / spanLng, usableHeight / spanLat);
  const scaledWidth = spanLng * scale;
  const scaledHeight = spanLat * scale;
  const offsetX = (VIEWBOX_WIDTH - scaledWidth) / 2;
  const offsetY = (VIEWBOX_HEIGHT - scaledHeight) / 2;

  return ([lng, lat]) => {
    if (!isFiniteCoordinate(lng) || !isFiniteCoordinate(lat)) {
      return null;
    }
    const x = offsetX + (lng - bounds.minLng) * scale;
    const y = offsetY + (bounds.maxLat - lat) * scale;
    return [x, y];
  };
}

function collectRenderableCoordinates(geometry) {
  if (!geometry?.type) {
    return [];
  }

  switch (geometry.type) {
    case "Point":
      return Array.isArray(geometry.coordinates) ? [geometry.coordinates] : [];
    case "MultiPoint":
    case "LineString":
      return Array.isArray(geometry.coordinates) ? geometry.coordinates : [];
    case "MultiLineString":
    case "Polygon":
      return Array.isArray(geometry.coordinates) ? geometry.coordinates.flat(1) : [];
    case "MultiPolygon":
      return Array.isArray(geometry.coordinates) ? geometry.coordinates.flat(2) : [];
    case "GeometryCollection":
      return Array.isArray(geometry.geometries)
        ? geometry.geometries.flatMap((item) => collectRenderableCoordinates(item))
        : [];
    default:
      return [];
  }
}

function pointsToPath(points, project) {
  const projected = points.map(project).filter(Boolean);
  if (projected.length === 0) {
    return "";
  }
  const [firstX, firstY] = projected[0];
  const segments = [`M ${firstX.toFixed(2)} ${firstY.toFixed(2)}`];

  for (let index = 1; index < projected.length; index += 1) {
    const [x, y] = projected[index];
    segments.push(`L ${x.toFixed(2)} ${y.toFixed(2)}`);
  }

  return segments.join(" ");
}

function polygonPath(rings, project) {
  const parts = rings
    .map((ring) => pointsToPath(ring, project))
    .filter(Boolean)
    .map((path) => `${path} Z`);
  return parts.join(" ");
}

function renderGeometryShape(geometry, project, colors) {
  if (!geometry?.type) {
    return "";
  }

  switch (geometry.type) {
    case "Point": {
      const point = project(geometry.coordinates);
      if (!point) {
        return "";
      }
      const [x, y] = point;
      return [
        `<circle cx="${x.toFixed(2)}" cy="${y.toFixed(2)}" r="8" fill="${colors.fill}" fill-opacity="0.18" />`,
        `<circle cx="${x.toFixed(2)}" cy="${y.toFixed(2)}" r="4.25" fill="${colors.line}" />`,
      ].join("");
    }
    case "MultiPoint":
      return (Array.isArray(geometry.coordinates) ? geometry.coordinates : [])
        .map((coords) =>
          renderGeometryShape({ type: "Point", coordinates: coords }, project, colors)
        )
        .join("");
    case "LineString": {
      const path = pointsToPath(geometry.coordinates, project);
      if (!path) {
        return "";
      }
      return `<path d="${path}" fill="none" stroke="${colors.line}" stroke-width="3" stroke-linecap="round" stroke-linejoin="round" />`;
    }
    case "MultiLineString":
      return (Array.isArray(geometry.coordinates) ? geometry.coordinates : [])
        .map((coords) =>
          renderGeometryShape(
            { type: "LineString", coordinates: coords },
            project,
            colors
          )
        )
        .join("");
    case "Polygon": {
      const path = polygonPath(geometry.coordinates, project);
      if (!path) {
        return "";
      }
      return [
        `<path d="${path}" fill="${colors.fill}" fill-opacity="0.24" fill-rule="evenodd" />`,
        `<path d="${path}" fill="none" stroke="${colors.line}" stroke-width="2.5" stroke-linejoin="round" />`,
      ].join("");
    }
    case "MultiPolygon":
      return (Array.isArray(geometry.coordinates) ? geometry.coordinates : [])
        .map((coords) =>
          renderGeometryShape({ type: "Polygon", coordinates: coords }, project, colors)
        )
        .join("");
    case "GeometryCollection":
      return (Array.isArray(geometry.geometries) ? geometry.geometries : [])
        .map((item) => renderGeometryShape(item, project, colors))
        .join("");
    default:
      return "";
  }
}

function renderGridLines() {
  const columns = [0.2, 0.4, 0.6, 0.8].map((ratio) => ratio * VIEWBOX_WIDTH);
  const rows = [0.2, 0.4, 0.6, 0.8].map((ratio) => ratio * VIEWBOX_HEIGHT);
  const vertical = columns
    .map(
      (x) =>
        `<line x1="${x.toFixed(2)}" y1="0" x2="${x.toFixed(2)}" y2="${VIEWBOX_HEIGHT}" />`
    )
    .join("");
  const horizontal = rows
    .map(
      (y) =>
        `<line x1="0" y1="${y.toFixed(2)}" x2="${VIEWBOX_WIDTH}" y2="${y.toFixed(2)}" />`
    )
    .join("");

  return `<g data-layer="grid" stroke="currentColor" stroke-opacity="0.08">${vertical}${horizontal}</g>`;
}

function renderMapBackground(imageUrl) {
  const escapedImageUrl = escapeAttribute(imageUrl);
  return `<image data-layer="map-background" href="${escapedImageUrl}" xlink:href="${escapedImageUrl}" x="0" y="0" width="${VIEWBOX_WIDTH}" height="${VIEWBOX_HEIGHT}" preserveAspectRatio="none" />`;
}

function renderCenterMarker(bounds, project, colors) {
  const point = project([
    (bounds.minLng + bounds.maxLng) / 2,
    (bounds.minLat + bounds.maxLat) / 2,
  ]);
  if (!point) {
    return "";
  }
  const [x, y] = point;
  return [
    `<circle cx="${x.toFixed(2)}" cy="${y.toFixed(2)}" r="3.5" fill="${colors.line}" fill-opacity="0.18" />`,
    `<circle cx="${x.toFixed(2)}" cy="${y.toFixed(2)}" r="1.5" fill="${colors.line}" />`,
  ].join("");
}

function buildGeometryPreviewMarkup(geometry, colors, options = {}) {
  const backgroundImageUrl =
    typeof options.backgroundImageUrl === "string"
      ? options.backgroundImageUrl.trim()
      : "";
  const backgroundBounds = normalizePreviewBounds(
    options.previewBounds || options.bounds
  );
  const hasMapBackground = Boolean(backgroundImageUrl && backgroundBounds);
  const bounds = hasMapBackground
    ? backgroundBounds
    : normalizeBounds(computeBounds(geometry));
  if (!bounds) {
    return "";
  }

  const renderableCoords = collectRenderableCoordinates(geometry).filter(
    (coords) =>
      Array.isArray(coords) &&
      coords.length >= 2 &&
      isFiniteCoordinate(coords[0]) &&
      isFiniteCoordinate(coords[1])
  );
  if (renderableCoords.length === 0) {
    return "";
  }

  const project = createProjector(bounds, {
    padding: hasMapBackground ? 0 : PREVIEW_PADDING,
    mercator: hasMapBackground,
  });
  const shapes = renderGeometryShape(geometry, project, colors);
  if (!shapes) {
    return "";
  }

  return `
    <svg
      class="map-preview-graphic"
      viewBox="0 0 ${VIEWBOX_WIDTH} ${VIEWBOX_HEIGHT}"
      preserveAspectRatio="xMidYMid meet"
      xmlns="http://www.w3.org/2000/svg"
      aria-hidden="true"
      data-preview-geometry="${geometry.type}"
      data-preview-background="${hasMapBackground ? "map" : "grid"}"
    >
      ${hasMapBackground ? renderMapBackground(backgroundImageUrl) : renderGridLines()}
      <g data-layer="boundary">${shapes}</g>
      ${hasMapBackground ? "" : renderCenterMarker(bounds, project, colors)}
    </svg>
  `.trim();
}

function renderGeometryPreview(container, geometry, colors, options = {}) {
  if (!container) {
    return false;
  }

  container.querySelector(".map-preview-graphic")?.remove();
  const markup = buildGeometryPreviewMarkup(geometry, colors, options);
  if (!markup) {
    container.classList.remove("has-map");
    return false;
  }

  container.insertAdjacentHTML("afterbegin", markup);
  container.classList.add("has-map");
  return true;
}

export { buildGeometryPreviewMarkup, renderGeometryPreview };
