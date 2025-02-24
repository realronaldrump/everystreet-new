class LoadingManager {
  constructor() {
    this.overlay = document.querySelector(".loading-overlay");
    this.loadingText = document.getElementById("loading-text");
    this.loadingBar = document.getElementById("loading-bar");
    this.operations = {};
    this.totalProgress = 0;
  }

  startOperation(name, total = 100) {
    this.operations[name] = { total, progress: 0, subOperations: {} };
    this.updateOverallProgress();
    this._showOverlay(name);
  }

  addSubOperation(opName, subName, total) {
    if (this.operations[opName]) {
      this.operations[opName].subOperations[subName] = { total, progress: 0 };
    }
  }

  updateSubOperation(opName, subName, progress) {
    const op = this.operations[opName];
    if (op?.subOperations[subName]) {
      op.subOperations[subName].progress = progress;
      this._updateOperationProgress(opName);
    }
  }

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

  _updateOperationProgress(opName) {
    const op = this.operations[opName];
    if (!op) return;
    const subOps = Object.values(op.subOperations);
    if (!subOps.length) return;
    const subProgress = subOps.reduce(
      (acc, sub) => acc + (sub.progress / sub.total) * (sub.total / op.total),
      0,
    );
    op.progress = subProgress * op.total;
    this.updateOverallProgress();
  }

  updateOverallProgress() {
    this.totalProgress = Object.values(this.operations).reduce(
      (acc, op) => acc + op.progress / 100,
      0,
    );
    const opCount = Object.keys(this.operations).length || 1;
    const overallPercentage = (this.totalProgress / opCount) * 100;
    this._updateOverlayProgress(overallPercentage);
  }

  _showOverlay(message) {
    if (this.overlay && this.loadingText && this.loadingBar) {
      this.overlay.style.display = "flex";
      this.loadingText.textContent = `${message}: 0%`;
      this.loadingBar.style.width = "0%";
      this.loadingBar.setAttribute("aria-valuenow", "0");
    }
  }

  _updateOverlayProgress(percentage, message) {
    if (!this.loadingText || !this.loadingBar) return;
    const currentMsg = message || this.loadingText.textContent.split(":")[0];
    const pct = Math.round(percentage);
    this.loadingText.textContent = `${currentMsg}: ${pct}%`;
    this.loadingBar.style.width = `${pct}%`;
    this.loadingBar.setAttribute("aria-valuenow", pct);
  }

  _hideOverlay() {
    if (this.overlay) {
      setTimeout(() => {
        this.overlay.style.display = "none";
      }, 500);
    }
  }

  error(message) {
    console.error("Loading Error:", message);
    if (this.loadingText) {
      this.loadingText.textContent = `Error: ${message}`;
    }
  }
}

window.loadingManager = new LoadingManager();
