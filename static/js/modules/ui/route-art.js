/**
 * Route Art Module
 *
 * Renders all trip routes as abstract art on a dark background.
 * Strips map tiles, shows only route lines with glow effects.
 * Supports coloring by time-of-day, speed, recency, or frequency.
 * Exportable as high-res PNG.
 */

const ROUTE_ART_OVERLAY_ID = "route-art-overlay";

class RouteArt {
  constructor() {
    this._active = false;
    this._mode = "glow"; // glow | time | speed | recency
    this._container = null;
    this._canvas = null;
    this._keyHandler = null;
    this._closeTimer = null;
    this._destroyed = false;
  }

  isActive() {
    return this._active;
  }

  _emit(eventName, detail = null) {
    if (
      typeof document?.dispatchEvent === "function" &&
      typeof CustomEvent === "function"
    ) {
      document.dispatchEvent(new CustomEvent(eventName, { detail }));
    }
  }

  /**
   * Launch route art mode.
   * @param {Object} options
   * @param {Array} options.trips - Array of trip GeoJSON features
   * @param {Object} options.bounds - { sw: [lng,lat], ne: [lng,lat] }
   * @param {Function} options.onClose - Callback when closed
   */
  launch(options = {}) {
    const { trips = [], bounds = null, onClose = null } = options;
    if (!trips.length) return;

    if (this._closeTimer) {
      clearTimeout(this._closeTimer);
      this._closeTimer = null;
    }

    this._active = true;
    this._onClose = onClose;
    this._trips = trips;
    this._bounds = bounds || this._computeBounds(trips);

    this._createOverlay();
    this._render();
    this._emit("routeArt:activated", { mode: this._mode });
  }

  close(options = {}) {
    const { immediate = false } = options;
    const wasActive = this._active;

    this._active = false;
    if (this._keyHandler) {
      document.removeEventListener("keydown", this._keyHandler);
      this._keyHandler = null;
    }
    const closingContainer = this._container;
    if (this._closeTimer) {
      clearTimeout(this._closeTimer);
      this._closeTimer = null;
    }
    if (closingContainer?.parentNode && !immediate) {
      closingContainer.classList.add("route-art-exit");
      this._closeTimer = setTimeout(() => {
        closingContainer.remove();
        if (this._container === closingContainer) {
          this._container = null;
          this._canvas = null;
        }
        this._closeTimer = null;
      }, 300);
    } else if (closingContainer?.parentNode) {
      closingContainer.remove();
      if (this._container === closingContainer) {
        this._container = null;
        this._canvas = null;
      }
    } else if (this._container === closingContainer) {
      this._container = null;
      this._canvas = null;
    }
    const onClose = this._onClose;
    this._onClose = null;
    onClose?.();
    if (wasActive) {
      this._emit("routeArt:deactivated");
    }
  }

  setMode(mode) {
    this._mode = mode;
    this._render();
    // Update active button
    this._container?.querySelectorAll(".route-art-mode-btn").forEach((btn) => {
      btn.classList.toggle("active", btn.dataset.mode === mode);
    });
  }

  async exportImage(filename = "route-art.png") {
    if (!this._canvas) return;
    return new Promise((resolve) => {
      this._canvas.toBlob((blob) => {
        if (!blob) { resolve(); return; }
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url;
        a.download = filename;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
        resolve();
      }, "image/png", 1.0);
    });
  }

  _createOverlay() {
    if (this._closeTimer) {
      clearTimeout(this._closeTimer);
      this._closeTimer = null;
    }
    if (this._container) this._container.remove();
    if (this._keyHandler) {
      document.removeEventListener("keydown", this._keyHandler);
      this._keyHandler = null;
    }

    const el = document.createElement("div");
    el.id = ROUTE_ART_OVERLAY_ID;
    el.className = "route-art-overlay";
    el.innerHTML = `
      <div class="route-art-toolbar">
        <div class="route-art-modes">
          <button class="route-art-mode-btn active" data-mode="glow" type="button">Glow</button>
          <button class="route-art-mode-btn" data-mode="time" type="button">Time</button>
          <button class="route-art-mode-btn" data-mode="speed" type="button">Speed</button>
          <button class="route-art-mode-btn" data-mode="recency" type="button">Recency</button>
        </div>
        <div class="route-art-actions">
          <button class="route-art-export-btn" type="button" aria-label="Download image">
            <i class="fas fa-download"></i> Export
          </button>
          <button class="route-art-close-btn" type="button" aria-label="Close route art">
            <i class="fas fa-times"></i>
          </button>
        </div>
      </div>
      <canvas class="route-art-canvas"></canvas>
    `;

    // Bind events
    el.querySelector(".route-art-close-btn")?.addEventListener("click", () => this.close());
    el.querySelector(".route-art-export-btn")?.addEventListener("click", () => this.exportImage());
    el.querySelectorAll(".route-art-mode-btn").forEach((btn) => {
      btn.addEventListener("click", () => this.setMode(btn.dataset.mode));
    });

    this._keyHandler = (e) => {
      if (e.key === "Escape" && this._active) this.close();
    };
    document.addEventListener("keydown", this._keyHandler);

    document.body.appendChild(el);
    this._container = el;
    this._canvas = el.querySelector("canvas");

    requestAnimationFrame(() => el.classList.add("route-art-enter"));
  }

