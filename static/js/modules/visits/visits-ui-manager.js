/* global bootstrap, DateUtils */

(() => {
  class VisitsUIManager {
    constructor(visitsManager) {
      this.manager = visitsManager;
      this.isDetailedView = false;
      this.isCustomPlacesVisible = true;
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
              <button type="button" class="btn btn-primary edit-place-btn" data-place-id="${place._id}" title="Edit Name/Boundary">
                <i class="fas fa-edit"></i> Edit
              </button>
              <button type="button" class="btn btn-danger delete-place-btn" data-place-id="${place._id}" title="Delete Place">
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
          const placeId = e.currentTarget.getAttribute("data-place-id");
          bootstrap.Modal.getInstance(
            document.getElementById("manage-places-modal")
          )?.hide();
          this.showEditPlaceModal(placeId, placesMap);
        });

        row.querySelector(".delete-place-btn").addEventListener("click", (e) => {
          const placeId = e.currentTarget.getAttribute("data-place-id");
          bootstrap.Modal.getInstance(
            document.getElementById("manage-places-modal")
          )?.hide();
          this.manager.deletePlace(placeId);
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

      this.manager.placeBeingEdited = null;
      if (this.manager.currentPolygon) {
        this.manager.resetDrawing();
      }

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

    async toggleView(placeId = null) {
      const mainViewContainer = document.getElementById("visits-table-container");
      const detailViewContainer = document.getElementById("trips-for-place-container");

      if (placeId) {
        const place = this.manager.places.get(placeId);
        if (!place) {
          console.error(`Cannot switch to detail view: Place ID ${placeId} not found.`);
          window.notificationManager?.show(
            "Could not find the selected place.",
            "warning"
          );
          return;
        }

        mainViewContainer.style.opacity = "0";
        setTimeout(() => {
          this.isDetailedView = true;
          mainViewContainer.style.display = "none";
          detailViewContainer.style.display = "block";
          detailViewContainer.style.opacity = "0";

          setTimeout(() => {
            detailViewContainer.style.transition = "opacity 0.3s ease";
            detailViewContainer.style.opacity = "1";
          }, 50);
        }, 300);

        const placeNameElement = document.getElementById("selected-place-name");
        if (placeNameElement) {
          placeNameElement.textContent = place.name;
        }

        await this.manager.showTripsForPlace(placeId);
        this.manager.mapController.animateToPlace(place);
      } else {
        detailViewContainer.style.opacity = "0";
        setTimeout(() => {
          this.isDetailedView = false;
          detailViewContainer.style.display = "none";
          mainViewContainer.style.display = "block";
          mainViewContainer.style.opacity = "0";

          setTimeout(() => {
            mainViewContainer.style.transition = "opacity 0.3s ease";
            mainViewContainer.style.opacity = "1";
          }, 50);
        }, 300);

        this.manager.visitsTable?.columns.adjust().responsive?.recalc?.();
      }
    }

    showInputError(input, message) {
      input?.classList.add("is-invalid");
      window.notificationManager?.show(message, "warning");
      input?.focus();
      input?.addEventListener(
        "input",
        () => {
          input.classList.remove("is-invalid");
        },
        { once: true }
      );
    }
  }

  window.VisitsUIManager = VisitsUIManager;
})();
