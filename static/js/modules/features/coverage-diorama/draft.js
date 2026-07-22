export const COVERAGE_ROUTE_DRAFT_KEY = "everystreet:coverage-route-draft:v1";
const COVERAGE_ROUTE_DRAFT_MAX_AGE_MS = 30 * 60 * 1000;

export function createCoverageRouteDraft(areaId, segmentIds, now = Date.now()) {
  const normalizedAreaId = String(areaId || "").trim();
  const normalizedSegmentIds = Array.from(
    new Set((segmentIds || []).map((id) => String(id || "").trim()).filter(Boolean))
  );
  if (!normalizedAreaId || normalizedSegmentIds.length === 0) {
    throw new Error("A coverage area and at least one segment are required.");
  }
  return {
    areaId: normalizedAreaId,
    segmentIds: normalizedSegmentIds,
    createdAt: Number(now),
  };
}

export function saveCoverageRouteDraft(storage, draft) {
  storage.setItem(COVERAGE_ROUTE_DRAFT_KEY, JSON.stringify(draft));
}

export function clearCoverageRouteDraft(storage) {
  storage.removeItem(COVERAGE_ROUTE_DRAFT_KEY);
}

export function readCoverageRouteDraft(storage, now = Date.now()) {
  let parsed = null;
  try {
    parsed = JSON.parse(storage.getItem(COVERAGE_ROUTE_DRAFT_KEY) || "null");
  } catch {
    storage.removeItem(COVERAGE_ROUTE_DRAFT_KEY);
    return null;
  }

  const createdAt = Number(parsed?.createdAt);
  if (
    !parsed ||
    !String(parsed.areaId || "").trim() ||
    !Array.isArray(parsed.segmentIds) ||
    parsed.segmentIds.length === 0 ||
    !Number.isFinite(createdAt) ||
    now - createdAt > COVERAGE_ROUTE_DRAFT_MAX_AGE_MS ||
    createdAt > now + 60_000
  ) {
    storage.removeItem(COVERAGE_ROUTE_DRAFT_KEY);
    return null;
  }

  return createCoverageRouteDraft(parsed.areaId, parsed.segmentIds, createdAt);
}

export function isDioramaDraftRequest(search = globalThis.location?.search || "") {
  return new URLSearchParams(search).get("draft") === "diorama";
}
