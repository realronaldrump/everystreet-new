import { escapeHtml } from "../../../utils.js";

export function sortRegions(regions = []) {
  return [...regions].sort((a, b) => {
    if (a.has_children && !b.has_children) {
      return -1;
    }
    if (!a.has_children && b.has_children) {
      return 1;
    }
    return a.name.localeCompare(b.name);
  });
}

export function renderRegionList(regionList, regions = []) {
  if (!regionList) {
    return;
  }

  if (regions.length === 0) {
    regionList.innerHTML = '<div class="text-muted">No regions found.</div>';
    return;
  }

  regionList.innerHTML = regions
    .map(
      (region) => `
            <div class="region-item"
              data-region-id="${escapeHtml(region.id)}"
              data-region-name="${escapeHtml(region.name)}"
              data-region-size="${region.pbf_size_mb || ""}"
              data-has-children="${region.has_children}">
              <div class="d-flex align-items-center gap-2">
                ${region.has_children ? '<i class="fas fa-folder"></i>' : '<i class="fas fa-map"></i>'}
                <span>${escapeHtml(region.name)}</span>
              </div>
              <div class="text-muted small">
                ${region.pbf_size_mb ? `${region.pbf_size_mb.toFixed(1)} MB` : ""}
                ${region.has_children ? '<i class="fas fa-chevron-right ms-2"></i>' : ""}
              </div>
            </div>
          `
    )
    .join("");
}
