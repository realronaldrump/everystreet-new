/**
 * Bouncie Simulator — simulates live trip webhooks for testing.
 *
 * Every route is resolved via the Mapbox Directions API so coordinates
 * follow the real road network.  Per-segment speed / duration / distance
 * annotations from the API drive realistic pacing.
 */

import {
  buildTripDataPayload,
  buildTripEndPayload,
  buildTripMetricsPayload,
  buildTripStartPayload,
  generateTransactionId,
  sendWebhookPayload,
} from "./payloads.js";
import {
  enableRoutePickerMode,
  fetchPresetRoute,
  getPresetRoutes,
} from "./routes.js";

// ---------------------------------------------------------------------------
// Geometry helpers
// ---------------------------------------------------------------------------

const DEG2RAD = Math.PI / 180;
const RAD2DEG = 180 / Math.PI;
const MPS_TO_MPH = 2.23694;
const M_TO_MI = 0.000621371;

/** Bearing from A→B in degrees [0, 360). */
function bearing(lat1, lon1, lat2, lon2) {
  const dLon = (lon2 - lon1) * DEG2RAD;
  const y = Math.sin(dLon) * Math.cos(lat2 * DEG2RAD);
  const x =
    Math.cos(lat1 * DEG2RAD) * Math.sin(lat2 * DEG2RAD) -
    Math.sin(lat1 * DEG2RAD) * Math.cos(lat2 * DEG2RAD) * Math.cos(dLon);
  return (Math.atan2(y, x) * RAD2DEG + 360) % 360;
}

// ---------------------------------------------------------------------------
// Configuration defaults
// ---------------------------------------------------------------------------

const DEFAULT_CONFIG = {
  /** How often Bouncie batches data (real-world seconds between sends). */
  dataIntervalSec: 3,
  /** How many coordinate points per tripData webhook (1–5, like real Bouncie). */
  batchSize: 3,
  /** Starting fuel level 0-100. */
  fuelStart: 82,
  /** Fuel consumption per mile (% of tank). */
  fuelPerMile: 0.35,
  /** Starting odometer reading. */
  odometerStart: 45678.9,
};

// ---------------------------------------------------------------------------
// BouncieSimulator
// ---------------------------------------------------------------------------

export class BouncieSimulator {
  constructor(map) {
    this.map = map;
    this.status = "idle"; // idle | loading | picking | simulating
    this.route = null; // ResolvedRoute from routes.js
    this.transactionId = null;
    this.currentIndex = 0;
    this.speedMultiplier = 2;
    this.config = { ...DEFAULT_CONFIG };
    this.tickTimer = null;
    this.picker = null;
    this.panel = null;

    // Running trip state
    this._tripStartTime = null;
    this._simElapsedSec = 0; // simulated elapsed seconds
    this._totalDistMi = 0;
    this._maxSpeedMph = 0;
    this._fuelLevel = this.config.fuelStart;
    this._eventLog = [];

    this._buildPanel();
  }

  // =========================================================================
  // Panel DOM
  // =========================================================================

