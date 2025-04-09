class LoadingManager {
  constructor() {
    this.elements = {
      overlay: document.querySelector(".loading-overlay"),
      text: document.getElementById("loading-text"),
      bar: document.getElementById("loading-progress-bar"),
    };

    this.operations = new Map();
    this.isVisible = false;
    this.errorTimeout = null;
    this.updateInterval = null;
    this.fadeTimeout = null;
  }

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

  error(message, opName = null, autoHide = true) {
    console.error(`Loading Error: ${message}${opName ? ` in ${opName}` : ""}`);

    if (this.elements.text) {
      this.elements.text.textContent = `Error: ${message}`;
      this.elements.text.classList.add("text-danger");
    }

    if (this.elements.bar) {
      this.elements.bar.classList.remove("bg-primary", "bg-success");
      this.elements.bar.classList.add("bg-danger");
    }

    if (opName) {
      this.operations.delete(opName);
    }

    if (this.errorTimeout) {
      clearTimeout(this.errorTimeout);
      this.errorTimeout = null;
    }

    if (autoHide) {
      this.errorTimeout = setTimeout(() => {
        this._hideOverlay();
        this.errorTimeout = null;

        if (this.elements.text) {
          this.elements.text.classList.remove("text-danger");
        }

        if (this.elements.bar) {
          this.elements.bar.classList.remove("bg-danger");
          this.elements.bar.classList.add("bg-primary");
        }
      }, 3000);
    }

    return this;
  }

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

    const latestOp = operations.reduce(
      (latest, op) =>
        !latest || op.startTime > latest.startTime ? op : latest,
      null,
    );

    const message = latestOp?.message || "Loading...";

    this._updateOverlayProgress(overallPercentage, message);
  }

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

  _showOverlay(message) {
    const { overlay, text, bar } = this.elements;

    if (!overlay) {
      console.warn("Loading overlay not found in DOM");
      return;
    }

    if (!this.isVisible) {
      if (this.fadeTimeout) {
        clearTimeout(this.fadeTimeout);
        this.fadeTimeout = null;
      }

      overlay.style.display = "flex";
      this.isVisible = true;

      overlay.offsetHeight;
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

  _updateOverlayProgress(percentage, message) {
    const { text, bar } = this.elements;

    if (!text || !bar) return;

    const pct = Math.min(Math.round(percentage), 100);
    const currentMsg = message || text.textContent.split(":")[0] || "Loading";

    text.textContent = `${currentMsg}: ${pct}%`;
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
      text.textContent = "Complete: 100%";
    }

    setTimeout(() => {
      this._hideOverlay();
    }, 500);
  }

  _hideOverlay() {
    const { overlay } = this.elements;

    if (!overlay || !this.isVisible) return;

    overlay.classList.add("fade-out");

    this.fadeTimeout = setTimeout(() => {
      overlay.style.display = "none";
      overlay.classList.remove("fade-out");
      this.isVisible = false;
      this.fadeTimeout = null;
    }, 300);
  }
}

if (!window.loadingManager) {
  window.loadingManager = new LoadingManager();
}

function showLoadingOverlay(message = "Loading...") {
  if (window.loadingManager) {
    window.loadingManager.startOperation("global", 100);
    window.loadingManager._showOverlay(message);
  } else {
    console.warn("Loading manager not initialized");
  }
}

function hideLoadingOverlay() {
  if (window.loadingManager) {
    window.loadingManager.finish();
  } else {
    console.warn("Loading manager not initialized");
  }
}

window.showLoadingOverlay = showLoadingOverlay;
window.hideLoadingOverlay = hideLoadingOverlay;
