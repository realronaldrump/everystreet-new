import notificationManager from "../ui/notifications.js";
import { MI_TO_M } from "../utils/geo-math.js";
import { escapeHtml } from "../utils.js";
import { SCANNER_STAGES, STAGE_COPY } from "./constants.js";

export class OptimalRouteUI {
  constructor(config = {}) {
    this.config = config;
    this.areaSelect = document.getElementById(config.areaSelectId);
    this.liveNavigationBtn = document.getElementById("start-live-navigation-btn");
    this.progressMessagePrimary = document.getElementById("progress-message-primary");
    this.progressMessageSecondary = document.getElementById(
      "progress-message-secondary"
    );
    this.hud = this.cacheHudElements();
    this.activityLog = [];
    this.lastActivityMessage = "";
    this.lastElapsedLabel = "0:00";
    this.elapsedTimer = null;
    this.startTime = null;
    this.currentStage = "initializing";
    this.currentMetrics = {};

    // Helper for formatting
    this.formatCount = (value) => {
      if (typeof value !== "number" || Number.isNaN(value)) {
        return "--";
      }
      return value.toLocaleString();
    };
  }

  cacheHudElements() {
    return {
      container: document.getElementById("route-solver-hud"),
      scanner: document.getElementById("map-scanner-overlay"),
      stage: document.getElementById("hud-stage"),
      message: document.getElementById("hud-message"),
      submessage: document.getElementById("hud-submessage"),
      segments: document.getElementById("hud-segments"),
      matched: document.getElementById("hud-matched"),
      elapsed: document.getElementById("hud-elapsed"),
      activity: document.getElementById("hud-activity"),
    };
  }

  isCoverageCalculationActive(status) {
    const normalized = String(status || "").toLowerCase();
    return ["initializing", "processing", "rebuilding"].includes(normalized);
  }

  populateAreaSelect(areas) {
    if (!this.areaSelect || !this.config.populateAreaSelect) {
      return;
    }

    this.areaSelect.innerHTML = '<option value="">Select a coverage area...</option>';

    areas.forEach((area) => {
      const option = document.createElement("option");
      const areaId = area.id || area._id || "";
      const areaName = area.display_name || area.location?.display_name || "Unknown";
      const status = area.status || "";
      const isProcessing = this.isCoverageCalculationActive(status);
      option.value = String(areaId);
      const coverage = area.coverage_percentage?.toFixed(2) || 0;
      const label = `${areaName} (${coverage}%)`;
      option.textContent = isProcessing ? `${label} (calculating coverage)` : label;
      option.dataset.coverage = coverage;
      option.dataset.status = String(status || "");
      option.dataset.processing = isProcessing ? "true" : "false";
      option.disabled = isProcessing;
      const totalLengthMeters = (area.total_length_miles || 0) * MI_TO_M;
      const drivenLengthMeters = (area.driven_length_miles || 0) * MI_TO_M;
      option.dataset.remaining = this.formatDistance(
        totalLengthMeters - drivenLengthMeters
      );
      this.areaSelect.appendChild(option);
    });
  }

  updateSavedRoutes(areas, onRouteClick) {
    const historyContainer = document.getElementById("route-history");
    if (!historyContainer) {
      return;
    }

    const areasWithRoutes = areas.filter((a) => a.has_optimal_route);

    if (areasWithRoutes.length === 0) {
      historyContainer.innerHTML = `
        <div class="empty-state">
          <i class="fas fa-route" aria-hidden="true"></i>
          <span>No saved routes yet</span>
        </div>
      `;
      return;
    }

    historyContainer.innerHTML = areasWithRoutes
      .map((area) => {
        const date = area.optimal_route_generated_at
          ? new Date(area.optimal_route_generated_at).toLocaleDateString()
          : "Unknown";
        const safeAreaId = escapeHtml(area.id || area._id || "");
        const safeAreaName = escapeHtml(area.display_name || "Unknown");
        const safeDate = escapeHtml(date);
        return `
          <div class="route-history-item" data-area-id="${safeAreaId}">
            <div class="route-history-main">
              <div class="route-name">${safeAreaName}</div>
              <div class="route-date">${safeDate}</div>
            </div>
            <span class="route-history-chevron" aria-hidden="true">
              <i class="fas fa-chevron-right"></i>
            </span>
          </div>
        `;
      })
      .join("");

    historyContainer.querySelectorAll(".route-history-item").forEach((item) => {
      item.addEventListener("click", () => {
        const { areaId } = item.dataset;
        if (this.areaSelect) {
          this.areaSelect.value = areaId;
        }
        onRouteClick(areaId);
      });
    });
  }

