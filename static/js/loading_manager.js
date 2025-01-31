// static/js/loading_manager.js
class LoadingManager {
    constructor() {
        this.overlay = document.querySelector('.loading-overlay');
        this.loadingText = document.getElementById('loading-text');
        this.loadingBar = document.getElementById('loading-bar');
        this.currentOperation = null;
        this.subOperations = new Map();
    }

    startOperation(operationName, totalSteps = 100) {
        this.currentOperation = {
            name: operationName,
            totalSteps: totalSteps,
            currentStep: 0,
        };
        this.subOperations.clear();

        this.overlay.style.display = 'flex';
        this.updateDisplay();
    }

    updateProgress(step, message = null) {
        if (!this.currentOperation) return;

        this.currentOperation.currentStep = Math.min(Math.max(step, 0), this.currentOperation.totalSteps);
        if (message) {
            this.currentOperation.name = message;
        }

        this.updateDisplay();
    }

    addSubOperation(name, weight = 1) {
        this.subOperations.set(name, {
            progress: 0,
            weight: weight,
        });
    }

    updateSubOperation(name, progress) {
        if (!this.subOperations.has(name)) return;

        const normalizedProgress = Math.min(Math.max(progress, 0), 100);
        this.subOperations.get(name).progress = normalizedProgress;
        this.calculateTotalProgress();
    }

    calculateTotalProgress() {
        if (this.subOperations.size === 0) return;

        const totalWeight = Array.from(this.subOperations.values()).reduce(
            (sum, op) => sum + op.weight,
            0
        );

        const weightedProgress = Array.from(this.subOperations.entries()).reduce(
            (sum, [_, op]) => sum + (op.progress / 100) * op.weight,
            0
        );

        const totalProgress = (weightedProgress / totalWeight) * 100;
        this.updateProgress(totalProgress);
    }

    updateDisplay() {
        if (!this.loadingText || !this.loadingBar) return;

        const percentage = Math.round((this.currentOperation.currentStep / this.currentOperation.totalSteps) * 100);
        this.loadingText.textContent = `${this.currentOperation.name}: ${percentage}%`;
        this.loadingBar.style.width = `${percentage}%`;
        this.loadingBar.setAttribute('aria-valuenow', percentage);
    }

    finish(operationName = null) {
        if (operationName) {
            if (this.currentOperation && this.currentOperation.name === operationName) {
                this.updateProgress(this.currentOperation.totalSteps);
                setTimeout(() => {
                    this.overlay.style.display = 'none';
                    this.currentOperation = null;
                    this.subOperations.clear();
                }, 500);
            }
        } else {
            this.updateProgress(this.currentOperation.totalSteps);
            setTimeout(() => {
                this.overlay.style.display = 'none';
                this.currentOperation = null;
                this.subOperations.clear();
            }, 500);
        }
    }

    error(message) {
        console.error('Loading Error:', message);
        if (this.loadingText) {
            this.loadingText.textContent = `Error: ${message}`;
        }
    }
}
