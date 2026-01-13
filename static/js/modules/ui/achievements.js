const STORAGE_KEYS = {
  coverage: "es:coverage-milestones",
  records: "es:record-metrics",
};

const MILESTONES = [25, 50, 75, 100];

const achievements = {
  observers: new Map(),
  confettiLayer: null,
  initialized: false,

  init() {
    if (this.initialized) {
      return;
    }
    this.observeCoverage();
    document.addEventListener("es:page-load", () => this.observeCoverage());
    document.addEventListener("achievements:update", (event) => {
      this.handleUpdate(event.detail || {});
    });
    this.initialized = true;
  },

  handleUpdate({ coveragePercent, streakDays, recordDistance }) {
    if (Number.isFinite(coveragePercent)) {
      this.checkCoverageMilestones(coveragePercent);
    }
    if (Number.isFinite(streakDays)) {
      this.checkStreak(streakDays);
    }
    if (Number.isFinite(recordDistance)) {
      this.checkRecordDistance(recordDistance);
    }
  },

  observeCoverage() {
    const elements = document.querySelectorAll("[data-coverage-percent]");
    elements.forEach((element) => {
      if (this.observers.has(element)) {
        return;
      }
      const observer = new MutationObserver(() => {
        const percent = this.parsePercent(element.textContent || "");
        if (Number.isFinite(percent)) {
          this.checkCoverageMilestones(percent);
        }
      });
      observer.observe(element, { childList: true, characterData: true, subtree: true });
      this.observers.set(element, observer);

      const initial = this.parsePercent(element.textContent || "");
      if (Number.isFinite(initial)) {
        this.checkCoverageMilestones(initial);
      }
    });
  },

  checkCoverageMilestones(percent) {
    const state = this.getStored(STORAGE_KEYS.coverage, {});
    const key = this.getCoverageKey();
    if (!state[key]) {
      state[key] = {};
    }

    const reached = MILESTONES.filter(
      (milestone) => percent >= milestone && !state[key][milestone]
    );
    if (reached.length === 0) {
      return;
    }
    const milestone = reached[reached.length - 1];
    state[key][milestone] = true;
    this.setStored(STORAGE_KEYS.coverage, state);
    this.fireCelebration(`Coverage milestone unlocked: ${milestone}%`);
  },

  checkStreak(days) {
    if (days < 2) {
      return;
    }
    const state = this.getStored(STORAGE_KEYS.records, {});
    const best = Number(state.bestStreak || 0);
    if (days > best) {
      state.bestStreak = days;
      this.setStored(STORAGE_KEYS.records, state);
      this.fireCelebration(`New driving streak: ${days} days`);
    }
  },

  checkRecordDistance(distance) {
    const state = this.getStored(STORAGE_KEYS.records, {});
    const best = Number(state.longestTrip || 0);
    if (distance > best) {
      state.longestTrip = distance;
      this.setStored(STORAGE_KEYS.records, state);
      this.fireCelebration("New personal record distance");
    }
  },

  fireCelebration(message) {
    window.notificationManager?.show(message, "success");
  },

  spawnConfetti() {
    if (!this.confettiLayer) {
      this.confettiLayer = document.createElement("div");
      this.confettiLayer.className = "confetti-layer";
      document.body.appendChild(this.confettiLayer);
    }

    const colors = ["#f4d35e", "#ee964b", "#f95738", "#5cb1b1", "#7c9d96"];
    const count = 26;

    for (let i = 0; i < count; i += 1) {
      const piece = document.createElement("span");
      piece.className = "confetti-piece";
      const color = colors[i % colors.length];
      const size = Math.floor(Math.random() * 6) + 6;
      const left = Math.random() * 100;
      const drift = (Math.random() * 2 - 1) * 60;
      const rotation = Math.random() * 360;
      const duration = 1.6 + Math.random() * 0.8;
      const delay = Math.random() * 0.2;

      piece.style.backgroundColor = color;
      piece.style.width = `${size}px`;
      piece.style.height = `${size + 4}px`;
      piece.style.left = `${left}%`;
      piece.style.setProperty("--confetti-drift", `${drift}px`);
      piece.style.setProperty("--confetti-rotate", `${rotation}deg`);
      piece.style.animationDuration = `${duration}s`;
      piece.style.animationDelay = `${delay}s`;

      this.confettiLayer.appendChild(piece);
      setTimeout(() => piece.remove(), (duration + delay) * 1000);
    }
  },

  parsePercent(value) {
    if (!value) {
      return Number.NaN;
    }
    const normalized = value.toString().replace(/[^0-9.]/g, "");
    return Number.parseFloat(normalized);
  },

  getCoverageKey() {
    return document.body?.dataset.route || window.location.pathname || "default";
  },

  getStored(key, fallback) {
    try {
      const raw = localStorage.getItem(key);
      if (!raw) {
        return fallback;
      }
      return JSON.parse(raw);
    } catch {
      return fallback;
    }
  },

  setStored(key, value) {
    try {
      localStorage.setItem(key, JSON.stringify(value));
    } catch {
      // Ignore storage failures.
    }
  },
};

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", () => achievements.init());
} else {
  achievements.init();
}

export default achievements;
