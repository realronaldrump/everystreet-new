/* global bootstrap */

import { DateUtils } from "../utils.js";

class VisitsUIManager {
  constructor(visitsManager) {
    this.manager = visitsManager;
    this.isDetailedView = false;
    this.isCustomPlacesVisible = true;
    this.sectionDisplayState = new Map();
  }

  setupEnhancedUI() {
    // Smooth scrolling
    document.querySelectorAll('a[href^="#"]').forEach((anchor) => {
      anchor.addEventListener("click", (e) => {
        e.preventDefault();
        const href = anchor.getAttribute("href");
        if (href && href !== "#") {
          try {
            const target = document.querySelector(href);
            if (target) {
              target.scrollIntoView({ behavior: "smooth", block: "start" });
            }
          } catch {
            console.warn("Invalid selector for smooth scroll:", href);
          }
        }
      });
    });

    // Tooltips
    const tooltipTriggerList = [].slice.call(
      document.querySelectorAll('[data-bs-toggle="tooltip"]')
    );
    tooltipTriggerList.forEach((tooltipTriggerEl) => {
      bootstrap.Tooltip.getOrCreateInstance(tooltipTriggerEl, {
        template:
          '<div class="tooltip" role="tooltip"><div class="tooltip-arrow"></div><div class="tooltip-inner bg-primary"></div></div>',
      });
    });

    // Input focus effects
    document.querySelectorAll(".place-name-input").forEach((input) => {
      input.addEventListener("focus", () => {
        input.parentElement.classList.add("focused");
      });

      input.addEventListener("blur", () => {
        if (!input.value) {
          input.parentElement.classList.remove("focused");
        }
      });
    });
  }

  showManagePlacesModal(placesMap) {
    const modalElement = document.getElementById("manage-places-modal");
    if (!modalElement) {
      return;
    }

    const modal = bootstrap.Modal.getOrCreateInstance(modalElement);
    this.refreshManagePlacesModal(placesMap);
    modal.show();
  }

  refreshManagePlacesModal(placesMap) {
    const tableBody = document.querySelector("#manage-places-table tbody");
    if (!tableBody) {
      return;
    }

    tableBody.innerHTML = "";
    const placesArray = Array.from(placesMap.values());
    placesArray.sort((a, b) => a.name.localeCompare(b.name));

    if (placesArray.length === 0) {
      tableBody.innerHTML = `
          <tr>
            <td colspan="3" class="text-center">
              <div class="empty-state py-4">
                <i class="fas fa-map-marked-alt"></i>
                <h5>No Custom Places Yet</h5>
                <p>Draw your first place on the map to get started</p>
              </div>
            </td>
          </tr>
        `;
      return;
    }

    placesArray.forEach((place, index) => {
      const row = tableBody.insertRow();
      const placeId = place?._id ?? place?.id ?? "";
      const createdDate = place.createdAt
        ? DateUtils.formatForDisplay(place.createdAt, { dateStyle: "medium" })
        : "Unknown";

      row.innerHTML = `
          <td>
            <i class="fas fa-map-marker-alt me-2 text-primary"></i>
            ${place.name}
          </td>
          <td class="text-center text-muted">${createdDate}</td>
          <td class="text-center">
            <div class="btn-group btn-group-sm" role="group">
              <button type="button" class="btn btn-primary edit-place-btn" data-place-id="${placeId}" title="Edit Name/Boundary">
                <i class="fas fa-edit"></i> Edit
              </button>
              <button type="button" class="btn btn-danger delete-place-btn" data-place-id="${placeId}" title="Delete Place">
                <i class="fas fa-trash-alt"></i> Delete
              </button>
            </div>
          </td>
        `;

      row.style.opacity = "0";
      setTimeout(() => {
        row.style.transition = "opacity 0.3s ease";
        row.style.opacity = "1";
      }, index * 50);

      row.querySelector(".edit-place-btn").addEventListener("click", (e) => {
        const selectedPlaceId = e.currentTarget.getAttribute("data-place-id");
        bootstrap.Modal.getInstance(
          document.getElementById("manage-places-modal")
        )?.hide();
        this.showEditPlaceModal(selectedPlaceId, placesMap);
      });

      row.querySelector(".delete-place-btn").addEventListener("click", (e) => {
        const selectedPlaceId = e.currentTarget.getAttribute("data-place-id");
        bootstrap.Modal.getInstance(
          document.getElementById("manage-places-modal")
        )?.hide();
        this.manager.deletePlace(selectedPlaceId);
      });
    });
  }

