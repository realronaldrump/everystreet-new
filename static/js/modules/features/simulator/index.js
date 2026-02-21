/**
 * Bouncie Simulator — simulates live trip webhooks for testing.
 *
 * Sends real webhook payloads to /webhook/bouncie with the correct auth
 * header, exercising the full tracking pipeline end-to-end.
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
  getPresetRouteById,
  getPresetRoutes,
} from "./routes.js";

// ---------------------------------------------------------------------------
// Geometry helpers
// ---------------------------------------------------------------------------

function toRad(deg) {
  return (deg * Math.PI) / 180;
}
function toDeg(rad) {
  return (rad * 180) / Math.PI;
}

/** Haversine distance in miles. */
function haversine(lat1, lon1, lat2, lon2) {
  const R = 3958.8;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

/** Bearing from point A to point B in degrees [0, 360). */
function bearing(lat1, lon1, lat2, lon2) {
  const dLon = toRad(lon2 - lon1);
  const y = Math.sin(dLon) * Math.cos(toRad(lat2));
  const x =
    Math.cos(toRad(lat1)) * Math.sin(toRad(lat2)) -
    Math.sin(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.cos(dLon);
  return (toDeg(Math.atan2(y, x)) + 360) % 360;
}

// ---------------------------------------------------------------------------
// Speed profiles — target speeds by route type (mph)
// ---------------------------------------------------------------------------

const SPEED_PROFILES = {
  "downtown-loop": { min: 15, max: 40, avg: 28 },
  "highway-run": { min: 45, max: 72, avg: 60 },
  neighborhood: { min: 10, max: 30, avg: 20 },
  custom: { min: 20, max: 50, avg: 35 },
};

// ---------------------------------------------------------------------------
// BouncieSimulator
// ---------------------------------------------------------------------------

export class BouncieSimulator {
  constructor(map) {
    this.map = map;
    this.status = "idle"; // idle | picking | simulating
    this.transactionId = null;
    this.routeId = null;
    this.routeCoords = null;
    this.routeMeta = null;
    this.currentIndex = 0;
    this.speedMultiplier = 2;
    this.intervalId = null;
    this.startTime = null;
    this.totalDistance = 0;
    this.maxSpeed = 0;
    this.lastSpeed = 0;
    this.fuelLevel = 82;
    this.eventLog = [];
    this.picker = null;
    this.panel = null;

    this._buildPanel();
  }

  // =========================================================================
  // Panel DOM Construction
  // =========================================================================

  _buildPanel() {
    const panel = document.createElement("div");
    panel.className = "sim-panel";
    panel.id = "sim-panel";
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

        <div class="sim-section">
          <label class="sim-label">Route</label>
          <select class="sim-select" data-ref="routeSelect">
            <option value="">Select a route...</option>
            ${getPresetRoutes()
              .map(
                (r) =>
                  `<option value="${r.id}">${r.name} (${r.pointCount} pts)</option>`,
              )
              .join("")}
            <option value="__pick__">Pick on Map...</option>
          </select>
          <div class="sim-route-info" data-ref="routeInfo"></div>
        </div>

        <div class="sim-section">
          <label class="sim-label">Speed</label>
          <div class="sim-speed-btns" data-ref="speedBtns">
            <button class="sim-speed-btn" data-speed="1">1x</button>
            <button class="sim-speed-btn active" data-speed="2">2x</button>
            <button class="sim-speed-btn" data-speed="5">5x</button>
            <button class="sim-speed-btn" data-speed="10">10x</button>
          </div>
        </div>

        <div class="sim-section sim-actions">
          <button class="sim-btn sim-btn-start" data-ref="startBtn" disabled>
            <i class="fas fa-play"></i> Start Trip
          </button>
          <button class="sim-btn sim-btn-stop" data-ref="stopBtn" disabled>
            <i class="fas fa-stop"></i> Stop Trip
          </button>
        </div>

        <div class="sim-status" data-ref="statusArea">
          <div class="sim-status-row">
            <span class="sim-status-dot idle"></span>
            <span class="sim-status-text" data-ref="statusText">Idle</span>
          </div>
          <div class="sim-status-metrics" data-ref="metrics">
            <span data-ref="metricCoord">--</span>
            <span data-ref="metricSpeed">-- mph</span>
            <span data-ref="metricProgress">0%</span>
          </div>
        </div>

        <div class="sim-section sim-log-section">
          <label class="sim-label">Event Log</label>
          <div class="sim-log" data-ref="log"></div>
        </div>
      </div>
    `;

    this.panel = panel;
    this.refs = {};

    // Cache element references
    panel.querySelectorAll("[data-ref]").forEach((el) => {
      this.refs[el.dataset.ref] = el;
    });

    this._bindEvents();

    // Insert into map container
    const mapEl = document.getElementById("map");
    if (mapEl) mapEl.appendChild(panel);
  }

  _bindEvents() {
    const panel = this.panel;

    // Collapse / close
    panel.addEventListener("mousedown", (e) => {
      const btn = e.target.closest("[data-action]");
      if (!btn) return;
      const action = btn.dataset.action;
      if (action === "collapse") this._toggleCollapse();
      if (action === "close") this.hide();
    });

    // Route select
    this.refs.routeSelect.addEventListener("change", (e) => {
      this._onRouteChange(e.target.value);
    });

    // Speed buttons
    this.refs.speedBtns.addEventListener("mousedown", (e) => {
      const btn = e.target.closest("[data-speed]");
      if (!btn) return;
      this.speedMultiplier = Number(btn.dataset.speed);
      this.refs.speedBtns
        .querySelectorAll(".sim-speed-btn")
        .forEach((b) => b.classList.toggle("active", b === btn));
    });

    // Start / Stop
    this.refs.startBtn.addEventListener("mousedown", () => this.startTrip());
    this.refs.stopBtn.addEventListener("mousedown", () => this.stopTrip());
  }

  // =========================================================================
  // Panel Visibility
  // =========================================================================

  toggle() {
    if (!this.panel) return;
    const isVisible = !this.panel.classList.contains("hidden");
    if (isVisible) this.hide();
    else this.show();
  }

  show() {
    if (!this.panel) return;
    this.panel.classList.remove("hidden");
    const toggleBtn = document.getElementById("sim-toggle");
    if (toggleBtn) toggleBtn.classList.add("active");
  }

  hide() {
    if (!this.panel) return;
    this.panel.classList.add("hidden");
    const toggleBtn = document.getElementById("sim-toggle");
    if (toggleBtn) toggleBtn.classList.remove("active");
  }

  _toggleCollapse() {
    if (!this.panel) return;
    const body = this.panel.querySelector(".sim-body");
    const icon = this.panel.querySelector("[data-action='collapse'] i");
    if (!body) return;

    const collapsed = body.style.display === "none";
    body.style.display = collapsed ? "" : "none";
    if (icon) {
      icon.className = collapsed ? "fas fa-chevron-down" : "fas fa-chevron-up";
    }
  }

  // =========================================================================
  // Route Selection
  // =========================================================================

  _onRouteChange(value) {
    if (this.picker) {
      this.picker.cancel();
      this.picker = null;
    }

    if (value === "__pick__") {
      this._startRoutePicker();
      return;
    }

    if (!value) {
      this.routeCoords = null;
      this.routeId = null;
      this.routeMeta = null;
      this.refs.routeInfo.textContent = "";
      this.refs.startBtn.disabled = true;
      return;
    }

    const route = getPresetRouteById(value);
    if (!route) return;

    this.routeId = route.id;
    this.routeCoords = route.coordinates;
    this.routeMeta = { distance: null, duration: null };
    this.refs.routeInfo.textContent = route.description;
    this.refs.startBtn.disabled = false;
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

      this.routeId = "custom";
      this.routeCoords = route.coordinates;
      this.routeMeta = {
        distance: route.distance,
        duration: route.duration,
      };
      this.refs.routeInfo.textContent = `Custom route: ${route.coordinates.length} pts, ${(route.distance / 1609.34).toFixed(1)} mi`;
      this.refs.startBtn.disabled = false;
      this.status = "idle";
      this._setStatus("idle", "Route ready");
    });
  }

  // =========================================================================
  // Simulation Lifecycle
  // =========================================================================

  async startTrip() {
    if (this.status === "simulating" || !this.routeCoords?.length) return;

    this.status = "simulating";
    this.currentIndex = 0;
    this.totalDistance = 0;
    this.maxSpeed = 0;
    this.lastSpeed = 0;
    this.fuelLevel = 82;
    this.transactionId = generateTransactionId();
    this.startTime = new Date();
    this.eventLog = [];

    this.refs.startBtn.disabled = true;
    this.refs.stopBtn.disabled = false;
    this.refs.routeSelect.disabled = true;

    // Send tripStart
    this._setStatus("sending", "Sending tripStart...");
    const startPayload = buildTripStartPayload({
      transactionId: this.transactionId,
      timestamp: this.startTime,
    });
    const startResult = await sendWebhookPayload(startPayload);
    this._logEvent("tripStart", startResult);

    if (!startResult.ok) {
      this._setStatus("error", `tripStart failed: ${startResult.status}`);
      this._resetControls();
      return;
    }

    // Begin tick loop
    const baseIntervalMs = 3000;
    const intervalMs = Math.max(baseIntervalMs / this.speedMultiplier, 200);

    this._setStatus("active", "Simulating...");
    this.intervalId = setInterval(() => this._tick(), intervalMs);

    // Send first data immediately
    await this._tick();
  }

  async stopTrip() {
    if (this.status !== "simulating") return;
    clearInterval(this.intervalId);
    this.intervalId = null;

    await this._finishTrip();
  }

  async _finishTrip() {
    const endTime = new Date();
    const tripTimeSec = (endTime - this.startTime) / 1000;

    this._setStatus("sending", "Sending tripMetrics...");

    // tripMetrics
    const metricsPayload = buildTripMetricsPayload({
      transactionId: this.transactionId,
      timestamp: endTime,
      tripTime: Math.round(tripTimeSec * this.speedMultiplier),
      tripDistance: parseFloat(this.totalDistance.toFixed(2)),
      totalIdlingTime: 0,
      maxSpeed: parseFloat(this.maxSpeed.toFixed(1)),
      averageDriveSpeed: parseFloat(
        (this.totalDistance / (tripTimeSec * this.speedMultiplier / 3600) || 0).toFixed(1),
      ),
      hardBrakingCounts: Math.floor(Math.random() * 3),
      hardAccelerationCounts: Math.floor(Math.random() * 2),
    });
    const metricsResult = await sendWebhookPayload(metricsPayload);
    this._logEvent("tripMetrics", metricsResult);

    // tripEnd
    this._setStatus("sending", "Sending tripEnd...");
    const endPayload = buildTripEndPayload({
      transactionId: this.transactionId,
      timestamp: endTime,
      odometer: 45678.9 + this.totalDistance,
      fuelConsumed: parseFloat(((82 - this.fuelLevel) * 0.08).toFixed(2)),
    });
    const endResult = await sendWebhookPayload(endPayload);
    this._logEvent("tripEnd", endResult);

    this.status = "idle";
    this._setStatus("idle", "Trip completed");
    this._setProgress(100);
    this._resetControls();
  }

  async _tick() {
    if (this.status !== "simulating" || !this.routeCoords) return;

    const coords = this.routeCoords;
    const total = coords.length;

    if (this.currentIndex >= total - 1) {
      clearInterval(this.intervalId);
      this.intervalId = null;
      await this._finishTrip();
      return;
    }

    // Batch 1–3 points per tick
    const batchSize = Math.min(
      1 + Math.floor(Math.random() * 3),
      total - 1 - this.currentIndex,
    );

    const profile =
      SPEED_PROFILES[this.routeId] ?? SPEED_PROFILES.custom;

    const dataPoints = [];
    const elapsed = (Date.now() - this.startTime.getTime()) / 1000;

    for (let i = 0; i < batchSize; i++) {
      const idx = this.currentIndex + i;
      if (idx >= total - 1) break;

      const curr = coords[idx];
      const next = coords[idx + 1];
      const dist = haversine(curr.lat, curr.lon, next.lat, next.lon);
      const hdg = bearing(curr.lat, curr.lon, next.lat, next.lon);

      // Simulate speed with some variance
      const targetSpeed =
        profile.avg + (Math.random() - 0.5) * (profile.max - profile.min) * 0.4;
      const speed = Math.max(
        profile.min,
        Math.min(profile.max, targetSpeed),
      );

      this.totalDistance += dist;
      this.maxSpeed = Math.max(this.maxSpeed, speed);
      this.lastSpeed = speed;
      this.fuelLevel = Math.max(0, this.fuelLevel - dist * 0.03);

      // Timestamp: startTime + scaled elapsed time
      const ptTime = new Date(
        this.startTime.getTime() +
          (elapsed + i * (3 / this.speedMultiplier)) * 1000 * this.speedMultiplier,
      );

      dataPoints.push({
        timestamp: ptTime,
        lat: next.lat,
        lon: next.lon,
        heading: Math.round(hdg),
        speed: parseFloat(speed.toFixed(1)),
        fuelLevelInput: parseFloat(this.fuelLevel.toFixed(1)),
      });
    }

    this.currentIndex += batchSize;

    // Send tripData
    const payload = buildTripDataPayload({
      transactionId: this.transactionId,
      dataPoints,
    });
    const result = await sendWebhookPayload(payload);
    this._logEvent("tripData", result, `${batchSize} pts`);

    // Update UI
    const last = dataPoints[dataPoints.length - 1];
    const pct = Math.round((this.currentIndex / (total - 1)) * 100);
    this._setProgress(pct);
    this.refs.metricCoord.textContent = `${last.lat.toFixed(4)}, ${last.lon.toFixed(4)}`;
    this.refs.metricSpeed.textContent = `${last.speed} mph`;
    this.refs.metricProgress.textContent = `${pct}%`;
    this._setStatus("active", `Simulating... ${pct}%`);
  }

  // =========================================================================
  // UI Helpers
  // =========================================================================

  _setStatus(state, text) {
    const dot = this.panel.querySelector(".sim-status-dot");
    if (dot) {
      dot.className = `sim-status-dot ${state}`;
    }
    if (this.refs.statusText) {
      this.refs.statusText.textContent = text;
    }
  }

  _setProgress(pct) {
    const fill = this.panel.querySelector(".sim-progress-fill");
    if (fill) fill.style.width = `${pct}%`;
  }

  _logEvent(eventType, result, extra = "") {
    const time = new Date().toLocaleTimeString("en-US", {
      hour12: false,
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
    const statusClass = result.ok ? "ok" : "err";
    const statusText = result.ok ? result.status : `ERR ${result.status}`;
    const detail = extra ? ` (${extra})` : "";

    const entry = document.createElement("div");
    entry.className = "sim-log-entry";
    entry.innerHTML = `
      <span class="sim-log-time">${time}</span>
      <span class="sim-log-event">${eventType}</span>
      <span class="sim-log-status ${statusClass}">${statusText}</span>
      <span class="sim-log-detail">${detail}</span>
    `;

    const log = this.refs.log;
    if (log) {
      log.appendChild(entry);
      // Keep last 50 entries
      while (log.children.length > 50) log.removeChild(log.firstChild);
      log.scrollTop = log.scrollHeight;
    }
  }

  _resetControls() {
    this.refs.startBtn.disabled = !this.routeCoords;
    this.refs.stopBtn.disabled = true;
    this.refs.routeSelect.disabled = false;
    this.status = "idle";
  }

  // =========================================================================
  // Cleanup
  // =========================================================================

  destroy() {
    if (this.intervalId) clearInterval(this.intervalId);
    if (this.picker) this.picker.cancel();
    if (this.panel) this.panel.remove();
    this.panel = null;
  }
}