  updateAreaStats(area) {
    const areaStats = document.getElementById("area-stats");
    if (!areaStats) {
      return;
    }

    const emptyHint = document.getElementById("area-empty-hint");
    const subtitle = document.getElementById("sidebar-subtitle");
    if (!area) {
      areaStats.style.display = "none";
      if (emptyHint) {
        emptyHint.style.display = "";
      }
      if (subtitle) {
        subtitle.textContent = "Select an area to begin planning";
      }
      return;
    }

    const coverage = Math.min(100, Math.max(0, Number(area.coverage_percentage) || 0));
    const totalMiles = Number(area.total_length_miles) || 0;
    const drivenMiles = Number(area.driven_length_miles) || 0;
    const remainingMeters = Math.max(0, totalMiles - drivenMiles) * MI_TO_M;
    const remainingLabel = this.formatDistance(remainingMeters);
    const areaName =
      area.display_name || area.location?.display_name || "Selected area";

    const coverageValue = document.getElementById("area-coverage");
    const remainingValue = document.getElementById("area-remaining");
    const drivenValue = document.querySelector(".acstat-driven-val");
    const totalValue = document.querySelector(".acstat-total-val");
    const donutArc = document.getElementById("donut-driven-arc");
    const coverageBar = document.getElementById("area-coverage-bar");

    if (coverageValue) {
      coverageValue.textContent = `${coverage.toFixed(2)}%`;
    }
    if (remainingValue) {
      remainingValue.textContent = remainingLabel;
    }
    if (drivenValue) {
      drivenValue.textContent = this.formatDistance(drivenMiles * MI_TO_M);
    }
    if (totalValue) {
      totalValue.textContent = this.formatCount(Number(area.total_segments));
    }
    if (donutArc) {
      donutArc.style.strokeDashoffset = String(201.06 * (1 - coverage / 100));
    }
    if (coverageBar) {
      coverageBar.style.width = `${coverage}%`;
    }
    if (emptyHint) {
      emptyHint.style.display = "none";
    }
    if (subtitle) {
      subtitle.textContent = `${areaName} · ${remainingLabel} remaining`;
    }
    areaStats.style.display = "block";
  }

  setGenerateState(state) {
    const generateBtn = document.getElementById("generate-route-btn");
    if (generateBtn) {
      generateBtn.dataset.state = state;
    }
  }

  updateProgress(data) {
    const stage = (data.stage || "initializing").toLowerCase();
    const rawMetrics = data.metrics || {};
    const metrics =
      Object.keys(rawMetrics).length > 0 ? rawMetrics : this.currentMetrics || {};
    this.currentStage = stage;
    this.currentMetrics = metrics;
    this.setHudActive(true);

    const progressBar = document.getElementById("progress-bar");
    if (progressBar) {
      const progress = Math.min(100, Math.max(0, Number(data.progress) || 0));
      progressBar.style.width = `${progress}%`;
      progressBar.setAttribute("aria-valuenow", String(progress));
    }

    const { primary, secondary, label } = this.buildProgressMessages(
      stage,
      data.message
    );
    const stageLabel = document.getElementById("progress-stage-label");
    if (stageLabel) {
      stageLabel.textContent = label;
    }
    this.setStatusMessage(primary, secondary, stage, metrics, label);

    this.setScannerActive(SCANNER_STAGES.has(stage));
  }

  buildProgressMessages(stage, message) {
    const meta = STAGE_COPY[stage] || {
      label: "Working",
      message: "Processing...",
    };
    const primary = meta.message || message || "Processing...";
    const secondary = message && message !== primary ? message : "";
    return { primary, secondary, label: meta.label || "Working" };
  }