  showEditPlaceModal(placeId, placesMap) {
    const place = placesMap.get(placeId);
    if (!place) {
      return;
    }

    const modalElement = document.getElementById("edit-place-modal");
    if (!modalElement) {
      return;
    }

    document.getElementById("edit-place-id").value = placeId;
    document.getElementById("edit-place-name").value = place.name;

    this.manager.resetDrawing();

    const modal = bootstrap.Modal.getOrCreateInstance(modalElement);
    modal.show();
  }

  toggleCustomPlacesVisibility(isVisible) {
    this.isCustomPlacesVisible = isVisible;
    this.manager.mapController.toggleCustomPlacesVisibility(isVisible);

    const customContent = document.getElementById("custom-places-content");
    const customTabButton = document.getElementById("custom-places-tab");

    if (isVisible) {
      customContent?.classList.remove("hidden");
      if (customTabButton?.parentElement) {
        customTabButton.parentElement.style.display = "";
      }

      if (!customTabButton?.classList.contains("active")) {
        const nonCustomTab = document.getElementById("non-custom-places-tab");
        if (nonCustomTab?.classList.contains("active")) {
          bootstrap.Tab.getOrCreateInstance(customTabButton)?.show();
        }
      }
    } else {
      customContent?.classList.add("hidden");
      if (customTabButton?.parentElement) {
        customTabButton.parentElement.style.display = "none";
      }

      if (customTabButton?.classList.contains("active")) {
        const nonCustomTab = document.getElementById("non-custom-places-tab");
        if (nonCustomTab) {
          bootstrap.Tab.getOrCreateInstance(nonCustomTab)?.show();
        }
      }
    }
  }

  _getDetailViewContainer() {
    return (
      document.getElementById("trips-for-place-container") ||
      document.getElementById("trips-section")
    );
  }

  _setMainContentVisible(isVisible) {
    const mainViewContainer = document.getElementById("visits-table-container");
    if (mainViewContainer) {
      mainViewContainer.classList.toggle("hidden", !isVisible);
      return;
    }

    const sections = document.querySelectorAll(".visits-section");
    if (!sections.length) {
      return;
    }

    if (isVisible) {
      sections.forEach((section) => {
        if (section.id === "trips-section") {
          return;
        }
        if (!this.sectionDisplayState.has(section)) {
          return;
        }
        section.style.display = this.sectionDisplayState.get(section);
      });
      this.sectionDisplayState.clear();
      return;
    }

    this.sectionDisplayState.clear();
    sections.forEach((section) => {
      if (section.id === "trips-section") {
        return;
      }
      this.sectionDisplayState.set(section, section.style.display);
      section.style.display = "none";
    });
  }

  _setDetailContentVisible(isVisible) {
    const detailViewContainer = this._getDetailViewContainer();
    if (!detailViewContainer) {
      return;
    }

    detailViewContainer.classList.toggle("hidden", !isVisible);
    detailViewContainer.style.display = isVisible ? "block" : "none";
  }

  async toggleView(placeId = null) {
    if (placeId) {
      this._setMainContentVisible(false);
      this._setDetailContentVisible(true);
      this.isDetailedView = true;

      if (typeof this.manager.showTripsForPlace === "function") {
        await this.manager.showTripsForPlace(placeId);
      } else if (typeof this.manager.loadTripsForPlace === "function") {
        await this.manager.loadTripsForPlace(placeId);
      } else {
        console.warn("Visits manager has no method to load trips for place.");
      }
      return;
    }

    this._setDetailContentVisible(false);
    this._setMainContentVisible(true);
    this.isDetailedView = false;
  }

  updateStatsDisplay(stats) {
    if (!stats) {
      return;
    }

    const totalVisits = stats.reduce((sum, place) => sum + place.totalVisits, 0);
    this.manager.statsManager.updateStatsCounts(this.manager.places.size, totalVisits);

    // Update stats cards
    const totalPlaces = document.getElementById("total-places-count");
    const totalVisitsEl = document.getElementById("total-visits-count");

    if (totalPlaces) {
      totalPlaces.textContent = this.manager.places.size;
    }
    if (totalVisitsEl) {
      totalVisitsEl.textContent = totalVisits;
    }

    this.manager.statsManager.updateInsights(stats);
  }
}

export { VisitsUIManager };
export default VisitsUIManager;
