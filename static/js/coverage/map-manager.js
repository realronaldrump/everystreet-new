// static/js/coverage/map-manager.js
class MapManager {
    constructor(apiManager, uiManager) {
      this.api = apiManager;
      this.ui = uiManager;
      this.map = null;
      this.drawingMap = null;
      this.drawingMapDraw = null;
      this.streetsGeoJson = null;
      this.mapBounds = null;
      this.currentFilter = 'all';
      this.showTripsActive = false;
      this.efficientStreetMarkers = [];
      this.mapInfoPanel = null;
      this.coverageSummaryControl = null;
    }
  
    async initializeMap(containerId, coverage) {
      if (!window.MAPBOX_ACCESS_TOKEN) {
        throw new Error('Mapbox access token not configured');
      }
  
      this.cleanup();
      mapboxgl.accessToken = window.MAPBOX_ACCESS_TOKEN;
  
      this.map = new mapboxgl.Map({
        container: containerId,
        style: 'mapbox://styles/mapbox/dark-v11',
        center: [0, 0],
        zoom: 1,
        minZoom: 0,
        maxZoom: 20,
        preserveDrawingBuffer: true,
        attributionControl: false
      });
  
      this.addControls();
      this.setupEventHandlers();
  
      await new Promise(resolve => this.map.on('load', resolve));
  
      if (coverage?.streets_geojson) {
        this.addStreetsToMap(coverage.streets_geojson);
        this.addCoverageSummary(coverage);
        this.fitMapToBounds();
      }
  
      if (this.showTripsActive) {
        this.setupTripLayers();
        this.loadTripsForView();
      }
  
      this.createMapInfoPanel();
      this.createBulkActionToolbar();
  
      return this.map;
    }
  
    addControls() {
      this.map.addControl(new mapboxgl.NavigationControl(), 'top-right');
      this.map.addControl(new mapboxgl.ScaleControl());
      this.map.addControl(new mapboxgl.FullscreenControl());
      this.map.addControl(
        new mapboxgl.AttributionControl({ compact: true }),
        'bottom-right'
      );
    }
  
    setupEventHandlers() {
      let moveEndTimer;
      this.map.on('moveend', () => {
        clearTimeout(moveEndTimer);
        moveEndTimer = setTimeout(() => {
          if (this.showTripsActive) this.loadTripsForView();
          this.saveMapPosition();
        }, 300);
      });
    }
  
    saveMapPosition() {
      const center = this.map.getCenter();
      const zoom = this.map.getZoom();
      localStorage.setItem('lastMapView', JSON.stringify({ center, zoom }));
    }
  
    addStreetsToMap(geojson) {
      this.removeExistingLayers();
      this.streetsGeoJson = geojson;
      this.currentFilter = 'all';
  
      this.map.addSource('streets', {
        type: 'geojson',
        data: geojson,
        promoteId: 'segment_id'
      });
  
      this.map.addLayer({
        id: 'streets-layer',
        type: 'line',
        source: 'streets',
        layout: { 'line-cap': 'round', 'line-join': 'round' },
        paint: {
          'line-color': this.getLineColorExpression(),
          'line-width': this.getLineWidthExpression(),
          'line-opacity': this.getLineOpacityExpression(),
          'line-dasharray': this.getLineDashExpression()
        }
      });
  
      this.calculateBounds(geojson);
      this.setupStreetInteractions();
    }
  
    removeExistingLayers() {
      const layers = ['streets-layer', 'streets-hover-highlight', 'streets-click-highlight', 'streets-selection-highlight'];
      layers.forEach(layerId => {
        if (this.map.getLayer(layerId)) this.map.removeLayer(layerId);
      });
      if (this.map.getSource('streets')) this.map.removeSource('streets');
    }
  
    getLineColorExpression() {
      return [
        'case',
        ['boolean', ['feature-state', 'hover'], false], '#ffff00',
        ['!=', ['feature-state', 'efficientRank'], null], 
        [
          'case',
          ['==', ['feature-state', 'efficientRank'], 1], '#ffd700',
          ['==', ['feature-state', 'efficientRank'], 2], '#c0c0c0',
          ['==', ['feature-state', 'efficientRank'], 3], '#cd7f32',
          '#9467bd'
        ],
        ['boolean', ['get', 'undriveable'], false], '#607d8b',
        ['boolean', ['get', 'driven'], false], '#4caf50',
        '#ff5252'
      ];
    }
  
