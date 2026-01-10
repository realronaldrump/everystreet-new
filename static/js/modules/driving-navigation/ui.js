/**
 * UI management for Driving Navigation.
 * Handles DOM elements, status messages, progress, popups, and user interactions.
 */

import { LOCATION_SOURCE_LABELS, PROCESSING_STEPS } from "./constants.js";

export class DrivingNavigationUI {
  /**
   * @param {Object} config - Configuration with element IDs
   */
  constructor(config = {}) {
    this.config = config;

    // DOM Elements
    this.areaSelect = document.getElementById(config.areaSelectId);
    this.findBtn = document.getElementById("find-next-street-btn");
    this.findEfficientBtn = document.getElementById(
      "find-efficient-street-btn",
    );
    this.statusMsg = document.getElementById("status-message");
    this.targetInfo = document.getElementById("target-info");
    this.autoFollowToggle = document.getElementById("auto-follow-toggle");
    this.openGoogleMapsBtn = document.getElementById("open-google-maps-btn");
    this.openAppleMapsBtn = document.getElementById("open-apple-maps-btn");
    this.progressContainer = document.getElementById(
      "route-progress-container",
    );
    this.progressBar = document.getElementById("route-progress-bar");
    this.processingStatus = document.getElementById("processing-status");
    this.routeDetails = document.getElementById("route-details");
    this.routeStats = document.getElementById("route-stats");
    this.stepClustering = document.getElementById("step-clustering");
    this.stepOptimizing = document.getElementById("step-optimizing");
    this.stepRendering = document.getElementById("step-rendering");

    this.currentStep = null;

    // For testing/debugging - store last popup info
    this.lastSegmentPopup = null;
    this.lastClusterPopup = null;
    this.lastLocationSourceLabel = null;
  }

  /**
   * Set the status message.
   * @param {string} message - Status message text
   * @param {boolean} [isError=false] - Whether this is an error message
   */
  setStatus(message, isError = false) {
    if (!this.statusMsg) return;
    this.statusMsg.textContent = message;
    this.statusMsg.className = isError ? "text-danger" : "text-info";
  }

  /**
   * Populate the area dropdown with coverage areas.
   * @param {Array} areas - Array of coverage area objects
   */
  populateAreaDropdown(areas) {
    if (!this.areaSelect) return;
    this.areaSelect.innerHTML = '<option value="">Select an area...</option>';
    areas.forEach((area) => {
      const areaId = area._id || area.id;
      if (area.location?.display_name && areaId) {
        const option = document.createElement("option");
        option.value = String(areaId);
        option.textContent = area.location.display_name;
        option.dataset.areaId = String(areaId);
        this.areaSelect.appendChild(option);
      }
    });
  }

  /**
   * Load the auto-follow toggle state from localStorage.
   */
  loadAutoFollowState() {
    if (!this.autoFollowToggle) return;
    const savedState =
      window.localStorage.getItem("drivingNavAutoFollow") === "true";
    this.autoFollowToggle.checked = savedState;
  }

  /**
   * Save the auto-follow toggle state to localStorage.
   * @param {boolean} isEnabled - Whether auto-follow is enabled
   */
  saveAutoFollowState(isEnabled) {
    window.localStorage.setItem("drivingNavAutoFollow", isEnabled);
  }

  /**
   * Get the current auto-follow state.
   * @returns {boolean}
   */
  getAutoFollowState() {
    return this.autoFollowToggle ? this.autoFollowToggle.checked : false;
  }

  /**
   * Show the progress container.
   */
  showProgressContainer() {
    if (this.progressContainer) {
      this.progressContainer.classList.add("active");
    }
    this.resetSteps();
  }

  /**
   * Hide the progress container.
   */
  hideProgressContainer() {
    if (this.progressContainer) {
      this.progressContainer.classList.remove("active");
    }
  }

  /**
   * Update the progress bar and status.
   * @param {number} percent - Progress percentage (0-100)
   * @param {string} status - Status text
   */
  updateProgress(percent, status) {
    if (this.progressBar) {
      this.progressBar.style.width = `${percent}%`;
    }
    if (this.processingStatus) {
      this.processingStatus.textContent = status;
    }
  }

  /**
   * Reset all step indicators.
   */
  resetSteps() {
    this.currentStep = null;
    [this.stepClustering, this.stepOptimizing, this.stepRendering].forEach(
      (s) => {
        if (s) s.className = "step";
      },
    );
  }

  /**
   * Set the active processing step.
   * @param {string} step - Step name: 'clustering', 'optimizing', or 'rendering'
   */
  setActiveStep(step) {
    this.resetSteps();
    this.currentStep = step;

    const stepConfig = PROCESSING_STEPS[step];
    if (!stepConfig) return;

    // Update step classes
    if (this.stepClustering) {
      this.stepClustering.className =
        step === "clustering" ? "step active" : "step completed";
    }
    if (this.stepOptimizing) {
      this.stepOptimizing.className =
        step === "optimizing"
          ? "step active"
          : step === "rendering"
            ? "step completed"
            : "step";
    }
    if (this.stepRendering) {
      this.stepRendering.className =
        step === "rendering" ? "step active" : "step";
    }

    this.updateProgress(stepConfig.progress, stepConfig.text);
  }

