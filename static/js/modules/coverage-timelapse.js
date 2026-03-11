/**
 * Coverage Timelapse Module
 *
 * Animates coverage streets being "painted" over time using first_driven_at timestamps.
 * A slider scrubs through trip dates, and segments progressively turn green.
 */

const TIMELAPSE_CONTROLS_ID = "coverage-timelapse-controls";

class CoverageTimelapse {
  constructor() {
    this._playing = false;
    this._frameId = null;
    this._segments = [];
    this._totalSegments = 0;
    this._dateRange = { min: null, max: null };
    this._currentDate = null;
    this._speed = 1;
    this._map = null;
    this._onUpdate = null;
    this._onClose = null;
    this._controlsEl = null;
    this._destroyed = false;
  }

  /**
   * Initialize timelapse with coverage segment data.
   * @param {Object} map - Mapbox GL map instance
   * @param {Object} geojson - GeoJSON FeatureCollection with street segments
   * @param {Object} options - Configuration options
   */
  initialize(map, geojson, options = {}) {
    if (!map || !geojson?.features?.length) return;

    this.pause();
    if (this._controlsEl?.parentNode) {
      this._controlsEl.remove();
    }

    this._destroyed = false;
    this._map = map;
    this._onUpdate = options.onUpdate || null;
    this._onClose = options.onClose || null;

    this._totalSegments = geojson.features.filter(
      (feature) => feature?.properties?.status !== "undriveable"
    ).length;

    // Extract segments with first-driven dates
    this._segments = geojson.features
      .filter((f) => f.properties?.first_driven_at)
      .map((f) => ({
        id: f.id || f.properties?.segment_id,
        firstDriven: new Date(f.properties.first_driven_at).getTime(),
        properties: f.properties,
      }))
      .filter((segment) => Number.isFinite(segment.firstDriven))
      .sort((a, b) => a.firstDriven - b.firstDriven);

    if (this._segments.length === 0) return;
    if (this._totalSegments <= 0) {
      this._totalSegments = this._segments.length;
    }

    this._dateRange = {
      min: this._segments[0].firstDriven,
      max: this._segments[this._segments.length - 1].firstDriven,
    };
    this._currentDate = this._dateRange.min;

    this._createControls();
    this._updateDisplay();
  }

  /** Start playback */
  play() {
    if (this._playing || this._destroyed) return;
    this._playing = true;
    this._updatePlayButton();
    const startTime = performance.now();
    const startDate = this._currentDate;
    const totalRange = Math.max(this._dateRange.max - this._dateRange.min, 1);
    const remainingRange = Math.max(this._dateRange.max - startDate, 0);
    // Total animation duration: ~15 seconds at 1x speed
    const baseDuration = 15000 / this._speed;
    const duration = Math.max(baseDuration * (remainingRange / totalRange), 500);

    const animate = (now) => {
      if (!this._playing || this._destroyed) return;
      const elapsed = now - startTime;
      const progress = Math.min(elapsed / duration, 1);
      const eased = 1 - (1 - progress) ** 2; // ease-out quad
      this._currentDate = startDate + eased * remainingRange;
      this._updateDisplay();
      this._updateSlider();

      if (progress < 1) {
        this._frameId = requestAnimationFrame(animate);
      } else {
        this._playing = false;
        this._updatePlayButton();
      }
    };

    this._frameId = requestAnimationFrame(animate);
  }

  /** Pause playback */
  pause() {
    this._playing = false;
    if (this._frameId) {
      cancelAnimationFrame(this._frameId);
      this._frameId = null;
    }
    this._updatePlayButton();
  }

  /** Toggle play/pause */
  toggle() {
    if (this._playing) this.pause();
    else this.play();
  }

  /** Reset to start */
  reset() {
    this.pause();
    this._currentDate = this._dateRange.min;
    this._updateDisplay();
    this._updateSlider();
  }

  /** Set playback speed */
  setSpeed(speed) {
    const wasPlaying = this._playing;
    if (wasPlaying) this.pause();
    this._speed = speed;
    if (this._controlsEl) {
      const speedLabel = this._controlsEl.querySelector(".timelapse-speed-label");
      if (speedLabel) speedLabel.textContent = `${speed}x`;
    }
    if (wasPlaying) this.play();
  }

  /** Seek to a specific progress (0-1) */
  seek(ratio) {
    const totalRange = this._dateRange.max - this._dateRange.min;
    this._currentDate = this._dateRange.min + ratio * totalRange;
    this._updateDisplay();
  }

  /** Clean up */
  destroy({ notify = true } = {}) {
    this._destroyed = true;
    this.pause();
    if (this._controlsEl?.parentNode) {
      this._controlsEl.parentNode.removeChild(this._controlsEl);
    }
    this._controlsEl = null;
    this._segments = [];
    this._totalSegments = 0;
    this._dateRange = { min: null, max: null };
    this._currentDate = null;
    this._map = null;
    const onClose = this._onClose;
    this._onClose = null;
    this._onUpdate = null;
    if (notify) {
      onClose?.();
    }
  }

  get isPlaying() {
    return this._playing;
  }

