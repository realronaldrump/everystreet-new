/**
 * Celebration Module
 *
 * Provides tasteful celebration overlays for milestones and records.
 * Uses lightweight canvas-based confetti and animated badge pop-ins.
 */

const CELEBRATION_CONTAINER_ID = "celebration-overlay";
const CONFETTI_DURATION = 2500;
const BADGE_DURATION = 4000;
const PARTICLE_COUNT = 80;

const COLORS = [
  "#3b8a7f", // sage teal
  "#d09868", // copper
  "#4d9a6a", // forest
  "#d4a24a", // honey
  "#6a9fc0", // steel blue
  "#b87a4a", // warm accent
];

class CelebrationManager {
  constructor() {
    this._canvas = null;
    this._ctx = null;
    this._particles = [];
    this._animFrameId = null;
    this._badgeTimeout = null;
  }

  /**
   * Show a confetti burst with an achievement badge.
   * @param {Object} options
   * @param {string} options.title - Achievement title
   * @param {string} options.value - Achievement value
   * @param {string} options.subtitle - Optional subtitle
   * @param {string} options.icon - Font Awesome icon class (e.g., "fa-trophy")
   * @param {string} options.accent - Accent color
   */
  celebrate({ title, value, subtitle = "", icon = "fa-star", accent = "#d4a24a" } = {}) {
    if (window.matchMedia?.("(prefers-reduced-motion: reduce)")?.matches) {
      // Still show badge but skip confetti
      this._showBadge({ title, value, subtitle, icon, accent });
      return;
    }

    this._showConfetti();
    this._showBadge({ title, value, subtitle, icon, accent });
  }

  /**
   * Show a quick record-breaking notification.
   * @param {string} recordType - Type of record
   * @param {string} newValue - New record value
   * @param {string} previousValue - Previous record value
   */
  celebrateRecord(recordType, newValue, previousValue) {
    this.celebrate({
      title: "New Personal Record!",
      value: newValue,
      subtitle: `${recordType} · was ${previousValue}`,
      icon: "fa-trophy",
      accent: "#d4a24a",
    });
  }

  /**
   * Show a coverage milestone celebration.
   * @param {number} percent - Coverage percentage reached
   */
  celebrateCoverageMilestone(percent) {
    const milestones = {
      25: { icon: "fa-seedling", title: "25% Complete!", subtitle: "Great start — keep exploring" },
      50: { icon: "fa-bolt", title: "Halfway There!", subtitle: "The city is opening up" },
      75: { icon: "fa-fire", title: "75% Done!", subtitle: "The finish line is in sight" },
      100: { icon: "fa-trophy", title: "Every Street!", subtitle: "You've covered it all" },
    };

    const milestone = milestones[percent];
    if (!milestone) return;

    this.celebrate({
      title: milestone.title,
      value: `${percent}%`,
      subtitle: milestone.subtitle,
      icon: milestone.icon,
      accent: percent === 100 ? "#d4a24a" : "#4d9a6a",
    });
  }

  // --- Confetti ---

