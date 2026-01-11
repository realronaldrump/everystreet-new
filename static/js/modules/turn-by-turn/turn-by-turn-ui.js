/**
 * Turn-by-Turn UI Module
 * DOM element caching and UI updates
 */

import { DURATION_LABELS, NAV_STATES } from "./turn-by-turn-config.js";
import {
  formatDistance,
  getInstructionText,
  getTurnRotation,
} from "./turn-by-turn-geo.js";

/**
 * UI manager for turn-by-turn navigation
 */
class TurnByTurnUI {
  constructor(config = {}) {
    this.config = config;
    this.elements = {};
  }

  /**
   * Cache all DOM element references
   */
  cacheElements() {
    const { config } = this;

    // Setup controls
    this.elements.areaSelect = document.getElementById(config.areaSelectId);
    this.elements.loadRouteBtn = document.getElementById(config.loadRouteBtnId);
    this.elements.startBtn = document.getElementById(config.startBtnId);
    this.elements.endBtn = document.getElementById(config.endBtnId);
    this.elements.overviewBtn = document.getElementById(config.overviewBtnId);
    this.elements.recenterBtn = document.getElementById(config.recenterBtnId);
    this.elements.routeBtn = document.getElementById(config.routeBtnId);

    // Setup panel
    this.elements.setupPanel = document.getElementById("nav-setup");
    this.elements.setupStatus = document.getElementById("nav-setup-status");
    this.elements.setupSummary = document.getElementById("nav-setup-summary");

    // Route preview panel
    this.elements.previewPanel = document.getElementById("nav-preview");
    this.elements.previewDistance = document.getElementById("preview-distance");
    this.elements.previewTime = document.getElementById("preview-time");
    this.elements.previewTurns = document.getElementById("preview-turns");
    this.elements.previewCoverage = document.getElementById("preview-coverage");
    this.elements.previewStartStatus = document.getElementById(
      "preview-start-status",
    );
    this.elements.previewStartText =
      document.getElementById("preview-start-text");
    this.elements.navToStartBtn = document.getElementById(
      "nav-start-from-here",
    );
    this.elements.beginNavBtn = document.getElementById("nav-begin");
    this.elements.changeRouteBtn = document.getElementById("nav-change-route");

    // Navigation HUD
    this.elements.navSignal = document.getElementById("nav-signal");
    this.elements.navSignalText = document.getElementById("nav-signal-text");
    this.elements.turnIcon = document.getElementById("nav-turn-icon");
    this.elements.turnIconGlyph = this.elements.turnIcon?.querySelector("i");
    this.elements.distanceToTurn = document.getElementById(
      "nav-distance-to-turn",
    );
    this.elements.primaryInstruction = document.getElementById(
      "nav-primary-instruction",
    );
    this.elements.roadName = document.getElementById("nav-road-name");

    // Dual progress bars
    this.elements.routeProgressFill = document.getElementById(
      "nav-route-progress-fill",
    );
    this.elements.routeProgressValue = document.getElementById(
      "nav-route-progress-value",
    );
    this.elements.coverageProgressBaseline = document.getElementById(
      "nav-coverage-baseline",
    );
    this.elements.coverageProgressLive =
      document.getElementById("nav-coverage-live");
    this.elements.coverageProgressValue = document.getElementById(
      "nav-coverage-progress-value",
    );

    // Legacy progress (fallback)
    this.elements.progressFill = document.getElementById("nav-progress-fill");
    this.elements.progressLabel = document.getElementById("nav-progress-label");
    this.elements.progressValue = document.getElementById("nav-progress-value");

    // Stats
    this.elements.remainingDistance = document.getElementById(
      "nav-remaining-distance",
    );
    this.elements.etaLabel = document.getElementById("nav-eta");
    this.elements.speedLabel = document.getElementById("nav-speed");
    this.elements.navStatus = document.getElementById("nav-status");

    // Resume prompt
    this.elements.resumePrompt = document.getElementById("nav-resume-prompt");
    this.elements.resumeDistanceText = document.getElementById(
      "resume-distance-text",
    );
    this.elements.resumeBtn = document.getElementById("nav-resume-btn");
    this.elements.dismissResumeBtn =
      document.getElementById("nav-dismiss-resume");
  }

