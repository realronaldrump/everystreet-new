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
    this.minimumShowTime = 300; // Minimum time to show overlay
    this.showStartTime = null;
    this.pendingHide = false;
    this.initialized = false;
    this.operationCounter = 0;
    this.activeOperations = new Map();
    this.operationQueue = [];
    this.isProcessingQueue = false;
    this.showTimeout = null;
    this.hideTimeout = null;

    // Track different loading stages
    this.stages = {
      init: { weight: 10, status: "pending" },
      map: { weight: 30, status: "pending" },
      data: { weight: 40, status: "pending" },
      render: { weight: 20, status: "pending" },
    };

    // Initialize on DOM ready
    if (document.readyState === "loading") {
      document.addEventListener("DOMContentLoaded", () => this.init());
    } else {
      this.init();
    }
  }

  init() {
    if (this.initialized) return;

    this.elements.overlay = document.querySelector(".loading-overlay");
    this.elements.text =
      document.getElementById("loading-text") ||
      document.querySelector(".loading-text");
    this.elements.bar =
      document.getElementById("loading-progress-bar") ||
      document.querySelector(".progress-bar");
    this.elements.spinner = document.querySelector(".loading-spinner");

    this.initialized = true;

    // Create overlay if it doesn't exist
    if (!this.elements.overlay) {
      this.createOverlay();
    }
  }

  createOverlay() {
    const overlay = document.createElement("div");
    overlay.className = "loading-overlay";
    overlay.style.cssText = `
      position: fixed;
      top: 0;
      left: 0;
      width: 100%;
      height: 100%;
      background: rgba(0, 0, 0, 0.7);
      display: none;
      justify-content: center;
      align-items: center;
      z-index: 9999;
      opacity: 0;
      transition: opacity 0.2s ease-in-out;
    `;

    const content = document.createElement("div");
    content.className = "loading-content";
    content.style.cssText = `
      background: white;
      padding: 20px;
      border-radius: 8px;
      text-align: center;
      min-width: 200px;
    `;

    const spinner = document.createElement("div");
    spinner.className = "loading-spinner";
    spinner.style.cssText = `
      width: 40px;
      height: 40px;
      margin: 0 auto 10px;
      border: 4px solid #f3f3f3;
      border-top: 4px solid #3498db;
      border-radius: 50%;
      animation: spin 1s linear infinite;
    `;

    const text = document.createElement("div");
    text.className = "loading-text";
    text.style.cssText = `
      margin-top: 10px;
      color: #333;
    `;

    const progressBar = document.createElement("div");
    progressBar.className = "loading-progress";
    progressBar.style.cssText = `
      width: 100%;
      height: 4px;
      background: #f3f3f3;
      margin-top: 10px;
      border-radius: 2px;
      overflow: hidden;
    `;

    const progress = document.createElement("div");
    progress.className = "progress-bar";
    progress.style.cssText = `
      width: 0%;
      height: 100%;
      background: #3498db;
      transition: width 0.3s ease-in-out;
    `;

    progressBar.appendChild(progress);
    content.appendChild(spinner);
    content.appendChild(text);
    content.appendChild(progressBar);
    overlay.appendChild(content);
    document.body.appendChild(overlay);

    this.elements = {
      overlay,
      content,
      spinner,
      text,
      progressBar,
      progress,
    };
  }

  // Start a loading stage
  startStage(stageName, message) {
    if (!this.stages[stageName]) {
      this.stages[stageName] = { weight: 10, status: "pending" };
    }

    this.stages[stageName].status = "loading";
    this.stages[stageName].message = message;

    this._showOverlay(message || `Loading ${stageName}...`);
    this.updateProgress();

    return {
      update: (progress, msg) => this.updateStage(stageName, progress, msg),
      complete: () => this.completeStage(stageName),
      error: (msg) => this.stageError(stageName, msg),
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

    this.stages[stageName].status = "complete";
    this.stages[stageName].progress = 100;

    this.updateProgress();

    // Check if all stages are complete
    const allComplete = Object.values(this.stages).every(
      (stage) => stage.status === "complete" || stage.status === "skipped",
    );

    if (allComplete) {
      this._completeOverlay();
    }
  }

  stageError(stageName, message) {
    if (!this.stages[stageName]) return;

    this.stages[stageName].status = "error";
    this.stages[stageName].error = message;

    this.error(message, stageName);
  }

  updateProgress() {
    const stages = Object.entries(this.stages);
    const totalWeight = stages.reduce(
      (sum, [_, stage]) => sum + stage.weight,
      0,
    );

    let weightedProgress = 0;
    let currentStage = null;
    let detailsHtml = '<div class="loading-stages">';

    stages.forEach(([name, stage]) => {
      const progress = stage.progress || 0;
      const stageProgress =
        stage.status === "complete"
          ? 100
          : stage.status === "error"
            ? 0
            : progress;

      weightedProgress += (stageProgress / 100) * stage.weight;

      // Build details HTML
      const statusIcon =
        stage.status === "complete"
          ? "✓"
          : stage.status === "error"
            ? "✗"
            : stage.status === "loading"
              ? "⟳"
              : "○";

      const statusClass =
        stage.status === "complete"
          ? "text-success"
          : stage.status === "error"
            ? "text-danger"
            : stage.status === "loading"
              ? "text-primary"
              : "text-muted";

      detailsHtml += `
        <div class="loading-stage ${statusClass} small">
          <span class="stage-icon">${statusIcon}</span>
          <span class="stage-name">${name}</span>
        </div>
      `;

      if (stage.status === "loading" && !currentStage) {
        currentStage = stage;
      }
    });

    detailsHtml += "</div>";

    const overallPercentage = Math.round(
      (weightedProgress / totalWeight) * 100,
    );
    const message = currentStage?.message || "Loading...";

    this._updateOverlayProgress(overallPercentage, message);

    if (this.elements.details) {
      this.elements.details.innerHTML = detailsHtml;
    }
  }

  startOperation(name, total = 100) {
    const operationId = ++this.operationCounter;

    const operation = {
      id: operationId,
      name,
      total,
      progress: 0,
      startTime: Date.now(),
      subOperations: new Map(),
      completed: false,
    };

    this.activeOperations.set(operationId, operation);

    // Debounce overlay show to prevent flicker
    clearTimeout(this.showTimeout);
    this.showTimeout = setTimeout(() => {
      if (this.activeOperations.size > 0) {
        this._showOverlay(`Loading ${name}...`);
      }
    }, 100);

    return {
      id: operationId,
      update: (progress, message) =>
        this.updateOperation(operationId, progress, message),
      finish: () => this.finishOperation(operationId),
      error: (message) => this.errorOperation(operationId, message),
      addSubOperation: (subName, subTotal) =>
        this.addSubOperation(operationId, subName, subTotal),
    };
  }

  updateOperation(operationId, progress, message) {
    const operation = this.activeOperations.get(operationId);
    if (!operation || operation.completed) return;

    operation.progress = Math.min(Math.max(0, progress), operation.total);
    if (message) operation.message = message;

    this.updateOverlay();
  }

  finishOperation(operationId) {
    const operation = this.activeOperations.get(operationId);
    if (!operation) return;

    operation.completed = true;
    operation.progress = operation.total;

    // Delay removal to ensure minimum show time
    const elapsed = Date.now() - operation.startTime;
    const delay = Math.max(0, this.minimumShowTime - elapsed);

    setTimeout(() => {
      this.activeOperations.delete(operationId);

      if (this.activeOperations.size === 0) {
        clearTimeout(this.showTimeout);
        this._hideOverlay();
      } else {
        this.updateOverlay();
      }
    }, delay);
  }

  errorOperation(operationId, message) {
    const operation = this.activeOperations.get(operationId);
    if (!operation) return;

    operation.error = message;
    operation.completed = true;

    // Show error briefly then remove
    this._showOverlay(`Error: ${message}`, true);

    setTimeout(() => {
      this.activeOperations.delete(operationId);

      if (this.activeOperations.size === 0) {
        this._hideOverlay();
      } else {
        this.updateOverlay();
      }
    }, 2000);
  }

  updateOverlay() {
    if (this.activeOperations.size === 0) return;

    // Calculate overall progress
    let totalProgress = 0;
    let totalWeight = 0;
    let currentMessage = "";

    for (const operation of this.activeOperations.values()) {
      if (!operation.completed) {
        const weight = operation.total;
        totalProgress += (operation.progress / operation.total) * weight;
        totalWeight += weight;
        currentMessage = operation.message || `Loading ${operation.name}...`;
      }
    }

    const overallProgress =
      totalWeight > 0 ? (totalProgress / totalWeight) * 100 : 0;
    this._updateOverlayProgress(Math.round(overallProgress), currentMessage);
  }

  show(message = "Loading...", _immediate = false) {
    const operation = this.startOperation("Manual", 100);
    operation.update(50, message);
    return this;
  }

  hide() {
    // Complete all active operations
    for (const [id, operation] of this.activeOperations) {
      if (!operation.completed) {
        this.finishOperation(id);
      }
    }
    return this;
  }

  finish(name) {
    if (name) {
      // Find and finish operation by name
      for (const [id, operation] of this.activeOperations) {
        if (operation.name === name && !operation.completed) {
          this.finishOperation(id);
          break;
        }
      }
    } else {
      // Finish all operations
      this.hide();
    }
    return this;
  }

  error(message, context = null, autoHide = true) {
    if (!this.initialized) this.init();

    console.error(
      `Loading Error: ${message}${context ? ` in ${context}` : ""}`,
    );

    this._showOverlay(`Error: ${message}`, true);

    if (this.elements.text) {
      this.elements.text.classList.add("text-danger");
    }

    if (this.elements.bar) {
      this.elements.bar.classList.remove("bg-primary", "bg-success");
      this.elements.bar.classList.add("bg-danger");
    }

    if (autoHide) {
      setTimeout(() => this._hideOverlay(), 3000);
    }

    return this;
  }

  _showOverlay(message, immediate = false) {
    if (!this.initialized) this.init();

    // Cancel any pending hide
    clearTimeout(this.hideTimeout);
    this.pendingHide = false;

    const { overlay, text, bar, spinner } = this.elements;
    if (!overlay) return;

    // Ensure overlay is visible
    if (!this.isVisible) {
      this.showStartTime = Date.now();
      overlay.style.display = "flex";
      overlay.style.opacity = "0";

      // Force reflow
      overlay.offsetHeight;

      // Fade in with shorter duration
      overlay.style.transition = immediate
        ? "none"
        : "opacity 0.2s ease-in-out";
      overlay.style.opacity = "1";

      this.isVisible = true;
    }

    if (text) {
      text.textContent = message;
      text.classList.remove("text-danger");
    }

    if (bar) {
      bar.classList.remove("bg-danger", "bg-success");
      bar.classList.add("bg-primary");
    }

    if (spinner) {
      spinner.classList.add("active");
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
    bar.setAttribute("aria-valuenow", pct);

    if (pct >= 100) {
      bar.classList.remove("bg-primary");
      bar.classList.add("bg-success");
    }
  }

  _completeOverlay() {
    const { bar, text } = this.elements;

    if (bar) {
      bar.style.width = "100%";
      bar.setAttribute("aria-valuenow", "100");
      bar.classList.remove("bg-primary");
      bar.classList.add("bg-success");
    }

    if (text) {
      text.textContent = "Complete!";
    }

    // Ensure minimum show time
    const elapsed = this.showStartTime
      ? Date.now() - this.showStartTime
      : Infinity;
    const remainingTime = Math.max(0, this.minimumShowTime - elapsed);

    setTimeout(() => this._hideOverlay(), remainingTime + 300);
  }

  _hideOverlay() {
    if (!this.initialized || !this.isVisible) return;

    // Cancel any pending show
    clearTimeout(this.showTimeout);

    const { overlay, spinner } = this.elements;
    if (!overlay) return;

    // Ensure minimum show time
    const elapsed = this.showStartTime
      ? Date.now() - this.showStartTime
      : Infinity;
    const remainingTime = Math.max(0, this.minimumShowTime - elapsed);

    this.hideTimeout = setTimeout(() => {
      overlay.style.opacity = "0";

      setTimeout(() => {
        if (overlay.style.opacity === "0" && this.activeOperations.size === 0) {
          overlay.style.display = "none";
          this.isVisible = false;
          this.showStartTime = null;

          if (spinner) {
            spinner.classList.remove("active");
          }

          // Reset state
          this.operations.clear();
          this.activeOperations.clear();
        }
      }, 200);
    }, remainingTime);
  }

  // New method for quick status updates
  pulse(message, duration = 2000) {
    const pulseEl = document.createElement("div");
    pulseEl.className = "loading-pulse";
    pulseEl.textContent = message;
    document.body.appendChild(pulseEl);

    // Trigger animation
    requestAnimationFrame(() => {
      pulseEl.classList.add("show");
      setTimeout(() => {
        pulseEl.classList.remove("show");
        setTimeout(() => pulseEl.remove(), 300);
      }, duration);
    });
  }

  // Add sub-operation tracking for legacy API compatibility
  addSubOperation(operationId, subName, subTotal = 100) {
    const operation = this.activeOperations.get(operationId);
    if (!operation) return;

    const subOperationId = ++this.operationCounter;

    const subOperation = {
      id: subOperationId,
      name: subName,
      total: subTotal,
      progress: 0,
      startTime: Date.now(),
      completed: false,
    };

    operation.subOperations.set(subOperationId, subOperation);

    return {
      id: subOperationId,
      update: (progress, message) =>
        this.updateSubOperation(operationId, subOperationId, progress, message),
      finish: () => this.finishSubOperation(operationId, subOperationId),
      error: (message) =>
        this.errorSubOperation(operationId, subOperationId, message),
    };
  }

  updateSubOperation(operationId, subOperationId, progress, message) {
    const operation = this.activeOperations.get(operationId);
    if (!operation) return;

    const subOperation = operation.subOperations.get(subOperationId);
    if (!subOperation) return;

    subOperation.progress = Math.min(Math.max(0, progress), subOperation.total);
    if (message) subOperation.message = message;

    this.updateOverlay();
  }

  finishSubOperation(operationId, subOperationId) {
    const operation = this.activeOperations.get(operationId);
    if (!operation) return;

    const subOperation = operation.subOperations.get(subOperationId);
    if (!subOperation) return;

    subOperation.completed = true;
    subOperation.progress = subOperation.total;

    // Delay removal to ensure minimum show time
    const elapsed = Date.now() - subOperation.startTime;
    const delay = Math.max(0, this.minimumShowTime - elapsed);

    setTimeout(() => {
      operation.subOperations.delete(subOperationId);

      if (operation.subOperations.size === 0) {
        this.finishOperation(operationId);
      } else {
        this.updateOverlay();
      }
    }, delay);
  }

  errorSubOperation(operationId, subOperationId, message) {
    const operation = this.activeOperations.get(operationId);
    if (!operation) return;

    const subOperation = operation.subOperations.get(subOperationId);
    if (!subOperation) return;

    subOperation.error = message;
    subOperation.completed = true;

    // Show error briefly then remove
    this._showOverlay(`Error: ${message}`, true);

    setTimeout(() => {
      operation.subOperations.delete(subOperationId);

      if (operation.subOperations.size === 0) {
        this.finishOperation(operationId);
      } else {
        this.updateOverlay();
      }
    }, 2000);
  }
}

// Create and export singleton instance
if (
  !window.loadingManager ||
  typeof window.loadingManager.startStage !== "function"
) {
  window.loadingManager = new LoadingManager();
}

// Legacy function support
window.showLoadingOverlay = (message) => window.loadingManager.show(message);
window.hideLoadingOverlay = () => window.loadingManager.hide();
