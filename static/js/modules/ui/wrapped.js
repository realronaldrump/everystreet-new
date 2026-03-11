/**
 * Wrapped / Year-in-Review Experience
 *
 * Full-screen storytelling sequence with swipeable slides.
 * Auto-generates from driving data for any date range.
 */

class WrappedExperience {
  constructor() {
    this._container = null;
    this._slides = [];
    this._currentSlide = 0;
    this._data = null;
    this._destroyed = false;
    this._touchStartY = 0;
    this._keyHandler = null;
  }

  /**
   * Launch the wrapped experience.
   * @param {Object} data - Aggregated data for the period
   * @param {string} data.periodLabel - e.g., "2025" or "March 2026"
   * @param {number} data.totalMiles - Total miles driven
   * @param {number} data.totalTrips - Total trips
   * @param {number} data.totalHours - Total driving hours
   * @param {number} data.longestTripMiles - Longest single trip
   * @param {string} data.longestTripDate - Date of longest trip
   * @param {number} data.busiestDayTrips - Most trips in a day
   * @param {string} data.busiestDayDate - Date of busiest day
   * @param {number} data.busiestDayMiles - Miles on busiest day
   * @param {Array} data.topDestinations - Top 5 destinations [{name, visits}]
   * @param {number} data.coverageStart - Coverage % at start of period
   * @param {number} data.coverageEnd - Coverage % at end of period
   * @param {number} data.newStreets - New streets covered
   * @param {number} data.drivingDays - Days with driving
   * @param {string} data.favoriteDayOfWeek - Most common driving day
   * @param {string} data.favoriteHour - Most common driving hour
   */
  launch(data) {
    if (!data) return;
    this._data = data;
    this._slides = this._buildSlides(data);
    this._currentSlide = 0;
    this._render();
    this._bindControls();
    document.body.style.overflow = "hidden";
  }

  close({ immediate = false } = {}) {
    this._destroyed = true;
    document.body.style.overflow = "";
    if (this._keyHandler) {
      document.removeEventListener("keydown", this._keyHandler);
      this._keyHandler = null;
    }
    const container = this._container;
    this._container = null;
    if (container?.parentNode) {
      if (immediate) {
        container.remove();
        return;
      }
      container.classList.remove("wrapped-visible");
      setTimeout(() => container.remove(), 400);
    }
  }

  // --- Slide Builder ---

