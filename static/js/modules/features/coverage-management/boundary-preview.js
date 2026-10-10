/**
 * The Add Area search's preview: the boundary of the place picked, on a
 * small map, so where it lies is plain before its streets are built.
 */

import MapStyles from "../../map-styles.js";
import { boundaryBounds, createModalMap } from "./modal-map.js";

const MAP_CONTAINER_ID = "place-preview-map";
const SOURCE_ID = "place-preview";
const FILL_LAYER_ID = "place-preview-fill";
const LINE_LAYER_ID = "place-preview-line";

const preview = {
  map: null,
  ready: false,
  loading: null,
  boundary: null,
  // Bumped when the page leaves, so a map still loading is never created.
  generation: 0,
};

function container() {
  return document.getElementById(MAP_CONTAINER_ID);
}

function drawBoundary() {
  const { map, boundary } = preview;
  if (!map || !preview.ready || !boundary) {
    return;
  }
  const data = { type: "Feature", properties: {}, geometry: boundary };
  try {
    const source = map.getSource(SOURCE_ID);
    if (source) {
      source.setData(data);
    } else {
      const colors = MapStyles.MAP_LAYER_COLORS.customPlaces;
      map.addSource(SOURCE_ID, { type: "geojson", data });
      map.addLayer({
        id: FILL_LAYER_ID,
        type: "fill",
        source: SOURCE_ID,
        paint: { "fill-color": colors.fill, "fill-opacity": 0.2 },
      });
      map.addLayer({
        id: LINE_LAYER_ID,
        type: "line",
        source: SOURCE_ID,
        paint: { "line-color": colors.outline, "line-width": 2.5 },
      });
    }
    map.resize();
    const bounds = boundaryBounds(boundary);
    if (bounds) {
      map.fitBounds(bounds, { padding: 24, duration: 0 });
    }
  } catch (error) {
    console.warn("Couldn't preview the area boundary:", error);
    container()?.classList.add("d-none");
  }
}

/** Show ``boundary`` (a GeoJSON Polygon or MultiPolygon) on the preview map. */
export async function showBoundaryPreview(boundary) {
  const host = container();
  if (!host || !boundary) {
    return;
  }
  preview.boundary = boundary;
  host.classList.remove("d-none");
  if (preview.map) {
    drawBoundary();
    return;
  }
  const { generation } = preview;
  preview.loading ??= createModalMap(MAP_CONTAINER_ID, {
    isCurrent: () => generation === preview.generation,
  })
    .then((map) => {
      if (!map) {
        return;
      }
      preview.map = map;
      map.on("load", () => {
        preview.ready = true;
        drawBoundary();
      });
    })
    .finally(() => {
      preview.loading = null;
    });
  try {
    await preview.loading;
  } catch (error) {
    console.warn("Couldn't load the preview map:", error);
    host.classList.add("d-none");
  }
}

export function hideBoundaryPreview() {
  preview.boundary = null;
  container()?.classList.add("d-none");
}

export function destroyBoundaryPreview() {
  preview.generation += 1;
  preview.map?.remove();
  preview.map = null;
  preview.ready = false;
  preview.loading = null;
  preview.boundary = null;
}
