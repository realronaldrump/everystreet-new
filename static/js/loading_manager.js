// static/js/loading_manager.js

class LoadingManager {
  constructor() {
    // Elements for showing/hiding an overlay
    this.overlay = document.querySelector(".loading-overlay");
    this.loadingText = document.getElementById("loading-text");
    this.loadingBar = document.getElementById("loading-bar");

    // Support for sub-operations across multiple named operations
    // This merges the approach from app.js:
    this.operations = {};
    this.totalProgress = 0;
  }

  /**
   * Begin a named operation, e.g. "Fetching and Displaying Trips".
   * @param {string} name  - The name of this operation.
   * @param {number} total - (Optional) The total "weight" or total progress steps for this operation.
   */
  startOperation(name, total = 100) {
    this.operations[name] = {
      total,
      progress: 0,
      subOperations: {},
    };
    this.updateOverallProgress();
    this._showOverlay(name);
  }

  /**
   * Add a sub-operation to a given named operation.
   * e.g. addSubOperation("fetch", "Fetching Data", 50)
   */
  addSubOperation(opName, subName, total) {
    if (this.operations[opName]) {
      this.operations[opName].subOperations[subName] = {
        total,
        progress: 0,
      };
    }
  }

  /**
   * Update the progress value of a specific sub-operation.
   * e.g. updateSubOperation("fetch", "Fetching Data", 25)
   */
  updateSubOperation(opName, subName, progress) {
    const op = this.operations[opName];
    if (op?.subOperations[subName]) {
      op.subOperations[subName].progress = progress;
      this._updateOperationProgress(opName);
    }
  }

  /**
   * Finish a named operation (or all operations if name not provided).
   */
  finish(name) {
    if (name) {
      delete this.operations[name];
    } else {
      this.operations = {};
    }
    this.updateOverallProgress();

    if (!Object.keys(this.operations).length) {
      this._hideOverlay();
    }
  }

  /**
   * Internal: Recalculate the progress for a named operation's sub-operations.
   */
  _updateOperationProgress(opName) {
    const op = this.operations[opName];
    if (!op) return;

    // Summation of subOperation progress
    const subOps = Object.values(op.subOperations);
    if (!subOps.length) return; // no sub-ops => no partial progress to sum

    // Weighted approach:
    const subProgress = subOps.reduce((acc, sub) => {
      return acc + (sub.progress / sub.total) * (sub.total / op.total);
    }, 0);

    op.progress = subProgress * op.total;
    this.updateOverallProgress();
  }

  /**
   * Internal: Re-summarize overall progress across all operations.
   */
  updateOverallProgress() {
    // Summation of op.progress, each normalized out of 100
    this.totalProgress = Object.values(this.operations).reduce(
      (acc, op) => acc + op.progress / 100,
      0
    );

    // Next, compute the final percentage
    const opCount = Object.keys(this.operations).length || 1;
    const overallPercentage = (this.totalProgress / opCount) * 100;

    this._updateOverlayProgress(overallPercentage);
  }

  /**
   * Internal: Show the overlay with a message.
   */
  _showOverlay(message) {
    if (this.overlay && this.loadingText && this.loadingBar) {
      this.overlay.style.display = "flex";
      this.loadingText.textContent = `${message}: 0%`;
      this.loadingBar.style.width = "0%";
      this.loadingBar.setAttribute("aria-valuenow", "0");
    }
  }

  /**
   * Internal: Update the overlay's visual progress bar.
   */
  _updateOverlayProgress(percentage, message) {
    if (!this.loadingText || !this.loadingBar) return;

    const currentMsg = message || this.loadingText.textContent.split(":")[0];
    const pct = Math.round(percentage);
    this.loadingText.textContent = `${currentMsg}: ${pct}%`;
    this.loadingBar.style.width = `${pct}%`;
    this.loadingBar.setAttribute("aria-valuenow", pct);
  }

  /**
   * Internal: Hide the overlay fully.
   */
  _hideOverlay() {
    if (this.overlay) {
      setTimeout(() => {
        this.overlay.style.display = "none";
      }, 500);
    }
  }

  /**
   * If any unrecoverable error occurs.
   */
  error(message) {
    console.error("Loading Error:", message);
    if (this.loadingText) {
      this.loadingText.textContent = `Error: ${message}`;
    }
  }
}

// Create/Export a global instance
window.loadingManager = new LoadingManager();