  /**
   * Show route details panel.
   * @param {Object} routeData - Route data with clusters, segments, duration, distance
   */
  showRouteDetails(routeData) {
    if (!this.routeDetails || !routeData) return;

    this.routeDetails.style.display = "block";

    const durationHours = Math.floor(routeData.duration / 3600);
    const durationMinutes = Math.floor((routeData.duration % 3600) / 60);
    const distanceMiles = (routeData.distance * 0.000621371).toFixed(1);

    if (this.routeStats) {
      this.routeStats.innerHTML = `
        <div><strong>Clusters:</strong> ${routeData.clusters || 1}</div>
        <div><strong>Segments:</strong> ${routeData.segments || 1}</div>
        <div><strong>Time:</strong> ${durationHours > 0 ? `${durationHours}h ` : ""}${durationMinutes}min</div>
        <div><strong>Distance:</strong> ${distanceMiles} mi</div>
      `;
    }
  }

  /**
   * Hide the route details panel.
   */
  hideRouteDetails() {
    if (this.routeDetails) {
      this.routeDetails.style.display = "none";
    }
  }

  /**
   * Display target street information.
   * @param {string} streetName - Name of the target street
   * @param {string} segmentId - Segment ID
   */
  displayTargetInfo(streetName, segmentId) {
    if (!this.targetInfo) return;

    this.targetInfo.innerHTML = `
      <div class="alert alert-info p-2 mb-2">
        <i class="fas fa-map-pin me-2"></i>
        <strong>Target:</strong> ${streetName}
        <div class="mt-1 small text-light">Segment ID: ${segmentId}</div>
      </div>
    `;
  }

  /**
   * Display route details content.
   * @param {number} durationMinutes - Route duration in minutes
   * @param {number} distanceMiles - Route distance in miles
   * @param {string} locationSource - Location source identifier
   */
  displayRouteDetailsContent(durationMinutes, distanceMiles, locationSource) {
    const routeDetailsContent = document.getElementById(
      "route-details-content",
    );
    if (!routeDetailsContent) return;

    routeDetailsContent.innerHTML = `
      <div class="route-info-detail">
        <div><i class="fas fa-clock"></i> ${durationMinutes} min</div>
        <div><i class="fas fa-road"></i> ${distanceMiles} mi</div>
        <div class="w-100 text-muted small">(Using ${this.formatLocationSource(locationSource)} position)</div>
      </div>
    `;
  }

  /**
   * Display efficient clusters summary info.
   * @param {Array} clusters - Array of cluster objects
   * @param {string[]} clusterColors - Array of color strings
   */
  displayEfficientClustersInfo(clusters, clusterColors) {
    const routeDetailsContent = document.getElementById(
      "route-details-content",
    );
    if (!routeDetailsContent || !clusters || clusters.length === 0) return;

    const totalSegments = clusters.reduce((sum, c) => sum + c.segment_count, 0);
    const totalLengthMiles =
      clusters.reduce((sum, c) => sum + c.total_length_m, 0) / 1609.34;

    routeDetailsContent.innerHTML = `
      <div class="cluster-summary mb-2">
        <div class="d-flex justify-content-between small">
          <span>Clusters found:</span>
          <strong>${clusters.length}</strong>
        </div>
        <div class="d-flex justify-content-between small">
          <span>Total segments:</span>
          <strong>${totalSegments}</strong>
        </div>
        <div class="d-flex justify-content-between small">
          <span>Total length:</span>
          <strong>${totalLengthMiles.toFixed(1)} mi</strong>
        </div>
      </div>
      <div class="cluster-list small" style="max-height: 120px; overflow-y: auto;">
        ${clusters
          .map(
            (c, i) => `
          <div class="cluster-item py-1 border-bottom" style="border-color: ${clusterColors[i]};">
            <strong style="color: ${clusterColors[i]};">Cluster #${i + 1}</strong>
            - ${c.segment_count} streets, ${(c.distance_to_cluster_m / 1609.34).toFixed(1)} mi away
          </div>
        `,
          )
          .join("")}
      </div>
    `;

    this.showRouteDetails({
      clusters: clusters.length,
      segments: totalSegments,
      duration: 0,
      distance: totalLengthMiles * 1609.34,
    });
  }

  /**
   * Clear target info and route details content.
   */
  clearRouteUI() {
    if (this.targetInfo) {
      this.targetInfo.innerHTML = "";
    }
    const routeDetailsContent = document.getElementById(
      "route-details-content",
    );
    if (routeDetailsContent) {
      routeDetailsContent.innerHTML = "";
    }
    this.hideRouteDetails();
  }