  _buildPanel() {
    const panel = document.createElement("div");
    panel.className = "sim-panel";
    panel.id = "sim-panel";

    const presetOptions = getPresetRoutes()
      .map((r) => `<option value="${r.id}">${r.name}</option>`)
      .join("");

    panel.innerHTML = `
      <div class="sim-header">
        <div class="sim-header-left">
          <i class="fas fa-broadcast-tower sim-header-icon"></i>
          <span class="sim-header-title">Bouncie Simulator</span>
        </div>
        <div class="sim-header-actions">
          <button class="sim-btn-icon" data-action="collapse" title="Collapse">
            <i class="fas fa-chevron-down"></i>
          </button>
          <button class="sim-btn-icon" data-action="close" title="Close">
            <i class="fas fa-times"></i>
          </button>
        </div>
      </div>
      <div class="sim-body">
        <div class="sim-progress-bar"><div class="sim-progress-fill"></div></div>

        <!-- Route -->
        <div class="sim-section">
          <label class="sim-label">Route</label>
          <select class="sim-select" data-ref="routeSelect">
            <option value="">Select a route...</option>
            ${presetOptions}
            <option value="__pick__">Pick on Map...</option>
          </select>
          <div class="sim-route-info" data-ref="routeInfo"></div>
        </div>

        <!-- Config -->
        <div class="sim-section">
          <label class="sim-label">Simulation Speed</label>
          <div class="sim-speed-btns" data-ref="speedBtns">
            <button class="sim-speed-btn" data-speed="1">1x</button>
            <button class="sim-speed-btn active" data-speed="2">2x</button>
            <button class="sim-speed-btn" data-speed="5">5x</button>
            <button class="sim-speed-btn" data-speed="10">10x</button>
          </div>
        </div>

        <div class="sim-section">
          <label class="sim-label">Options</label>
          <div class="sim-config-grid">
            <div class="sim-config-item">
              <span class="sim-config-label">Data interval</span>
              <select class="sim-config-select" data-ref="cfgInterval">
                <option value="2">2 sec</option>
                <option value="3" selected>3 sec</option>
                <option value="5">5 sec</option>
                <option value="10">10 sec</option>
              </select>
            </div>
            <div class="sim-config-item">
              <span class="sim-config-label">Batch size</span>
              <select class="sim-config-select" data-ref="cfgBatch">
                <option value="1">1 pt</option>
                <option value="2">2 pts</option>
                <option value="3" selected>3 pts</option>
                <option value="5">5 pts</option>
              </select>
            </div>
          </div>
        </div>

        <!-- Actions -->
        <div class="sim-section sim-actions">
          <button class="sim-btn sim-btn-start" data-ref="startBtn" disabled>
            <i class="fas fa-play"></i> Start Trip
          </button>
          <button class="sim-btn sim-btn-stop" data-ref="stopBtn" disabled>
            <i class="fas fa-stop"></i> Stop Trip
          </button>
        </div>

        <!-- Status -->
        <div class="sim-status" data-ref="statusArea">
          <div class="sim-status-row">
            <span class="sim-status-dot idle"></span>
            <span class="sim-status-text" data-ref="statusText">Idle</span>
          </div>
          <div class="sim-status-metrics">
            <div class="sim-metric-col">
              <span class="sim-metric-val" data-ref="metricSpeed">--</span>
              <span class="sim-metric-unit">mph</span>
            </div>
            <div class="sim-metric-col">
              <span class="sim-metric-val" data-ref="metricDist">--</span>
              <span class="sim-metric-unit">mi</span>
            </div>
            <div class="sim-metric-col">
              <span class="sim-metric-val" data-ref="metricTime">--</span>
              <span class="sim-metric-unit">min</span>
            </div>
            <div class="sim-metric-col">
              <span class="sim-metric-val" data-ref="metricPct">--%</span>
              <span class="sim-metric-unit">done</span>
            </div>
          </div>
        </div>

        <!-- Event log -->
        <div class="sim-section sim-log-section">
          <label class="sim-label">Event Log</label>
          <div class="sim-log" data-ref="log"></div>
        </div>
      </div>
    `;

    this.panel = panel;
    this.refs = {};
    panel.querySelectorAll("[data-ref]").forEach((el) => {
      this.refs[el.dataset.ref] = el;
    });

    this._bindEvents();
    const mapEl = document.getElementById("map");
    if (mapEl) mapEl.appendChild(panel);
  }

  _bindEvents() {
    const panel = this.panel;

    panel.addEventListener("mousedown", (e) => {
      const btn = e.target.closest("[data-action]");
      if (!btn) return;
      if (btn.dataset.action === "collapse") this._toggleCollapse();
      if (btn.dataset.action === "close") this.hide();
    });

    this.refs.routeSelect.addEventListener("change", (e) =>
      this._onRouteChange(e.target.value),
    );

    this.refs.speedBtns.addEventListener("mousedown", (e) => {
      const btn = e.target.closest("[data-speed]");
      if (!btn) return;
      this.speedMultiplier = Number(btn.dataset.speed);
      this.refs.speedBtns
        .querySelectorAll(".sim-speed-btn")
        .forEach((b) => b.classList.toggle("active", b === btn));
    });

    this.refs.cfgInterval.addEventListener("change", (e) => {
      this.config.dataIntervalSec = Number(e.target.value);
    });
    this.refs.cfgBatch.addEventListener("change", (e) => {
      this.config.batchSize = Number(e.target.value);
    });

    this.refs.startBtn.addEventListener("mousedown", () => this.startTrip());
    this.refs.stopBtn.addEventListener("mousedown", () => this.stopTrip());
  }