  _buildSlides(data) {
    const slides = [];
    const fmt = (n, d = 0) => {
      if (!Number.isFinite(n)) return "0";
      return n.toLocaleString("en-US", { maximumFractionDigits: d });
    };

    // Slide 1: Intro
    slides.push({
      accent: "#3b8a7f",
      icon: "fa-road",
      pretitle: "Your driving story",
      title: data.periodLabel || "Year in Review",
      subtitle: "Let's see what you accomplished",
      type: "intro",
    });

    // Slide 2: Total miles
    if (data.totalMiles) {
      const comparison = this._getMilesComparison(data.totalMiles);
      slides.push({
        accent: "#4d9a6a",
        icon: "fa-gauge-high",
        pretitle: "You drove a total of",
        title: `${fmt(data.totalMiles, 1)} miles`,
        subtitle: comparison,
        type: "stat",
      });
    }

    // Slide 3: Trip count
    if (data.totalTrips) {
      slides.push({
        accent: "#d09868",
        icon: "fa-car",
        pretitle: "Across",
        title: `${fmt(data.totalTrips)} trips`,
        subtitle: data.totalHours
          ? `That's ${fmt(data.totalHours, 1)} hours behind the wheel`
          : "",
        type: "stat",
      });
    }

    // Slide 4: Longest trip
    if (data.longestTripMiles) {
      slides.push({
        accent: "#d4a24a",
        icon: "fa-trophy",
        pretitle: "Your longest trip was",
        title: `${fmt(data.longestTripMiles, 1)} miles`,
        subtitle: data.longestTripDate ? `on ${data.longestTripDate}` : "",
        type: "stat",
      });
    }

    // Slide 5: Busiest day
    if (data.busiestDayTrips) {
      slides.push({
        accent: "#c45454",
        icon: "fa-fire",
        pretitle: "Your busiest day had",
        title: `${data.busiestDayTrips} trips · ${fmt(data.busiestDayMiles || 0, 1)} mi`,
        subtitle: data.busiestDayDate ? `on ${data.busiestDayDate}` : "",
        type: "stat",
      });
    }

    // Slide 6: Top destinations
    if (data.topDestinations?.length) {
      slides.push({
        accent: "#6a9fc0",
        icon: "fa-location-dot",
        pretitle: "Your top destinations",
        title: "",
        items: data.topDestinations.slice(0, 5).map((d, i) => ({
          rank: i + 1,
          name: d.name,
          detail: `${d.visits} visits`,
        })),
        type: "list",
      });
    }

    // Slide 7: Coverage growth
    if (data.coverageEnd != null) {
      const growth = (data.coverageEnd || 0) - (data.coverageStart || 0);
      slides.push({
        accent: "#4d9a6a",
        icon: "fa-chart-line",
        pretitle: "Coverage grew from",
        title: `${fmt(data.coverageStart || 0, 1)}% → ${fmt(data.coverageEnd, 1)}%`,
        subtitle: data.newStreets
          ? `${fmt(data.newStreets)} new streets explored`
          : `+${fmt(growth, 1)}% coverage gained`,
        type: "stat",
      });
    }

    // Slide 8: Driving habits
    if (data.favoriteDayOfWeek || data.favoriteHour) {
      const parts = [];
      if (data.favoriteDayOfWeek) parts.push(`${data.favoriteDayOfWeek}s`);
      if (data.favoriteHour) parts.push(`around ${data.favoriteHour}`);
      slides.push({
        accent: "#b87a4a",
        icon: "fa-clock",
        pretitle: "You drive most on",
        title: parts.join(" "),
        subtitle: data.drivingDays
          ? `${data.drivingDays} active driving days`
          : "",
        type: "stat",
      });
    }

    // Slide 9: Finale
    slides.push({
      accent: "#d4a24a",
      icon: "fa-flag-checkered",
      pretitle: data.periodLabel || "",
      title: "Keep exploring",
      subtitle: "Every street is waiting",
      type: "finale",
    });

    return slides;
  }

  _getMilesComparison(miles) {
    const comparisons = [
      { threshold: 50, text: "that's like driving across a small county" },
      { threshold: 200, text: "that's roughly LA to San Diego" },
      { threshold: 500, text: "that's like LA to San Francisco" },
      { threshold: 1000, text: "that's roughly Chicago to Nashville" },
      { threshold: 2000, text: "that's like New York to Miami" },
      { threshold: 3000, text: "that's roughly coast to coast" },
      { threshold: 5000, text: "that's like crossing the US and back" },
      { threshold: 10000, text: "that's nearly halfway around the Earth" },
      { threshold: 25000, text: "that's roughly around the entire Earth" },
    ];
    for (let i = comparisons.length - 1; i >= 0; i--) {
      if (miles >= comparisons[i].threshold) return comparisons[i].text;
    }
    return "every mile counts";
  }

  // --- Rendering ---

  _render() {
    if (this._container) {
      this.close({ immediate: true });
    }

    const el = document.createElement("div");
    el.className = "wrapped-overlay";
    el.innerHTML = `
      <div class="wrapped-inner">
        <button class="wrapped-close" aria-label="Close" type="button">
          <i class="fas fa-times"></i>
        </button>
        <div class="wrapped-slide-container"></div>
        <div class="wrapped-nav">
          <div class="wrapped-dots"></div>
          <div class="wrapped-nav-buttons">
            <button class="wrapped-prev" aria-label="Previous slide" type="button">
              <i class="fas fa-arrow-left"></i>
            </button>
            <button class="wrapped-next" aria-label="Next slide" type="button">
              <i class="fas fa-arrow-right"></i>
            </button>
          </div>
        </div>
      </div>
    `;

    document.body.appendChild(el);
    this._container = el;

    requestAnimationFrame(() => {
      el.classList.add("wrapped-visible");
      this._renderSlide(0);
      this._renderDots();
    });
  }

