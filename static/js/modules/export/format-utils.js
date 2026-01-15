/**
 * Export Format Utilities
 * Handles format-related operations including file extensions,
 * content types, and format conversions
 */

/**
 * Get file extension for a given export format
 * @param {string} format - Export format (json, geojson, gpx, csv, etc.)
 * @returns {string} File extension including the dot
 */
export function getExtensionForFormat(format) {
  if (!format) {
    return ".dat";
  }

  switch (format.toLowerCase()) {
    case "json":
      return ".json";
    case "geojson":
      return ".geojson";
    case "gpx":
      return ".gpx";
    case "csv":
      return ".csv";
    case "shapefile":
      return ".zip";
    case "kml":
      return ".kml";
    default:
      return `.${format.toLowerCase()}`;
  }
}

/**
 * Get MIME content type for a given export format
 * @param {string} format - Export format
 * @returns {string} MIME content type
 */
export function getContentTypeForFormat(format) {
  if (!format) {
    return "application/octet-stream";
  }

  switch (format.toLowerCase()) {
    case "json":
      return "application/json";
    case "geojson":
      return "application/geo+json";
    case "gpx":
      return "application/gpx+xml";
    case "csv":
      return "text/csv";
    case "shapefile":
      return "application/zip";
    case "kml":
      return "application/vnd.google-earth.kml+xml";
    default:
      return "application/octet-stream";
  }
}

/**
 * Convert GeoJSON to GPX format
 * Simple converter for LineString features
 * @param {Object} geojson - GeoJSON FeatureCollection
 * @returns {string} GPX XML string
 */
export function geojsonToGpx(geojson) {
  let gpx =
    '<?xml version="1.0" encoding="UTF-8"?>\n<gpx version="1.1" creator="EveryStreet" xmlns="http://www.topografix.com/GPX/1/1">\n';

  if (geojson?.features && Array.isArray(geojson.features)) {
    geojson.features.forEach((f, i) => {
      if (
        f.geometry &&
        f.geometry.type === "LineString" &&
        Array.isArray(f.geometry.coordinates)
      ) {
        gpx += `<trk><name>Undriven Street ${i + 1}</name><trkseg>`;
        f.geometry.coordinates.forEach(([lon, lat]) => {
          gpx += `<trkpt lat="${lat}" lon="${lon}"></trkpt>`;
        });
        gpx += "</trkseg></trk>\n";
      }
    });
  }

  gpx += "</gpx>\n";
  return gpx;
}

/**
 * Generate a timestamp string for file naming
 * @param {Date} date - Date object (defaults to now)
 * @returns {string} Formatted timestamp string
 */
export function generateTimestamp(date = new Date()) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  const hours = String(date.getHours()).padStart(2, "0");
  const minutes = String(date.getMinutes()).padStart(2, "0");
  const seconds = String(date.getSeconds()).padStart(2, "0");

  return `${year}-${month}-${day}-${hours}-${minutes}-${seconds}`;
}

/**
 * Generate a filename-safe string from a display name
 * @param {string} displayName - Display name to sanitize
 * @returns {string} Sanitized name suitable for filenames
 */
export function sanitizeFilename(displayName) {
  return displayName.replace(/[^a-zA-Z0-9]/g, "_");
}

/**
 * Get filename from Content-Disposition header or generate one
 * @param {string|null} contentDisposition - Content-Disposition header value
 * @param {string} exportName - Export type name for fallback
 * @param {string} format - Export format
 * @returns {string} Filename to use for download
 */
export function getFilenameFromHeaders(contentDisposition, exportName, format) {
  let filename = null;

  if (contentDisposition) {
    const quotedMatch = contentDisposition.match(/filename="([^"]+)"/);
    if (quotedMatch) {
      filename = quotedMatch[1];
    } else {
      const unquotedMatch = contentDisposition.match(/filename=([^;]+)/);
      if (unquotedMatch) {
        filename = unquotedMatch[1].trim();
      }
    }
  }

  if (!filename) {
    const timestamp = generateTimestamp();
    const extension = getExtensionForFormat(format);
    filename = `${exportName}-${timestamp}${extension}`;
  }

  // Ensure correct extension
  if (format && !filename.endsWith(getExtensionForFormat(format))) {
    filename = `${filename}${getExtensionForFormat(format)}`;
  }

  return filename;
}

export default {
  getExtensionForFormat,
  getContentTypeForFormat,
  geojsonToGpx,
  generateTimestamp,
  sanitizeFilename,
  getFilenameFromHeaders,
};
