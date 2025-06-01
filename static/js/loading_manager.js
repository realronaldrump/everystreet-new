class LoadingManager {
  constructor() {
    this.elements = {
      overlay: null,
      text: null,
      bar: null,
      spinner: null,
    };

    this.operations = new Map();
    this.isVisible = false;
    this.minimumShowTime = 500; // Minimum time to show overlay
    this.showStartTime = null;
    this.pendingHide = false;
    this.initialized = false;
    
    // Track different loading stages
    this.stages = {
      init: { weight: 10, status: 'pending' },
      map: { weight: 30, status: 'pending' },
      data: { weight: 40, status: 'pending' },
      render: { weight: 20, status: 'pending' }
    };

    // Initialize on DOM ready
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', () => this.init());
    } else {
      this.init();
    }
  }

  init() {
    if (this.initialized) return;
    
    this.elements.overlay = document.querySelector('.loading-overlay');
    this.elements.text = document.getElementById('loading-text') || 
                         document.querySelector('.loading-text');
    this.elements.bar = document.getElementById('loading-progress-bar') || 
                        document.querySelector('.progress-bar');
    this.elements.spinner = document.querySelector('.loading-spinner');
    
    this.initialized = true;
    
    // Create overlay if it doesn't exist
    if (!this.elements.overlay) {
      this.createOverlay();
    }
  }

  createOverlay() {
    const overlay = document.createElement('div');
    overlay.className = 'loading-overlay';
    overlay.setAttribute('role', 'status');
    overlay.setAttribute('aria-live', 'polite');
    overlay.innerHTML = `
      <div class="loading-content">
        <div class="loading-spinner" aria-hidden="true">
          <div class="spinner-ring"></div>
          <div class="spinner-ring"></div>
          <div class="spinner-ring"></div>
        </div>
        <div class="loading-text">Initializing...</div>
        <div class="loading-progress" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow="0">
          <div class="progress-bar" id="loading-progress-bar"></div>
        </div>
        <div class="loading-details"></div>
      </div>
    `;
    
    document.body.appendChild(overlay);
    
    // Update element references
    this.elements.overlay = overlay;
    this.elements.text = overlay.querySelector('.loading-text');
    this.elements.bar = overlay.querySelector('.progress-bar');
    this.elements.spinner = overlay.querySelector('.loading-spinner');
    this.elements.details = overlay.querySelector('.loading-details');
  }

  // Start a loading stage
  startStage(stageName, message) {
    if (!this.stages[stageName]) {
      this.stages[stageName] = { weight: 10, status: 'pending' };
    }
    
    this.stages[stageName].status = 'loading';
    this.stages[stageName].message = message;
    
    this._showOverlay(message || `Loading ${stageName}...`);
    this.updateProgress();
    
    return {
      update: (progress, msg) => this.updateStage(stageName, progress, msg),
      complete: () => this.completeStage(stageName),
      error: (msg) => this.stageError(stageName, msg)
    };
  }

  updateStage(stageName, progress, message) {
    if (!this.stages[stageName]) return;
    
    this.stages[stageName].progress = Math.min(100, Math.max(0, progress));
    if (message) {
      this.stages[stageName].message = message;
    }
    
    this.updateProgress();
  }

  completeStage(stageName) {
    if (!this.stages[stageName]) return;
    
    this.stages[stageName].status = 'complete';
    this.stages[stageName].progress = 100;
    
    this.updateProgress();
    
    // Check if all stages are complete
    const allComplete = Object.values(this.stages).every(
      stage => stage.status === 'complete' || stage.status === 'skipped'
    );
    
    if (allComplete) {
      this._completeOverlay();
    }
  }

  stageError(stageName, message) {
    if (!this.stages[stageName]) return;
    
    this.stages[stageName].status = 'error';
    this.stages[stageName].error = message;
    
    this.error(message, stageName);
  }

  updateProgress() {
    const stages = Object.entries(this.stages);
    const totalWeight = stages.reduce((sum, [_, stage]) => sum + stage.weight, 0);
    
    let weightedProgress = 0;
    let currentStage = null;
    let detailsHtml = '<div class="loading-stages">';
    
    stages.forEach(([name, stage]) => {
      const progress = stage.progress || 0;
      const stageProgress = stage.status === 'complete' ? 100 : 
                           stage.status === 'error' ? 0 : progress;
      
      weightedProgress += (stageProgress / 100) * stage.weight;
      
      // Build details HTML
      const statusIcon = stage.status === 'complete' ? '✓' : 
                        stage.status === 'error' ? '✗' : 
                        stage.status === 'loading' ? '⟳' : '○';
      
      const statusClass = stage.status === 'complete' ? 'text-success' : 
                         stage.status === 'error' ? 'text-danger' : 
                         stage.status === 'loading' ? 'text-primary' : 'text-muted';
      
      detailsHtml += `
        <div class="loading-stage ${statusClass} small">
          <span class="stage-icon">${statusIcon}</span>
          <span class="stage-name">${name}</span>
        </div>
      `;
      
      if (stage.status === 'loading' && !currentStage) {
        currentStage = stage;
      }
    });
    
    detailsHtml += '</div>';
    
    const overallPercentage = Math.round((weightedProgress / totalWeight) * 100);
    const message = currentStage?.message || 'Loading...';
    
    this._updateOverlayProgress(overallPercentage, message);
    
    if (this.elements.details) {
      this.elements.details.innerHTML = detailsHtml;
    }
  }

  // Legacy method support
  startOperation(name, total = 100) {
    if (!name) {
      console.warn('Operation name is required');
      return this;
    }

    this.operations.set(name, {
      total,
      progress: 0,
      startTime: Date.now(),
      message: `Loading ${name}...`,
    });

    this._showOverlay(`Loading ${name}...`);
    return this;
  }

  updateOperation(name, progress, message) {
    const operation = this.operations.get(name);
    if (!operation) return this;

    operation.progress = Math.min(Math.max(0, progress), operation.total);
    if (message) operation.message = message;

    const overallProgress = this._calculateOverallProgress();
    this._updateOverlayProgress(overallProgress, message || operation.message);
    
    return this;
  }

  _calculateOverallProgress() {
    if (this.operations.size === 0) return 0;
    
    const operations = Array.from(this.operations.values());
    const totalWeight = operations.reduce((sum, op) => sum + op.total, 0);
    const weightedProgress = operations.reduce(
      (sum, op) => sum + (op.progress / op.total) * op.total,
      0
    );
    
    return Math.round((weightedProgress / totalWeight) * 100);
  }

  show(message = 'Loading...', immediate = false) {
    this._showOverlay(message, immediate);
    return this;
  }

  hide() {
    this.finish();
    return this;
  }

  finish(name) {
    if (name) {
      this.operations.delete(name);
      if (this.operations.size > 0) {
        const progress = this._calculateOverallProgress();
        this._updateOverlayProgress(progress);
        return this;
      }
    } else {
      this.operations.clear();
    }

    this._completeOverlay();
    return this;
  }

  error(message, context = null, autoHide = true) {
    if (!this.initialized) this.init();
    
    console.error(`Loading Error: ${message}${context ? ` in ${context}` : ''}`);

    this._showOverlay(`Error: ${message}`, true);
    
    if (this.elements.text) {
      this.elements.text.classList.add('text-danger');
    }

    if (this.elements.bar) {
      this.elements.bar.classList.remove('bg-primary', 'bg-success');
      this.elements.bar.classList.add('bg-danger');
    }

    if (autoHide) {
      setTimeout(() => this._hideOverlay(), 3000);
    }

    return this;
  }

  _showOverlay(message, immediate = false) {
    if (!this.initialized) this.init();
    
    const { overlay, text, bar, spinner } = this.elements;
    if (!overlay) return;

    // Clear any pending hide
    this.pendingHide = false;
    
    if (!this.isVisible) {
      this.showStartTime = Date.now();
      overlay.style.display = 'flex';
      overlay.style.opacity = '0';
      
      // Force reflow
      overlay.offsetHeight;
      
      // Fade in
      overlay.style.transition = immediate ? 'none' : 'opacity 0.3s ease-in-out';
      overlay.style.opacity = '1';
      
      this.isVisible = true;
    }

    if (text) {
      text.textContent = message;
      text.classList.remove('text-danger');
    }

    if (bar) {
      bar.style.width = '0%';
      bar.setAttribute('aria-valuenow', '0');
      bar.classList.remove('bg-danger', 'bg-success');
      bar.classList.add('bg-primary');
    }

    if (spinner) {
      spinner.classList.add('active');
    }
  }

  _updateOverlayProgress(percentage, message) {
    if (!this.initialized) return;
    
    const { text, bar } = this.elements;
    if (!text || !bar) return;

    const pct = Math.min(Math.round(percentage), 100);
    
    if (message) {
      text.textContent = message;
    }
    
    bar.style.width = `${pct}%`;
    bar.setAttribute('aria-valuenow', pct);

    if (pct >= 100) {
      bar.classList.remove('bg-primary');
      bar.classList.add('bg-success');
    }
  }

  _completeOverlay() {
    const { bar, text } = this.elements;

    if (bar) {
      bar.style.width = '100%';
      bar.setAttribute('aria-valuenow', '100');
      bar.classList.remove('bg-primary');
      bar.classList.add('bg-success');
    }

    if (text) {
      text.textContent = 'Complete!';
    }

    // Ensure minimum show time
    const elapsed = this.showStartTime ? Date.now() - this.showStartTime : Infinity;
    const remainingTime = Math.max(0, this.minimumShowTime - elapsed);
    
    setTimeout(() => this._hideOverlay(), remainingTime + 300);
  }

  _hideOverlay() {
    if (!this.initialized || !this.isVisible) return;
    
    const { overlay, spinner } = this.elements;
    if (!overlay) return;

    overlay.style.opacity = '0';
    
    setTimeout(() => {
      if (overlay.style.opacity === '0') {
        overlay.style.display = 'none';
        this.isVisible = false;
        this.showStartTime = null;
        
        // Reset stages for next load
        Object.keys(this.stages).forEach(stage => {
          this.stages[stage].status = 'pending';
          this.stages[stage].progress = 0;
        });
        
        if (spinner) {
          spinner.classList.remove('active');
        }
        
        // Reset text colors
        if (this.elements.text) {
          this.elements.text.classList.remove('text-danger', 'text-success');
        }
        
        if (this.elements.bar) {
          this.elements.bar.classList.remove('bg-danger', 'bg-success');
          this.elements.bar.classList.add('bg-primary');
        }
      }
    }, 300);
  }

  // New method for quick status updates
  pulse(message, duration = 2000) {
    const pulseEl = document.createElement('div');
    pulseEl.className = 'loading-pulse';
    pulseEl.textContent = message;
    document.body.appendChild(pulseEl);
    
    // Trigger animation
    requestAnimationFrame(() => {
      pulseEl.classList.add('show');
      setTimeout(() => {
        pulseEl.classList.remove('show');
        setTimeout(() => pulseEl.remove(), 300);
      }, duration);
    });
  }

  // Add sub-operation tracking for legacy API compatibility
  addSubOperation(name, total = 100) {
    // Treat sub-operations as operations for legacy compatibility
    this.startOperation(name, total);
    return this;
  }

  updateSubOperation(name, progress, message) {
    // Update progress of the sub-operation (operation)
    this.updateOperation(name, typeof progress === 'number' ? progress : 0, message);
    return this;
  }
}

// Create and export singleton instance
if (!window.loadingManager || typeof window.loadingManager.startStage !== 'function') {
  window.loadingManager = new LoadingManager();
}

// Legacy function support
window.showLoadingOverlay = (message) => window.loadingManager.show(message);
window.hideLoadingOverlay = () => window.loadingManager.hide();