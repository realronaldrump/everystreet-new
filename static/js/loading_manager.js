/**
 * LoadingManager - Manages loading states and progress for async operations
 */
class LoadingManager {
  /**
   * Initialize a new loading manager
   */
  constructor() {
    // Cache DOM elements
    this.elements = {
      overlay: document.querySelector('.loading-overlay'),
      text: document.getElementById('loading-text'),
      bar: document.getElementById('loading-bar')
    };
    
    this.operations = {};
    this.isVisible = false;
    this.errorTimeout = null;
  }

  /**
   * Start a new operation with a specified weight
   * @param {string} name - Operation identifier
   * @param {number} total - Total weight of the operation
   * @returns {LoadingManager} This instance for chaining
   */
  startOperation(name, total = 100) {
    if (!name) {
      console.warn('Operation name is required');
      return this;
    }
    
    this.operations[name] = { 
      total, 
      progress: 0,
      subOperations: {},
      startTime: Date.now()
    };
    
    this._showOverlay(name);
    this.updateOverallProgress();
    
    return this;
  }

  /**
   * Add a sub-operation to an existing operation
   * @param {string} opName - Parent operation name
   * @param {string} subName - Sub-operation name
   * @param {number} total - Weight of the sub-operation
   * @returns {LoadingManager} This instance for chaining
   */
  addSubOperation(opName, subName, total) {
    if (!this.operations[opName]) {
      console.warn(`Parent operation "${opName}" not found`);
      return this;
    }
    
    this.operations[opName].subOperations[subName] = { total, progress: 0 };
    return this;
  }

  /**
   * Update progress of a sub-operation
   * @param {string} opName - Parent operation name
   * @param {string} subName - Sub-operation name
   * @param {number} progress - Current progress
   * @returns {LoadingManager} This instance for chaining
   */
  updateSubOperation(opName, subName, progress) {
    const op = this.operations[opName];
    if (!op) {
      console.warn(`Operation "${opName}" not found`);
      return this;
    }
    
    const subOp = op.subOperations[subName];
    if (!subOp) {
      console.warn(`Sub-operation "${subName}" not found in "${opName}"`);
      return this;
    }
    
    subOp.progress = Math.min(Math.max(0, progress), subOp.total);
    this._updateOperationProgress(opName);
    
    return this;
  }

  /**
   * Update operation progress directly
   * @param {string} name - Operation name
   * @param {number} progress - Current progress
   * @returns {LoadingManager} This instance for chaining
   */
  updateOperation(name, progress) {
    const op = this.operations[name];
    if (!op) {
      console.warn(`Operation "${name}" not found`);
      return this;
    }
    
    op.progress = Math.min(Math.max(0, progress), op.total);
    this.updateOverallProgress();
    
    return this;
  }

  /**
   * Mark an operation or all operations as finished
   * @param {string} [name] - Operation name (if omitted, all operations are finished)
   * @returns {LoadingManager} This instance for chaining
   */
  finish(name) {
    if (name) {
      delete this.operations[name];
    } else {
      this.operations = {};
    }
    
    this.updateOverallProgress();
    
    if (Object.keys(this.operations).length === 0) {
      this._hideOverlay();
    }
    
    return this;
  }

  /**
   * Report an error for an operation
   * @param {string} message - Error message
   * @param {string} [opName] - Associated operation name
   * @param {boolean} [autoHide=true] - Whether to auto-hide the overlay
   * @returns {LoadingManager} This instance for chaining
   */
  error(message, opName = null, autoHide = true) {
    console.error('Loading Error:', message, opName ? `in ${opName}` : '');
    
    if (this.elements.text) {
      this.elements.text.textContent = `Error: ${message}`;
      this.elements.text.classList.add('text-danger');
    }
    
    if (opName) {
      delete this.operations[opName];
    }
    
    // Clear any existing timeout
    if (this.errorTimeout) {
      clearTimeout(this.errorTimeout);
      this.errorTimeout = null;
    }
    
    // Auto-hide if requested
    if (autoHide) {
      this.errorTimeout = setTimeout(() => {
        this._hideOverlay();
        this.errorTimeout = null;
        
        // Reset error styling
        if (this.elements.text) {
          this.elements.text.classList.remove('text-danger');
        }
      }, 3000);
    }
    
    return this;
  }

  /**
   * Calculate and update the overall progress
   */
  updateOverallProgress() {
    const ops = Object.values(this.operations);
    if (ops.length === 0) return;
    
    const totalWeight = ops.reduce((sum, op) => sum + op.total, 0);
    const weightedProgress = ops.reduce((sum, op) => sum + (op.progress / op.total) * op.total, 0);
    
    const overallPercentage = (weightedProgress / totalWeight) * 100;
    this._updateOverlayProgress(overallPercentage);
  }

  /**
   * Update operation progress based on sub-operations
   * @param {string} opName - Operation name
   * @private
   */
  _updateOperationProgress(opName) {
    const op = this.operations[opName];
    if (!op) return;
    
    const subOps = Object.values(op.subOperations);
    if (subOps.length === 0) return;
    
    const totalSubWeight = subOps.reduce((sum, sub) => sum + sub.total, 0);
    const subProgress = subOps.reduce((sum, sub) => sum + (sub.progress / sub.total) * sub.total, 0);
    
    op.progress = totalSubWeight > 0 ? (subProgress / totalSubWeight) * op.total : 0;
    this.updateOverallProgress();
  }

  /**
   * Show the loading overlay
   * @param {string} message - Loading message
   * @private
   */
  _showOverlay(message) {
    const { overlay, text, bar } = this.elements;
    
    if (!overlay) {
      console.warn('Loading overlay not found in DOM');
      return;
    }
    
    if (!this.isVisible) {
      overlay.style.display = 'flex';
      this.isVisible = true;
    }
    
    if (text) {
      text.textContent = `${message}: 0%`;
      text.classList.remove('text-danger');
    }
    
    if (bar) {
      bar.style.width = '0%';
      bar.setAttribute('aria-valuenow', '0');
    }
  }

  /**
   * Update the progress display
   * @param {number} percentage - Progress percentage
   * @param {string} [message] - Optional updated message
   * @private
   */
  _updateOverlayProgress(percentage, message) {
    const { text, bar } = this.elements;
    if (!text || !bar) return;
    
    const pct = Math.min(Math.round(percentage), 100);
    const currentMsg = message || (text.textContent.split(':')[0] || 'Loading');
    
    text.textContent = `${currentMsg}: ${pct}%`;
    bar.style.width = `${pct}%`;
    bar.setAttribute('aria-valuenow', pct);
  }

  /**
   * Hide the loading overlay
   * @private
   */
  _hideOverlay() {
    const { overlay } = this.elements;
    if (!overlay || !this.isVisible) return;
    
    // Use setTimeout to allow CSS transitions to complete
    setTimeout(() => {
      overlay.style.display = 'none';
      this.isVisible = false;
    }, 300);
  }
}

// Create and expose global instance
window.loadingManager = new LoadingManager();
