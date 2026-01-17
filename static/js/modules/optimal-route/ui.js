import { SCANNER_STAGES, STAGE_COPY } from "./constants.js";

export class OptimalRouteUI {
  constructor(config = {}) {
    this.config = config;
    this.areaSelect = document.getElementById(config.areaSelectId);
    this.turnByTurnBtn = document.getElementById("start-turn-by-turn-btn");
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
      fallback: document.getElementById("hud-fallback"),
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
      const coverage = area.coverage_percentage?.toFixed(1) || 0;
      const label = `${areaName} (${coverage}%)`;
      option.textContent = isProcessing ? `${label} (calculating coverage)` : label;
      option.dataset.coverage = coverage;
      option.dataset.status = String(status || "");
      option.dataset.processing = isProcessing ? "true" : "false";
      option.disabled = isProcessing;
      const totalLengthMeters = (area.total_length_miles || 0) * 1609.344;
      const drivenLengthMeters = (area.driven_length_miles || 0) * 1609.344;
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
      historyContainer.innerHTML =
        '<div class="text-muted small">No saved routes yet.</div>';
      return;
    }

    historyContainer.innerHTML = areasWithRoutes
      .map((area) => {
        const date = area.optimal_route_generated_at
          ? new Date(area.optimal_route_generated_at).toLocaleDateString()
          : "Unknown";
        return `
          <div class="route-history-item" data-area-id="${area.id || area._id}">
            <div>
              <div class="route-name">${area.display_name || "Unknown"}</div>
              <div class="route-date">${date}</div>
            </div>
            <i class="fas fa-chevron-right text-muted"></i>
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

  updateAreaStats(areaId) {
    const areaStats = document.getElementById("area-stats");
    if (!areaStats) {
      return;
    }

    const selectedOption = this.areaSelect?.querySelector(`option[value="${areaId}"]`);
    if (selectedOption) {
      document.getElementById("area-coverage").textContent =
        `${selectedOption.dataset.coverage}%`;
      document.getElementById("area-remaining").textContent =
        selectedOption.dataset.remaining;
      areaStats.style.display = "block";
    } else {
      areaStats.style.display = "none";
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
      progressBar.style.width = `${data.progress}%`;
    }

    const { primary, secondary, label } = this.buildProgressMessages(
      stage,
      data.message
    );
    this.setStatusMessage(primary, secondary, stage, metrics, label);

    const stages = document.querySelectorAll(".progress-stages .stage");
    stages.forEach((stageEl) => {
      const stageNames = stageEl.dataset.stage
        .split(",")
        .map((name) => name.trim().toLowerCase());
      stageEl.classList.remove("active", "completed");

      if (stageNames.includes(stage)) {
        stageEl.classList.add("active");
      } else if (this.isStageComplete(stage, stageNames)) {
        stageEl.classList.add("completed");
      }
    });

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
    const fallbackTotal = metrics.fallback_total ?? null;
    const fallbackMatched = metrics.fallback_matched ?? null;
    const mappedSegments =
      metrics.mapped_segments ?? Number(osmMatched || 0) + Number(fallbackMatched || 0);

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
    if (this.hud.fallback) {
      this.hud.fallback.textContent = hasMetrics
        ? fallbackTotal
          ? `${this.formatCount(fallbackMatched || 0)}/${this.formatCount(fallbackTotal)}`
          : fallbackMatched != null
            ? this.formatCount(fallbackMatched)
            : "--"
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

  isStageComplete(currentStage, stageNames) {
    const stageOrder = [
      "queued",
      "waiting",
      "initializing",
      "loading_area",
      "loading_segments",
      "loading_graph",
      "fetching_osm",
      "mapping_segments",
      "connectivity_check",
      "routing",
      "finalizing",
      "complete",
      "error",
    ];

    const currentIndex = stageOrder.indexOf(currentStage);
    if (currentIndex === -1) {
      return false;
    }

    return stageNames.every((name) => {
      const stageIndex = stageOrder.indexOf(name);
      return stageIndex !== -1 && stageIndex < currentIndex;
    });
  }

  showProgressSection(startTime) {
    document.getElementById("results-section").style.display = "none";
    document.getElementById("error-section").style.display = "none";
    const progressSection = document.getElementById("progress-section");
    if (progressSection) {
      progressSection.style.display = "block";
    }

    document.getElementById("progress-bar").style.width = "0%";
    this.currentStage = "initializing";
    this.currentMetrics = {};
    this.resetHud();
    const { primary, secondary, label } = this.buildProgressMessages(
      "initializing",
      ""
    );
    this.setStatusMessage(primary, secondary, "initializing", {}, label);
    this.setHudActive(true);
    this.setScannerActive(true);

    document.querySelectorAll(".progress-stages .stage").forEach((stage) => {
      stage.classList.remove("active", "completed");
    });

    this.startTime = startTime || Date.now();
    this.updateElapsedTime();
    this.elapsedTimer = setInterval(() => this.updateElapsedTime(), 1000);

    const generateBtn = document.getElementById("generate-route-btn");
    if (generateBtn) {
      generateBtn.disabled = true;
    }
  }

  hideProgressSection() {
    this.stopElapsedTimer();
    const progressSection = document.getElementById("progress-section");
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
    document.getElementById("generate-route-btn").disabled = false;

    document.getElementById("stat-total-distance").textContent = this.formatDistance(
      data.total_distance_m
    );
    document.getElementById("stat-required-distance").textContent = this.formatDistance(
      data.required_distance_m
    );
    document.getElementById("stat-deadhead-distance").textContent = this.formatDistance(
      data.deadhead_distance_m
    );
    document.getElementById("stat-deadhead-percent").textContent = `${(
      100 - (data.deadhead_percentage || 0)
    ).toFixed(1)}%`;

    document.getElementById("results-section").style.display = "block";

    // Show legend
    document.getElementById("map-legend").style.display = "block";

    this.setTurnByTurnEnabled(true);
    this.setReplayEnabled(true);
    this.showNotification("Route generated successfully!", "success");
  }

  showError(message) {
    this.hideProgressSection();
    document.getElementById("error-section").style.display = "block";
    document.getElementById("error-message").textContent = message;
    document.getElementById("generate-route-btn").disabled = false;
    this.setTurnByTurnEnabled(false);
  }

  formatDistance(meters) {
    if (!meters && meters !== 0) {
      return "--";
    }
    return `${(meters / 1609.344).toFixed(2)} mi`;
  }

  setTurnByTurnEnabled(isEnabled) {
    if (this.turnByTurnBtn) {
      this.turnByTurnBtn.disabled = !isEnabled;
    }
  }

  setReplayEnabled(isEnabled) {
    const replayBtn = document.getElementById("replay-animation-btn");
    if (replayBtn) {
      replayBtn.disabled = !isEnabled;
    }
  }

  showNotification(message, type = "info") {
    if (window.notificationManager) {
      window.notificationManager.show(message, type);
    } else {
      console.log(`[${type}] ${message}`);
    }
  }
}
