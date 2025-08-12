"use strict";

// Classic script exposing dashboard and map rendering helpers for coverage management.
// Exposes: window.CoverageModules.Dashboard

(() => {
  window.CoverageModules = window.CoverageModules || {};
  const STATUS = window.STATUS || {};

  const Dashboard = {
    async displayCoverageDashboard(manager, locationId) {
      manager.currentDashboardLocationId = locationId;
      const dashboardElement = document.getElementById("coverage-dashboard");
      const locationNameElement = document.getElementById(
        "dashboard-location-name",
      );
      const streetTypeChartElement =
        document.getElementById("street-type-chart");
      const streetTypeCoverageElement = document.getElementById(
        "street-type-coverage",
      );
      const mapContainer = document.getElementById("coverage-map");
      if (!dashboardElement || !locationNameElement || !mapContainer) {
        manager.notificationManager?.show(
          "UI Error: Dashboard components missing.",
          "danger",
        );
        return;
      }
      manager.clearDashboardUI?.();
      dashboardElement.style.display = "block";
      dashboardElement.classList.add("fade-in-up");
      locationNameElement.innerHTML = `<span class="loading-skeleton" style="width: 150px; display: inline-block;"></span>`;
      if (streetTypeChartElement)
        streetTypeChartElement.innerHTML = Dashboard.createLoadingSkeleton(180);
      if (streetTypeCoverageElement)
        streetTypeCoverageElement.innerHTML = Dashboard.createLoadingSkeleton(
          100,
          3,
        );
      mapContainer.innerHTML = Dashboard.createLoadingIndicator(
        "Loading map data...",
      );
      try {
        const cachedData = manager.getCachedData?.(`dashboard-${locationId}`);
        let coverageData;
        if (cachedData) {
          coverageData = cachedData;
          manager.notificationManager?.show(
            "Loaded dashboard from cache.",
            "info",
            1500,
          );
        } else {
          const metaResponse = await fetch(`/api/coverage_areas/${locationId}`);
          if (!metaResponse.ok) {
            const errorData = await metaResponse.json().catch(() => ({}));
            throw new Error(
              `Failed to load metadata: ${errorData.detail || metaResponse.statusText}`,
            );
          }
          const apiResponse = await metaResponse.json();
          if (
            !apiResponse.success ||
            !apiResponse.coverage ||
            !apiResponse.coverage.location
          ) {
            throw new Error(
              apiResponse.error || "Incomplete metadata received.",
            );
          }
          coverageData = apiResponse.coverage;
          const streetsResp = await fetch(
            `/api/coverage_areas/${locationId}/streets?cache_bust=${Date.now()}`,
          );
          if (!streetsResp.ok) {
            const errData = await streetsResp.json().catch(() => ({}));
            throw new Error(
              `Failed to load street geometry: ${errData.detail || streetsResp.statusText}`,
            );
          }
          coverageData.streets_geojson = await streetsResp.json();
          manager.setCachedData?.(`dashboard-${locationId}`, coverageData);
        }
        manager.selectedLocation = coverageData;
        locationNameElement.textContent =
          coverageData.location.display_name || "Unnamed Area";
        Dashboard.updateDashboardStats(manager, coverageData);
        Dashboard.updateStreetTypeCoverage(
          manager,
          coverageData.street_types || [],
        );
        Dashboard.createStreetTypeChart(
          manager,
          coverageData.street_types || [],
        );
        manager.updateFilterButtonStates?.();
        Dashboard.initializeCoverageMap(manager, coverageData);
        manager.showTripsActive =
          localStorage.getItem("showTripsOverlay") === "true";
        const tripToggle = document.getElementById("toggle-trip-overlay");
        if (tripToggle) tripToggle.checked = manager.showTripsActive;
      } catch (error) {
        // eslint-disable-next-line no-console
        console.error("Error displaying coverage dashboard:", error);
        locationNameElement.textContent = "Error loading data";
        manager.notificationManager?.show(
          `Error loading dashboard: ${error.message}`,
          "danger",
        );
        mapContainer.innerHTML = Dashboard.createAlertMessage(
          "Dashboard Load Error",
          error.message,
          "danger",
          locationId,
        );
      } finally {
        manager.initTooltips?.();
      }
    },

    createLoadingSkeleton(height, count = 1) {
      return Array.from({ length: count })
        .map(
          () =>
            `<div class="loading-skeleton skeleton-shimmer mb-2" style="height: ${height}px;"></div>`,
        )
        .join("");
    },

    updateDashboardStats(manager, coverage) {
      if (!coverage) return;
      const statsContainer = document.querySelector(
        ".dashboard-stats-card .stats-container",
      );
      if (!statsContainer) return;
      const totalLengthM = parseFloat(coverage.total_length || 0);
      const drivenLengthM = parseFloat(coverage.driven_length || 0);
      const coveragePercentage = parseFloat(
        coverage.coverage_percentage || 0,
      ).toFixed(1);
      const totalSegments = parseInt(coverage.total_segments || 0, 10);
      let coveredSegments = 0;
      if (Array.isArray(coverage.street_types)) {
        coveredSegments = coverage.street_types.reduce(
          (sum, t) =>
            sum +
            (parseInt(t.covered, 10) || parseInt(t.covered_segments, 10) || 0),
          0,
        );
      }
      const lastUpdated =
        coverage.last_stats_update || coverage.last_updated
          ? manager.formatRelativeTime?.(
              coverage.last_stats_update || coverage.last_updated,
            )
          : "Never";
      let barColor = "bg-success";
      if ([STATUS.ERROR, STATUS.CANCELED].includes(coverage.status))
        barColor = "bg-danger";
      else if (![STATUS.COMPLETED, STATUS.COMPLETE].includes(coverage.status))
        barColor = "bg-warning";
      const html = `
        <div class="row g-3">
          ${Dashboard.createStatItem(CoverageShared.UI.distanceInUserUnits(totalLengthM), "Total Length")}
          ${Dashboard.createStatItem(CoverageShared.UI.distanceInUserUnits(drivenLengthM), "Driven Length", "text-success")}
          ${Dashboard.createStatItem(`${coveragePercentage}%`, "Coverage", "text-primary")}
          ${Dashboard.createStatItem(totalSegments.toLocaleString(), "Total Segments")}
          ${Dashboard.createStatItem(coveredSegments.toLocaleString(), "Driven Segments", "text-success")}
          ${Dashboard.createStatItem(lastUpdated, "Last Updated", "text-muted", "small")}
        </div>
        <div class="progress mt-3 mb-2" style="height: 12px;">
          <div class="progress-bar ${barColor}" role="progressbar" style="width: ${coveragePercentage}%" aria-valuenow="${coveragePercentage}" aria-valuemin="0" aria-valuemax="100"></div>
        </div>`;
      statsContainer.innerHTML = html;
      statsContainer.querySelectorAll(".stat-value").forEach((el) => {
        el.classList.add("value-updated");
        setTimeout(() => el.classList.remove("value-updated"), 600);
      });
      const progressBar = statsContainer.querySelector(".progress-bar");
      if (progressBar) progressBar.style.transition = "width 0.6s ease";
      manager.initTooltips?.();
    },

    createStatItem(value, label, valueClass = "", labelClass = "") {
      return `
        <div class="col-md-4 col-6">
          <div class="stat-item">
            <div class="stat-value ${valueClass}">${value}</div>
            <div class="stat-label ${labelClass}">${label}</div>
          </div>
        </div>`;
    },

    updateStreetTypeCoverage(manager, streetTypes) {
      const streetTypeCoverageEl = document.getElementById(
        "street-type-coverage",
      );
      if (!streetTypeCoverageEl) return;
      if (!streetTypes || !streetTypes.length) {
        streetTypeCoverageEl.innerHTML = Dashboard.createAlertMessage(
          "No Data",
          "No street type data available.",
          "secondary",
        );
        return;
      }
      const sorted = [...streetTypes].sort(
        (a, b) =>
          parseFloat(b.total_length_m || 0) - parseFloat(a.total_length_m || 0),
      );
      const topTypes = sorted.slice(0, 6);
      streetTypeCoverageEl.innerHTML = topTypes
        .map((type) => {
          const coveragePct = parseFloat(type.coverage_percentage || 0).toFixed(
            1,
          );
          const coveredDist = CoverageShared.UI.distanceInUserUnits(
            parseFloat(type.covered_length_m || 0),
          );
          const totalDist = CoverageShared.UI.distanceInUserUnits(
            parseFloat((type.driveable_length_m ?? type.total_length_m) || 0),
          );
          const denominatorLabel =
            type.driveable_length_m !== undefined ? "Driveable" : "Total";
          const barColor =
            parseFloat(coveragePct) < 25
              ? "bg-danger"
              : parseFloat(coveragePct) < 75
                ? "bg-warning"
                : "bg-success";
          return `
            <div class="street-type-item mb-2">
              <div class="d-flex justify-content-between align-items-center mb-1">
                <small class="fw-bold text-truncate me-2" title="${Dashboard.formatStreetType(type.type)}">${Dashboard.formatStreetType(type.type)}</small>
                <small class="text-muted text-nowrap">${coveragePct}% (${coveredDist} / ${totalDist} ${denominatorLabel})</small>
              </div>
              <div class="progress" style="height: 8px;" title="${Dashboard.formatStreetType(type.type)}: ${coveragePct}% Covered">
                <div class="progress-bar ${barColor}" role="progressbar" style="width: ${coveragePct}%" aria-valuenow="${coveragePct}" aria-valuemin="0" aria-valuemax="100"></div>
              </div>
            </div>`;
        })
        .join("");
    },

    clearDashboardUI(manager) {
      document.getElementById("dashboard-location-name").textContent =
        "Select a location";
      const statsContainer = document.querySelector(
        ".dashboard-stats-card .stats-container",
      );
      if (statsContainer) statsContainer.innerHTML = "";
      const chartContainer = document.getElementById("street-type-chart");
      if (chartContainer) chartContainer.innerHTML = "";
      const coverageEl = document.getElementById("street-type-coverage");
      if (coverageEl) coverageEl.innerHTML = "";
      const mapContainer = document.getElementById("coverage-map");
      if (mapContainer) mapContainer.innerHTML = "";
      if (manager.coverageMap) {
        try {
          manager.coverageMap.remove();
        } catch (_) {}
        manager.coverageMap = null;
      }
      manager.selectedLocation = null;
      manager.streetsGeoJson = null;
      manager.mapBounds = null;
      if (manager.streetTypeChartInstance) {
        manager.streetTypeChartInstance.destroy();
        manager.streetTypeChartInstance = null;
      }
      manager.currentDashboardLocationId = null;
      if (manager.mapInfoPanel) {
        manager.mapInfoPanel.remove();
        manager.mapInfoPanel = null;
      }
      if (manager.coverageSummaryControl && manager.coverageMap) {
        try {
          manager.coverageMap.removeControl(manager.coverageSummaryControl);
        } catch (_) {}
        manager.coverageSummaryControl = null;
      }
      document.title = "Coverage Management";
      manager.clearEfficientStreetMarkers?.();
    },

    createLoadingIndicator(message = "Loading...") {
      return `
        <div class="d-flex flex-column align-items-center justify-content-center p-4 text-center text-muted h-100">
          <div class="loading-indicator mb-3"></div>
          <small>${message}</small>
        </div>`;
    },

    createAlertMessage(title, message, type = "info", locationId = null) {
      const icon =
        {
          danger: "fa-exclamation-circle",
          warning: "fa-exclamation-triangle",
          info: "fa-info-circle",
          secondary: "fa-question-circle",
        }[type] || "fa-info-circle";
      const showButton =
        locationId && (type === "danger" || type === "warning");
      const buttonHtml = showButton
        ? `
        <hr class="my-2">
        <p class="mb-1 small">Try running an update:</p>
        <button class="update-missing-data-btn btn btn-sm btn-primary" data-location-id="${locationId}">
          <i class="fas fa-sync-alt me-1"></i> Update Coverage Now
        </button>`
        : "";
      return `
        <div class="alert alert-${type} m-3 fade-in-up">
          <h5 class="alert-heading h6 mb-1"><i class="fas ${icon} me-2"></i>${title}</h5>
          <p class="small mb-0">${message}</p>
          ${buttonHtml}
        </div>`;
    },

    initializeCoverageMap(manager, coverage) {
      const mapContainer = document.getElementById("coverage-map");
      if (!mapContainer) return;
      if (
        manager.coverageMap &&
        typeof manager.coverageMap.remove === "function"
      ) {
        try {
          manager.coverageMap.remove();
        } catch (e) {
          /* noop */
        }
        manager.coverageMap = null;
      }
      mapContainer.innerHTML = "";
      if (!window.MAPBOX_ACCESS_TOKEN) {
        mapContainer.innerHTML = Dashboard.createAlertMessage(
          "Mapbox Token Missing",
          "Cannot display map. Please configure Mapbox access token.",
          "danger",
        );
        return;
      }
      mapboxgl.accessToken = window.MAPBOX_ACCESS_TOKEN;
      try {
        manager.coverageMap = new mapboxgl.Map({
          container: "coverage-map",
          style: "mapbox://styles/mapbox/dark-v11",
          center: [0, 0],
          zoom: 1,
          minZoom: 0,
          maxZoom: 20,
          preserveDrawingBuffer: true,
          attributionControl: false,
        });
        manager.coverageMap.addControl(
          new mapboxgl.NavigationControl(),
          "top-right",
        );
        manager.coverageMap.addControl(new mapboxgl.ScaleControl());
        manager.coverageMap.addControl(new mapboxgl.FullscreenControl());
        manager.coverageMap.addControl(
          new mapboxgl.AttributionControl({ compact: true }),
          "bottom-right",
        );
        manager.coverageMap.on("load", () => {
          if (coverage.streets_geojson)
            Dashboard.addStreetsToMap(manager, coverage.streets_geojson);
          else
            manager.notificationManager?.show(
              "No street data found for this area.",
              "warning",
            );
          Dashboard.addCoverageSummary?.(manager, coverage);
          Dashboard.fitMapToBounds(manager);
          manager.setupMapEventHandlers?.();
          if (manager.showTripsActive) {
            manager.setupTripLayers?.();
            manager.loadTripsForView?.();
          }
        });
        manager.coverageMap.on("error", (e) => {
          // eslint-disable-next-line no-console
          console.error("Mapbox GL Error:", e.error);
          manager.notificationManager?.show(
            `Map error: ${e.error?.message || "Unknown map error"}`,
            "danger",
          );
          mapContainer.innerHTML = Dashboard.createAlertMessage(
            "Map Load Error",
            e.error?.message || "Could not initialize map.",
            "danger",
          );
        });
        if (manager.mapInfoPanel) manager.mapInfoPanel.remove();
        manager.createMapInfoPanel?.();
        manager.createBulkActionToolbar?.();
      } catch (err) {
        // eslint-disable-next-line no-console
        console.error("Failed to initialize Mapbox GL:", err);
        mapContainer.innerHTML = Dashboard.createAlertMessage(
          "Map Initialization Failed",
          err.message,
          "danger",
        );
      }
    },

    addStreetsToMap(manager, geojson) {
      if (
        !manager.coverageMap ||
        !manager.coverageMap.isStyleLoaded() ||
        !geojson
      )
        return;
      [
        "streets-layer",
        "streets-hover-highlight",
        "streets-click-highlight",
        "streets-selection-highlight",
      ].forEach((id) => {
        if (manager.coverageMap.getLayer(id))
          manager.coverageMap.removeLayer(id);
      });
      if (manager.coverageMap.getSource("streets"))
        manager.coverageMap.removeSource("streets");
      manager.streetsGeoJson = geojson;
      manager.currentFilter = "all";
      manager.coverageMap.addSource("streets", {
        type: "geojson",
        data: geojson,
        promoteId: "segment_id",
      });
      const getLineColor = [
        "case",
        ["boolean", ["feature-state", "hover"], false],
        "#ffff00",
        ["!=", ["feature-state", "efficientRank"], null],
        [
          "case",
          ["==", ["feature-state", "efficientRank"], 1],
          "#ffd700",
          ["==", ["feature-state", "efficientRank"], 2],
          "#c0c0c0",
          ["==", ["feature-state", "efficientRank"], 3],
          "#cd7f32",
          "#9467bd",
        ],
        ["boolean", ["get", "undriveable"], false],
        "#607d8b",
        ["boolean", ["get", "driven"], false],
        "#4caf50",
        "#ff5252",
      ];
      const getLineWidth = [
        "interpolate",
        ["linear"],
        ["zoom"],
        8,
        1.5,
        14,
        4,
        18,
        7,
      ];
      const getLineOpacity = [
        "case",
        ["boolean", ["feature-state", "hover"], false],
        1.0,
        ["boolean", ["get", "undriveable"], false],
        0.6,
        0.85,
      ];
      const getLineDash = [
        "case",
        ["boolean", ["get", "undriveable"], false],
        ["literal", [2, 2]],
        ["literal", [1, 0]],
      ];
      manager.coverageMap.addLayer({
        id: "streets-layer",
        type: "line",
        source: "streets",
        layout: { "line-cap": "round", "line-join": "round" },
        paint: {
          "line-color": getLineColor,
          "line-width": getLineWidth,
          "line-opacity": getLineOpacity,
          "line-dasharray": getLineDash,
        },
      });
      const bounds = new mapboxgl.LngLatBounds();
      geojson.features.forEach((f) => {
        if (f.geometry?.coordinates) {
          if (f.geometry.type === "LineString")
            f.geometry.coordinates.forEach((c) => bounds.extend(c));
          else if (f.geometry.type === "MultiLineString")
            f.geometry.coordinates.forEach((line) =>
              line.forEach((c) => bounds.extend(c)),
            );
        }
      });
      manager.mapBounds = !bounds.isEmpty() ? bounds : null;
      let hoveredSegmentId = null;
      manager.coverageMap.on("mouseenter", "streets-layer", (e) => {
        manager.coverageMap.getCanvas().style.cursor = "pointer";
        const props = e.features?.[0]?.properties;
        if (!props) return;
        const currentHoverId = props.segment_id;
        if (currentHoverId !== hoveredSegmentId) {
          if (
            hoveredSegmentId !== null &&
            manager.coverageMap.getSource("streets")
          ) {
            manager.coverageMap.setFeatureState(
              { source: "streets", id: hoveredSegmentId },
              { hover: false },
            );
          }
          if (manager.coverageMap.getSource("streets")) {
            manager.coverageMap.setFeatureState(
              { source: "streets", id: currentHoverId },
              { hover: true },
            );
          }
          hoveredSegmentId = currentHoverId;
        }
        manager.updateMapInfoPanel?.(props, true);
        if (manager.mapInfoPanel) manager.mapInfoPanel.style.display = "block";
      });
      manager.coverageMap.on("mouseleave", "streets-layer", () => {
        manager.coverageMap.getCanvas().style.cursor = "";
        if (manager.mapInfoPanel) manager.mapInfoPanel.style.display = "none";
        if (
          hoveredSegmentId !== null &&
          manager.coverageMap.getSource("streets")
        ) {
          manager.coverageMap.setFeatureState(
            { source: "streets", id: hoveredSegmentId },
            { hover: false },
          );
        }
        hoveredSegmentId = null;
      });
      manager.coverageMap.on("click", "streets-layer", (e) => {
        if (e.originalEvent?.button !== 0) return;
        const props = e.features?.[0]?.properties;
        if (!props) return;
        const isMultiSelect =
          e.originalEvent?.ctrlKey ||
          e.originalEvent?.metaKey ||
          e.originalEvent?.shiftKey;
        if (isMultiSelect) {
          const segId = props.segment_id;
          if (segId) manager.toggleSegmentSelection?.(segId);
          return;
        }
        const popup = new mapboxgl.Popup({
          closeButton: true,
          closeOnClick: true,
          maxWidth: "350px",
          className: "coverage-popup",
        })
          .setLngLat(e.lngLat)
          .setHTML(manager.createStreetPopupContentHTML?.(props) || "")
          .addTo(manager.coverageMap);
        const popupElement = popup.getElement();
        popupElement?.addEventListener("click", (evt) => {
          const button = evt.target.closest("button[data-action]");
          if (!button) return;
          const action = button.dataset.action;
          const segmentId = button.dataset.segmentId;
          if (action && segmentId) {
            manager._handleMarkSegmentAction?.(action, segmentId);
            popup.remove();
          }
        });
        manager.updateMapInfoPanel?.(props, false);
        if (manager.mapInfoPanel) manager.mapInfoPanel.style.display = "block";
      });
    },

    fitMapToBounds(manager) {
      if (
        manager.coverageMap &&
        manager.mapBounds &&
        !manager.mapBounds.isEmpty()
      ) {
        try {
          manager.coverageMap.fitBounds(manager.mapBounds, {
            padding: 20,
            maxZoom: 17,
            duration: 800,
          });
        } catch (_) {
          manager.notificationManager?.show(
            "Could not zoom to area bounds. Map view may be incorrect.",
            "warning",
          );
        }
      } else if (manager.coverageMap) {
        manager.notificationManager?.show(
          "No geographical data to display for this area.",
          "info",
        );
      }
    },

    // (helpers already defined above)
    formatStreetType(type) {
      return !type
        ? "Unknown"
        : type.replace(/_/g, " ").replace(/\b\w/g, (l) => l.toUpperCase());
    },
    createStreetTypeChart(manager, streetTypes) {
      const chartContainer = document.getElementById("street-type-chart");
      if (!chartContainer) return;
      const labels = streetTypes.map((t) => Dashboard.formatStreetType(t.type));
      const dataValues = streetTypes.map((t) =>
        parseFloat(t.coverage_percentage || 0).toFixed(1),
      );
      if (manager.streetTypeChartInstance)
        manager.streetTypeChartInstance.destroy();
      const ctxId = "streetTypeChartCanvas";
      chartContainer.innerHTML = `<canvas id="${ctxId}" height="220"></canvas>`;
      const ctx = document.getElementById(ctxId)?.getContext("2d");
      if (!ctx) return;
      manager.streetTypeChartInstance = new Chart(ctx, {
        type: "bar",
        data: {
          labels,
          datasets: [
            {
              label: "Coverage %",
              data: dataValues,
              backgroundColor: "rgba(54, 162, 235, 0.5)",
              borderColor: "rgba(54, 162, 235, 1)",
              borderWidth: 1,
            },
          ],
        },
        options: {
          maintainAspectRatio: false,
          scales: {
            y: {
              beginAtZero: true,
              max: 100,
              ticks: { callback: (v) => `${v}%` },
            },
          },
          plugins: { legend: { display: false } },
        },
      });
    },
  };

  window.CoverageModules.Dashboard = Dashboard;
})();