  _render() {
    if (!this._canvas || !this._trips.length) return;

    const dpr = window.devicePixelRatio || 1;
    const w = window.innerWidth;
    const h = window.innerHeight;
    this._canvas.width = w * dpr;
    this._canvas.height = h * dpr;
    this._canvas.style.width = `${w}px`;
    this._canvas.style.height = `${h}px`;

    const ctx = this._canvas.getContext("2d");
    ctx.scale(dpr, dpr);

    // Dark background
    ctx.fillStyle = "#060608";
    ctx.fillRect(0, 0, w, h);

    const bounds = this._bounds;
    const padding = 60;
    const project = this._createProjection(bounds, w, h, padding);

    // Sort trips by date for recency coloring
    const trips = [...this._trips].sort((a, b) => {
      const da = a.properties?.startTime || a.properties?.start_time || "";
      const db = b.properties?.startTime || b.properties?.start_time || "";
      return da.localeCompare(db);
    });

    // Draw each trip
    trips.forEach((trip, index) => {
      const coords = this._getCoordinates(trip);
      if (coords.length < 2) return;

      ctx.beginPath();
      const startPt = project(coords[0]);
      ctx.moveTo(startPt[0], startPt[1]);

      for (let i = 1; i < coords.length; i++) {
        const pt = project(coords[i]);
        ctx.lineTo(pt[0], pt[1]);
      }

      const color = this._getColor(trip, index, trips.length);
      ctx.strokeStyle = color;
      ctx.lineWidth = 1.2;
      ctx.globalAlpha = 0.3;
      ctx.lineCap = "round";
      ctx.lineJoin = "round";
      ctx.stroke();

      // Glow pass
      if (this._mode === "glow") {
        ctx.strokeStyle = color;
        ctx.lineWidth = 3;
        ctx.globalAlpha = 0.08;
        ctx.filter = "blur(3px)";
        ctx.stroke();
        ctx.filter = "none";
      }
    });

    ctx.globalAlpha = 1;

    // Watermark
    ctx.font = "14px 'IBM Plex Sans', sans-serif";
    ctx.fillStyle = "rgba(255,255,255,0.15)";
    ctx.textAlign = "right";
    ctx.fillText("everystreet.me", w - 20, h - 20);
  }

  _getColor(trip, index, total) {
    switch (this._mode) {
      case "time": {
        const hour = this._getTripHour(trip);
        // Warm colors for day, cool for night
        if (hour >= 6 && hour < 10) return "#f0b840"; // morning gold
        if (hour >= 10 && hour < 14) return "#d09868"; // midday copper
        if (hour >= 14 && hour < 18) return "#c45454"; // afternoon rose
        if (hour >= 18 && hour < 22) return "#6a4fad"; // evening purple
        return "#3b8a7f"; // night teal
      }
      case "speed": {
        const speed = trip.properties?.maxSpeed || trip.properties?.max_speed || 30;
        if (speed < 25) return "#4d9a6a";
        if (speed < 45) return "#d4a24a";
        if (speed < 65) return "#d09868";
        return "#c45454";
      }
      case "recency": {
        const ratio = total > 1 ? index / (total - 1) : 1;
        // Fade from dim past to bright present
        const r = Math.round(59 + ratio * (208 - 59));
        const g = Math.round(138 + ratio * (152 - 138));
        const b = Math.round(127 + ratio * (104 - 127));
        return `rgb(${r},${g},${b})`;
      }
      default: // glow
        return "#f0b840";
    }
  }

  _getTripHour(trip) {
    const time = trip.properties?.startTime || trip.properties?.start_time;
    if (!time) return 12;
    const d = new Date(time);
    return Number.isNaN(d.getTime()) ? 12 : d.getHours();
  }

  _getCoordinates(trip) {
    const geom = trip.geometry;
    if (!geom) return [];
    if (geom.type === "LineString") return geom.coordinates;
    if (geom.type === "MultiLineString") return geom.coordinates.flat();
    return [];
  }

  _computeBounds(trips) {
    let minLng = Infinity, minLat = Infinity, maxLng = -Infinity, maxLat = -Infinity;
    for (const trip of trips) {
      for (const coord of this._getCoordinates(trip)) {
        minLng = Math.min(minLng, coord[0]);
        minLat = Math.min(minLat, coord[1]);
        maxLng = Math.max(maxLng, coord[0]);
        maxLat = Math.max(maxLat, coord[1]);
      }
    }
    return { sw: [minLng, minLat], ne: [maxLng, maxLat] };
  }

  _createProjection(bounds, w, h, padding) {
    const sw = bounds.sw;
    const ne = bounds.ne;
    const lngRange = ne[0] - sw[0] || 0.01;
    const latRange = ne[1] - sw[1] || 0.01;
    const drawW = w - padding * 2;
    const drawH = h - padding * 2;
    const scale = Math.min(drawW / lngRange, drawH / latRange);

    return (coord) => {
      const x = padding + (coord[0] - sw[0]) * scale;
      const y = padding + (ne[1] - coord[1]) * scale; // Flip Y
      return [x, y];
    };
  }
}

const routeArt = new RouteArt();
export { RouteArt };
export default routeArt;
