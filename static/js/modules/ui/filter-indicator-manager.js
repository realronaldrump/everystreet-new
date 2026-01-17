import { CONFIG } from "../config.js";
import uiState from "../ui-state.js";
import dateManager from "./date-manager.js";
import eventManager from "./event-manager.js";
import panelManager from "./panel-manager.js";

function ensureIndicator() {
  let indicator = uiState.getElement(CONFIG.UI.selectors.filterIndicator);
  if (!indicator) {
    const tools = uiState.getElement(CONFIG.UI.selectors.toolsSection);
    if (!tools) {
      return null;
    }
    indicator = document.createElement("span");
    indicator.id = "filter-indicator";
    indicator.className = "filter-indicator";
    indicator.innerHTML
      = '<i class="fas fa-calendar-alt me-1" aria-hidden="true"></i> <span class="filter-date-range">—</span>';
    tools.insertBefore(indicator, tools.firstChild.nextSibling); // after filters button
  }
  return indicator;
}

const filterIndicatorManager = {
  init() {
    const indicator = ensureIndicator();
    const filtersBtn = uiState.getElement(CONFIG.UI.selectors.filterToggle);
    if (!indicator || !filtersBtn) {
      return;
    }

    filtersBtn.addEventListener("click", () => {
      indicator.classList.remove(CONFIG.UI.classes.unseen);
    });

    document.addEventListener("filtersApplied", () => {
      indicator.classList.remove(CONFIG.UI.classes.active);
      indicator.classList.add(CONFIG.UI.classes.applied);
      indicator.classList.add(CONFIG.UI.classes.unseen);
      dateManager.updateIndicator();
    });

    eventManager.on("filtersReset", () => {
      indicator.classList.remove(CONFIG.UI.classes.applied, CONFIG.UI.classes.unseen);
    });

    // Clicking the indicator or icon opens the filters panel
    eventManager.add(indicator, "click", (e) => {
      e.stopPropagation();
      panelManager.open("filters");
    });
  },
};

export default filterIndicatorManager;
