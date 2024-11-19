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
			currentStep: 0
		};

		if (this.overlay) {
			this.overlay.style.display = 'flex';
			this.updateDisplay();
		}
	}

	updateProgress(step, message = null) {
		if (!this.currentOperation) return;

		this.currentOperation.currentStep = Math.min(Math.max(step, 0), 100);
		if (message) {
			this.currentOperation.name = message;
		}

		this.updateDisplay();
	}

	addSubOperation(name, weight = 1) {
		this.subOperations.set(name, {
			progress: 0,
			weight: weight
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

		const totalWeight = Array.from(this.subOperations.values())
			.reduce((sum, op) => sum + op.weight, 0);

		const weightedProgress = Array.from(this.subOperations.entries())
			.reduce((sum, [_, op]) => sum + ((op.progress / 100) * op.weight), 0);

		const totalProgress = (weightedProgress / totalWeight) * 100;
		this.updateProgress(totalProgress);
	}

	updateDisplay() {
		if (!this.loadingText || !this.loadingBar) return;

		const percentage = Math.round(this.currentOperation.currentStep);
		this.loadingText.textContent = `${this.currentOperation.name}: ${percentage}%`;
		this.loadingBar.style.width = `${percentage}%`;
		this.loadingBar.setAttribute('aria-valuenow', percentage);
	}

	finish() {
		if (!this.overlay) return;

		this.updateProgress(100, 'Complete');
		setTimeout(() => {
			this.overlay.style.display = 'none';
			this.currentOperation = null;
			this.subOperations.clear();
		}, 500);
	}
}

// Initialize LoadingManager after DOM is loaded
document.addEventListener('DOMContentLoaded', () => {
	window.EveryStreet = window.EveryStreet || {};
	window.EveryStreet.loadingManager = new LoadingManager();
});

// Add a helper function to safely access the loading manager
function getLoadingManager() {
	if (!window.EveryStreet?.loadingManager) {
		console.warn('LoadingManager not initialized yet, creating new instance');
		window.EveryStreet = window.EveryStreet || {};
		window.EveryStreet.loadingManager = new LoadingManager();
	}
	return window.EveryStreet.loadingManager;
}