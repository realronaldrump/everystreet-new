import { UI_CONFIG as CONFIG } from '../ui-config.js';
import uiState from '../ui-state.js';
import utils from '../ui-utils.js';
import eventManager from './event-manager.js';
import dateManager from './date-manager.js';
import panelManager from './panel-manager.js';

function ensureIndicator() {
  let indicator = uiState.getElement(CONFIG.selectors.filterIndicator);
  if (!indicator) {
    const tools = uiState.getElement(CONFIG.selectors.toolsSection);
    if (!tools) return null;
    indicator = document.createElement('span');
    indicator.id = 'filter-indicator';
    indicator.className = 'filter-indicator';
    indicator.innerHTML = '<i class="fas fa-calendar-alt me-1" aria-hidden="true"></i> <span class="filter-date-range">—</span>';
    tools.insertBefore(indicator, tools.firstChild.nextSibling); // after filters button
  }
  return indicator;
}

const filterIndicatorManager = {
  init() {
    const indicator = ensureIndicator();
    const filtersBtn = uiState.getElement(CONFIG.selectors.filterToggle);
    if (!indicator || !filtersBtn) return;

    filtersBtn.addEventListener('click', () => {
      indicator.classList.remove(CONFIG.classes.unseen);
    });

    document.addEventListener('filtersApplied', (e) => {
      indicator.classList.remove(CONFIG.classes.active);
      indicator.classList.add(CONFIG.classes.applied);
      indicator.classList.add(CONFIG.classes.unseen);
      dateManager.updateIndicator();
    });

    eventManager.on('filtersReset', () => {
      indicator.classList.remove(CONFIG.classes.applied, CONFIG.classes.unseen);
    });

    // Clicking the indicator or icon opens the filters panel
    eventManager.add(indicator, 'click', (e) => { e.stopPropagation(); panelManager.open('filters'); });
  },
};

if (!window.filterIndicatorManager) window.filterIndicatorManager = filterIndicatorManager;
export { filterIndicatorManager as default }; 