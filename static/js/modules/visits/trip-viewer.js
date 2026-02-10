/* global bootstrap, mapboxgl */

import { CONFIG } from "../core/config.js";
import MapStyles from "../map-styles.js";
import { DateUtils } from "../utils.js";
import { VisitsGeometry } from "./geometry.js";

class TripViewer {
  constructor({ geometryUtils = VisitsGeometry, mapStyles = MapStyles } = {}) {
    this.geometryUtils = geometryUtils;
    this.mapStyles = mapStyles;
    this.tripViewMap = null;
    this.startMarker = null;
    this.endMarker = null;
    this.currentTheme
      = document.documentElement.getAttribute("data-bs-theme") || "dark";
  }

  showTrip(trip) {
    const modalElement = document.getElementById("view-trip-modal");
    const tripInfoContainer = document.getElementById("trip-info");
    if (!modalElement || !tripInfoContainer) {
      return;
    }

    const startTime = trip.startTime
      ? DateUtils.formatForDisplay(trip.startTime, {
          dateStyle: "medium",
          timeStyle: "short",
        })
      : "Unknown";
    const endTime = trip.endTime
      ? DateUtils.formatForDisplay(trip.endTime, {
          dateStyle: "medium",
          timeStyle: "short",
        })
      : "Unknown";

    let formattedDistance = "Unknown";
    if (trip.distance) {
      let distanceValue
        = typeof trip.distance === "object" && trip.distance.value !== undefined
          ? trip.distance.value
          : trip.distance;
      distanceValue = parseFloat(distanceValue);
      if (!Number.isNaN(distanceValue) && distanceValue >= 0) {
        formattedDistance = `${distanceValue.toFixed(2)} miles`;
      }
    }

    const transactionId = trip.transactionId || trip.id || trip._id;
    const startLocation
      = trip.startLocation?.formatted_address || trip.startPlace || "Unknown";
    const endLocation
      = trip.destination?.formatted_address || trip.destinationPlace || "Unknown";

    tripInfoContainer.innerHTML = `
        <div class="trip-details">
          <h6 class="mb-3">
            <i class="fas fa-hashtag me-2"></i>
            Trip ${transactionId}
          </h6>
          <div class="row g-3">
            <div class="col-md-6">
              <div class="info-card p-3 bg-body-secondary rounded">
                <h6 class="text-success mb-2">
                  <i class="fas fa-play-circle me-2"></i>Start
                </h6>
                <p class="mb-1"><strong>Time:</strong> ${startTime}</p>
                <p class="mb-0 text-truncate" title="${startLocation}">
                  <strong>Location:</strong> ${startLocation}
                </p>
              </div>
            </div>
            <div class="col-md-6">
              <div class="info-card p-3 bg-body-secondary rounded">
                <h6 class="text-danger mb-2">
                  <i class="fas fa-stop-circle me-2"></i>End
                </h6>
                <p class="mb-1"><strong>Time:</strong> ${endTime}</p>
                <p class="mb-0 text-truncate" title="${endLocation}">
                  <strong>Location:</strong> ${endLocation}
                </p>
              </div>
            </div>
          </div>
          <div class="mt-3 text-center">
            <span class="badge bg-primary px-3 py-2">
              <i class="fas fa-route me-2"></i>
              Distance: ${formattedDistance}
            </span>
          </div>
        </div>
      `;

    const modal = bootstrap.Modal.getOrCreateInstance(modalElement);
    modalElement.removeEventListener("shown.bs.modal", this._handleTripModalShown);
    this._handleTripModalShown = () => this._initializeOrUpdateTripMap(trip);
    modalElement.addEventListener("shown.bs.modal", this._handleTripModalShown, {
      once: true,
    });

    modal.show();
  }

  updateTheme(theme) {
    this.currentTheme = theme;
    if (!this.tripViewMap) {
      return;
    }

    const styleUrl
      = this.currentTheme === "light"
        ? CONFIG.MAP.styles.light
        : CONFIG.MAP.styles.dark;

    const center = this.tripViewMap.getCenter();
    const zoom = this.tripViewMap.getZoom();
    const bearing = this.tripViewMap.getBearing();
    const pitch = this.tripViewMap.getPitch();

    this.tripViewMap.setStyle(styleUrl);
    this.tripViewMap.once("styledata", () => {
      this.tripViewMap.jumpTo({ center, zoom, bearing, pitch });
      setTimeout(() => this.tripViewMap.resize(), 100);
    });
  }