  // --- Private ---

  _updateDisplay() {
    const currentTs = this._currentDate;
    const drivenCount = this._segments.filter((s) => s.firstDriven <= currentTs).length;
    const totalCount = this._totalSegments > 0 ? this._totalSegments : this._segments.length;
    const percent = totalCount > 0 ? (drivenCount / totalCount) * 100 : 0;

    // Update date label
    const dateLabel = this._controlsEl?.querySelector(".timelapse-date");
    if (dateLabel) {
      dateLabel.textContent = new Date(currentTs).toLocaleDateString("en-US", {
        month: "short",
        day: "numeric",
        year: "numeric",
      });
    }

    // Update stats
    const statsLabel = this._controlsEl?.querySelector(".timelapse-stats");
    if (statsLabel) {
      statsLabel.textContent = `${drivenCount} / ${totalCount} streets (${percent.toFixed(1)}%)`;
    }

    // Update progress bar
    const progressBar = this._controlsEl?.querySelector(".timelapse-progress-fill");
    if (progressBar) {
      progressBar.style.width = `${percent}%`;
    }

    // Notify parent to update map filtering
    this._onUpdate?.({
      currentDate: currentTs,
      drivenCount,
      totalCount,
      percent,
    });
  }

  _updateSlider() {
    const slider = this._controlsEl?.querySelector(".timelapse-slider");
    if (!slider) return;
    const totalRange = this._dateRange.max - this._dateRange.min;
    const progress = totalRange > 0
      ? (this._currentDate - this._dateRange.min) / totalRange
      : 0;
    slider.value = (progress * 1000).toFixed(0);
  }

  _updatePlayButton() {
    const btn = this._controlsEl?.querySelector(".timelapse-play-btn");
    if (!btn) return;
    btn.innerHTML = this._playing
      ? '<i class="fas fa-pause"></i>'
      : '<i class="fas fa-play"></i>';
    btn.setAttribute("aria-label", this._playing ? "Pause timelapse" : "Play timelapse");
  }

  _createControls() {
    // Remove existing
    const existing = document.getElementById(TIMELAPSE_CONTROLS_ID);
    if (existing) existing.remove();

    const el = document.createElement("div");
    el.id = TIMELAPSE_CONTROLS_ID;
    el.className = "timelapse-controls";
    el.innerHTML = `
      <div class="timelapse-header">
        <span class="timelapse-title"><i class="fas fa-clock-rotate-left"></i> Coverage Timelapse</span>
        <button class="timelapse-close-btn" aria-label="Close timelapse" type="button">
          <i class="fas fa-times"></i>
        </button>
      </div>
      <div class="timelapse-body">
        <div class="timelapse-date-row">
          <span class="timelapse-date">--</span>
          <span class="timelapse-stats">-- / -- streets</span>
        </div>
        <div class="timelapse-progress">
          <div class="timelapse-progress-fill"></div>
        </div>
        <input type="range" class="timelapse-slider" min="0" max="1000" value="0" aria-label="Timelapse position" />
        <div class="timelapse-buttons">
          <button class="timelapse-play-btn" type="button" aria-label="Play timelapse">
            <i class="fas fa-play"></i>
          </button>
          <button class="timelapse-reset-btn" type="button" aria-label="Reset timelapse">
            <i class="fas fa-backward-step"></i>
          </button>
          <div class="timelapse-speed-group">
            <button class="timelapse-speed-btn" data-speed="0.5" type="button">0.5x</button>
            <button class="timelapse-speed-btn active" data-speed="1" type="button">1x</button>
            <button class="timelapse-speed-btn" data-speed="2" type="button">2x</button>
            <button class="timelapse-speed-btn" data-speed="5" type="button">5x</button>
          </div>
          <span class="timelapse-speed-label">1x</span>
        </div>
      </div>
    `;

    // Bind events
    el.querySelector(".timelapse-play-btn")?.addEventListener("click", () => this.toggle());
    el.querySelector(".timelapse-reset-btn")?.addEventListener("click", () => this.reset());
    el.querySelector(".timelapse-close-btn")?.addEventListener("click", () => this.destroy());

    const slider = el.querySelector(".timelapse-slider");
    slider?.addEventListener("input", (e) => {
      this.pause();
      this.seek(Number(e.target.value) / 1000);
    });

    el.querySelectorAll(".timelapse-speed-btn").forEach((btn) => {
      btn.addEventListener("click", () => {
        el.querySelectorAll(".timelapse-speed-btn").forEach((b) => b.classList.remove("active"));
        btn.classList.add("active");
        this.setSpeed(Number(btn.dataset.speed));
      });
    });

    // Insert into DOM (prefer map container, fallback to main content)
    const mapContainer = document.getElementById("map-canvas") || document.getElementById("map");
    const parent = mapContainer || document.getElementById("main-content");
    if (parent) {
      parent.style.position = parent.style.position || "relative";
      parent.appendChild(el);
    }

    this._controlsEl = el;
  }
}

const coverageTimelapse = new CoverageTimelapse();
export { CoverageTimelapse };
export default coverageTimelapse;
