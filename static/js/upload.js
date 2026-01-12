/**
 * Upload Entry Point
 *
 * This file serves as the entry point for the upload functionality.
 *
 * The actual implementation is split into smaller, focused modules:
 * - constants.js: Configuration and constants
 * - parsers.js: GPX and GeoJSON file parsing
 * - preview-map.js: Map preview functionality
 * - ui.js: DOM manipulation and UI updates
 * - api.js: Server communication
 * - upload-manager.js: Main orchestrator class
 *
 * @see static/js/modules/upload/
 */

import { UploadManager } from "./modules/upload/index.js";

new UploadManager();
