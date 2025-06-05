(function () {
  async function fetchTrip(tripId) {
    const resp = await fetch(`/api/trips/${tripId}`);
    if (!resp.ok) {
      throw new Error(`Failed to fetch trip ${tripId}`);
    }
    const data = await resp.json();
    return data.trip || data;
  }

  function extractGeometry(trip) {
    if (
      trip.gps &&
      typeof trip.gps === "object" &&
      trip.gps.type === "LineString"
    ) {
      return trip.gps;
    }
    if (trip.geometry?.coordinates?.length) {
      return trip.geometry;
    }
    if (trip.matchedGps?.coordinates?.length) {
      return trip.matchedGps;
    }
    if (typeof trip.gps === "string" && trip.gps) {
      try {
        const gps = JSON.parse(trip.gps);
        if (gps?.coordinates?.length) return gps;
      } catch (e) {
        console.warn("Failed to parse gps JSON");
      }
    }
    if (
      trip.startGeoPoint?.coordinates &&
      trip.destinationGeoPoint?.coordinates
    ) {
      return {
        type: "LineString",
        coordinates: [
          trip.startGeoPoint.coordinates,
          trip.destinationGeoPoint.coordinates,
        ],
      };
    }
    return null;
  }

  function formatDate(value) {
    if (!value) return "Unknown";
    try {
      return new Date(value).toLocaleString();
    } catch {
      return String(value);
    }
  }

  function updateInfo(trip) {
    const infoEl = document.getElementById("trip-info");
    if (!infoEl) return;
    const start = formatDate(trip.startTime);
    const end = formatDate(trip.endTime);
    const dist = trip.distance
      ? parseFloat(trip.distance).toFixed(2) + " miles"
      : "Unknown";
    infoEl.innerHTML = `<p><strong>Start:</strong> ${start}</p>
<p><strong>End:</strong> ${end}</p>
<p><strong>Distance:</strong> ${dist}</p>`;
  }

  function showTripOnMap(map, layerGroup, geometry) {
    if (!geometry || !geometry.coordinates || !geometry.coordinates.length)
      return;
    const path = L.geoJSON(geometry, {
      style: { color: "#BB86FC", weight: 4, opacity: 0.8 },
    });
    layerGroup.addLayer(path);
    const coords = geometry.coordinates;
    L.marker([coords[0][1], coords[0][0]], {
      icon: L.divIcon({
        className: "trip-marker start-marker",
        html: '<i class="fas fa-play-circle"></i>',
        iconSize: [20, 20],
        iconAnchor: [10, 10],
      }),
    }).addTo(layerGroup);
    L.marker([coords[coords.length - 1][1], coords[coords.length - 1][0]], {
      icon: L.divIcon({
        className: "trip-marker end-marker",
        html: '<i class="fas fa-stop-circle"></i>',
        iconSize: [20, 20],
        iconAnchor: [10, 10],
      }),
    }).addTo(layerGroup);
    map.fitBounds(path.getBounds(), { padding: [25, 25], maxZoom: 17 });
  }

  async function init() {
    const tripId = window.TRIP_ID;
    if (!tripId) return;
    const map = window.mapBase.createMap("trip-map", {
      library: "leaflet",
      center: [37.8, -96],
      zoom: 4,
      tileLayer:
        "https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png",
      tileOptions: { maxZoom: 19 },
    });
    const layerGroup = L.layerGroup().addTo(map);
    try {
      const trip = await fetchTrip(tripId);
      updateInfo(trip);
      const geom = extractGeometry(trip);
      if (geom) {
        showTripOnMap(map, layerGroup, geom);
      }
    } catch (e) {
      console.error("Failed to load trip", e);
      const infoEl = document.getElementById("trip-info");
      if (infoEl) infoEl.textContent = "Failed to load trip data.";
    }
  }

  document.addEventListener("DOMContentLoaded", init);
})();