    getLineWidthExpression() {
      return ['interpolate', ['linear'], ['zoom'], 8, 1.5, 14, 4, 18, 7];
    }
  
    getLineOpacityExpression() {
      return [
        'case',
        ['boolean', ['feature-state', 'hover'], false], 1.0,
        ['boolean', ['get', 'undriveable'], false], 0.6,
        0.85
      ];
    }
  
    getLineDashExpression() {
      return [
        'case',
        ['boolean', ['get', 'undriveable'], false], ['literal', [2, 2]],
        ['literal', [1, 0]]
      ];
    }
  
    setupStreetInteractions() {
      let hoveredSegmentId = null;
  
      this.map.on('mouseenter', 'streets-layer', (e) => {
        this.map.getCanvas().style.cursor = 'pointer';
        if (e.features?.length > 0) {
          const currentId = e.features[0].properties.segment_id;
          if (currentId !== hoveredSegmentId) {
            if (hoveredSegmentId !== null) {
              this.map.setFeatureState({ source: 'streets', id: hoveredSegmentId }, { hover: false });
            }
            this.map.setFeatureState({ source: 'streets', id: currentId }, { hover: true });
            hoveredSegmentId = currentId;
          }
          this.updateMapInfoPanel(e.features[0].properties, true);
          if (this.mapInfoPanel) this.mapInfoPanel.style.display = 'block';
        }
      });
  
      this.map.on('mouseleave', 'streets-layer', () => {
        this.map.getCanvas().style.cursor = '';
        if (this.mapInfoPanel) this.mapInfoPanel.style.display = 'none';
        if (hoveredSegmentId !== null) {
          this.map.setFeatureState({ source: 'streets', id: hoveredSegmentId }, { hover: false });
          hoveredSegmentId = null;
        }
      });
  
      this.map.on('click', 'streets-layer', (e) => this.handleStreetClick(e));
    }
  
    handleStreetClick(e) {
      if (e.originalEvent?.button !== 0) return;
      if (!e.features?.length) return;
  
      const props = e.features[0].properties;
      const isMultiSelect = e.originalEvent?.ctrlKey || e.originalEvent?.metaKey || e.originalEvent?.shiftKey;
  
      if (isMultiSelect) {
        this.toggleSegmentSelection(props.segment_id);
        return;
      }
  
      this.showStreetPopup(e, props);
    }
  
    showStreetPopup(e, props) {
      const popup = new mapboxgl.Popup({
        closeButton: true,
        closeOnClick: true,
        maxWidth: '350px'
      })
      .setLngLat(e.lngLat)
      .setHTML(this.createStreetPopupContent(props))
      .addTo(this.map);
  
      popup.getElement().addEventListener('click', (event) => {
        const button = event.target.closest('button[data-action]');
        if (button) {
          this.handleSegmentAction(button.dataset.action, button.dataset.segmentId);
          popup.remove();
        }
      });
    }
  
    createStreetPopupContent(props) {
      const streetName = props.street_name || props.name || 'Unnamed Street';
      const streetType = props.highway || props.inferred_highway_type || 'unknown';
      const segmentLength = parseFloat(props.segment_length || props.length || 0);
      const isDriven = props.driven === true || String(props.driven).toLowerCase() === 'true';
      const isUndriveable = props.undriveable === true || String(props.undriveable).toLowerCase() === 'true';
      const segmentId = props.segment_id || 'N/A';
  
      return `
        <div class="coverage-popup-content">
          <div class="popup-title">${streetName}</div>
          <div class="popup-detail">
            <span class="popup-label">Type:</span>
            <span class="popup-value">${this.ui.constructor.formatStreetType(streetType)}</span>
          </div>
          <div class="popup-detail">
            <span class="popup-label">Length:</span>
            <span class="popup-value">${this.ui.constructor.distanceInUserUnits(segmentLength)}</span>
          </div>
          <div class="popup-detail">
            <span class="popup-label">Status:</span>
            <span class="popup-value ${isDriven ? 'status-driven' : 'status-undriven'}">
              ${isDriven ? 'Driven' : 'Not Driven'}
            </span>
          </div>
          ${isUndriveable ? `
            <div class="popup-detail">
              <span class="popup-label">Marked as:</span>
              <span class="popup-value status-undriveable">Undriveable</span>
            </div>
          ` : ''}
          <div class="popup-detail">
            <span class="popup-label">ID:</span>
            <span class="popup-value segment-id">${segmentId}</span>
          </div>
          ${this.createSegmentActionButtons(isDriven, isUndriveable, segmentId)}
        </div>
      `;
    }
  