  _initializeOrUpdateTripMap(trip) {
    const mapContainer = document.getElementById("trip-map-container");
    if (!mapContainer) {
      return;
    }

    if (!this.tripViewMap) {
      const mapElement = document.createElement("div");
      mapElement.id = "trip-map-instance";
      mapElement.style.height = "100%";
      mapElement.style.width = "100%";
      mapContainer.innerHTML = "";
      mapContainer.appendChild(mapElement);

      const styleUrl
        = this.currentTheme === "light"
          ? CONFIG.MAP.styles.light
          : CONFIG.MAP.styles.dark;

      this.tripViewMap = new mapboxgl.Map({
        container: mapElement.id,
        style: styleUrl,
        center: [-95.7129, 37.0902],
        zoom: 4,
        attributionControl: false,
      });

      this.tripViewMap.on("load", () => this._updateTripMapData(trip));
    } else {
      this._updateTripMapData(trip);
    }
  }

  _updateTripMapData(trip) {
    if (!this.tripViewMap) {
      return;
    }

    if (this.tripViewMap.getLayer("trip-path")) {
      this.tripViewMap.removeLayer("trip-path");
    }
    if (this.tripViewMap.getLayer("trip-path-outline")) {
      this.tripViewMap.removeLayer("trip-path-outline");
    }
    if (this.tripViewMap.getSource("trip")) {
      this.tripViewMap.removeSource("trip");
    }

    this.startMarker?.remove();
    this.endMarker?.remove();

    document.getElementById("trip-info").querySelector(".alert")?.remove();

    if (trip.geometry?.coordinates?.length > 0) {
      try {
        this.tripViewMap.addSource("trip", {
          type: "geojson",
          data: trip.geometry,
        });

        this.tripViewMap.addLayer({
          id: "trip-path-outline",
          type: "line",
          source: "trip",
          paint: {
            "line-color": "#b87a4a",
            "line-width": 6,
            "line-opacity": 0.6,
          },
        });

        this.tripViewMap.addLayer({
          id: "trip-path",
          type: "line",
          source: "trip",
          paint: {
            "line-color": this.mapStyles.MAP_LAYER_COLORS.customPlaces.fill,
            "line-width": 4,
            "line-dasharray": [2, 1],
          },
        });

        const { coordinates } = trip.geometry;
        const startCoord = coordinates[0];
        const endCoord = coordinates[coordinates.length - 1];

        if (Array.isArray(startCoord) && startCoord.length >= 2) {
          this.startMarker = new mapboxgl.Marker({
            color: "#4d9a6a",
            scale: 1.2,
          })
            .setLngLat(startCoord)
            .setPopup(new mapboxgl.Popup({ offset: 25 }).setText("Trip Start"))
            .addTo(this.tripViewMap);
        }

        if (Array.isArray(endCoord) && endCoord.length >= 2) {
          this.endMarker = new mapboxgl.Marker({
            color: "#c45454",
            scale: 1.2,
          })
            .setLngLat(endCoord)
            .setPopup(new mapboxgl.Popup({ offset: 25 }).setText("Trip End"))
            .addTo(this.tripViewMap);
        }

        const bounds = coordinates.reduce(
          (b, c) => b.extend(c),
          new mapboxgl.LngLatBounds(coordinates[0], coordinates[0])
        );
        this.tripViewMap.fitBounds(bounds, {
          padding: 50,
          maxZoom: 16,
          duration: 1000,
        });
      } catch (error) {
        document.getElementById("trip-info").innerHTML
          += '<div class="alert alert-danger mt-3"><i class="fas fa-exclamation-triangle me-2"></i>Error displaying trip route.</div>';
        console.error("Error processing trip geometry:", error);
      }
    } else {
      document.getElementById("trip-info").innerHTML
        += '<div class="alert alert-warning mt-3"><i class="fas fa-info-circle me-2"></i>No route data available for this trip.</div>';
      this.tripViewMap.setCenter([-95.7129, 37.0902]);
      this.tripViewMap.setZoom(4);
    }

    this.tripViewMap.resize();
  }
}

export { TripViewer };
export default TripViewer;