  _showConfetti() {
    this._cleanupConfetti();

    const canvas = document.createElement("canvas");
    canvas.className = "celebration-canvas";
    canvas.style.cssText = `
      position: fixed; top: 0; left: 0; width: 100vw; height: 100vh;
      pointer-events: none; z-index: 10001;
    `;
    canvas.width = window.innerWidth;
    canvas.height = window.innerHeight;
    document.body.appendChild(canvas);
    this._canvas = canvas;
    this._ctx = canvas.getContext("2d");

    // Create particles from top center
    this._particles = [];
    const cx = canvas.width / 2;
    for (let i = 0; i < PARTICLE_COUNT; i++) {
      this._particles.push({
        x: cx + (Math.random() - 0.5) * canvas.width * 0.6,
        y: -10 - Math.random() * 40,
        vx: (Math.random() - 0.5) * 6,
        vy: Math.random() * 3 + 2,
        size: Math.random() * 6 + 3,
        color: COLORS[Math.floor(Math.random() * COLORS.length)],
        rotation: Math.random() * 360,
        rotationSpeed: (Math.random() - 0.5) * 10,
        gravity: 0.08 + Math.random() * 0.04,
        drag: 0.98 + Math.random() * 0.015,
        opacity: 1,
        shape: Math.random() > 0.5 ? "rect" : "circle",
      });
    }

    const startTime = performance.now();

    const animate = (now) => {
      const elapsed = now - startTime;
      const fadeStart = CONFETTI_DURATION * 0.6;

      this._ctx.clearRect(0, 0, canvas.width, canvas.height);

      for (const p of this._particles) {
        p.vy += p.gravity;
        p.vx *= p.drag;
        p.x += p.vx;
        p.y += p.vy;
        p.rotation += p.rotationSpeed;

        if (elapsed > fadeStart) {
          p.opacity = Math.max(0, 1 - (elapsed - fadeStart) / (CONFETTI_DURATION - fadeStart));
        }

        this._ctx.save();
        this._ctx.globalAlpha = p.opacity;
        this._ctx.translate(p.x, p.y);
        this._ctx.rotate((p.rotation * Math.PI) / 180);

        if (p.shape === "rect") {
          this._ctx.fillStyle = p.color;
          this._ctx.fillRect(-p.size / 2, -p.size / 2, p.size, p.size * 0.6);
        } else {
          this._ctx.beginPath();
          this._ctx.arc(0, 0, p.size / 2, 0, Math.PI * 2);
          this._ctx.fillStyle = p.color;
          this._ctx.fill();
        }
        this._ctx.restore();
      }

      if (elapsed < CONFETTI_DURATION) {
        this._animFrameId = requestAnimationFrame(animate);
      } else {
        this._cleanupConfetti();
      }
    };

    this._animFrameId = requestAnimationFrame(animate);
  }

  _cleanupConfetti() {
    if (this._animFrameId) {
      cancelAnimationFrame(this._animFrameId);
      this._animFrameId = null;
    }
    if (this._canvas?.parentNode) {
      this._canvas.parentNode.removeChild(this._canvas);
    }
    this._canvas = null;
    this._ctx = null;
    this._particles = [];
  }

  // --- Badge Overlay ---

  _showBadge({ title, value, subtitle, icon, accent }) {
    // Remove existing badge
    const existing = document.getElementById(CELEBRATION_CONTAINER_ID);
    if (existing) existing.remove();
    if (this._badgeTimeout) clearTimeout(this._badgeTimeout);

    const badge = document.createElement("div");
    badge.id = CELEBRATION_CONTAINER_ID;
    badge.className = "celebration-badge";
    badge.setAttribute("role", "status");
    badge.setAttribute("aria-live", "polite");
    badge.innerHTML = `
      <div class="celebration-badge-inner" style="--celebration-accent: ${accent}">
        <div class="celebration-icon">
          <i class="fas ${icon}"></i>
        </div>
        <div class="celebration-content">
          <div class="celebration-title">${this._escapeHtml(title)}</div>
          <div class="celebration-value">${this._escapeHtml(value)}</div>
          ${subtitle ? `<div class="celebration-subtitle">${this._escapeHtml(subtitle)}</div>` : ""}
        </div>
      </div>
    `;

    document.body.appendChild(badge);

    const dismissBadge = () => {
      if (!badge.parentNode) {
        return;
      }
      badge.classList.remove("entering");
      badge.classList.add("exiting");
      setTimeout(() => badge.remove(), 400);
    };

    // Trigger entrance animation
    requestAnimationFrame(() => {
      badge.classList.add("entering");
    });

    // Auto-dismiss
    this._badgeTimeout = setTimeout(() => {
      dismissBadge();
    }, BADGE_DURATION);

    // Click to dismiss
    badge.addEventListener("click", () => {
      if (this._badgeTimeout) clearTimeout(this._badgeTimeout);
      dismissBadge();
    });
  }

  _escapeHtml(str) {
    const div = document.createElement("div");
    div.textContent = str;
    return div.innerHTML;
  }
}

const celebrationManager = new CelebrationManager();
export { CelebrationManager };
export default celebrationManager;
