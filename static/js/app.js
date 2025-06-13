/* global mapboxgl, DateUtils */
// Refactored bootstrap – loads the modular Everystreet application.
// This keeps the original <script src="static/js/app.js"> tag working
// without needing to change HTML to type="module".

(async () => {
  try {
    const { default: AppController } = await import('./modules/app-controller.js');

    const startApp = () => AppController.initialize();

    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', startApp);
        } else {
      startApp();
    }
  } catch (err) {
    console.error('Application bootstrap error:', err);
    if (window.loadingManager?.error) {
      window.loadingManager.error(`Bootstrap error: ${err.message}`);
    }
  }
})();