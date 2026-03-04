/**
 * Shared geo-math utilities
 * Canonical implementations for haversine distance, bearing, and coordinate conversions.
 */

export const EARTH_RADIUS_M = 6_371_000;

export function toRad(deg) {
  return deg * (Math.PI / 180);
}

export function toDeg(rad) {
  return rad * (180 / Math.PI);
}

/**
 * Haversine distance between two points.
 * @param {number} lat1
 * @param {number} lon1
 * @param {number} lat2
 * @param {number} lon2
 * @returns {number} Distance in meters
 */
export function haversineDistance(lat1, lon1, lat2, lon2) {
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const rLat1 = toRad(lat1);
  const rLat2 = toRad(lat2);
  const h =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(rLat1) * Math.cos(rLat2) * Math.sin(dLon / 2) * Math.sin(dLon / 2);
  return 2 * EARTH_RADIUS_M * Math.atan2(Math.sqrt(h), Math.sqrt(1 - h));
}

/**
 * Bearing from point A to point B.
 * @param {number} lat1
 * @param {number} lon1
 * @param {number} lat2
 * @param {number} lon2
 * @returns {number} Bearing in degrees [0, 360)
 */
export function bearing(lat1, lon1, lat2, lon2) {
  const rLat1 = toRad(lat1);
  const rLat2 = toRad(lat2);
  const dLon = toRad(lon2 - lon1);
  const y = Math.sin(dLon) * Math.cos(rLat2);
  const x =
    Math.cos(rLat1) * Math.sin(rLat2) -
    Math.sin(rLat1) * Math.cos(rLat2) * Math.cos(dLon);
  return (toDeg(Math.atan2(y, x)) + 360) % 360;
}

/**
 * Convert [lon, lat] coordinate into XY meters for local projection math.
 * @param {[number, number]} coord - [lon, lat]
 * @param {number} refLat - Reference latitude
 * @returns {{x:number,y:number}}
 */
export function toXY(coord, refLat) {
  const lat = toRad(coord[1]);
  const lon = toRad(coord[0]);
  const x = lon * Math.cos(toRad(refLat)) * EARTH_RADIUS_M;
  const y = lat * EARTH_RADIUS_M;
  return { x, y };
}

/**
 * Project point onto segment in local XY space.
 * @param {[number, number]} point - [lon, lat]
 * @param {[number, number]} a - Segment start [lon, lat]
 * @param {[number, number]} b - Segment end [lon, lat]
 * @returns {{distance:number,t:number,point:[number,number]}}
 */
export function projectToSegment(point, a, b) {
  const refLat = (a[1] + b[1]) / 2;
  const p = toXY(point, refLat);
  const p1 = toXY(a, refLat);
  const p2 = toXY(b, refLat);
  const dx = p2.x - p1.x;
  const dy = p2.y - p1.y;
  const lenSq = dx * dx + dy * dy;

  let t = 0;
  if (lenSq > 0) {
    t = ((p.x - p1.x) * dx + (p.y - p1.y) * dy) / lenSq;
    t = Math.min(1, Math.max(0, t));
  }

  const projX = p1.x + t * dx;
  const projY = p1.y + t * dy;
  const distance = Math.hypot(p.x - projX, p.y - projY);
  const projLng = a[0] + t * (b[0] - a[0]);
  const projLat = a[1] + t * (b[1] - a[1]);
  return { distance, t, point: [projLng, projLat] };
}

/**
 * Signed angle delta from bearing A to bearing B in degrees [-180, 180].
 * @param {number} from
 * @param {number} to
 * @returns {number}
 */
export function angleDelta(from, to) {
  return ((to - from + 540) % 360) - 180;
}

/**
 * Cardinal direction from bearing.
 * @param {number} deg - Bearing in degrees
 * @returns {string} One of "N","NE","E","SE","S","SW","W","NW"
 */
export function cardinalDirection(deg) {
  const directions = ["N", "NE", "E", "SE", "S", "SW", "W", "NW"];
  return directions[Math.round(deg / 45) % 8];
}

/** Meters-per-second → miles-per-hour */
export const MPS_TO_MPH = 2.23694;

/** Meters → miles */
export const M_TO_MI = 0.000621371;
