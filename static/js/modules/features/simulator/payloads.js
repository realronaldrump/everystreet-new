/**
 * Bouncie webhook payload builders and sender.
 *
 * Constructs payloads in the exact format Bouncie sends them,
 * then POSTs to the app's webhook endpoint.
 */

const DEFAULT_IMEI = "353816090000794";
const DEFAULT_VIN = "1FTFW1E88MFA00001";
const WEBHOOK_KEY = "62982120092935393436662883483703";
const WEBHOOK_PATH = "/webhook/bouncie";

/**
 * Generate a Bouncie-style transaction ID.
 * Format: {imei}-{epochSeconds}-{YYYYMM}
 */
export function generateTransactionId(imei = DEFAULT_IMEI) {
  const now = new Date();
  const epoch = Math.floor(now.getTime() / 1000);
  const yyyymm =
    String(now.getFullYear()) + String(now.getMonth() + 1).padStart(2, "0");
  return `${imei}-${epoch}-${yyyymm}`;
}

export function buildTripStartPayload({
  imei = DEFAULT_IMEI,
  vin = DEFAULT_VIN,
  transactionId,
  timestamp,
  timeZone = "America/Chicago",
  odometer = 45678.9,
} = {}) {
  return {
    eventType: "tripStart",
    imei,
    vin,
    transactionId,
    start: {
      timestamp: timestamp.toISOString(),
      timeZone,
      odometer,
    },
  };
}

export function buildTripDataPayload({
  imei = DEFAULT_IMEI,
  vin = DEFAULT_VIN,
  transactionId,
  dataPoints,
} = {}) {
  return {
    eventType: "tripData",
    imei,
    vin,
    transactionId,
    data: dataPoints.map((pt) => ({
      timestamp: pt.timestamp.toISOString(),
      speed: pt.speed ?? 0,
      gps: {
        lat: pt.lat,
        lon: pt.lon,
        heading: pt.heading ?? 0,
      },
      ...(pt.fuelLevelInput != null ? { fuelLevelInput: pt.fuelLevelInput } : {}),
    })),
  };
}

export function buildTripMetricsPayload({
  imei = DEFAULT_IMEI,
  vin = DEFAULT_VIN,
  transactionId,
  timestamp,
  tripTime = 0,
  tripDistance = 0,
  totalIdlingTime = 0,
  maxSpeed = 0,
  averageDriveSpeed = 0,
  hardBrakingCounts = 0,
  hardAccelerationCounts = 0,
} = {}) {
  return {
    eventType: "tripMetrics",
    imei,
    vin,
    transactionId,
    metrics: {
      timestamp: timestamp.toISOString(),
      tripTime,
      tripDistance,
      totalIdlingTime,
      maxSpeed,
      averageDriveSpeed,
      hardBrakingCounts,
      hardAccelerationCounts,
    },
  };
}

export function buildTripEndPayload({
  imei = DEFAULT_IMEI,
  vin = DEFAULT_VIN,
  transactionId,
  timestamp,
  timeZone = "America/Chicago",
  odometer = 45691.4,
  fuelConsumed = 0.8,
} = {}) {
  return {
    eventType: "tripEnd",
    imei,
    vin,
    transactionId,
    end: {
      timestamp: timestamp.toISOString(),
      timeZone,
      odometer,
      fuelConsumed,
    },
  };
}

/**
 * Send a webhook payload to the app's Bouncie webhook endpoint.
 * Returns { ok, status, eventType }.
 */
export async function sendWebhookPayload(payload) {
  try {
    const response = await fetch(WEBHOOK_PATH, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-bouncie-authorization": WEBHOOK_KEY,
      },
      body: JSON.stringify(payload),
    });
    return {
      ok: response.ok,
      status: response.status,
      eventType: payload.eventType,
    };
  } catch (err) {
    return {
      ok: false,
      status: 0,
      eventType: payload.eventType,
      error: err.message,
    };
  }
}