  // =========================================================================
  // Panel visibility
  // =========================================================================

  toggle() {
    if (!this.panel) return;
    this.panel.classList.contains("hidden") ? this.show() : this.hide();
  }

  show() {
    if (!this.panel) return;
    this.panel.classList.remove("hidden");
    document.getElementById("sim-toggle")?.classList.add("active");
  }

  hide() {
    if (!this.panel) return;
    this.panel.classList.add("hidden");
    document.getElementById("sim-toggle")?.classList.remove("active");
  }

  _toggleCollapse() {
    const body = this.panel?.querySelector(".sim-body");
    const icon = this.panel?.querySelector("[data-action='collapse'] i");
    if (!body) return;
    const collapsed = body.style.display === "none";
    body.style.display = collapsed ? "" : "none";
    if (icon) icon.className = collapsed ? "fas fa-chevron-down" : "fas fa-chevron-up";
  }

  // =========================================================================
  // Route selection
  // =========================================================================

  async _onRouteChange(value) {
    if (this.picker) {
      this.picker.cancel();
      this.picker = null;
    }

    if (value === "__pick__") {
      this._startRoutePicker();
      return;
    }

    if (!value) {
      this.route = null;
      this.refs.routeInfo.textContent = "";
      this.refs.startBtn.disabled = true;
      return;
    }

    // Fetch preset from Directions API (real roads)
    this._setStatus("loading", "Fetching route...");
    this.refs.startBtn.disabled = true;
    this.refs.routeSelect.disabled = true;

    try {
      this.route = await fetchPresetRoute(value);
      this._showRouteInfo(this.route);
      this.refs.startBtn.disabled = false;
      this._setStatus("idle", "Route ready");
    } catch (err) {
      console.error("Route fetch failed:", err);
      this._setStatus("error", `Route failed: ${err.message}`);
      this.route = null;
    } finally {
      this.refs.routeSelect.disabled = false;
    }
  }

  _startRoutePicker() {
    this.status = "picking";
    this._setStatus("picking", "Click start point on map...");
    this.refs.startBtn.disabled = true;

    this.picker = enableRoutePickerMode(this.map, (route) => {
      this.picker = null;
      if (!route) {
        this.status = "idle";
        this._setStatus("idle", "Route pick cancelled");
        this.refs.routeSelect.value = "";
        return;
      }
      this.route = route;
      this._showRouteInfo(route);
      this.refs.startBtn.disabled = false;
      this.status = "idle";
      this._setStatus("idle", "Route ready");
    });
  }

  _showRouteInfo(route) {
    const mi = (route.totalDistance * M_TO_MI).toFixed(1);
    const mins = Math.round(route.totalDuration / 60);
    const pts = route.segments.length;
    this.refs.routeInfo.textContent = `${mi} mi · ~${mins} min · ${pts} road points`;
  }

  // =========================================================================
  // Simulation lifecycle
  // =========================================================================

  async startTrip() {
    if (this.status === "simulating" || !this.route?.segments?.length) return;

    this.status = "simulating";
    this.currentIndex = 0;
    this._tripStartTime = new Date();
    this._simElapsedSec = 0;
    this._totalDistMi = 0;
    this._maxSpeedMph = 0;
    this._fuelLevel = this.config.fuelStart;
    this.transactionId = generateTransactionId();
    this._eventLog = [];

    this.refs.startBtn.disabled = true;
    this.refs.stopBtn.disabled = false;
    this.refs.routeSelect.disabled = true;
    this._setConfigEnabled(false);

    // --- tripStart ---
    this._setStatus("sending", "Sending tripStart...");
    const startPayload = buildTripStartPayload({
      transactionId: this.transactionId,
      timestamp: this._tripStartTime,
      odometer: this.config.odometerStart,
    });
    const startResult = await sendWebhookPayload(startPayload);
    this._logEvent("tripStart", startResult);

    if (!startResult.ok) {
      this._setStatus("error", `tripStart failed: ${startResult.status}`);
      this._resetControls();
      return;
    }

    // --- begin tick loop ---
    this._setStatus("active", "Simulating...");
    this._scheduleTick();

    // First data immediately
    await this._tick();
  }

