/**
 * The weather note beside the status line on the home page title.
 *
 * Reads Open-Meteo for the last known trip location (or the browser's
 * position) and keeps the answer for twenty minutes so page visits do not
 * each make a request.
 */

import { getStorage } from "../../utils.js";

const CACHE_KEY = "es:weather-cache";
const CACHE_MAX_AGE_MS = 20 * 60 * 1000;

const WEATHER_LABELS = [
  [[0], "Clear"],
  [[1, 2], "Partly Cloudy"],
  [[3], "Cloudy"],
  [[45, 48], "Fog"],
  [[51, 53, 55, 56, 57], "Drizzle"],
  [[61, 63, 65, 66, 67], "Rain"],
  [[71, 73, 75, 77], "Snow"],
  [[80, 81, 82], "Showers"],
  [[95, 96, 99], "Storm"],
];

export function mapWeatherCode(code) {
  const numeric = Number(code);
  if (!Number.isFinite(numeric)) {
    return null;
  }
  const match = WEATHER_LABELS.find(([codes]) => codes.includes(numeric));
  return match ? match[1] : "Clear";
}

function readCache() {
  const cached = getStorage(CACHE_KEY);
  if (!cached || Date.now() - cached.timestamp > CACHE_MAX_AGE_MS) {
    return null;
  }
  return cached;
}

function writeCache({ temp, label }) {
  try {
    localStorage.setItem(
      CACHE_KEY,
      JSON.stringify({ temp, label, timestamp: Date.now() })
    );
  } catch {
    // Storage can be full or blocked; the next visit asks again.
  }
}

function currentPosition() {
  return new Promise((resolve, reject) => {
    navigator.geolocation.getCurrentPosition(
      (position) => resolve(position.coords),
      reject,
      { timeout: 5000, maximumAge: 600000 }
    );
  });
}

function show(chip, { temp, label }) {
  chip.textContent = `${temp}°F · ${label}`;
  chip.hidden = false;
}

/**
 * Fill the weather chip.
 * @param {HTMLElement|null} chip
 * @param {{ location: {latitude:number, longitude:number}|null, fetchRaw: Function }} options
 */
export async function loadWeather(chip, { location, fetchRaw }) {
  if (!chip) {
    return;
  }
  const cached = readCache();
  if (cached) {
    show(chip, cached);
    return;
  }
  if (!location && !navigator.geolocation) {
    chip.hidden = true;
    return;
  }

  try {
    const { latitude, longitude } = location || (await currentPosition());
    const url = `https://api.open-meteo.com/v1/forecast?latitude=${latitude}&longitude=${longitude}&current=temperature_2m,weather_code&temperature_unit=fahrenheit&timezone=auto`;
    const response = await fetchRaw(url, { retry: false });
    if (!response.ok) {
      throw new Error("Weather request failed");
    }
    const data = await response.json();
    const reading = {
      temp: Math.round(Number(data.current?.temperature_2m)),
      label: mapWeatherCode(data.current?.weather_code),
    };
    if (!Number.isFinite(reading.temp) || !reading.label) {
      throw new Error("Weather data missing");
    }
    show(chip, reading);
    writeCache(reading);
  } catch {
    chip.hidden = true;
  }
}
