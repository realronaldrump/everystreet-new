/**
 * How streets are named and described in the coverage street panel.
 */

// =============================================================================
// Format Utilities
// =============================================================================

export function formatStatus(statusKey) {
  const labels = { driven: "Driven", undriven: "Not driven", undriveable: "Undriveable" };
  return labels[statusKey] || "Unknown";
}

export function formatHighwayType(type) {
  if (!type) {
    return "Unknown";
  }
  return String(type)
    .replace(/_/g, " ")
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

export function getStreetDisplayName(streetName) {
  const normalizedName = typeof streetName === "string" ? streetName.trim() : "";
  return normalizedName || "Unnamed road";
}

export function formatPopupDate(value, statusKey) {
  if (!value) {
    if (statusKey === "driven") {
      return "Unknown";
    }
    if (statusKey === "undriveable") {
      return "—";
    }
    return "Not yet";
  }
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return "Unknown";
  }
  return date.toLocaleDateString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}
