/**
 * File Parsers Module
 * Handles parsing of GPX and GeoJSON files for upload
 */

/**
 * Read a file as text using FileReader API
 * @param {File} file - The file to read
 * @returns {Promise<string>} The file contents as text
 */
export function readFileAsText(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = (e) => resolve(e.target.result);
    reader.onerror = (error) => reject(error);
    reader.readAsText(file);
  });
}

/**
 * Get the file extension from a filename
 * @param {string} filename - The filename to parse
 * @returns {string} The file extension (including the dot, lowercase)
 */
export function getFileExtension(filename) {
  return filename.slice(((filename.lastIndexOf(".") - 1) >>> 0) + 1).toLowerCase();
}

/**
 * Parse a GPX file and extract track data
 * @param {File} file - The file object
 * @param {string} gpxContent - The GPX file content as text
 * @returns {Object|null} Parsed file entry or null on error
 * @throws {Error} If parsing fails
 */
export function parseGPX(file, gpxContent) {
  const parser = new DOMParser();
  const gpxDoc = parser.parseFromString(gpxContent, "application/xml");

  const errorNode = gpxDoc.querySelector("parsererror");
  if (errorNode) {
    throw new Error(`GPX parsing error: ${errorNode.textContent}`);
  }

  const coordinates = [];
  const times = [];

  // Try track points first
  const trkpts = gpxDoc.getElementsByTagName("trkpt");

  if (trkpts.length === 0) {
    // Fall back to route points
    const rtepts = gpxDoc.getElementsByTagName("rtept");
    if (rtepts.length > 0) {
      extractPointsFromElements(rtepts, coordinates, times);
    } else {
      throw new Error(
        `No track points (trkpt) or route points (rtept) found in ${file.name}`
      );
    }
  } else {
    extractPointsFromElements(trkpts, coordinates, times);
  }

  if (coordinates.length < 2) {
    throw new Error(`Insufficient valid coordinates found in ${file.name}`);
  }

  const startTime =
    times.length > 0 ? new Date(Math.min(...times.map((t) => t.getTime()))) : null;
  const endTime =
    times.length > 0 ? new Date(Math.max(...times.map((t) => t.getTime()))) : null;

  return {
    file,
    filename: file.name,
    startTime,
    endTime,
    points: coordinates.length,
    coordinates,
    type: "gpx",
  };
}

/**
 * Extract coordinates and times from GPX point elements
 * @param {HTMLCollection} elements - The point elements (trkpt or rtept)
 * @param {Array} coordinates - Array to push coordinates to
 * @param {Array} times - Array to push times to
 */
function extractPointsFromElements(elements, coordinates, times) {
  for (let i = 0; i < elements.length; i++) {
    const point = elements[i];
    const lat = parseFloat(point.getAttribute("lat"));
    const lon = parseFloat(point.getAttribute("lon"));

    if (!Number.isNaN(lat) && !Number.isNaN(lon)) {
      coordinates.push([lon, lat]);
      const timeElems = point.getElementsByTagName("time");
      if (timeElems.length > 0) {
        times.push(new Date(timeElems[0].textContent));
      }
    }
  }
}

/**
 * Parse a GeoJSON file and extract features
 * @param {File} file - The file object
 * @param {string} content - The GeoJSON file content as text
 * @returns {Array<Object>} Array of parsed file entries
 * @throws {Error} If parsing fails
 */
export function parseGeoJSON(file, content) {
  const geojsonData = JSON.parse(content);
  const entries = [];

  if (geojsonData.type === "FeatureCollection") {
    if (!geojsonData.features || !Array.isArray(geojsonData.features)) {
      throw new Error("Invalid GeoJSON FeatureCollection structure");
    }

    geojsonData.features.forEach((feature, index) => {
      const entry = processGeoJSONFeature(feature, file, index);
      if (entry) {
        entries.push(entry);
      }
    });
  } else if (geojsonData.type === "Feature") {
    const entry = processGeoJSONFeature(geojsonData, file, 0);
    if (entry) {
      entries.push(entry);
    }
  } else if (geojsonData.type === "LineString") {
    const entry = processGeoJSONGeometry(geojsonData, file);
    if (entry) {
      entries.push(entry);
    }
  } else {
    throw new Error(
      "Unsupported GeoJSON type. Must be FeatureCollection, Feature, or LineString."
    );
  }

  return entries;
}

/**
 * Process a GeoJSON feature into a file entry
 * @param {Object} feature - The GeoJSON feature
 * @param {File} file - The original file
 * @param {number} index - The feature index within the file
 * @returns {Object|null} Parsed file entry or null if invalid
 */
function processGeoJSONFeature(feature, file, index) {
  if (
    !feature.geometry ||
    !feature.properties ||
    feature.geometry.type !== "LineString"
  ) {
    return null;
  }

  const { coordinates } = feature.geometry;
  if (!Array.isArray(coordinates) || coordinates.length < 2) {
    return null;
  }

  const { properties } = feature;
  const filename = `${file.name} (Feature ${index + 1})`;

  return {
    file,
    filename,
    startTime: extractStartTime(properties),
    endTime: extractEndTime(properties),
    points: coordinates.length,
    coordinates,
    type: "geojson",
    properties: {
      max_speed: properties.max_speed,
      hard_brakings: properties.hard_brakings,
      hard_accelerations: properties.hard_accelerations,
      idle: properties.idle,
      transaction_id: properties.transaction_id,
    },
  };
}

/**
 * Extract start time from GeoJSON properties
 * @param {Object} properties - The feature properties
 * @returns {Date|null} The start time or null
 */
function extractStartTime(properties) {
  if (properties.start_time) {
    return new Date(properties.start_time);
  }
  if (properties.coordTimes?.length > 0) {
    return new Date(properties.coordTimes[0]);
  }
  return null;
}

/**
 * Extract end time from GeoJSON properties
 * @param {Object} properties - The feature properties
 * @returns {Date|null} The end time or null
 */
function extractEndTime(properties) {
  if (properties.end_time) {
    return new Date(properties.end_time);
  }
  if (properties.coordTimes?.length > 0) {
    return new Date(properties.coordTimes[properties.coordTimes.length - 1]);
  }
  return null;
}

/**
 * Process a bare GeoJSON geometry (LineString) into a file entry
 * @param {Object} geometry - The GeoJSON geometry
 * @param {File} file - The original file
 * @returns {Object|null} Parsed file entry or null if invalid
 */
function processGeoJSONGeometry(geometry, file) {
  const { coordinates } = geometry;
  if (!Array.isArray(coordinates) || coordinates.length < 2) {
    return null;
  }

  return {
    file,
    filename: file.name,
    startTime: null,
    endTime: null,
    points: coordinates.length,
    coordinates,
    type: "geojson",
    properties: {},
  };
}
