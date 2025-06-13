import utils from '../ui-utils.js';
import { UI_CONFIG as CONFIG } from '../ui-config.js';
import uiState from '../ui-state.js';
import eventManager from './event-manager.js';
import themeManager from './theme-manager.js';
import panelManager from './panel-manager.js';
import dateManager from './date-manager.js';
import mapControlsManager from './map-controls-manager.js';
import filterIndicatorManager from './filter-indicator-manager.js';
import perf from './performance-optimisations.js';

function init() {
  if (uiState.initialized) return;

  try {
    themeManager.init();
    panelManager.init();
    mapControlsManager.init?.();
    filterIndicatorManager.init?.();
    perf.init?.();

    // Defer heavier init (date pickers & events)
    const runDeferred = () => {
      dateManager.init?.();
      // setupEvents still lives in legacy script; if extracted add here.
    };
    if ('requestIdleCallback' in window) {
      requestIdleCallback(runDeferred, { timeout: 1000 });
    } else {
      setTimeout(runDeferred, 100);
    }

    uiState.initialized = true;
    document.dispatchEvent(new CustomEvent('modernUIReady'));
  } catch (err) {
    console.error('Modern UI init error', err);
    utils.showNotification?.(`Error initializing UI: ${err.message}`, 'danger');
  }
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
}

export default { init }; 