  /**
   * Bind event listeners
   * @param {Object} callbacks
   */
  bindEvents(callbacks) {
    const { elements } = this;

    elements.areaSelect?.addEventListener("change", callbacks.onAreaChange);
    elements.loadRouteBtn?.addEventListener("click", callbacks.onLoadRoute);
    elements.startBtn?.addEventListener("click", callbacks.onStartNavigation);
    elements.endBtn?.addEventListener("click", callbacks.onEndNavigation);
    elements.overviewBtn?.addEventListener("click", callbacks.onToggleOverview);
    elements.recenterBtn?.addEventListener("click", callbacks.onRecenter);
    elements.routeBtn?.addEventListener("click", callbacks.onToggleSetupPanel);

    elements.navToStartBtn?.addEventListener(
      "click",
      callbacks.onNavigateToStart,
    );
    elements.beginNavBtn?.addEventListener(
      "click",
      callbacks.onBeginNavigation,
    );
    elements.changeRouteBtn?.addEventListener("click", callbacks.onShowSetup);

    elements.resumeBtn?.addEventListener("click", callbacks.onResumeFromAhead);
    elements.dismissResumeBtn?.addEventListener(
      "click",
      callbacks.onDismissResume,
    );
  }

  /**
   * Get element reference
   * @param {string} name
   * @returns {HTMLElement|null}
   */
  getElement(name) {
    return this.elements[name] || null;
  }

  // === Panel Visibility ===

  showSetupPanel() {
    this.elements.setupPanel?.classList.remove("hidden");
  }

  hideSetupPanel() {
    this.elements.setupPanel?.classList.add("hidden");
  }

  toggleSetupPanel() {
    const panel = this.elements.setupPanel;
    if (!panel) {
      return;
    }
    if (panel.classList.contains("hidden")) {
      this.showSetupPanel();
    } else {
      this.hideSetupPanel();
    }
  }

  // === State-based UI Updates ===

  /**
   * Update UI based on navigation state
   * @param {string} state
   * @param {Object} data - State-specific data
   */
  updateForState(state, data = {}) {
    // Hide all panels first
    this.elements.setupPanel?.classList.add("hidden");
    this.elements.previewPanel?.setAttribute("hidden", "");
    this.elements.resumePrompt?.setAttribute("hidden", "");

    switch (state) {
      case NAV_STATES.SETUP:
        this.showSetupPanel();
        break;

      case NAV_STATES.ROUTE_PREVIEW:
        this.showRoutePreview(data);
        break;

      case NAV_STATES.NAVIGATING_TO_START:
        this.showNavigatingToStart(data);
        break;

      case NAV_STATES.ARRIVED_AT_START:
        this.showArrivedAtStart();
        break;

      case NAV_STATES.ACTIVE_NAVIGATION:
        this.showActiveNavigation();
        break;

      case NAV_STATES.OFF_ROUTE:
        this.showOffRoute();
        break;

      case NAV_STATES.RESUME_AHEAD:
        this.showResumePrompt();
        break;

      case NAV_STATES.ARRIVED:
        this.showArrived();
        break;

      default:
        break;
    }
  }

  showRoutePreview(data) {
    this.hideSetupPanel();
    this.elements.previewPanel?.removeAttribute("hidden");

    if (this.elements.previewDistance) {
      this.elements.previewDistance.textContent = formatDistance(
        data.totalDistance,
      );
    }
    if (this.elements.previewTime) {
      this.elements.previewTime.textContent = this.formatDuration(
        data.estimatedTime,
      );
    }
    if (this.elements.previewTurns) {
      this.elements.previewTurns.textContent = data.turnCount || 0;
    }
    if (this.elements.previewCoverage) {
      this.elements.previewCoverage.textContent = `${(data.coveragePercent || 0).toFixed(1)}%`;
    }
  }