  _renderSlide(index) {
    const slideContainer = this._container?.querySelector(".wrapped-slide-container");
    if (!slideContainer) return;

    const slide = this._slides[index];
    if (!slide) return;

    this._currentSlide = index;
    this._renderDots();

    let content = "";

    if (slide.type === "list" && slide.items) {
      const itemsHtml = slide.items
        .map(
          (item) => `
        <div class="wrapped-list-item">
          <span class="wrapped-rank">${item.rank}</span>
          <span class="wrapped-item-name">${this._escapeHtml(item.name)}</span>
          <span class="wrapped-item-detail">${this._escapeHtml(item.detail)}</span>
        </div>
      `
        )
        .join("");
      content = `
        <div class="wrapped-slide" style="--slide-accent: ${slide.accent}">
          <div class="wrapped-slide-icon"><i class="fas ${slide.icon}"></i></div>
          <div class="wrapped-pretitle">${this._escapeHtml(slide.pretitle)}</div>
          <div class="wrapped-list">${itemsHtml}</div>
        </div>
      `;
    } else {
      content = `
        <div class="wrapped-slide ${slide.type === "intro" ? "wrapped-slide-intro" : ""} ${slide.type === "finale" ? "wrapped-slide-finale" : ""}" style="--slide-accent: ${slide.accent}">
          <div class="wrapped-slide-icon"><i class="fas ${slide.icon}"></i></div>
          <div class="wrapped-pretitle">${this._escapeHtml(slide.pretitle)}</div>
          <div class="wrapped-title">${this._escapeHtml(slide.title)}</div>
          ${slide.subtitle ? `<div class="wrapped-subtitle">${this._escapeHtml(slide.subtitle)}</div>` : ""}
        </div>
      `;
    }

    // Fade transition
    slideContainer.style.opacity = "0";
    slideContainer.style.transform = "translateY(12px)";
    setTimeout(() => {
      slideContainer.innerHTML = content;
      slideContainer.style.transition = "opacity 400ms ease, transform 400ms ease";
      slideContainer.style.opacity = "1";
      slideContainer.style.transform = "translateY(0)";
    }, 150);

    // Update nav button visibility
    const prevBtn = this._container?.querySelector(".wrapped-prev");
    const nextBtn = this._container?.querySelector(".wrapped-next");
    if (prevBtn) prevBtn.style.visibility = index > 0 ? "visible" : "hidden";
    if (nextBtn) nextBtn.textContent = index < this._slides.length - 1 ? "" : "";
    if (nextBtn) {
      nextBtn.innerHTML =
        index < this._slides.length - 1
          ? '<i class="fas fa-arrow-right"></i>'
          : '<i class="fas fa-check"></i>';
    }
  }

  _renderDots() {
    const dotsContainer = this._container?.querySelector(".wrapped-dots");
    if (!dotsContainer) return;
    dotsContainer.innerHTML = this._slides
      .map(
        (_, i) =>
          `<span class="wrapped-dot ${i === this._currentSlide ? "active" : ""}"></span>`
      )
      .join("");
  }

  _bindControls() {
    if (!this._container) return;

    this._container.querySelector(".wrapped-close")?.addEventListener("click", () => this.close());
    this._container.querySelector(".wrapped-prev")?.addEventListener("click", () => this._prev());
    this._container.querySelector(".wrapped-next")?.addEventListener("click", () => {
      if (this._currentSlide >= this._slides.length - 1) {
        this.close();
      } else {
        this._next();
      }
    });

    // Keyboard
    this._keyHandler = (e) => {
      if (e.key === "ArrowRight" || e.key === " ") {
        e.preventDefault();
        this._next();
      } else if (e.key === "ArrowLeft") {
        e.preventDefault();
        this._prev();
      } else if (e.key === "Escape") {
        this.close();
      }
    };
    document.addEventListener("keydown", this._keyHandler);

    // Touch swipe
    this._container.addEventListener("touchstart", (e) => {
      this._touchStartY = e.touches[0].clientX;
    }, { passive: true });

    this._container.addEventListener("touchend", (e) => {
      const diff = e.changedTouches[0].clientX - this._touchStartY;
      if (Math.abs(diff) > 50) {
        if (diff < 0) this._next();
        else this._prev();
      }
    }, { passive: true });
  }

  _next() {
    if (this._currentSlide < this._slides.length - 1) {
      this._renderSlide(this._currentSlide + 1);
    }
  }

  _prev() {
    if (this._currentSlide > 0) {
      this._renderSlide(this._currentSlide - 1);
    }
  }

  _escapeHtml(str) {
    if (!str) return "";
    const div = document.createElement("div");
    div.textContent = str;
    return div.innerHTML;
  }
}

const wrappedExperience = new WrappedExperience();
export default wrappedExperience;
