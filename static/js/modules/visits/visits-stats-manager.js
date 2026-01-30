import metricAnimator from "../ui/metric-animator.js";
import { DateUtils } from "../utils.js";
import VisitsDataService from "./data-service.js";

class VisitsStatsManager {
  constructor() {
    this.statsUpdateTimer = null;
  }

  startStatsAnimation(placesCount, updateCallback) {
    this.animateCounter("total-places-count", placesCount, 1000);
    this.updateMonthlyVisits();

    // Initial update
    if (updateCallback) {
      updateCallback();
    }

    this.statsUpdateTimer = setInterval(() => {
      if (updateCallback) {
        updateCallback();
      }
    }, 30000);
  }

  animateCounter(elementId, targetValue, duration = 1000) {
    const element = document.getElementById(elementId);
    if (!element) {
      return;
    }

    metricAnimator.animate(element, targetValue, {
      decimals: 0,
      duration: duration / 1000,
    });
  }

  async updateMonthlyVisits() {
    try {
      const stats = await VisitsDataService.fetchPlaceStatistics({
        timeframe: "month",
      });
      const monthlyVisits = stats.reduce(
        (sum, p) => sum + (p.monthlyVisits || p.totalVisits || 0),
        0
      );
      this.animateCounter("month-visits-count", monthlyVisits);
    } catch (error) {
      console.error("Error updating monthly visits:", error);
    }
  }

  updateStatsCounts(placesCount, totalVisits) {
    this.animateCounter("total-places-count", placesCount);

    if (totalVisits !== undefined && totalVisits !== null) {
      this.animateCounter("total-visits-count", totalVisits);
    }
  }

  updateInsights(stats) {
    // These insights are now displayed in the new design via VisitsPageController
    // Keeping this method for backward compatibility
    if (!stats || stats.length === 0) {
      return;
    }

    // Most visited place, avg duration, and visit frequency are calculated in visits-new.js
    // and displayed in the hero section, patterns section, and place detail modals
  }

  destroy() {
    if (this.statsUpdateTimer) {
      clearInterval(this.statsUpdateTimer);
    }
  }
}

export { VisitsStatsManager };
export default VisitsStatsManager;