  showNavigatingToStart(data) {
    this.elements.previewPanel?.setAttribute("hidden", "");
    this.hideSetupPanel();

    if (this.elements.primaryInstruction) {
      this.elements.primaryInstruction.textContent = "Drive to start point";
    }
    if (this.elements.distanceToTurn && data.distanceToStart) {
      this.elements.distanceToTurn.textContent = formatDistance(
        data.distanceToStart,
      );
    }
    this.setNavStatus("Navigating to route start");
  }

  showArrivedAtStart() {
    if (this.elements.primaryInstruction) {
      this.elements.primaryInstruction.textContent = "Arrived at start";
    }
    if (this.elements.distanceToTurn) {
      this.elements.distanceToTurn.textContent = "Starting route...";
    }
    this.elements.turnIcon?.classList.add("arrive");
  }

  showActiveNavigation() {
    this.elements.previewPanel?.setAttribute("hidden", "");
    this.hideSetupPanel();
    this.elements.turnIcon?.classList.remove("arrive", "off-route");
    this.setNavStatus("On route");
  }

  showOffRoute() {
    this.elements.turnIcon?.classList.add("off-route");
    this.elements.turnIcon?.classList.remove("arrive");
    this.setNavStatus("Off route - return to highlighted path", true);
  }

  showResumePrompt() {
    this.elements.resumePrompt?.removeAttribute("hidden");
  }

  showArrived() {
    this.elements.turnIcon?.classList.add("arrive");
    this.elements.turnIcon?.classList.remove("off-route");
    if (this.elements.primaryInstruction) {
      this.elements.primaryInstruction.textContent = "You have arrived!";
    }
    if (this.elements.distanceToTurn) {
      this.elements.distanceToTurn.textContent = "Destination";
    }
    this.setNavStatus("Arrived at destination");
  }

  // === Start Status ===

  updateStartStatus(status, text) {
    const statusEl = this.elements.previewStartStatus;
    if (statusEl) {
      statusEl.classList.remove("at-start", "away", "unknown");
      if (status) {
        statusEl.classList.add(status);
      }
    }
    if (this.elements.previewStartText) {
      this.elements.previewStartText.textContent = text;
    }
  }

  showNavigateToStartButton() {
    this.elements.navToStartBtn?.removeAttribute("hidden");
    this.elements.beginNavBtn?.setAttribute("hidden", "");
  }

  showBeginButton() {
    this.elements.navToStartBtn?.setAttribute("hidden", "");
    this.elements.beginNavBtn?.removeAttribute("hidden");
  }

  // === Status Messages ===

  setSetupStatus(message, isError = false) {
    const el = this.elements.setupStatus;
    if (!el) {
      return;
    }
    el.textContent = message;
    el.style.color = isError ? "#b91c1c" : "";
  }

  setNavStatus(message, isError = false) {
    const el = this.elements.navStatus;
    if (!el) {
      return;
    }
    el.textContent = message;
    el.style.color = isError ? "#b91c1c" : "";
  }

  // === Navigation HUD Updates ===

  updateInstruction(type, distanceToTurn, routeName, offRoute, closest) {
    const {
      primaryInstruction,
      distanceToTurn: distEl,
      roadName,
      turnIcon,
    } = this.elements;

    if (!primaryInstruction || !distEl) {
      return;
    }

    turnIcon?.classList.remove("off-route", "arrive");

    if (offRoute) {
      primaryInstruction.textContent = "Return to route";
      distEl.textContent = `Off by ${formatDistance(closest?.distance || 0)}`;
      if (roadName) {
        roadName.textContent = routeName;
      }
      turnIcon?.classList.add("off-route");
      this.setNavStatus("Off route. Rejoin the highlighted path.", true);
      this.setTurnRotation(0);
      return;
    }

    if (distanceToTurn < 25 && type === "arrive") {
      primaryInstruction.textContent = "Arrive at destination";
      distEl.textContent = "Now";
      if (roadName) {
        roadName.textContent = routeName;
      }
      turnIcon?.classList.add("arrive");
      this.setNavStatus("Arriving at destination.");
      this.setTurnRotation(180);
      return;
    }

    const distLabel =
      distanceToTurn < 25 ? "Now" : `In ${formatDistance(distanceToTurn)}`;
    const instruction = getInstructionText(type);
    const rotation = getTurnRotation(type);

    distEl.textContent = distLabel;
    primaryInstruction.textContent = instruction;
    if (roadName) {
      roadName.textContent = routeName;
    }
    this.setTurnRotation(rotation);
    this.setNavStatus("On route.");
  }

