import { UI_CONFIG as CONFIG } from '../ui-config.js';
import uiState from '../ui-state.js';
import utils from '../ui-utils.js';
import eventManager from './event-manager.js';
import panelManager from './panel-manager.js';

const mapControlsManager = {
  init() {
    const mapTypeSelect = uiState.getElement(CONFIG.selectors.mapTypeSelect);
    const opacityRange = uiState.getElement(CONFIG.selectors.basemapOpacityRange);
    if (mapTypeSelect) {
      mapTypeSelect.value = utils.getStorage(CONFIG.storage.mapType) || 'satellite';
      mapTypeSelect.addEventListener('change', (e) => this.updateMapType(e.target.value));
    }
    if (opacityRange) {
      opacityRange.value = utils.getStorage(CONFIG.storage.basemapOpacity) || 0.75;
      opacityRange.addEventListener('input', (e) => this.updateOpacity(parseFloat(e.target.value)));
    }
    const toggleBtn = uiState.getElement(CONFIG.selectors.controlsToggle);
    if (toggleBtn) toggleBtn.addEventListener('click', () => this.toggleControlPanel());

    // Apply persisted settings on load
    this.updateMapType(mapTypeSelect?.value);
    this.updateOpacity(parseFloat(opacityRange?.value || 0.75), false);
  },

  toggleControlPanel() {
    const panel = uiState.getElement(CONFIG.selectors.mapControls);
    if (!panel) return;
    panel.classList.toggle(CONFIG.classes.open);
    const isOpen = panel.classList.contains(CONFIG.classes.open);
    utils.setStorage(CONFIG.storage.mapControlsOpen, isOpen);
    eventManager.emit('mapControlsToggled', { open: isOpen });
  },

  updateMapType(type = 'satellite') {
    const map = window.EveryStreet?.mapManager?.getMap?.();
    if (!map) return;
    utils.setStorage(CONFIG.storage.mapType, type);
    map.setStyle(`mapbox://styles/mapbox/${type}-v12`);
    eventManager.emit('mapTypeChanged', { type });
  },

  updateOpacity(value = 0.75, persist = true) {
    const map = window.EveryStreet?.mapManager?.getMap?.();
    if (!map) return;
    const basemapLayers = ['satellite', 'background', 'land', 'water'];
    basemapLayers.forEach((id) => {
      if (map.getLayer(id)) map.setPaintProperty(id, 'raster-opacity', value);
    });
    if (persist) utils.setStorage(CONFIG.storage.basemapOpacity, value);
    eventManager.emit('basemapOpacityChanged', { value });
  },
};

if (!window.mapControlsManager) window.mapControlsManager = mapControlsManager;
export { mapControlsManager as default }; 