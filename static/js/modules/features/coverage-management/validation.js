/**
 * The Add Area form's place lookup: find areas (cities, counties, states)
 * matching the typed place, list them, and load the boundary of the one
 * picked.
 */

import apiClient from "../../core/api-client.js";
import { escapeHtml } from "../../utils.js";
import { API_BASE, withSignal } from "./context.js";

export const VALIDATION_DEBOUNCE_MS = 500;
const CANDIDATE_LIMIT = 8;
const AREA_KIND_NOUNS = {
  city: { one: "city or town", many: "cities and towns" },
  county: { one: "county", many: "counties" },
  state: { one: "state", many: "states" },
};

export const validationState = {
  status: "idle",
  lastQuery: "",
  lastType: "",
  candidates: [],
  selectedCandidate: null,
  confirmedCandidate: null,
  confirmedBoundary: null,
  note: "",
  requestId: 0,
  resolveRequestId: 0,
};
export let validationElements = null;

// =============================================================================
// Location Validation
// =============================================================================

export function initValidationUI() {
  validationElements = {
    status: document.getElementById("location-validation-status"),
    note: document.getElementById("location-validation-note"),
    candidates: document.getElementById("location-validation-candidates"),
    addButton: document.getElementById("add-coverage-area"),
  };
  resetValidationState();
}

function setAddButtonEnabled(enabled) {
  if (!validationElements?.addButton) {
    return;
  }
  validationElements.addButton.disabled = !enabled;
  validationElements.addButton.setAttribute("aria-disabled", String(!enabled));
}

export function setValidationStatus({ icon, message, tone = "neutral" }) {
  if (!validationElements?.status) {
    return;
  }
  const toneClassMap = {
    neutral: "text-secondary",
    info: "text-info",
    success: "text-success",
    warning: "text-warning",
    danger: "text-danger",
  };
  const toneClass = toneClassMap[tone] || toneClassMap.neutral;
  validationElements.status.className = `validation-status ${toneClass}`;
  validationElements.status.innerHTML = `
    <span class="status-icon"><i class="fas ${icon}" aria-hidden="true"></i></span>
    <span>${escapeHtml(message)}</span>`;
}

function setValidationNote(text) {
  if (!validationElements?.note) {
    return;
  }
  validationElements.note.textContent = text || "";
  validationElements.note.classList.toggle("d-none", !text);
}

function markSelectedCandidate(index) {
  validationElements?.candidates
    ?.querySelectorAll(".validation-candidate")
    .forEach((el, i) => {
      const selected = i === index;
      el.classList.toggle("is-selected", selected);
      el.setAttribute("aria-selected", selected ? "true" : "false");
      const icon = el.querySelector(".candidate-icon");
      if (icon) {
        icon.className = `candidate-icon fas ${
          selected ? "fa-circle-check" : "fa-chevron-right"
        }`;
      }
    });
}

export function clearValidationSelection() {
  validationState.resolveRequestId += 1;
  validationState.selectedCandidate = null;
  validationState.confirmedCandidate = null;
  validationState.confirmedBoundary = null;
  setAddButtonEnabled(false);
  markSelectedCandidate(-1);
}

export function resetValidationState() {
  Object.assign(validationState, {
    status: "idle",
    lastQuery: "",
    lastType: "",
    candidates: [],
    selectedCandidate: null,
    confirmedCandidate: null,
    confirmedBoundary: null,
    note: "",
    requestId: 0,
    resolveRequestId: 0,
  });
  if (validationElements?.candidates) {
    validationElements.candidates.innerHTML = "";
  }
  setValidationNote("");
  setAddButtonEnabled(false);
  setValidationStatus({
    icon: "fa-location-dot",
    message: "Type a city, county, or state to find it.",
    tone: "neutral",
  });
}

/** One line telling the user what the search found and what to do next. */
export function describeSearchResult(candidates, kind) {
  const nouns = AREA_KIND_NOUNS[kind] || AREA_KIND_NOUNS.city;
  if (!candidates.length) {
    return "No areas found. Check the spelling, or add the state, like “Garfield County, CO”.";
  }
  if (!candidates.some((candidate) => candidate.type_match)) {
    return "Pick a place below, or change the kind of place.";
  }
  if (candidates.length === 1) {
    return `Found 1 ${nouns.one}.`;
  }
  return `Found ${candidates.length} ${nouns.many}. Pick the one you mean.`;
}