  setTurnRotation(deg) {
    const glyph = this.elements.turnIconGlyph;
    if (!glyph) {
      return;
    }
    glyph.style.transform = `rotate(${deg}deg)`;
  }

  // === Stats Updates ===

  updateSignal(accuracy) {
    const { navSignal, navSignalText } = this.elements;
    if (!navSignal || !navSignalText || !Number.isFinite(accuracy)) {
      return;
    }

    const rounded = Math.round(accuracy);
    navSignalText.textContent = `GPS ${rounded}m`;
    navSignal.classList.remove("good", "poor");
    if (accuracy <= 12) {
      navSignal.classList.add("good");
    } else if (accuracy >= 35) {
      navSignal.classList.add("poor");
    }
  }

  updateSpeed(speedMps) {
    const el = this.elements.speedLabel;
    if (!el) {
      return;
    }
    if (!speedMps || speedMps < 0.5) {
      el.textContent = "--";
      return;
    }
    const mph = speedMps * 2.23694;
    el.textContent = `${Math.round(mph)} mph`;
  }

  updateEta(remainingDistance, speedMps) {
    const el = this.elements.etaLabel;
    if (!el) {
      return;
    }
    if (!speedMps || speedMps < 0.5) {
      el.textContent = "--";
      return;
    }
    const etaSeconds = remainingDistance / speedMps;
    const etaTime = new Date(Date.now() + etaSeconds * 1000);
    el.textContent = etaTime.toLocaleTimeString([], {
      hour: "numeric",
      minute: "2-digit",
    });
  }

  updateRemaining(distance) {
    const el = this.elements.remainingDistance;
    if (el) {
      el.textContent = formatDistance(distance);
    }
  }

  // === Progress Bars ===

  updateRouteProgress(progressDistance, totalDistance, routeName) {
    const percent =
      totalDistance > 0 ? (progressDistance / totalDistance) * 100 : 0;

    if (this.elements.routeProgressFill) {
      this.elements.routeProgressFill.style.transform = `scaleX(${percent / 100})`;
    }
    if (this.elements.routeProgressValue) {
      this.elements.routeProgressValue.textContent = `${Math.round(percent)}%`;
    }

    // Legacy progress bar
    if (this.elements.progressLabel) {
      this.elements.progressLabel.textContent = routeName;
    }
    if (this.elements.progressValue) {
      this.elements.progressValue.textContent = `${formatDistance(progressDistance)} of ${formatDistance(totalDistance)}`;
    }
    if (this.elements.progressFill) {
      const ratio = totalDistance ? progressDistance / totalDistance : 0;
      this.elements.progressFill.style.transform = `scaleX(${Math.min(Math.max(ratio, 0), 1)})`;
    }
  }

  updateCoverageProgress(baselinePercent, livePercent) {
    if (this.elements.coverageProgressBaseline) {
      this.elements.coverageProgressBaseline.style.width = `${baselinePercent}%`;
    }
    if (this.elements.coverageProgressLive) {
      this.elements.coverageProgressLive.style.width = `${livePercent}%`;
    }
    if (this.elements.coverageProgressValue) {
      this.elements.coverageProgressValue.textContent = `${livePercent.toFixed(1)}%`;
    }
  }

  initializeCoverageDisplay(baselinePercent) {
    this.updateCoverageProgress(baselinePercent, baselinePercent);
  }

  // === Setup Summary ===

  updateSetupSummary(totalDistance, turnCount, coveragePercent) {
    const el = this.elements.setupSummary;
    if (!el) {
      return;
    }

    el.innerHTML = `
      <div class="summary-item">
        <span>Distance</span>
        <span>${formatDistance(totalDistance)}</span>
      </div>
      <div class="summary-item">
        <span>Turns</span>
        <span>${turnCount}</span>
      </div>
      <div class="summary-item">
        <span>Coverage</span>
        <span>${coveragePercent.toFixed(1)}%</span>
      </div>
    `;
  }