  /**
   * Enable or disable navigation buttons.
   * @param {boolean} enabled - Whether buttons should be enabled
   */
  setNavigationButtonsEnabled(enabled) {
    if (this.findBtn) this.findBtn.disabled = !enabled;
    if (this.findEfficientBtn) this.findEfficientBtn.disabled = !enabled;
  }

  /**
   * Enable or disable map link buttons.
   * @param {boolean} enabled - Whether buttons should be enabled
   */
  setMapLinkButtonsEnabled(enabled) {
    if (this.openGoogleMapsBtn) this.openGoogleMapsBtn.disabled = !enabled;
    if (this.openAppleMapsBtn) this.openAppleMapsBtn.disabled = !enabled;
  }

  /**
   * Set button to loading state.
   * @param {HTMLElement} button - The button element
   * @param {string} loadingText - Text to show while loading
   * @returns {string} Original button HTML for restoration
   */
  setButtonLoading(button, loadingText) {
    if (!button) return "";
    const originalHtml = button.innerHTML;
    button.disabled = true;
    button.innerHTML = `<i class="fas fa-spinner fa-spin"></i> ${loadingText}`;
    return originalHtml;
  }

  /**
   * Restore button from loading state.
   * @param {HTMLElement} button - The button element
   * @param {string} originalHtml - Original button HTML
   */
  restoreButton(button, originalHtml) {
    if (!button) return;
    button.disabled = false;
    button.innerHTML = originalHtml;
  }

  /**
   * Create popup HTML for a street segment.
   * @param {Object} segment - The segment feature
   * @returns {string} HTML string for popup
   */
  createSegmentPopup(segment) {
    const props = segment.properties;
    const streetName = props.street_name || "Unnamed Street";
    const segmentId = props.segment_id || "Unknown";

    const content = `
      <div class="segment-popup">
        <h6>${streetName}</h6>
        <div class="small text-muted">Segment ID: ${segmentId}</div>
        <div class="mt-2">
          <button class="btn btn-sm btn-primary navigate-to-segment" data-segment-id="${segmentId}">
            <i class="fas fa-route me-1"></i> Navigate Here
          </button>
        </div>
      </div>
    `;

    this.lastSegmentPopup = { segmentId, content };
    return content;
  }

  /**
   * Create popup HTML for an efficient cluster.
   * @param {Object} cluster - The cluster object
   * @param {number} rank - The cluster rank (0-indexed)
   * @returns {string} HTML string for popup
   */
  createClusterPopup(cluster, rank) {
    const distanceMiles = (cluster.distance_to_cluster_m / 1609.34).toFixed(1);
    const lengthMiles = (cluster.total_length_m / 1609.34).toFixed(2);
    const score = cluster.efficiency_score.toFixed(2);

    const content = `
      <div class="efficient-cluster-popup">
        <h6>Cluster #${rank + 1}</h6>
        <div class="cluster-stats small">
          <div><i class="fas fa-road"></i> ${cluster.segment_count} streets</div>
          <div><i class="fas fa-ruler"></i> ${lengthMiles} mi total</div>
          <div><i class="fas fa-location-arrow"></i> ${distanceMiles} mi away</div>
          <div><i class="fas fa-chart-line"></i> Score: ${score}</div>
        </div>
        <button class="btn btn-sm btn-primary mt-2 navigate-to-segment" data-segment-id="${cluster.nearest_segment.segment_id}">
          <i class="fas fa-route me-1"></i> Navigate to Cluster
        </button>
      </div>
    `;

    this.lastClusterPopup = { rank, content };
    return content;
  }

  /**
   * Format a location source for display.
   * @param {string} source - Location source identifier
   * @returns {string} Human-readable label
   */
  formatLocationSource(source) {
    const label = LOCATION_SOURCE_LABELS[source] || source || "unknown";
    this.lastLocationSourceLabel = label;
    return label;
  }

  /**
   * Inject CSS styles for cluster markers.
   */
  static injectClusterStyles() {
    const styleClusters = document.createElement("style");
    styleClusters.textContent = `
      .efficient-cluster-marker { cursor: pointer; transition: transform 0.2s; }
      .cluster-marker-wrapper { position: relative; width: 40px; height: 40px; }
      .cluster-marker-inner { position: absolute; width: 100%; height: 100%; border-radius: 50%; border: 3px solid white; box-shadow: 0 2px 8px rgba(0,0,0,0.3); display: flex; flex-direction: column; align-items: center; justify-content: center; color: white; font-weight: bold; }
      .cluster-number { font-size: 16px; line-height: 1; }
      .cluster-count { font-size: 10px; line-height: 1; opacity: 0.9; }
      .efficient-cluster-marker:hover { transform: scale(1.1); z-index: 1000 !important; }
    `;
    document.head.appendChild(styleClusters);
  }
}