    createSegmentActionButtons(isDriven, isUndriveable, segmentId) {
      const buttons = [];
      
      if (!isDriven) {
        buttons.push(`<button class="btn btn-sm btn-outline-success" data-action="driven" data-segment-id="${segmentId}">
          <i class="fas fa-check me-1"></i>Mark Driven
        </button>`);
      } else {
        buttons.push(`<button class="btn btn-sm btn-outline-danger" data-action="undriven" data-segment-id="${segmentId}">
          <i class="fas fa-times me-1"></i>Mark Undriven
        </button>`);
      }
  
      if (!isUndriveable) {
        buttons.push(`<button class="btn btn-sm btn-outline-warning" data-action="undriveable" data-segment-id="${segmentId}">
          <i class="fas fa-ban me-1"></i>Mark Undriveable
        </button>`);
      } else {
        buttons.push(`<button class="btn btn-sm btn-outline-info" data-action="driveable" data-segment-id="${segmentId}">
          <i class="fas fa-road me-1"></i>Mark Driveable
        </button>`);
      }
  
      return `<div class="street-actions mt-3 d-flex gap-2 flex-wrap">${buttons.join('')}</div>`;
    }
  
    calculateBounds(geojson) {
      const bounds = new mapboxgl.LngLatBounds();
      geojson.features.forEach(feature => {
        const coords = feature.geometry?.coordinates;
        if (!coords) return;
  
        if (feature.geometry.type === 'LineString') {
          coords.forEach(coord => bounds.extend(coord));
        } else if (feature.geometry.type === 'MultiLineString') {
          coords.forEach(line => line.forEach(coord => bounds.extend(coord)));
        }
      });
      this.mapBounds = !bounds.isEmpty() ? bounds : null;
    }
  
    fitMapToBounds() {
      if (this.map && this.mapBounds && !this.mapBounds.isEmpty()) {
        this.map.fitBounds(this.mapBounds, {
          padding: 20,
          maxZoom: 17,
          duration: 800
        });
      }
    }
  
    setMapFilter(filterType) {
      if (!this.map || !this.map.getLayer('streets-layer')) return;
  
      this.currentFilter = filterType;
      const filters = {
        driven: ['all', ['==', ['get', 'driven'], true], ['!=', ['get', 'undriveable'], true]],
        undriven: ['all', ['==', ['get', 'driven'], false], ['!=', ['get', 'undriveable'], true]],
        undriveable: ['==', ['get', 'undriveable'], true],
        all: null
      };
  
      this.map.setFilter('streets-layer', filters[filterType] || null);
    }
  
    // Trip overlay methods
    setupTripLayers() {
      if (!this.map || !this.map.isStyleLoaded()) return;
  
      if (!this.map.getSource('trips-source')) {
        this.map.addSource('trips-source', {
          type: 'geojson',
          data: { type: 'FeatureCollection', features: [] }
        });
      }
  
      if (!this.map.getLayer('trips-layer')) {
        this.map.addLayer({
          id: 'trips-layer',
          type: 'line',
          source: 'trips-source',
          layout: { 'line-join': 'round', 'line-cap': 'round' },
          paint: {
            'line-color': '#3388ff',
            'line-width': 2.5,
            'line-opacity': 0.75,
            'line-blur': 0.5
          }
        }, 'streets-layer');
      }
    }
  