  // === Area Select ===

  populateAreaSelect(areas) {
    const select = this.elements.areaSelect;
    if (!select) {
      return;
    }

    select.innerHTML = '<option value="">Select a coverage area...</option>';
    areas.forEach((area) => {
      const areaId = area._id || area.id;
      const name =
        area.location?.display_name ||
        area.location?.city ||
        area.name ||
        "Coverage Area";
      if (!areaId) {
        return;
      }

      const option = document.createElement("option");
      option.value = String(areaId);
      option.textContent = name;
      option.dataset.name = name;
      select.appendChild(option);
    });
  }

  getSelectedAreaId() {
    return this.elements.areaSelect?.value || "";
  }

  getSelectedAreaName() {
    const select = this.elements.areaSelect;
    const option = select?.selectedOptions?.[0];
    return option?.dataset?.name || option?.textContent || "";
  }

  setAreaSelectValue(value) {
    if (this.elements.areaSelect) {
      this.elements.areaSelect.value = value;
    }
  }

  // === Button States ===

  updateControlStates(overviewMode, followMode) {
    this.elements.overviewBtn?.classList.toggle("active", overviewMode);
    this.elements.recenterBtn?.classList.toggle("active", followMode);
  }

  setLoadRouteLoading(loading) {
    const btn = this.elements.loadRouteBtn;
    if (!btn) {
      return;
    }
    btn.disabled = loading;
    btn.classList.toggle("loading", loading);
  }

  setLoadRouteEnabled(enabled) {
    if (this.elements.loadRouteBtn) {
      this.elements.loadRouteBtn.disabled = !enabled;
    }
  }

  setStartEnabled(enabled) {
    if (this.elements.startBtn) {
      this.elements.startBtn.disabled = !enabled;
    }
  }

  setNavToStartLoading(loading) {
    const btn = this.elements.navToStartBtn;
    if (btn) {
      btn.classList.toggle("loading", loading);
    }
  }

  // === Resume Prompt ===

  updateResumeDistance(text) {
    if (this.elements.resumeDistanceText) {
      this.elements.resumeDistanceText.textContent = text;
    }
  }

  // === Reset UI ===

  resetGuidanceUI() {
    const { distanceToTurn, primaryInstruction, roadName, turnIcon } =
      this.elements;

    if (distanceToTurn) {
      distanceToTurn.textContent = "Ready";
    }
    if (primaryInstruction) {
      primaryInstruction.textContent = "Select a route to begin";
    }
    if (roadName) {
      roadName.textContent = "--";
    }
    this.setTurnRotation(0);
    turnIcon?.classList.remove("off-route", "arrive");

    if (this.elements.progressValue) {
      this.elements.progressValue.textContent = "--";
    }
    if (this.elements.progressLabel) {
      this.elements.progressLabel.textContent = "Route";
    }
    if (this.elements.progressFill) {
      this.elements.progressFill.style.transform = "scaleX(0)";
    }
    if (this.elements.remainingDistance) {
      this.elements.remainingDistance.textContent = "--";
    }
    if (this.elements.etaLabel) {
      this.elements.etaLabel.textContent = "--";
    }
    if (this.elements.speedLabel) {
      this.elements.speedLabel.textContent = "--";
    }
  }

  // === Utilities ===

  /**
   * Format duration in seconds to human readable string
   * @param {number} seconds
   * @returns {string}
   */
  formatDuration(seconds) {
    if (!seconds || !Number.isFinite(seconds)) {
      return "--";
    }
    const hours = Math.floor(seconds / 3600);
    const minutes = Math.round((seconds % 3600) / 60);

    if (hours > 0) {
      return `${hours}${DURATION_LABELS.hour} ${minutes}${DURATION_LABELS.minute}`;
    }
    return `${minutes} ${DURATION_LABELS.minute}`;
  }
}

export default TurnByTurnUI;
