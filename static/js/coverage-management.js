/**
 * Coverage Management - Main Entry Point
 * Imports and initializes the modular coverage management system
 */

import CoverageManager from "./modules/coverage/coverage-manager.js";

// The CoverageManager class handles all initialization in its constructor
// It will be instantiated when DOMContentLoaded fires
// The instance is stored in window.coverageManager for backward compatibility

export default CoverageManager;
