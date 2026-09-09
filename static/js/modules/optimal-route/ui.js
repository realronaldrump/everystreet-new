import { syncAppSelect } from "../ui/app-select.js";
import { revealPlannerSection } from "../features/coverage-route-planner/ui-scaffold.js";
import notificationManager from "../ui/notifications.js";
import { getRemainingDriveableMiles } from "../features/navigation-core/coverage-areas.js";
import { MI_TO_M } from "../utils/geo-math.js";
import { escapeHtml } from "../utils.js";
import { STAGE_COPY } from "./constants.js";

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
      stage: document.getElementById("hud-stage"),
      elapsed: document.getElementById("hud-elapsed"),
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

    this.areaSelect.disabled = areas.length === 0;
    this.areaSelect.innerHTML = '<option value="">Choose a coverage area…</option>';
    this.setAreaLoadState(areas.length ? "ready" : "empty");

    areas.forEach((area) => {
      const option = document.createElement("option");
      const areaId = area.id;
      const areaName = area.display_name;
      const status = area.status || "";
      const isProcessing = this.isCoverageCalculationActive(status);
      option.value = String(areaId);
      const coverage = area.coverage_percentage?.toFixed(2) || 0;
      const label = `${areaName.split(",").slice(0, 2).join(",")} · ${Number(coverage).toFixed(1)}% driven`;
      option.textContent = isProcessing ? `${label} (calculating coverage)` : label;
      option.dataset.coverage = coverage;
      option.dataset.status = String(status || "");
      option.dataset.processing = isProcessing ? "true" : "false";
      option.disabled = isProcessing;
      const remainingMiles = getRemainingDriveableMiles(area);
      option.dataset.remaining = this.formatDistance(
        remainingMiles === null ? null : remainingMiles * MI_TO_M
      );
      this.areaSelect.appendChild(option);
    });
  }

  setAreaSelection(areaId) {
    if (!this.areaSelect) return;
    this.areaSelect.value = areaId;
    syncAppSelect(this.areaSelect);
  }

  updateSavedRoutes(areas, onRouteClick) {
    const historyContainer = document.getElementById("route-history");
    if (!historyContainer) {
      return;
    }

    const areasWithRoutes = areas.filter((a) => a.has_optimal_route);
    const count = document.getElementById("saved-route-count");
    if (count) count.textContent = String(areasWithRoutes.length);

    if (areasWithRoutes.length === 0) {
      historyContainer.innerHTML = `
        <div class="empty-state">
          <i class="fas fa-route" aria-hidden="true"></i>
          <span>Routes you build will be saved here.</span>
        </div>
      `;
      return;
    }

    historyContainer.innerHTML = areasWithRoutes
      .map((area) => {
        const date = area.optimal_route_generated_at
          ? new Date(area.optimal_route_generated_at).toLocaleDateString()
          : "Unknown";
        const safeAreaId = escapeHtml(area.id);
        const safeAreaName = escapeHtml((area.display_name || "Unknown").split(",")[0]);
        const safeDate = escapeHtml(date);
        return `
          <button type="button" class="route-history-item" data-area-id="${safeAreaId}">
            <span class="route-history-main">
              <span class="route-name">${safeAreaName}</span>
              <span class="route-date">${safeDate}</span>
            </span>
            <span class="route-history-chevron" aria-hidden="true">
              <i class="fas fa-chevron-right"></i>
            </span>
          </button>
        `;
      })
      .join("");

    historyContainer.querySelectorAll(".route-history-item").forEach((item) => {
      item.addEventListener("click", () => {
        const { areaId } = item.dataset;
        this.setAreaSelection(areaId);
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
    const mapTitle = document.getElementById("map-area-name");
    const mapEmpty = document.getElementById("map-empty-state");
    const fitButton = document.getElementById("fit-area-btn");
    if (mapTitle)
      mapTitle.textContent =
        area?.display_name?.split(",")[0] || "Your next drive starts here";
    if (mapEmpty) mapEmpty.hidden = Boolean(area);
    if (fitButton) fitButton.disabled = !area;
    this.areaIsComplete = Boolean(area?.is_complete);
    this.setMapStatus("");
    if (!area) {
      areaStats.style.display = "none";
      if (emptyHint) {
        emptyHint.style.display = "";
      }
      if (subtitle) {
        subtitle.textContent = "Choose a coverage area to explore its streets.";
      }
      return;
    }

    const coverage = Math.min(100, Math.max(0, Number(area.coverage_percentage) || 0));
    const drivenMiles = Number(area.driven_length_miles) || 0;
    const remainingMiles = getRemainingDriveableMiles(area);
    const remainingMeters = remainingMiles === null ? null : remainingMiles * MI_TO_M;
    const remainingLabel = this.formatDistance(remainingMeters);
    const coverageValue = document.getElementById("area-coverage");
    const remainingValue = document.getElementById("area-remaining");
    const drivenValue = document.querySelector(".acstat-driven-val");
    const totalValue = document.querySelector(".acstat-total-val");
    const donutArc = document.getElementById("donut-driven-arc");
    const coverageBar = document.getElementById("area-coverage-bar");

    if (coverageValue) {
      coverageValue.textContent = `${coverage.toFixed(1)}%`;
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
      subtitle.textContent = `${coverage.toFixed(1)}% driven · ${remainingLabel} remaining`;
    }
    areaStats.style.display = "block";
  }

  setGenerateState(state) {
    const generateBtn = document.getElementById("generate-route-btn");
    if (generateBtn) {
      const isComplete = this.areaIsComplete && state !== "working";
      generateBtn.dataset.state = isComplete ? "complete" : state;
      generateBtn.disabled = state === "idle" || state === "working" || isComplete;
    }
  }

  setAreaLoadState(state) {
    const feedback = document.getElementById("area-load-feedback");
    const message = document.getElementById("area-load-message");
    const retry = document.getElementById("retry-areas-btn");
    const create = document.getElementById("create-area-link");
    if (feedback) feedback.hidden = state === "ready" || state === "loading";
    if (message)
      message.textContent =
        state === "empty"
          ? "Create a coverage area to start planning your drives."
          : "Coverage areas couldn’t load. Check your connection and try again.";
    if (retry) retry.hidden = state !== "error";
    if (create) create.hidden = state !== "empty";
    if (this.areaSelect && state !== "ready") this.areaSelect.disabled = true;
  }

  setMapStatus(message) {
    const status = document.getElementById("map-selection-status");
    if (!status) return;
    status.textContent = message;
    status.hidden = !message;
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
  }

  updateHud(stage, _primary, _secondary, _metrics, labelOverride) {
    const meta = STAGE_COPY[stage] || { label: "Working" };
    if (this.hud.stage) this.hud.stage.textContent = labelOverride || meta.label;
  }

  setHudActive(isActive) {
    if (!this.hud?.container) {
      return;
    }
    this.hud.container.classList.toggle("active", isActive);
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

    this.stopElapsedTimer();
    this.startTime = startTime || Date.now();
    this.updateElapsedTime();
    this.elapsedTimer = setInterval(() => this.updateElapsedTime(), 1000);

    const generateBtn = document.getElementById("generate-route-btn");
    if (generateBtn) {
      generateBtn.disabled = true;
    }
    this.setGenerateState("working");
    revealPlannerSection("section-planner");
  }

  hideProgressSection() {
    this.stopElapsedTimer();
    const progressSection = document.getElementById("route-progress-inline");
    if (progressSection) {
      progressSection.style.display = "none";
    }
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
    const meta = document.getElementById("route-result-meta");
    const note = document.getElementById("route-coverage-note");
    const generated = data.generated_at ? new Date(data.generated_at) : null;
    const date =
      generated && Number.isFinite(generated.getTime())
        ? generated.toLocaleDateString(undefined, { month: "short", day: "numeric" })
        : null;
    if (meta)
      meta.textContent = [
        data.kind === "cluster" ? "Selected street route" : "Full area route",
        date ? `Built ${date}` : null,
      ]
        .filter(Boolean)
        .join(" · ");
    if (note) note.hidden = !data.coverage_changed;
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
      `${efficiency.toFixed(1)}%`;

    const ring = document.getElementById("eff-ring-fill");
    if (ring) {
      ring.style.strokeDashoffset = String(188.5 * (1 - efficiency / 100));
    }
    document.getElementById("results-section").style.display = "block";
    this.setGenerateState("done");

    // Show legend
    document.getElementById("map-legend").style.display = "block";

    this.setLiveNavigationEnabled(Boolean(data.route_id));
    this.setReplayEnabled(true);
    revealPlannerSection("section-results");
    this.showNotification("Route generated successfully!", "success");
  }

  showError(message) {
    this.hideProgressSection();
    document.getElementById("error-section").style.display = "block";
    document.getElementById("error-message").textContent = message;
    document.getElementById("generate-route-btn").disabled = false;
    this.setLiveNavigationEnabled(false);
    revealPlannerSection("section-planner");
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
