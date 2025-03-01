/**
 * LoadingManager - Manages loading states and progress for async operations
 * @class
 */
class LoadingManager {
  /**
   * Creates a new loading manager instance
   */
  constructor() {
    // Cache DOM elements
    this.elements = {
      overlay: document.querySelector(".loading-overlay"),
      text: document.getElementById("loading-text"),
      bar: document.getElementById("loading-progress-bar"),
    };

    // State variables
    this.operations = new Map();
    this.isVisible = false;
    this.errorTimeout = null;
    this.updateInterval = null;
    this.fadeTimeout = null;
  }

  /**
   * Start a new operation with a specified weight
   * @param {string} name - Operation identifier
   * @param {number} [total=100] - Total weight of the operation
   * @returns {LoadingManager} This instance for chaining
   */
  startOperation(name, total = 100) {
    if (!name) {
      console.warn("Operation name is required");
      return this;
    }

    this.operations.set(name, {
      total,
      progress: 0,
      subOperations: new Map(),
      startTime: Date.now(),
      message: `Starting ${name}...`,
    });

    this._showOverlay(`Starting ${name}...`);
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
    const operation = this.operations.get(opName);

    if (!operation) {
      console.warn(`Parent operation "${opName}" not found`);
      return this;
    }

    operation.subOperations.set(subName, {
      total,
      progress: 0,
      message: `Starting ${subName}...`,
    });

    return this;
  }

  /**
   * Update progress of a sub-operation
   * @param {string} opName - Parent operation name
   * @param {string} subName - Sub-operation name
   * @param {number} progress - Current progress
   * @param {string} [message] - Optional progress message
   * @returns {LoadingManager} This instance for chaining
   */
  updateSubOperation(opName, subName, progress, message) {
    const operation = this.operations.get(opName);

    if (!operation) {
      console.warn(`Operation "${opName}" not found`);
      return this;
    }

    const subOp = operation.subOperations.get(subName);

    if (!subOp) {
      console.warn(`Sub-operation "${subName}" not found in "${opName}"`);
      return this;
    }

    subOp.progress = Math.min(Math.max(0, progress), subOp.total);

    if (message) {
      subOp.message = message;
    }

    this._updateOperationProgress(opName);

    return this;
  }

  /**
   * Update operation progress directly
   * @param {string} name - Operation name
   * @param {number} progress - Current progress
   * @param {string} [message] - Optional progress message
   * @returns {LoadingManager} This instance for chaining
   */
  updateOperation(name, progress, message) {
    const operation = this.operations.get(name);

    if (!operation) {
      console.warn(`Operation "${name}" not found`);
      return this;
    }

    operation.progress = Math.min(Math.max(0, progress), operation.total);

    if (message) {
      operation.message = message;
    }

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
      this.operations.delete(name);
    } else {
      this.operations.clear();
    }

    this.updateOverallProgress();