  setStatusMessage(primary, secondary, stage, metrics, labelOverride) {
    if (stage) {
      this.currentStage = stage;
    }
    if (metrics) {
      this.currentMetrics = metrics;
    }

    if (this.progressMessagePrimary) {
      this.progressMessagePrimary.textContent = primary;
    }
    if (this.progressMessageSecondary) {
      this.progressMessageSecondary.textContent = secondary;
    }

    this.updateHud(stage, primary, secondary, metrics, labelOverride);
    this.appendActivity(secondary || primary);
  }

  updateHud(stage, primary, secondary, metrics, labelOverride) {
    if (!this.hud?.container) {
      return;
    }
    const meta = STAGE_COPY[stage] || { label: "Working", message: "Processing..." };

    if (this.hud.stage) {
      this.hud.stage.textContent = labelOverride || meta.label || "Working";
    }
    if (this.hud.message) {
      this.hud.message.textContent = primary || meta.message || "Processing...";
    }
    if (this.hud.submessage) {
      this.hud.submessage.textContent = secondary || "";
    }
    this.updateHudMetrics(metrics || {});
  }

  updateHudMetrics(metrics = {}) {
    const hasMetrics = Object.keys(metrics).length > 0;
    const total = metrics.total_segments ?? metrics.segment_count ?? null;
    const processed = metrics.processed_segments ?? null;
    const osmMatched = metrics.osm_matched ?? null;
    const defaultMatched = metrics.default_matched ?? null;
    const mappedSegments =
      metrics.mapped_segments ?? Number(osmMatched || 0) + Number(defaultMatched || 0);

    if (this.hud.segments) {
      this.hud.segments.textContent = hasMetrics
        ? this.formatMetricRatio(processed, total)
        : "--";
    }
    if (this.hud.matched) {
      this.hud.matched.textContent = hasMetrics
        ? total
          ? `${this.formatCount(mappedSegments)}/${this.formatCount(total)}`
          : this.formatCount(mappedSegments)
        : "--";
    }
  }

  formatMetricRatio(value, total) {
    if (
      typeof value !== "number" ||
      typeof total !== "number" ||
      total <= 0 ||
      value < 0
    ) {
      return "--";
    }
    return `${this.formatCount(value)}/${this.formatCount(total)}`;
  }

  appendActivity(text) {
    if (!this.hud?.activity) {
      return;
    }
    if (!text || text === this.lastActivityMessage) {
      return;
    }

    const entry = {
      time: this.lastElapsedLabel || "0:00",
      text,
    };

    this.activityLog.push(entry);
    if (this.activityLog.length > 4) {
      this.activityLog.shift();
    }

    this.hud.activity.replaceChildren(
      ...this.activityLog.map((item) => {
        const row = document.createElement("div");
        row.className = "hud-activity-item";

        const time = document.createElement("span");
        time.className = "hud-activity-time";
        time.textContent = item.time;

        const message = document.createElement("span");
        message.className = "hud-activity-text";
        message.textContent = item.text;

        row.append(time, message);
        return row;
      })
    );

    this.lastActivityMessage = text;
  }

  setHudActive(isActive) {
    if (!this.hud?.container) {
      return;
    }
    this.hud.container.classList.toggle("active", isActive);
  }

  setScannerActive(isActive) {
    if (!this.hud?.scanner) {
      return;
    }
    this.hud.scanner.classList.toggle("active", isActive);
  }

  resetHud() {
    this.activityLog = [];
    this.lastActivityMessage = "";
    if (this.hud?.activity) {
      this.hud.activity.replaceChildren();
    }
    this.updateHudMetrics({});
  }

  showProgressSection(startTime) {
    const resultsSection = document.getElementById("results-section");
    const errorSection = document.getElementById("error-section");
    if (resultsSection) {
      resultsSection.style.display = "none";
    }
    if (errorSection) {
      errorSection.style.display = "none";
    }
    const progressSection = document.getElementById("route-progress-inline");
    if (progressSection) {
      progressSection.style.display = "block";
    }

    const progressBar = document.getElementById("progress-bar");
    if (progressBar) {
      progressBar.style.width = "0%";
      progressBar.setAttribute("aria-valuenow", "0");
    }
    this.currentStage = "initializing";
    this.currentMetrics = {};
    this.resetHud();
    const { primary, secondary, label } = this.buildProgressMessages(
      "initializing",
      ""
    );
    const stageLabel = document.getElementById("progress-stage-label");
    if (stageLabel) {
      stageLabel.textContent = label;
    }
    this.setStatusMessage(primary, secondary, "initializing", {}, label);
    this.setHudActive(true);
    this.setScannerActive(true);

    this.stopElapsedTimer();
    this.startTime = startTime || Date.now();
    this.updateElapsedTime();
    this.elapsedTimer = setInterval(() => this.updateElapsedTime(), 1000);

    const generateBtn = document.getElementById("generate-route-btn");
    if (generateBtn) {
      generateBtn.disabled = true;
    }
    this.setGenerateState("ready");
  }