  async stopTrip() {
    if (this.status !== "simulating") return;
    this._clearTick();
    await this._finishTrip();
  }

  _scheduleTick() {
    this._clearTick();
    const wallIntervalMs =
      (this.config.dataIntervalSec / this.speedMultiplier) * 1000;
    this.tickTimer = setTimeout(() => this._tick(), Math.max(wallIntervalMs, 150));
  }

  _clearTick() {
    if (this.tickTimer) {
      clearTimeout(this.tickTimer);
      this.tickTimer = null;
    }
  }

  // =========================================================================
  // Simulation tick — uses Directions API annotations for realistic pacing
  // =========================================================================

  async _tick() {
    if (this.status !== "simulating" || !this.route) return;

    const segs = this.route.segments;
    const total = segs.length;

    if (this.currentIndex >= total - 1) {
      this._clearTick();
      await this._finishTrip();
      return;
    }

    // Determine how many segments to advance this tick.
    // We advance enough segments to cover `dataIntervalSec` of simulated time.
    const targetSimSec = this.config.dataIntervalSec;
    let simSecThisTick = 0;
    let advanceCount = 0;

    for (let i = this.currentIndex + 1; i < total; i++) {
      const segDur = segs[i].durationS;
      if (simSecThisTick + segDur > targetSimSec && advanceCount > 0) break;
      simSecThisTick += segDur;
      advanceCount++;
      if (advanceCount >= this.config.batchSize) break;
    }

    // If no segments could be consumed (very tiny durations), advance at least 1
    if (advanceCount === 0) {
      advanceCount = Math.min(1, total - 1 - this.currentIndex);
      if (advanceCount === 0) {
        this._clearTick();
        await this._finishTrip();
        return;
      }
    }

    // Build data points for webhook payload
    const dataPoints = [];
    for (let i = 0; i < advanceCount; i++) {
      const segIdx = this.currentIndex + 1 + i;
      if (segIdx >= total) break;

      const seg = segs[segIdx];
      const prev = segs[segIdx - 1];

      // Accumulate simulated elapsed time
      this._simElapsedSec += seg.durationS;

      // Distance
      const distMi = seg.distanceM * M_TO_MI;
      this._totalDistMi += distMi;

      // Speed: use Directions API speed (m/s → mph) with slight jitter
      const baseSpeedMph = seg.speedMps * MPS_TO_MPH;
      const jitter = 1 + (Math.random() - 0.5) * 0.08; // ±4%
      const speedMph = Math.max(0, baseSpeedMph * jitter);
      this._maxSpeedMph = Math.max(this._maxSpeedMph, speedMph);

      // Fuel
      this._fuelLevel = Math.max(0, this._fuelLevel - distMi * this.config.fuelPerMile);

      // Heading
      const hdg = bearing(prev.lat, prev.lon, seg.lat, seg.lon);

      // Timestamp: trip start + simulated elapsed time
      const ptTime = new Date(
        this._tripStartTime.getTime() + this._simElapsedSec * 1000,
      );

      dataPoints.push({
        timestamp: ptTime,
        lat: seg.lat,
        lon: seg.lon,
        heading: Math.round(hdg),
        speed: parseFloat(speedMph.toFixed(1)),
        fuelLevelInput: parseFloat(this._fuelLevel.toFixed(1)),
      });
    }

    this.currentIndex += advanceCount;

    // Send tripData webhook
    const payload = buildTripDataPayload({
      transactionId: this.transactionId,
      dataPoints,
    });
    const result = await sendWebhookPayload(payload);
    this._logEvent("tripData", result, `${dataPoints.length} pts`);

    // Update UI
    this._updateMetrics(dataPoints);

    // Schedule next tick
    if (this.status === "simulating") this._scheduleTick();
  }

  // =========================================================================
  // Trip end
  // =========================================================================