export async function validateLocationInput() {
  const query = document.getElementById("location-input")?.value.trim() || "";
  const typeSelect = document.getElementById("location-type");
  const areaType = typeSelect?.value || "city";

  if (!query || query.length < 2) {
    return;
  }

  if (query === validationState.lastQuery && areaType === validationState.lastType) {
    return;
  }

  validationState.lastQuery = query;
  validationState.lastType = areaType;
  const requestId = ++validationState.requestId;

  try {
    const result = await apiClient.post(
      `${API_BASE}/areas/validate`,
      { location: query, area_type: areaType, limit: CANDIDATE_LIMIT },
      withSignal()
    );

    if (requestId !== validationState.requestId) {
      return;
    }

    // Typing "County" searches counties; show that in the kind picker.
    const kind = result.kind || areaType;
    if (typeSelect && kind !== areaType) {
      typeSelect.value = kind;
      validationState.lastType = kind;
    }

    validationState.candidates = result.candidates || [];
    renderValidationCandidates(validationState.candidates);
    setValidationNote(result.note);
    setValidationStatus({
      icon: validationState.candidates.length ? "fa-list" : "fa-magnifying-glass",
      message: describeSearchResult(validationState.candidates, kind),
      tone: validationState.candidates.length ? "info" : "warning",
    });

    // One clear match needs no extra tap.
    const [onlyCandidate] = validationState.candidates;
    if (validationState.candidates.length === 1 && onlyCandidate.type_match) {
      await resolveValidationCandidateAtIndex(0);
    }
  } catch (error) {
    if (requestId !== validationState.requestId) {
      return;
    }
    setValidationStatus({
      icon: "fa-exclamation-circle",
      message: `Couldn't search for places: ${error.message}`,
      tone: "danger",
    });
  }
}

async function resolveValidationCandidateAtIndex(index) {
  const candidate = validationState.candidates[index];
  if (!candidate) {
    return;
  }

  validationState.selectedCandidate = candidate;
  validationState.confirmedCandidate = null;
  validationState.confirmedBoundary = null;
  setAddButtonEnabled(false);
  markSelectedCandidate(index);

  const label = candidateLabel(candidate);
  setValidationStatus({
    icon: "fa-spinner fa-spin",
    message: `Loading the boundary of ${label}…`,
    tone: "info",
  });

  const resolveId = ++validationState.resolveRequestId;

  try {
    const result = await apiClient.post(
      `${API_BASE}/areas/resolve`,
      { osm_id: candidate.osm_id, osm_type: candidate.osm_type },
      withSignal()
    );

    if (resolveId !== validationState.resolveRequestId) {
      return;
    }

    const resolvedCandidate =
      result && typeof result === "object" && result.candidate
        ? result.candidate
        : result;
    const resolvedBoundary =
      resolvedCandidate && typeof resolvedCandidate === "object"
        ? resolvedCandidate.boundary
        : null;

    if (!resolvedBoundary) {
      throw new Error("Resolved location did not include a boundary.");
    }

    validationState.confirmedCandidate = resolvedCandidate;
    validationState.confirmedBoundary = resolvedBoundary;

    setValidationStatus({
      icon: "fa-check-circle",
      message: `${label} is ready to add.`,
      tone: "success",
    });
    setAddButtonEnabled(true);
  } catch (error) {
    if (resolveId !== validationState.resolveRequestId) {
      return;
    }
    markSelectedCandidate(-1);
    setValidationStatus({
      icon: "fa-exclamation-circle",
      message: `Couldn't load the boundary of ${label}: ${error.message}`,
      tone: "danger",
    });
  }
}

/** "Garfield County, Colorado" from a candidate's name and context. */
export function candidateLabel(candidate) {
  const name = candidate?.name || candidate?.display_name || "this place";
  const region = String(candidate?.context || "")
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean)
    .at(-1);
  return region && region !== name ? `${name}, ${region}` : name;
}

export function buildCandidateMarkup(candidate, index) {
  const name = candidate.name || candidate.display_name || "";
  const context = candidate.context
    ? `<div class="candidate-context">${escapeHtml(candidate.context)}</div>`
    : "";
  const kindBadge = candidate.kind_label
    ? `<span class="validation-badge badge-kind">${escapeHtml(candidate.kind_label)}</span>`
    : "";
  const approximate =
    candidate.has_boundary === false
      ? '<span class="validation-badge badge-approx" title="No mapped boundary; uses the area around this point">Approximate boundary</span>'
      : "";
  return `
    <button type="button"
            class="validation-candidate"
            data-candidate-index="${index}"
            role="option"
            aria-selected="false">
      <div class="candidate-body">
        <div class="candidate-title">${escapeHtml(name)}</div>
        ${context}
        <div class="candidate-meta">${kindBadge}${approximate}</div>
      </div>
      <i class="candidate-icon fas fa-chevron-right" aria-hidden="true"></i>
    </button>`;
}

export function renderValidationCandidates(candidates) {
  if (!validationElements?.candidates) {
    return;
  }
  validationElements.candidates.innerHTML = candidates
    .map((candidate, index) => buildCandidateMarkup(candidate, index))
    .join("");
}

export async function handleCandidateClick(event) {
  const btn = event.target.closest("[data-candidate-index]");
  if (!btn) {
    return;
  }

  const idx = parseInt(btn.dataset.candidateIndex, 10);
  if (Number.isNaN(idx)) {
    return;
  }
  await resolveValidationCandidateAtIndex(idx);
}
