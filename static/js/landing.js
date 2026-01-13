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
  let refreshIntervalId = null;
  let liveTrackingIntervalId = null;
  let swipeActionsBound = false;
  let recordDistanceCache = null;

  let pageSignal = null;
  let lastKnownLocation = null;

  /**
   * Initialize the landing page
   */
  function init({ signal, cleanup } = {}) {
    pageSignal = signal || null;
    cacheElements();
    updateGreeting();

    highlightFrequentTiles();
    bindWidgetEditToggle();

    loadAllData();
    setupRefreshInterval();
    checkLiveTracking();
    bindSwipeActions();
    if (typeof cleanup === "function") {
      cleanup(() => {
        clearIntervals();
        swipeActionsBound = false;
      });
    }
  }

  /**
   * Cache DOM elements for performance
   */
  function cacheElements() {
    elements = {
      greetingTitle: document.getElementById("greeting-title"),
      greetingSubtitle: document.getElementById("greeting-subtitle"),
      weatherChip: document.getElementById("weather-chip"),
      statMiles: document.getElementById("stat-miles"),
      statTrips: document.getElementById("stat-trips"),
      liveIndicator: document.getElementById("live-indicator"),
      recentTrip: document.getElementById("recent-trip"),
      lastFillup: document.getElementById("last-fillup"),
      activityFeed: document.getElementById("activity-feed"),
      recordCard: document.getElementById("record-card"),
      recordDistance: document.getElementById("record-distance"),

      widgetEditToggle: document.getElementById("widget-edit-toggle"),
      navTiles: Array.from(document.querySelectorAll(".nav-tile")),
    };
  }

  /**
   * Load all data sources in parallel
   */
  async function loadAllData() {
    try {
      updateGreeting();

      highlightFrequentTiles();

      // Load trips first to get location
      await loadRecentTrips();

      await Promise.all([
        loadMetrics(),
        loadGasStats(),
        loadInsights(),
        checkLiveTracking(),
        loadWeather(),
      ]);
    } catch (error) {
      console.warn("Failed to load landing data", error);
    }
  }

  function updateGreeting() {
    if (!elements.greetingTitle || !elements.greetingSubtitle) {
      return;
    }
    const hour = new Date().getHours();
    let title = "Welcome back";
    let subtitle = "Here is your latest drive snapshot.";

    if (hour >= 5 && hour < 12) {
      title = "Good morning";
      subtitle = "Plan your next drive while the roads are fresh.";
    } else if (hour >= 12 && hour < 17) {
      title = "Good afternoon";
      subtitle = "Your coverage journey is ready for another push.";
    } else if (hour >= 17 && hour < 22) {
      title = "Good evening";
      subtitle = "Wrap up the day with a quick route check.";
    } else {
      title = "Welcome back";
      subtitle = "Night drives still count toward coverage.";
    }

    elements.greetingTitle.textContent = title;
    elements.greetingSubtitle.textContent = subtitle;
  }

  function bindWidgetEditToggle() {
    if (!elements.widgetEditToggle) {
      return;
    }
    elements.widgetEditToggle.addEventListener(
      "click",
      () => {
        document.dispatchEvent(new CustomEvent("widgets:toggle-edit"));
      },
      pageSignal ? { signal: pageSignal } : false,
    );
    document.addEventListener(
      "widgets:edit-toggled",
      (event) => {
        const enabled = event.detail?.enabled;
        elements.widgetEditToggle.textContent = enabled ? "Done" : "Customize";
        elements.widgetEditToggle.classList.toggle("active", Boolean(enabled));
      },
      pageSignal ? { signal: pageSignal } : false,
    );
  }

  function highlightFrequentTiles() {
    if (!elements.navTiles || elements.navTiles.length === 0) {
      return;
    }
    const counts = getRouteCounts();
    const frequentPaths = Object.entries(counts)
      .filter(([path]) => path !== "/" && path !== "/landing")
      .sort((a, b) => b[1] - a[1])
      .slice(0, 2)
      .map(([path]) => path);

    const pathToTile = {
      "/map": "map",
      "/coverage-navigator": "navigate",
      "/trips": "trips",
      "/insights": "insights",
      "/gas-tracking": "gas",
      "/visits": "visits",
      "/upload": "upload",
      "/export": "export",
      "/coverage-management": "areas",
      "/settings": "settings",
    };

    const frequentTiles = new Set(
      frequentPaths.map((path) => pathToTile[path]).filter(Boolean),
    );

    elements.navTiles.forEach((tile) => {
      const tileId = tile.dataset.tile;
      tile.classList.toggle("tile-frequent", frequentTiles.has(tileId));
    });
  }

  async function loadWeather() {
    if (!elements.weatherChip) {
      return;
    }

    const cached = getCachedWeather();
    if (cached) {
      elements.weatherChip.textContent = `Weather: ${cached.temp}F ${cached.label}`;
      return;
    }

    if (!navigator.geolocation && !lastKnownLocation) {
      elements.weatherChip.textContent = "Weather: --";
      return;
    }

    try {
      let latitude, longitude;

      if (lastKnownLocation) {
        ({ latitude, longitude } = lastKnownLocation);
      } else {
        const position = await new Promise((resolve, reject) => {
          navigator.geolocation.getCurrentPosition(resolve, reject, {
            timeout: 5000,
            maximumAge: 600000,
          });
        });
        ({ latitude, longitude } = position.coords);
      }
      const url = `https://api.open-meteo.com/v1/forecast?latitude=${latitude}&longitude=${longitude}&current=temperature_2m,weather_code&temperature_unit=fahrenheit&timezone=auto`;
      const response = await fetch(url);
      if (!response.ok) {
        throw new Error("Weather request failed");
      }

      const data = await response.json();
      const temp = Math.round(Number(data.current?.temperature_2m));
      const label = mapWeatherCode(data.current?.weather_code);
      if (!Number.isFinite(temp) || !label) {
        throw new Error("Weather data missing");
      }

      elements.weatherChip.textContent = `Weather: ${temp}F ${label}`;
      setCachedWeather({ temp, label });
    } catch {
      elements.weatherChip.textContent = "Weather: --";
    }
  }

  function updateRecordValue(distance) {
    const numeric = Number(distance);
    if (!Number.isFinite(numeric) || numeric <= 0) {
      if (elements.recordDistance) {
        elements.recordDistance.textContent = recordDistanceCache
          ? `${recordDistanceCache.toFixed(1)} mi`
          : "--";
      }
      return recordDistanceCache || 0;
    }

    if (!recordDistanceCache || numeric > recordDistanceCache) {
      recordDistanceCache = numeric;
    }

    if (elements.recordDistance) {
      elements.recordDistance.textContent = `${recordDistanceCache.toFixed(1)} mi`;
    }

    if (elements.recordCard) {
      const existing = getStoredValue("es:record-metrics") || {};
      const previous = Number(existing.longestTrip || 0);
      elements.recordCard.classList.toggle(
        "is-record",
        recordDistanceCache > previous,
      );
    }

    return recordDistanceCache;
  }

  function getRecordDistance(trips) {
    if (!Array.isArray(trips) || trips.length === 0) {
      return 0;
    }
    return trips.reduce((max, trip) => {
      const distance = Number.parseFloat(trip.distance || 0);
      return Number.isFinite(distance) && distance > max ? distance : max;
    }, 0);
  }

  function _formatDayKey(date) {
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, "0");
    const day = String(date.getDate()).padStart(2, "0");
    return `${year}-${month}-${day}`;
  }

  function getRouteCounts() {
    return getStoredValue("es:route-counts") || {};
  }

  function getMostVisitedPath(counts) {
    const entries = Object.entries(counts);
    if (entries.length === 0) {
      return null;
    }
    const [path] = entries.sort((a, b) => b[1] - a[1])[0];
    return { path, timestamp: null };
  }

  function getStoredValue(key) {
    try {
      const raw = localStorage.getItem(key);
      if (!raw) {
        return null;
      }
      return JSON.parse(raw);
    } catch {
      return null;
    }
  }

  function getCachedWeather() {
    const cached = getStoredValue("es:weather-cache");
    if (!cached) {
      return null;
    }
    const maxAge = 20 * 60 * 1000;
    if (Date.now() - cached.timestamp > maxAge) {
      return null;
    }
    return cached;
  }

  function setCachedWeather({ temp, label }) {
    try {
      localStorage.setItem(
        "es:weather-cache",
        JSON.stringify({
          temp,
          label,
          timestamp: Date.now(),
        }),
      );
    } catch {
      // Ignore storage failures.
    }
  }

  function mapWeatherCode(code) {
    const numeric = Number(code);
    if (!Number.isFinite(numeric)) {
      return null;
    }
    if (numeric === 0) {
      return "Clear";
    }
    if ([1, 2].includes(numeric)) {
      return "Partly Cloudy";
    }
    if (numeric === 3) {
      return "Cloudy";
    }
    if ([45, 48].includes(numeric)) {
      return "Fog";
    }
    if ([51, 53, 55, 56, 57].includes(numeric)) {
      return "Drizzle";
    }
    if ([61, 63, 65, 66, 67].includes(numeric)) {
      return "Rain";
    }
    if ([71, 73, 75, 77].includes(numeric)) {
      return "Snow";
    }
    if ([80, 81, 82].includes(numeric)) {
      return "Showers";
    }
    if ([95, 96, 99].includes(numeric)) {
      return "Storm";
    }
    return "Clear";
  }

  /**
   * Fetch trip metrics and update stats
   */
  async function loadMetrics() {
    try {
      const response = await fetch("/api/metrics");
      if (!response.ok) {
        throw new Error("Failed to fetch metrics");
      }

      const data = await response.json();

      // Update stats with animation
      const miles = parseFloat(data.total_distance) || 0;
      const trips = parseInt(data.total_trips, 10) || 0;

      if (window.metricAnimator?.animate) {
        window.metricAnimator.animate(elements.statMiles, miles, {
          decimals: 0,
        });
        window.metricAnimator.animate(elements.statTrips, trips, {
          decimals: 0,
        });
      } else {
        animateValue(elements.statMiles, miles, formatMiles);
        animateValue(elements.statTrips, trips, formatNumber);
      }
    } catch {
      if (elements.statMiles) {
        elements.statMiles.textContent = "--";
      }
      if (elements.statTrips) {
        elements.statTrips.textContent = "--";
      }
    }
  }

  /**
   * Fetch recent trips for activity feed
   */
  async function loadRecentTrips() {
    try {
      const response = await fetch("/api/trips/history?limit=60");
      if (!response.ok) {
        throw new Error("Failed to fetch trips");
      }

      const data = await response.json();
      const trips = data.trips || data || [];

      // Extract last known location from the most recent trip
      if (trips.length > 0) {
        const lastTrip = trips[0];
        if (
          lastTrip.destinationGeoPoint &&
          lastTrip.destinationGeoPoint.coordinates &&
          lastTrip.destinationGeoPoint.coordinates.length >= 2
        ) {
          const [lon, lat] = lastTrip.destinationGeoPoint.coordinates;
          if (Number.isFinite(lat) && Number.isFinite(lon)) {
            lastKnownLocation = { latitude: lat, longitude: lon };
          }
        }
      }

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

      updateRecordValue(recordDistanceCache || getRecordDistance(trips));
    } catch {
      populateActivityFeed([]);

      updateRecordValue(recordDistanceCache || 0);
    }
  }

  /**
   * Fetch driving insights for records
   */
  async function loadInsights() {
    try {
      const response = await fetch("/api/driving-insights");
      if (!response.ok) {
        throw new Error("Failed to fetch insights");
      }
      const data = await response.json();
      updateRecordValue(data.longest_trip_distance || 0);
    } catch (error) {
      console.warn("Failed to load driving insights", error);
    }
  }

  /**
   * Fetch gas/fuel statistics
   */
  async function loadGasStats() {
    try {
      const response = await fetch("/api/gas-statistics");
      if (!response.ok) {
        throw new Error("Failed to fetch gas stats");
      }

      const data = await response.json();

      if (elements.lastFillup) {
        const valueEl = elements.lastFillup.querySelector(".meta-value");
        if (valueEl && data.average_mpg) {
          valueEl.textContent = data.average_mpg.toFixed(1);
        }
      }
    } catch (error) {
      console.warn("Failed to load gas stats", error);
    }
  }

  /**
   * Check if there's an active live tracking session
   */
  async function checkLiveTracking() {
    try {
      const response = await fetch("/api/active_trip");
      if (!response.ok) {
        throw new Error("Failed to check live tracking");
      }

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
    } catch {
      if (elements.liveIndicator) {
        elements.liveIndicator.classList.remove("active");
      }
    }
  }

  /**
   * Populate the activity feed with recent trips
   */
  function populateActivityFeed(trips) {
    if (!elements.activityFeed) {
      return;
    }

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
        const distance = trip.distance
          ? parseFloat(trip.distance).toFixed(1)
          : "?";
        const destination = formatDestination(trip.destination);
        const time = trip.endTime || trip.startTime;
        const timeAgo = time ? formatTimeAgo(new Date(time)) : "";

        return `
        <div class="swipe-item" data-swipe-actions data-trip-id="${trip.transactionId || ""}">
          <div class="swipe-actions">
            <button class="swipe-action-btn secondary" data-action="share" aria-label="Share trip">
              <i class="fas fa-share-alt"></i>
            </button>
            <button class="swipe-action-btn" data-action="view" aria-label="View trips">
              <i class="fas fa-route"></i>
            </button>
          </div>
          <div class="swipe-content">
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
          </div>
        </div>
      `;
      })
      .join("");

    elements.activityFeed.innerHTML = activityHtml;
  }

  function bindSwipeActions() {
    if (swipeActionsBound || !elements.activityFeed) {
      return;
    }
    elements.activityFeed.addEventListener(
      "click",
      (event) => {
        const button = event.target.closest(".swipe-action-btn");
        if (!button) {
          return;
        }
        const { action } = button.dataset;
        const item = button.closest("[data-trip-id]");
        const tripId = item?.dataset.tripId;

        if (action === "view") {
          window.location.href = "/trips";
        } else if (action === "share" && tripId) {
          const shareData = {
            title: "EveryStreet Trip",
            text: "Check out this recent trip.",
            url: `${window.location.origin}/trips`,
          };
          if (navigator.share) {
            navigator.share(shareData).catch(() => {});
          } else {
            window.notificationManager?.show(
              "Share is not available on this device",
              "info",
            );
          }
        }
      },
      pageSignal ? { signal: pageSignal } : false,
    );
    swipeActionsBound = true;
  }

  /**
   * Format a destination object for display
   */
  function formatDestination(dest) {
    if (!dest) {
      return "Unknown";
    }
    if (typeof dest === "string") {
      return dest;
    }
    if (dest.name) {
      return dest.name;
    }
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
    if (!element) {
      return;
    }

    const startValue =
      parseFloat(element.textContent.replace(/[^0-9.-]/g, "")) || 0;
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

    if (diffSec < 60) {
      return "just now";
    }
    if (diffMin < 60) {
      return `${diffMin}m`;
    }
    if (diffHour < 24) {
      return `${diffHour}h`;
    }
    if (diffDay < 7) {
      return `${diffDay}d`;
    }
    if (diffDay < 30) {
      return `${Math.floor(diffDay / 7)}w`;
    }
    return `${Math.floor(diffDay / 30)}mo`;
  }

  /**
   * Set up periodic data refresh
   */
  function setupRefreshInterval() {
    clearIntervals();

    // Refresh data periodically
    refreshIntervalId = setInterval(() => {
      loadAllData();
    }, CONFIG.refreshInterval);

    // Check live tracking more frequently
    liveTrackingIntervalId = setInterval(() => {
      checkLiveTracking();
    }, 10000); // Every 10 seconds
  }

  function clearIntervals() {
    if (refreshIntervalId) {
      clearInterval(refreshIntervalId);
      refreshIntervalId = null;
    }
    if (liveTrackingIntervalId) {
      clearInterval(liveTrackingIntervalId);
      liveTrackingIntervalId = null;
    }
  }

  window.utils?.onPageLoad(init, { route: "/" });
})();
