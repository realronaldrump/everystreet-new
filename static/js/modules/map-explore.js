import mapManager from "./map-manager.js";
import state from "./state.js";
import { onPageLoad, utils } from "./utils.js";

const dateUtils = window.DateUtils;

const mapExplore = {
  trips: [],
  filteredTrips: [],
  activeRange: "all",
  visibleCount: 0,
  batchSize: 30,
  selectedTripId: null,
  pendingSelectionId: null,

  init({ signal } = {}) {
    this.cacheElements();
    if (!this.elements.drawer || !this.elements.gallery) {
      return;
    }

    this.visibleCount = 0;
    this.bindEvents(signal);
    this.setActiveTab("explore", { focus: false });
    this.updateRangeLabel();
    this.refreshFromState();
  },

  cacheElements() {
    this.elements = {
      drawer: document.getElementById("map-controls"),
      controlsToggle: document.getElementById("controls-toggle"),
      commandToggle: document.getElementById("journey-panel-toggle"),
      tabList: document.querySelector(".journey-tabs"),
      tabs: Array.from(document.querySelectorAll("[data-journey-tab]")),
      panels: Array.from(document.querySelectorAll("[data-journey-panel]")),
      gallery: document.getElementById("trip-gallery"),
      galleryEmpty: document.getElementById("trip-gallery-empty"),
      loadMore: document.getElementById("trip-gallery-load-more"),
      filterGroup: document.querySelector(".journey-filters"),
      timeline: document.getElementById("trip-timeline"),
      timelineStart: document.getElementById("timeline-start"),
      timelineEnd: document.getElementById("timeline-end"),
      rangeLabel: document.getElementById("journey-range"),
      metaTrips: document.getElementById("journey-total-trips"),
      metaDistance: document.getElementById("journey-total-distance"),
      metaDays: document.getElementById("journey-total-days"),
      spotlightCard: document.getElementById("journey-spotlight"),
      spotlightDistance: document.getElementById("spotlight-distance"),
      spotlightDate: document.getElementById("spotlight-date"),
      spotlightDuration: document.getElementById("spotlight-duration"),
      spotlightSpeed: document.getElementById("spotlight-speed"),
      spotlightStart: document.getElementById("spotlight-start"),
    };
  },

  bindEvents(signal) {
    if (this.elements.commandToggle && this.elements.controlsToggle) {
      this.elements.commandToggle.addEventListener(
        "click",
        () => this.elements.controlsToggle.click(),
        { signal },
      );
    }

    if (this.elements.tabList) {
      this.elements.tabList.addEventListener(
        "click",
        (event) => {
          const button = event.target.closest("[data-journey-tab]");
          if (!button) {
            return;
          }
          this.setActiveTab(button.dataset.journeyTab, { focus: true });
        },
        { signal },
      );

      this.elements.tabList.addEventListener(
        "keydown",
        (event) => {
          if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) {
            return;
          }
          event.preventDefault();
          this.handleTabKeyNavigation(event.key);
        },
        { signal },
      );
    }

    if (this.elements.filterGroup) {
      this.elements.filterGroup.addEventListener(
        "click",
        (event) => {
          const button = event.target.closest("[data-range]");
          if (!button) {
            return;
          }
          this.setActiveRange(button.dataset.range);
        },
        { signal },
      );
    }

    if (this.elements.gallery) {
      this.elements.gallery.addEventListener(
        "click",
        (event) => {
          const card = event.target.closest("[data-trip-id]");
          if (!card) {
            return;
          }
          const tripId = card.dataset.tripId;
          this.focusTripById(tripId, { origin: "explore" });
        },
        { signal },
      );
    }

    if (this.elements.loadMore) {
      this.elements.loadMore.addEventListener(
        "click",
        () => {
          this.visibleCount = Math.min(
            this.visibleCount + this.batchSize,
            this.filteredTrips.length,
          );
          this.renderGallery({ append: true });
        },
        { signal },
      );
    }

    if (this.elements.timeline) {
      const throttledInput = utils.throttle((value) => {
        this.focusTripByIndex(Number.parseInt(value, 10), {
          origin: "timeline",
        });
      }, 150);

      this.elements.timeline.addEventListener(
        "input",
        (event) => {
          throttledInput(event.target.value);
        },
        { signal },
      );

      this.elements.timeline.addEventListener(
        "change",
        (event) => {
          this.focusTripByIndex(Number.parseInt(event.target.value, 10), {
            origin: "timeline",
            announce: true,
          });
        },
        { signal },
      );
    }

    document.addEventListener(
      "tripsUpdated",
      (event) => {
        this.handleTripsUpdated(event.detail?.trips);
      },
      { signal },
    );

    document.addEventListener(
      "tripSelected",
      (event) => {
        if (event.detail?.source === "explore") {
          return;
        }
        const tripId = event.detail?.tripId;
        if (tripId) {
          this.focusTripById(tripId, { origin: "map" });
        }
      },
      { signal },
    );

    document.addEventListener(
      "tripSelectionCleared",
      () => {
        this.clearSelection();
      },
      { signal },
    );

    document.addEventListener(
      "filtersApplied",
      () => {
        this.updateRangeLabel();
        this.refreshFromState();
      },
      { signal },
    );
  },

  refreshFromState() {
    this.selectedTripId = state.selectedTripId
      ? String(state.selectedTripId)
      : null;
    this.handleTripsUpdated(state.mapLayers.trips?.layer);
  },

  handleTripsUpdated(tripData) {
    this.trips = this.buildTrips(tripData);
    this.applyFilters();
    if (this.pendingSelectionId) {
      this.focusTripById(this.pendingSelectionId, { origin: "map" });
      this.pendingSelectionId = null;
    }
  },

  buildTrips(tripData) {
    if (!tripData?.features?.length) {
      return [];
    }

    const trips = tripData.features
      .map((feature) => this.normalizeTrip(feature))
      .filter(Boolean)
      .sort((a, b) => (b.endTs || 0) - (a.endTs || 0));

    return trips;
  },

  normalizeTrip(feature) {
    const props = feature.properties || {};
    const tripId =
      props.transactionId || props.id || props.tripId || feature.id || null;
    if (!tripId) {
      return null;
    }

    const startTs = props.es_startTs || this.parseTimestamp(props.startTime);
    const endTs =
      props.es_endTs || this.parseTimestamp(props.endTime) || startTs;
    const distanceMiles = this.parseNumber(
      props.es_distanceMiles || props.distance,
    );
    const avgSpeed = this.parseNumber(
      props.es_avgSpeed || props.averageSpeed || props.avgSpeed,
    );
    const durationSec = this.parseNumber(
      props.es_durationSec || props.duration || props.drivingTime,
    );

    const dayKey = endTs ? new Date(endTs).toDateString() : "unknown";

    return {
      id: String(tripId),
      startTs,
      endTs,
      distanceMiles,
      avgSpeed,
      durationSec,
      props,
      dayKey,
      feature,
    };
  },

  parseNumber(value) {
    if (value == null) {
      return null;
    }
    const parsed = Number.parseFloat(value);
    return Number.isFinite(parsed) ? parsed : null;
  },

  parseTimestamp(value) {
    if (!value) {
      return null;
    }
    const ts = new Date(value).getTime();
    return Number.isFinite(ts) ? ts : null;
  },

  applyFilters() {
    const now = Date.now();
    const days = Number.parseInt(this.activeRange, 10);
    const useRange = Number.isFinite(days);
    const cutoff = useRange ? now - days * 24 * 60 * 60 * 1000 : null;

    this.filteredTrips = this.trips.filter((trip) => {
      if (!useRange) {
        return true;
      }
      if (!trip.endTs) {
        return false;
      }
      return trip.endTs >= cutoff;
    });

    this.visibleCount = Math.min(
      Math.max(this.visibleCount || this.batchSize, this.batchSize),
      this.filteredTrips.length,
    );

    this.renderGallery({ append: false });
    this.updateTimeline();
    this.updateMeta();

    if (!this.selectedTripId && this.filteredTrips.length) {
      this.updateSpotlight(this.filteredTrips[0]);
      this.updateTimelineValue(this.filteredTrips[0]);
    }
  },

  renderGallery({ append }) {
    if (!this.elements.gallery) {
      return;
    }

    if (!append) {
      this.elements.gallery
        .querySelectorAll("[data-trip-id]")
        .forEach((node) => node.remove());
    }

    const slice = this.filteredTrips.slice(0, this.visibleCount);
    if (!slice.length) {
      if (this.elements.galleryEmpty) {
        this.elements.galleryEmpty.hidden = false;
      }
      if (this.elements.loadMore) {
        this.elements.loadMore.classList.add("d-none");
      }
      return;
    }

    if (this.elements.galleryEmpty) {
      this.elements.galleryEmpty.hidden = true;
    }

    const fragment = document.createDocumentFragment();
    const startIndex = append ? Math.max(0, slice.length - this.batchSize) : 0;

    slice.slice(startIndex).forEach((trip, index) => {
      const card = document.createElement("button");
      card.type = "button";
      card.className = "trip-card";
      card.dataset.tripId = trip.id;
      card.setAttribute("role", "option");
      card.setAttribute("aria-selected", "false");
      card.style.setProperty(
        "--stagger-delay",
        `${(index + startIndex) * 0.02}s`,
      );

      const title = document.createElement("div");
      title.className = "trip-card-title";
      title.textContent = this.formatDate(trip.endTs, "medium");

      const meta = document.createElement("div");
      meta.className = "trip-card-meta";
      meta.textContent = this.formatMeta(trip);

      const time = document.createElement("div");
      time.className = "trip-card-time";
      time.textContent = this.formatDate(trip.startTs, "short", "short");

      card.appendChild(title);
      card.appendChild(meta);
      card.appendChild(time);
      fragment.appendChild(card);
    });

    this.elements.gallery.appendChild(fragment);
    this.syncSelectionToGallery();

    if (this.elements.loadMore) {
      const hasMore = slice.length < this.filteredTrips.length;
      this.elements.loadMore.classList.toggle("d-none", !hasMore);
    }
  },

  updateTimeline() {
    const timeline = this.elements.timeline;
    if (!timeline) {
      return;
    }

    const tripCount = this.filteredTrips.length;
    if (!tripCount) {
      timeline.disabled = true;
      timeline.min = 0;
      timeline.max = 0;
      timeline.value = 0;
      if (this.elements.timelineStart) {
        this.elements.timelineStart.textContent = "--";
      }
      if (this.elements.timelineEnd) {
        this.elements.timelineEnd.textContent = "--";
      }
      return;
    }

    timeline.disabled = false;
    timeline.min = 0;
    timeline.max = Math.max(tripCount - 1, 0);
    if (Number.parseInt(timeline.value, 10) > timeline.max) {
      timeline.value = timeline.max;
    }

    const oldest = this.filteredTrips[tripCount - 1];
    const newest = this.filteredTrips[0];
    if (this.elements.timelineStart) {
      this.elements.timelineStart.textContent = this.formatDate(
        oldest.endTs,
        "medium",
      );
    }
    if (this.elements.timelineEnd) {
      this.elements.timelineEnd.textContent = this.formatDate(
        newest.endTs,
        "medium",
      );
    }
  },

  updateMeta() {
    if (!this.filteredTrips.length) {
      if (this.elements.metaTrips) {
        this.elements.metaTrips.textContent = "0";
      }
      if (this.elements.metaDistance) {
        this.elements.metaDistance.textContent = "0";
      }
      if (this.elements.metaDays) {
        this.elements.metaDays.textContent = "0";
      }
      return;
    }

    const totalTrips = this.filteredTrips.length;
    const totalDistance = this.filteredTrips.reduce((sum, trip) => {
      return sum + (trip.distanceMiles || 0);
    }, 0);

    const uniqueDays = new Set(
      this.filteredTrips.map((trip) => trip.dayKey || "unknown"),
    ).size;

    if (this.elements.metaTrips) {
      this.elements.metaTrips.textContent = totalTrips.toLocaleString();
    }
    if (this.elements.metaDistance) {
      this.elements.metaDistance.textContent = totalDistance.toFixed(1);
    }
    if (this.elements.metaDays) {
      this.elements.metaDays.textContent = uniqueDays.toLocaleString();
    }
  },

  updateRangeLabel() {
    if (!this.elements.rangeLabel || !dateUtils?.getCachedDateRange) {
      return;
    }

    const { start, end } = dateUtils.getCachedDateRange();
    if (!start || !end) {
      return;
    }
    const startLabel = dateUtils.formatForDisplay(start, {
      dateStyle: "medium",
    });
    const endLabel = dateUtils.formatForDisplay(end, { dateStyle: "medium" });
    this.elements.rangeLabel.textContent = `${startLabel} - ${endLabel}`;
  },

  setActiveTab(tabName, { focus } = {}) {
    if (!tabName) {
      return;
    }
    this.elements.tabs.forEach((tab) => {
      const isActive = tab.dataset.journeyTab === tabName;
      tab.classList.toggle("is-active", isActive);
      tab.setAttribute("aria-selected", String(isActive));
      tab.setAttribute("tabindex", isActive ? "0" : "-1");
      if (isActive && focus) {
        tab.focus();
      }
    });

    this.elements.panels.forEach((panel) => {
      const isActive = panel.dataset.journeyPanel === tabName;
      panel.classList.toggle("is-active", isActive);
      panel.toggleAttribute("hidden", !isActive);
    });
  },

  handleTabKeyNavigation(key) {
    const tabs = this.elements.tabs;
    if (!tabs.length) {
      return;
    }
    const currentIndex = tabs.findIndex((tab) =>
      tab.classList.contains("is-active"),
    );
    let nextIndex = currentIndex >= 0 ? currentIndex : 0;

    if (key === "Home") {
      nextIndex = 0;
    } else if (key === "End") {
      nextIndex = tabs.length - 1;
    } else if (key === "ArrowRight") {
      nextIndex = (nextIndex + 1) % tabs.length;
    } else if (key === "ArrowLeft") {
      nextIndex = (nextIndex - 1 + tabs.length) % tabs.length;
    }

    const nextTab = tabs[nextIndex];
    if (nextTab) {
      this.setActiveTab(nextTab.dataset.journeyTab, { focus: true });
    }
  },

  setActiveRange(range) {
    if (!range) {
      return;
    }
    this.activeRange = range;
    if (this.elements.filterGroup) {
      this.elements.filterGroup
        .querySelectorAll("[data-range]")
        .forEach((btn) => {
          btn.classList.toggle("is-active", btn.dataset.range === range);
        });
    }
    this.applyFilters();
  },

  focusTripByIndex(index, { origin, announce } = {}) {
    const trip = this.filteredTrips[index];
    if (!trip) {
      return;
    }
    this.focusTrip(trip, { origin, announce });
  },

  focusTripById(tripId, { origin } = {}) {
    if (!tripId) {
      return;
    }

    const trip =
      this.filteredTrips.find((item) => item.id === String(tripId)) ||
      this.trips.find((item) => item.id === String(tripId));
    if (!trip) {
      this.pendingSelectionId = String(tripId);
      return;
    }

    this.focusTrip(trip, { origin });
  },

  focusTrip(trip, { origin, announce } = {}) {
    if (!trip) {
      return;
    }

    this.selectedTripId = trip.id;
    this.updateSpotlight(trip);
    this.updateTimelineValue(trip);
    this.syncSelectionToGallery();

    if (origin !== "map") {
      const prefersReducedMotion = window.matchMedia(
        "(prefers-reduced-motion: reduce)",
      ).matches;
      mapManager.zoomToTrip(trip.id, {
        duration: prefersReducedMotion ? 0 : 1600,
      });
      document.dispatchEvent(
        new CustomEvent("tripSelected", {
          detail: { tripId: trip.id, source: "explore" },
        }),
      );
    }

    if (announce) {
      utils.announce(
        `Spotlight on trip from ${this.formatDate(trip.endTs, "medium")}`,
        "polite",
      );
    }
  },

  updateSpotlight(trip) {
    if (!this.elements.spotlightCard) {
      return;
    }

    if (this.elements.spotlightDistance) {
      this.elements.spotlightDistance.textContent =
        trip.distanceMiles != null ? trip.distanceMiles.toFixed(1) : "--";
    }
    if (this.elements.spotlightDate) {
      this.elements.spotlightDate.textContent = this.formatDate(
        trip.endTs,
        "medium",
        "short",
      );
    }
    if (this.elements.spotlightDuration) {
      const formatDuration = dateUtils?.formatDuration;
      this.elements.spotlightDuration.textContent =
        trip.durationSec != null
          ? formatDuration
            ? formatDuration(trip.durationSec)
            : `${Math.round(trip.durationSec)}s`
          : "--";
    }
    if (this.elements.spotlightSpeed) {
      this.elements.spotlightSpeed.textContent =
        trip.avgSpeed != null ? `${trip.avgSpeed.toFixed(1)} mph` : "--";
    }
    if (this.elements.spotlightStart) {
      this.elements.spotlightStart.textContent = this.formatDate(
        trip.startTs,
        "medium",
        "short",
      );
    }

    this.elements.spotlightCard.classList.add("is-active");
  },

  updateTimelineValue(trip) {
    const timeline = this.elements.timeline;
    if (!timeline || !trip) {
      return;
    }

    const index = this.filteredTrips.findIndex((item) => item.id === trip.id);
    if (index >= 0) {
      timeline.value = String(index);
      timeline.setAttribute(
        "aria-valuetext",
        this.formatDate(trip.endTs, "medium", "short"),
      );
    }
  },

  syncSelectionToGallery() {
    if (!this.elements.gallery) {
      return;
    }

    const prefersReducedMotion = window.matchMedia(
      "(prefers-reduced-motion: reduce)",
    ).matches;

    const cards = this.elements.gallery.querySelectorAll("[data-trip-id]");
    cards.forEach((card) => {
      const isSelected = card.dataset.tripId === String(this.selectedTripId);
      card.classList.toggle("is-selected", isSelected);
      card.setAttribute("aria-selected", String(isSelected));
      if (isSelected) {
        card.scrollIntoView({
          block: "nearest",
          behavior: prefersReducedMotion ? "auto" : "smooth",
        });
      }
    });
  },

  clearSelection() {
    this.selectedTripId = null;
    if (this.elements.gallery) {
      this.elements.gallery
        .querySelectorAll("[data-trip-id]")
        .forEach((card) => {
          card.classList.remove("is-selected");
          card.setAttribute("aria-selected", "false");
        });
    }
  },

  formatDate(timestamp, dateStyle = "medium", timeStyle = null) {
    if (!timestamp || !dateUtils?.formatForDisplay) {
      return "--";
    }
    return dateUtils.formatForDisplay(timestamp, {
      dateStyle,
      timeStyle,
    });
  },

  formatMeta(trip) {
    const distance =
      trip.distanceMiles != null ? `${trip.distanceMiles.toFixed(1)} mi` : "--";
    const duration =
      trip.durationSec != null
        ? dateUtils?.formatDuration
          ? dateUtils.formatDuration(trip.durationSec)
          : `${Math.round(trip.durationSec)}s`
        : "--";
    const speed =
      trip.avgSpeed != null ? `${trip.avgSpeed.toFixed(0)} mph` : "--";
    return `${distance} · ${duration} · ${speed}`;
  },
};

onPageLoad(({ signal }) => mapExplore.init({ signal }), { route: "/map" });

export default mapExplore;