    async loadTripsForView() {
      if (!this.map || !this.showTripsActive || !this.map.isStyleLoaded()) return;
  
      this.setupTripLayers();
      const bounds = this.map.getBounds();
      const zoom = this.map.getZoom();
  
      if (zoom < 12) {
        this.clearTripOverlay();
        return;
      }
  
      try {
        const boundsParams = {
          min_lat: bounds.getSouthWest().lat.toFixed(6),
          min_lon: bounds.getSouthWest().lng.toFixed(6),
          max_lat: bounds.getNorthEast().lat.toFixed(6),
          max_lon: bounds.getNorthEast().lng.toFixed(6)
        };
  
        const data = await this.api.getTripsInBounds(boundsParams);
        const tripFeatures = data.trips
          .filter(coords => Array.isArray(coords) && coords.length >= 2)
          .map((coords, index) => ({
            type: 'Feature',
            properties: { tripId: `trip-${index}` },
            geometry: { type: 'LineString', coordinates: coords }
          }));
  
        this.map.getSource('trips-source').setData({
          type: 'FeatureCollection',
          features: tripFeatures
        });
      } catch (error) {
        console.error('Failed to load trip overlay:', error);
        this.clearTripOverlay();
      }
    }
  
    clearTripOverlay() {
      if (!this.map || !this.map.getSource('trips-source')) return;
      this.map.getSource('trips-source').setData({ type: 'FeatureCollection', features: [] });
    }
  
    toggleTripOverlay(enabled) {
      this.showTripsActive = enabled;
      localStorage.setItem('showTripsOverlay', enabled.toString());
  
      if (enabled) {
        this.setupTripLayers();
        this.loadTripsForView();
      } else {
        this.clearTripOverlay();
      }
    }
  
    // Coverage summary control
    addCoverageSummary(coverage) {
      if (this.coverageSummaryControl) {
        this.map.removeControl(this.coverageSummaryControl);
      }
  
      const coveragePercentage = parseFloat(coverage.coverage_percentage || 0).toFixed(1);
      const totalDist = this.ui.constructor.distanceInUserUnits(coverage.total_length || 0);
      const drivenDist = this.ui.constructor.distanceInUserUnits(coverage.driven_length || 0);
  
      const controlDiv = document.createElement('div');
      controlDiv.className = 'coverage-summary-control mapboxgl-ctrl mapboxgl-ctrl-group';
      controlDiv.innerHTML = `
        <div class="summary-title">Overall Coverage</div>
        <div class="summary-percentage">${coveragePercentage}%</div>
        <div class="summary-progress">
          <div class="progress" style="height: 8px;">
            <div class="progress-bar bg-success" style="width: ${coveragePercentage}%"></div>
          </div>
        </div>
        <div class="summary-details">
          <div>Total: ${totalDist}</div>
          <div>Driven: ${drivenDist}</div>
        </div>
      `;
  
      this.coverageSummaryControl = {
        onAdd: () => controlDiv,
        onRemove: () => controlDiv.remove(),
        getDefaultPosition: () => 'top-left'
      };
  
      this.map.addControl(this.coverageSummaryControl, 'top-left');
    }
  
    // Map info panel
    createMapInfoPanel() {
      if (document.querySelector('.map-info-panel')) return;
  
      this.mapInfoPanel = document.createElement('div');
      this.mapInfoPanel.className = 'map-info-panel';
      this.mapInfoPanel.style.display = 'none';
      
      const mapContainer = document.getElementById('coverage-map');
      if (mapContainer) mapContainer.appendChild(this.mapInfoPanel);
    }
  