    if (this.operations.size === 0) {
      this._completeOverlay();
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
    console.error(`Loading Error: ${message}${opName ? ` in ${opName}` : ""}`);

    // Show error in loading overlay
    if (this.elements.text) {
      this.elements.text.textContent = `Error: ${message}`;
      this.elements.text.classList.add("text-danger");
    }

    // Set progress bar to error state
    if (this.elements.bar) {
      this.elements.bar.classList.remove("bg-primary", "bg-success");
      this.elements.bar.classList.add("bg-danger");
    }

    // Clean up operations
    if (opName) {
      this.operations.delete(opName);
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
          this.elements.text.classList.remove("text-danger");
        }

        // Reset progress bar
        if (this.elements.bar) {
          this.elements.bar.classList.remove("bg-danger");
          this.elements.bar.classList.add("bg-primary");
        }
      }, 3000);
    }

    return this;
  }

  /**
   * Calculate and update the overall progress
   */
  updateOverallProgress() {
    const operations = Array.from(this.operations.values());

    if (operations.length === 0) {
      return;
    }

    const totalWeight = operations.reduce((sum, op) => sum + op.total, 0);
    const weightedProgress = operations.reduce(
      (sum, op) => sum + (op.progress / op.total) * op.total,
      0,
    );

    const overallPercentage = Math.min(
      Math.round((weightedProgress / totalWeight) * 100),
      100,
    );

    // Get latest message from most recently updated operation
    const latestOp = operations.reduce(
      (latest, op) =>
        !latest || op.startTime > latest.startTime ? op : latest,
      null,
    );

    const message = latestOp?.message || "Loading...";

    this._updateOverlayProgress(overallPercentage, message);
  }

  /**
   * Update operation progress based on sub-operations
   * @param {string} opName - Operation name
   * @private
   */
  _updateOperationProgress(opName) {
    const operation = this.operations.get(opName);

    if (!operation) return;

    const subOps = Array.from(operation.subOperations.values());

    if (subOps.length === 0) return;

    const totalSubWeight = subOps.reduce((sum, sub) => sum + sub.total, 0);
    const subProgress = subOps.reduce(
      (sum, sub) => sum + (sub.progress / sub.total) * sub.total,
      0,
    );

    // Get message from the sub-operation with the lowest completion percentage
    const lowestCompletionSubOp = subOps.reduce((lowest, current) => {
      const lowestCompletion = lowest ? lowest.progress / lowest.total : 1;
      const currentCompletion = current.progress / current.total;
      return currentCompletion < lowestCompletion ? current : lowest;
    }, null);

    operation.progress =
      totalSubWeight > 0 ? (subProgress / totalSubWeight) * operation.total : 0;

    if (lowestCompletionSubOp) {
      operation.message = lowestCompletionSubOp.message;
    }

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
      console.warn("Loading overlay not found in DOM");
      return;
    }

    if (!this.isVisible) {
      // Clear any fade timeout
      if (this.fadeTimeout) {
        clearTimeout(this.fadeTimeout);
        this.fadeTimeout = null;
      }

      overlay.style.display = "flex";
      this.isVisible = true;

      // Force reflow for animation
      const _ = overlay.offsetHeight;
    }

    if (text) {
      text.textContent = `${message}: 0%`;
      text.classList.remove("text-danger");
    }

    if (bar) {
      bar.style.width = "0%";
      bar.setAttribute("aria-valuenow", "0");
      bar.classList.remove("bg-danger", "bg-success");
      bar.classList.add("bg-primary");
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
    const currentMsg = message || text.textContent.split(":")[0] || "Loading";

    text.textContent = `${currentMsg}: ${pct}%`;
    bar.style.width = `${pct}%`;
    bar.setAttribute("aria-valuenow", pct);

    // Add success class when complete
    if (pct >= 100) {
      bar.classList.remove("bg-primary");
      bar.classList.add("bg-success");
    }
  }

  /**
   * Animate to 100% and prepare to hide the overlay
   * @private
   */
  _completeOverlay() {
    const { bar, text } = this.elements;

    // Set to 100%
    if (bar) {
      bar.style.width = "100%";
      bar.setAttribute("aria-valuenow", "100");
      bar.classList.remove("bg-primary");
      bar.classList.add("bg-success");
    }

    if (text) {
      text.textContent = "Complete: 100%";
    }

    // Hide after a short delay
    setTimeout(() => {
      this._hideOverlay();
    }, 500);
  }

  /**
   * Hide the loading overlay with fade effect
   * @private
   */
  _hideOverlay() {
    const { overlay } = this.elements;

    if (!overlay || !this.isVisible) return;

    // Apply fade-out class if it exists
    overlay.classList.add("fade-out");

    // Use setTimeout to allow CSS transitions to complete
    this.fadeTimeout = setTimeout(() => {
      overlay.style.display = "none";
      overlay.classList.remove("fade-out");
      this.isVisible = false;
      this.fadeTimeout = null;
    }, 300);
  }
}

// Create and expose global instance if it doesn't already exist
if (!window.loadingManager) {
  window.loadingManager = new LoadingManager();
}
