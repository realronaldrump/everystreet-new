class VisitsUIManager {
  constructor(visitsManager) {
    this.manager = visitsManager;
    this.isDetailedView = false;
    this.sectionDisplayState = new Map();
  }

  _getDetailViewContainer() {
    return document.getElementById("trips-section");
  }

  _setMainContentVisible(isVisible) {
    const sections = document.querySelectorAll(".visits-section");
    if (!sections.length) {
      return;
    }

    if (isVisible) {
      sections.forEach((section) => {
        if (section.id === "trips-section") {
          return;
        }
        if (!this.sectionDisplayState.has(section)) {
          return;
        }
        section.style.display = this.sectionDisplayState.get(section);
      });
      this.sectionDisplayState.clear();
      return;
    }

    this.sectionDisplayState.clear();
    sections.forEach((section) => {
      if (section.id === "trips-section") {
        return;
      }
      this.sectionDisplayState.set(section, section.style.display);
      section.style.display = "none";
    });
  }

  _setDetailContentVisible(isVisible) {
    const detailViewContainer = this._getDetailViewContainer();
    if (!detailViewContainer) {
      return;
    }

    detailViewContainer.classList.toggle("hidden", !isVisible);
    detailViewContainer.style.display = isVisible ? "block" : "none";
  }

  async toggleView(placeId = null) {
    if (placeId) {
      this._setMainContentVisible(false);
      this._setDetailContentVisible(true);
      this.isDetailedView = true;
      await this.manager.showTripsForPlace(placeId);
      return;
    }

    this._setDetailContentVisible(false);
    this._setMainContentVisible(true);
    this.isDetailedView = false;
  }
}

export default VisitsUIManager;
