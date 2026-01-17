/* global DateUtils */

(() => {
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

      if (window.metricAnimator?.animateById) {
        window.metricAnimator.animateById(elementId, targetValue, {
          decimals: 0,
          duration: duration / 1000,
        });
        return;
      }

      const startValue = parseInt(element.textContent, 10) || 0;
      const increment = (targetValue - startValue) / (duration / 16);
      let currentValue = startValue;

      const animate = () => {
        currentValue += increment;
        if (
          (increment > 0 && currentValue >= targetValue)
          || (increment < 0 && currentValue <= targetValue)
        ) {
          element.textContent = Math.round(targetValue);
        } else {
          element.textContent = Math.round(currentValue);
          requestAnimationFrame(animate);
        }
      };

      requestAnimationFrame(animate);
    }

    async updateMonthlyVisits() {
      try {
        const stats = await window.VisitsDataService.fetchPlaceStatistics({
          timeframe: "month",
        });
        const monthlyVisits = stats.reduce(
          (sum, p) => sum + (p.monthlyVisits || p.totalVisits || 0),
          0
        );
        this.animateCounter("month-visits-stat", monthlyVisits);
      } catch (error) {
        console.error("Error updating monthly visits:", error);
      }
    }

    updateStatsCounts(placesCount, totalVisits) {
      document.getElementById("total-places-count").textContent = placesCount;
      document.getElementById("active-places-stat").textContent = placesCount;

      if (totalVisits !== undefined && totalVisits !== null) {
        this.animateCounter("total-visits-count", totalVisits);
      }
    }

    updateInsights(stats) {
      if (!stats || stats.length === 0) {
        document.getElementById("most-visited-place").textContent = "-";
        document.getElementById("avg-visit-duration").textContent = "-";
        document.getElementById("visit-frequency").textContent = "-";
        return;
      }

      const mostVisited = stats.reduce((max, place) =>
        place.totalVisits > max.totalVisits ? place : max
      );
      document.getElementById("most-visited-place").textContent
        = `${mostVisited.name} (${mostVisited.totalVisits} visits)`;

      const avgDurations = stats
        .filter((s) => s.averageTimeSpent && s.averageTimeSpent !== "N/A")
        .map((s) => DateUtils.convertDurationToSeconds(s.averageTimeSpent));

      if (avgDurations.length > 0) {
        const overallAvg
          = avgDurations.reduce((a, b) => a + b, 0) / avgDurations.length;
        const formatted = DateUtils.formatDuration(overallAvg * 1000);
        document.getElementById("avg-visit-duration").textContent = formatted;
      }

      const totalVisits = stats.reduce((sum, place) => sum + place.totalVisits, 0);

      const validFirstVisits = stats
        .filter((s) => s.firstVisit)
        .map((s) => new Date(s.firstVisit));

      let firstVisitDate;
      if (validFirstVisits.length > 0) {
        firstVisitDate = validFirstVisits.reduce((min, date) =>
          date < min ? date : min
        );
      } else {
        firstVisitDate = new Date();
      }

      const weeksSinceFirst = (Date.now() - firstVisitDate) / (1000 * 60 * 60 * 24 * 7);
      const visitsPerWeek = (totalVisits / Math.max(weeksSinceFirst, 1)).toFixed(1);
      document.getElementById("visit-frequency").textContent
        = `${visitsPerWeek} visits/week`;
    }

    destroy() {
      if (this.statsUpdateTimer) {
        clearInterval(this.statsUpdateTimer);
      }
    }
  }

  window.VisitsStatsManager = VisitsStatsManager;
})();