    updateMapInfoPanel(props, isHover = false) {
      if (!this.mapInfoPanel) return;
  
      const streetName = props.name || props.street_name || 'Unnamed Street';
      const streetType = props.highway || props.inferred_highway_type || 'unknown';
      const segmentLength = parseFloat(props.segment_length || props.length || 0);
      const isDriven = props.driven === true || String(props.driven).toLowerCase() === 'true';
      const isUndriveable = props.undriveable === true || String(props.undriveable).toLowerCase() === 'true';
      const segmentId = props.segment_id || 'N/A';
  
      this.mapInfoPanel.innerHTML = `
        <strong class="d-block mb-1">${streetName}</strong>
        ${isHover ? '' : '<hr class="panel-divider my-1">'}
        <div class="d-flex justify-content-between small">
          <span class="text-muted">Type:</span>
          <span class="text-info">${this.ui.constructor.formatStreetType(streetType)}</span>
        </div>
        <div class="d-flex justify-content-between small">
          <span class="text-muted">Length:</span>
          <span class="text-info">${this.ui.constructor.distanceInUserUnits(segmentLength)}</span>
        </div>
        <div class="d-flex justify-content-between small">
          <span class="text-muted">Status:</span>
          <span class="${isDriven ? 'text-success' : 'text-danger'}">
            <i class="fas fa-${isDriven ? 'check-circle' : 'times-circle'} me-1"></i>
            ${isDriven ? 'Driven' : 'Not Driven'}
          </span>
        </div>
        ${isUndriveable ? `
          <div class="d-flex justify-content-between small">
            <span class="text-muted">Marked:</span>
            <span class="text-warning">
              <i class="fas fa-exclamation-triangle me-1"></i>Undriveable
            </span>
          </div>
        ` : ''}
        ${!isHover ? `
          <div class="d-flex justify-content-between small mt-1">
            <span class="text-muted">ID:</span>
            <span class="text-muted">${segmentId.substring(0, 12)}...</span>
          </div>
          <div class="mt-2 small text-center text-muted opacity-75">
            Click segment for actions
          </div>
        ` : ''}
      `;
    }
  
    // Bulk action toolbar
    createBulkActionToolbar() {
      if (document.getElementById('bulk-action-toolbar')) return;
  
      const mapContainer = document.getElementById('coverage-map');
      if (!mapContainer) return;
  
      const toolbar = document.createElement('div');
      toolbar.id = 'bulk-action-toolbar';
      toolbar.className = 'bulk-action-toolbar mapboxgl-ctrl mapboxgl-ctrl-group p-2';
      toolbar.style.display = 'none';
  
      toolbar.innerHTML = `
        <span id="bulk-selected-count" class="badge bg-info me-2">0 Selected</span>
        <button class="btn btn-sm btn-outline-success me-1 bulk-mark-btn" data-action="driven" disabled>Mark Driven</button>
        <button class="btn btn-sm btn-outline-danger me-1 bulk-mark-btn" data-action="undriven" disabled>Mark Undriven</button>
        <button class="btn btn-sm btn-outline-warning me-1 bulk-mark-btn" data-action="undriveable" disabled>Mark Undriveable</button>
        <button class="btn btn-sm btn-outline-info me-1 bulk-mark-btn" data-action="driveable" disabled>Mark Driveable</button>
        <button class="btn btn-sm btn-secondary ms-2 bulk-clear-selection-btn" disabled>Clear</button>
      `;
  
      mapContainer.appendChild(toolbar);
    }
  
    // Selection management
    toggleSegmentSelection(segmentId) {
      // This will be handled by the main CoverageManager
      if (this.onSegmentSelection) {
        this.onSegmentSelection(segmentId);
      }
    }
  
    updateSelectionHighlight(selectedIds) {
      if (!this.map || !this.map.getSource('streets')) return;
  
      const layerId = 'streets-selection-highlight';
      if (!this.map.getLayer(layerId)) {
        this.map.addLayer({
          id: layerId,
          type: 'line',
          source: 'streets',
          layout: { 'line-cap': 'round', 'line-join': 'round' },
          paint: {
            'line-color': '#00bcd4',
            'line-width': ['interpolate', ['linear'], ['zoom'], 8, 3, 14, 7],
            'line-opacity': 1
          },
          filter: ['in', 'segment_id', '']
        }, 'streets-layer');
      }
  
      const filter = selectedIds.length === 0 
        ? ['in', 'segment_id', '']
        : ['in', 'segment_id', ...selectedIds];
      
      this.map.setFilter(layerId, filter);
    }
  
    // Cleanup
    cleanup() {
      if (this.map) {
        this.map.remove();
        this.map = null;
      }
      this.cleanupDrawingMap();
      this.clearEfficientStreetMarkers();
    }
  
    cleanupDrawingMap() {
      if (this.drawingMap) {
        this.drawingMap.remove();
        this.drawingMap = null;
        this.drawingMapDraw = null;
      }
    }
  
    clearEfficientStreetMarkers() {
      this.efficientStreetMarkers.forEach(marker => marker.remove());
      this.efficientStreetMarkers = [];
    }
  }