/**
 * Landing Page Controller
 * Fetches live data and animates the landing page
 */

(() => {
  // Configuration
  const CONFIG = {
    refreshInterval: 60000, // 1 minute
    animationDuration: 500,
    activityLimit: 5,
  };

  // DOM Elements (cached after DOMContentLoaded)
  let elements = {};

  /**
   * Initialize the landing page
   */
  function init() {
    cacheElements();
    loadAllData();
    setupRefreshInterval();
    checkLiveTracking();
  }

  /**
   * Cache DOM elements for performance
   */
  function cacheElements() {
    elements = {
      statMiles: document.getElementById("stat-miles"),
      statTrips: document.getElementById("stat-trips"),
      liveIndicator: document.getElementById("live-indicator"),
      recentTrip: document.getElementById("recent-trip"),
      lastFillup: document.getElementById("last-fillup"),
      activityFeed: document.getElementById("activity-feed"),
    };
  }

  /**
   * Load all data sources in parallel
   */
  async function loadAllData() {
    try {
      await Promise.all([
        loadMetrics(),
        loadRecentTrips(),
        loadGasStats(),
        checkLiveTracking(),
      ]);
    } catch (_error) {}
  }

  /**
   * Fetch trip metrics and update stats
   */
  async function loadMetrics() {
    try {
      const response = await fetch("/api/metrics");
      if (!response.ok) throw new Error("Failed to fetch metrics");

      const data = await response.json();

      // Update stats with animation
      animateValue(
        elements.statMiles,
        parseFloat(data.total_distance) || 0,
        formatMiles
      );
      animateValue(
        elements.statTrips,
        parseInt(data.total_trips, 10) || 0,
        formatNumber
      );
    } catch (error) {
      if (elements.statMiles) elements.statMiles.textContent = "--";
      if (elements.statTrips) elements.statTrips.textContent = "--";
    }
  }

  /**
   * Fetch recent trips for activity feed
   */
  async function loadRecentTrips() {
    try {
      const response = await fetch("/api/trips/history?limit=5");
      if (!response.ok) throw new Error("Failed to fetch trips");

      const data = await response.json();
      const trips = data.trips || data || [];

      // Update recent trip meta
      if (trips.length > 0 && elements.recentTrip) {
        const lastTrip = trips[0];
        const lastTripTime = lastTrip.endTime || lastTrip.startTime;
        if (lastTripTime) {
          const valueEl = elements.recentTrip.querySelector(".meta-value");
          if (valueEl) {
            valueEl.textContent = formatTimeAgo(new Date(lastTripTime));
          }
        }
      }

      // Populate activity feed
      populateActivityFeed(trips);
    } catch (error) {
      populateActivityFeed([]);
    }
  }

  /**
   * Fetch gas/fuel statistics
   */
  async function loadGasStats() {
    try {
      const response = await fetch("/api/gas-statistics");
      if (!response.ok) throw new Error("Failed to fetch gas stats");

      const data = await response.json();

      if (elements.lastFillup) {
        const valueEl = elements.lastFillup.querySelector(".meta-value");
        if (valueEl && data.average_mpg) {
          valueEl.textContent = data.average_mpg.toFixed(1);
        }
      }
    } catch (_error) {}
  }

  /**
   * Check if there's an active live tracking session
   */
  async function checkLiveTracking() {
    try {
      const response = await fetch("/api/active_trip");
      if (!response.ok) throw new Error("Failed to check live tracking");

      const data = await response.json();

      if (elements.liveIndicator) {
        if (data.trip && data.trip.status === "active") {
          elements.liveIndicator.classList.add("active");
          elements.liveIndicator.title = "Live tracking active";
        } else {
          elements.liveIndicator.classList.remove("active");
          elements.liveIndicator.title = "No active tracking";
        }
      }
    } catch (error) {
      if (elements.liveIndicator) {
        elements.liveIndicator.classList.remove("active");
      }
    }
  }

  /**
   * Populate the activity feed with recent trips
   */
  function populateActivityFeed(trips) {
    if (!elements.activityFeed) return;

    if (!trips || trips.length === 0) {
      elements.activityFeed.innerHTML = `
        <div class="activity-empty">
          <i class="fas fa-road" style="margin-right: 8px; opacity: 0.5;"></i>
          No recent activity
        </div>
      `;
      return;
    }

    const activityHtml = trips
      .slice(0, CONFIG.activityLimit)
      .map((trip, index) => {
        const distance = trip.distance ? parseFloat(trip.distance).toFixed(1) : "?";
        const destination = formatDestination(trip.destination);
        const time = trip.endTime || trip.startTime;
        const timeAgo = time ? formatTimeAgo(new Date(time)) : "";

        return `
        <div class="activity-item" style="animation-delay: ${index * 0.1}s">
          <div class="activity-icon trip">
            <i class="fas fa-car"></i>
          </div>
          <div class="activity-text">
            <div class="activity-description">
              ${distance} mi to ${destination}
            </div>
            <div class="activity-time">${timeAgo}</div>
          </div>
        </div>
      `;
      })
      .join("");

    elements.activityFeed.innerHTML = activityHtml;
  }

  /**
   * Format a destination object for display
   */
  function formatDestination(dest) {
    if (!dest) return "Unknown";
    if (typeof dest === "string") return dest;
    if (dest.name) return dest.name;
    if (dest.formatted_address) {
      // Shorten the address
      const parts = dest.formatted_address.split(",");
      return parts[0] || dest.formatted_address;
    }
    return "Unknown";
  }

  /**
   * Animate a numeric value change
   */
  function animateValue(element, endValue, formatter) {
    if (!element) return;

    const startValue = parseFloat(element.textContent.replace(/[^0-9.-]/g, "")) || 0;
    const startTime = performance.now();
    const duration = CONFIG.animationDuration;

    element.classList.add("updating");

    function update(currentTime) {
      const elapsed = currentTime - startTime;
      const progress = Math.min(elapsed / duration, 1);

      // Easing function (ease-out cubic)
      const eased = 1 - (1 - progress) ** 3;
      const current = startValue + (endValue - startValue) * eased;

      element.textContent = formatter(current);

      if (progress < 1) {
        requestAnimationFrame(update);
      } else {
        element.classList.remove("updating");
      }
    }

    requestAnimationFrame(update);
  }

  /**
   * Format miles for display
   */
  function formatMiles(value) {
    return Math.round(value).toLocaleString();
  }

  /**
   * Format a number with comma separators
   */
  function formatNumber(value) {
    return Math.round(value).toLocaleString();
  }

  /**
   * Format a date as relative time ago
   */
  function formatTimeAgo(date) {
    const now = new Date();
    const diffMs = now - date;
    const diffSec = Math.floor(diffMs / 1000);
    const diffMin = Math.floor(diffSec / 60);
    const diffHour = Math.floor(diffMin / 60);
    const diffDay = Math.floor(diffHour / 24);

    if (diffSec < 60) return "just now";
    if (diffMin < 60) return `${diffMin}m`;
    if (diffHour < 24) return `${diffHour}h`;
    if (diffDay < 7) return `${diffDay}d`;
    if (diffDay < 30) return `${Math.floor(diffDay / 7)}w`;
    return `${Math.floor(diffDay / 30)}mo`;
  }

  /**
   * Set up periodic data refresh
   */
  function setupRefreshInterval() {
    // Refresh data periodically
    setInterval(() => {
      loadAllData();
    }, CONFIG.refreshInterval);

    // Check live tracking more frequently
    setInterval(() => {
      checkLiveTracking();
    }, 10000); // Every 10 seconds
  }

  // Initialize when DOM is ready
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