  hideProgressSection() {
    this.stopElapsedTimer();
    const progressSection = document.getElementById("route-progress-inline");
    if (progressSection) {
      progressSection.style.display = "none";
    }
    this.setScannerActive(false);
    this.setHudActive(false);
  }

  hideReplayButton() {
    this.setReplayEnabled(false);
  }

  updateElapsedTime() {
    if (!this.startTime) {
      return;
    }

    const elapsed = Math.floor((Date.now() - this.startTime) / 1000);
    const minutes = Math.floor(elapsed / 60);
    const seconds = elapsed % 60;
    const elapsedLabel = `${minutes}:${seconds.toString().padStart(2, "0")}`;

    const elapsedValue = document.getElementById("elapsed-value");
    if (elapsedValue) {
      elapsedValue.textContent = elapsedLabel;
    }
    if (this.hud?.elapsed) {
      this.hud.elapsed.textContent = elapsedLabel;
    }
    this.lastElapsedLabel = elapsedLabel;
  }

  stopElapsedTimer() {
    if (this.elapsedTimer) {
      clearInterval(this.elapsedTimer);
      this.elapsedTimer = null;
    }
  }

  showResults(data) {
    this.hideProgressSection();
    const generateBtn = document.getElementById("generate-route-btn");
    if (generateBtn) {
      generateBtn.disabled = false;
    }

    document.getElementById("stat-total-distance").textContent = this.formatDistance(
      data.total_distance_m
    );
    document.getElementById("stat-required-distance").textContent = this.formatDistance(
      data.required_distance_m
    );
    document.getElementById("stat-deadhead-distance").textContent = this.formatDistance(
      data.deadhead_distance_m
    );
    const efficiency = Math.min(
      100,
      Math.max(0, 100 - (Number(data.deadhead_percentage) || 0))
    );
    document.getElementById("stat-deadhead-percent").textContent =
      `${efficiency.toFixed(2)}%`;

    const ring = document.getElementById("eff-ring-fill");
    if (ring) {
      ring.style.strokeDashoffset = String(188.5 * (1 - efficiency / 100));
    }
    const grade = document.getElementById("eff-grade");
    if (grade) {
      grade.textContent =
        efficiency >= 90
          ? "Excellent"
          : efficiency >= 75
            ? "Good"
            : efficiency >= 60
              ? "Fair"
              : "Heavy deadhead";
      grade.style.display = "inline-block";
    }

    document.getElementById("results-section").style.display = "block";
    this.setGenerateState("done");

    // Show legend
    document.getElementById("map-legend").style.display = "block";

    this.setLiveNavigationEnabled(true);
    this.setReplayEnabled(true);
    this.showNotification("Route generated successfully!", "success");
  }

  showError(message) {
    this.hideProgressSection();
    document.getElementById("error-section").style.display = "block";
    document.getElementById("error-message").textContent = message;
    document.getElementById("generate-route-btn").disabled = false;
    this.setLiveNavigationEnabled(false);
  }

  formatDistance(meters) {
    if (!meters && meters !== 0) {
      return "--";
    }
    return `${(meters / MI_TO_M).toFixed(2)} mi`;
  }

  setLiveNavigationEnabled(isEnabled) {
    if (this.liveNavigationBtn) {
      this.liveNavigationBtn.disabled = !isEnabled;
    }
  }

  setReplayEnabled(isEnabled) {
    const replayBtn = document.getElementById("replay-animation-btn");
    if (replayBtn) {
      replayBtn.disabled = !isEnabled;
    }
  }

  showNotification(message, type = "info") {
    notificationManager.show(message, type);
  }
}