  async _finishTrip() {
    const endTime = new Date(
      this._tripStartTime.getTime() + this._simElapsedSec * 1000,
    );

    // --- tripMetrics ---
    this._setStatus("sending", "Sending tripMetrics...");
    const avgSpeed =
      this._simElapsedSec > 0
        ? this._totalDistMi / (this._simElapsedSec / 3600)
        : 0;

    const metricsPayload = buildTripMetricsPayload({
      transactionId: this.transactionId,
      timestamp: endTime,
      tripTime: Math.round(this._simElapsedSec),
      tripDistance: parseFloat(this._totalDistMi.toFixed(2)),
      totalIdlingTime: 0,
      maxSpeed: parseFloat(this._maxSpeedMph.toFixed(1)),
      averageDriveSpeed: parseFloat(avgSpeed.toFixed(1)),
      hardBrakingCounts: Math.floor(Math.random() * 3),
      hardAccelerationCounts: Math.floor(Math.random() * 2),
    });
    const mResult = await sendWebhookPayload(metricsPayload);
    this._logEvent("tripMetrics", mResult);

    // --- tripEnd ---
    this._setStatus("sending", "Sending tripEnd...");
    const endPayload = buildTripEndPayload({
      transactionId: this.transactionId,
      timestamp: endTime,
      odometer: this.config.odometerStart + this._totalDistMi,
      fuelConsumed: parseFloat(
        ((this.config.fuelStart - this._fuelLevel) * 0.08).toFixed(2),
      ),
    });
    const eResult = await sendWebhookPayload(endPayload);
    this._logEvent("tripEnd", eResult);

    this.status = "idle";
    this._setProgress(100);
    this._setStatus("idle", "Trip completed");
    this._resetControls();
  }

  // =========================================================================
  // UI helpers
  // =========================================================================

  _updateMetrics(dataPoints) {
    if (!dataPoints.length) return;
    const last = dataPoints[dataPoints.length - 1];
    const total = this.route.segments.length;
    const pct = Math.round((this.currentIndex / (total - 1)) * 100);
    const mins = (this._simElapsedSec / 60).toFixed(1);

    this.refs.metricSpeed.textContent = last.speed.toFixed(0);
    this.refs.metricDist.textContent = this._totalDistMi.toFixed(2);
    this.refs.metricTime.textContent = mins;
    this.refs.metricPct.textContent = `${pct}%`;
    this._setProgress(pct);
    this._setStatus("active", `Simulating... ${pct}%`);
  }

  _setStatus(state, text) {
    const dot = this.panel?.querySelector(".sim-status-dot");
    if (dot) dot.className = `sim-status-dot ${state}`;
    if (this.refs.statusText) this.refs.statusText.textContent = text;
  }

  _setProgress(pct) {
    const fill = this.panel?.querySelector(".sim-progress-fill");
    if (fill) fill.style.width = `${pct}%`;
  }

  _setConfigEnabled(enabled) {
    this.refs.cfgInterval.disabled = !enabled;
    this.refs.cfgBatch.disabled = !enabled;
    this.refs.speedBtns.querySelectorAll("button").forEach((b) => {
      b.disabled = !enabled;
    });
  }

  _logEvent(eventType, result, extra = "") {
    const time = new Date().toLocaleTimeString("en-US", {
      hour12: false,
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
    const ok = result.ok;
    const detail = extra ? ` (${extra})` : "";

    const entry = document.createElement("div");
    entry.className = "sim-log-entry";
    entry.innerHTML = `
      <span class="sim-log-time">${time}</span>
      <span class="sim-log-event">${eventType}</span>
      <span class="sim-log-status ${ok ? "ok" : "err"}">${ok ? result.status : `ERR ${result.status}`}</span>
      <span class="sim-log-detail">${detail}</span>
    `;

    const log = this.refs.log;
    if (log) {
      log.appendChild(entry);
      while (log.children.length > 50) log.removeChild(log.firstChild);
      log.scrollTop = log.scrollHeight;
    }
  }

  _resetControls() {
    this.refs.startBtn.disabled = !this.route;
    this.refs.stopBtn.disabled = true;
    this.refs.routeSelect.disabled = false;
    this._setConfigEnabled(true);
    this.status = "idle";
  }

  // =========================================================================
  // Cleanup
  // =========================================================================

  destroy() {
    this._clearTick();
    if (this.picker) this.picker.cancel();
    if (this.panel) this.panel.remove();
    this.panel = null;
  }
}
