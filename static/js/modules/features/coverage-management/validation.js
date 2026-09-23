/**
 * The Add Area form's location lookup: validate a place name, list the
 * candidates, and confirm the boundary to add.
 */

import apiClient from "../../core/api-client.js";
import { escapeHtml } from "../../utils.js";
import { API_BASE, withSignal } from "./context.js";

export const VALIDATION_DEBOUNCE_MS = 500;
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
    confirmation: document.getElementById("location-validation-confirmation"),
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

export function clearValidationSelection() {
  validationState.resolveRequestId += 1;
  validationState.selectedCandidate = null;
  validationState.confirmedCandidate = null;
  validationState.confirmedBoundary = null;
  setAddButtonEnabled(false);

  if (validationElements?.confirmation) {
    validationElements.confirmation.classList.add("d-none");
    validationElements.confirmation.textContent = "";
  }
  if (validationElements?.candidates) {
    validationElements.candidates
      .querySelectorAll(".validation-candidate")
      .forEach((el) => {
        el.classList.remove("is-selected");
      });
  }
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
  if (validationElements?.note) {
    validationElements.note.textContent = "";
    validationElements.note.classList.add("d-none");
  }
  if (validationElements?.confirmation) {
    validationElements.confirmation.classList.add("d-none");
    validationElements.confirmation.textContent = "";
  }
  setAddButtonEnabled(false);
  setValidationStatus({
    icon: "fa-location-dot",
    message: "Enter a location to validate.",
    tone: "neutral",
  });
}

export async function validateLocationInput() {
  const query = document.getElementById("location-input")?.value.trim() || "";
  const areaType = document.getElementById("location-type")?.value || "city";

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
      { location: query, area_type: areaType, limit: 5 },
      withSignal()
    );

    if (requestId !== validationState.requestId) {
      return;
    }

    validationState.candidates = prioritizeBoundaryCandidates(result.candidates || []);
    renderValidationCandidates(validationState.candidates);

    if (validationState.candidates.length === 0) {
      setValidationStatus({
        icon: "fa-triangle-exclamation",
        message: "No matches found. Try a different spelling or area type.",
        tone: "warning",
      });
    } else {
      setValidationStatus({
        icon: "fa-list",
        message: `Found ${validationState.candidates.length} match${validationState.candidates.length !== 1 ? "es" : ""}. Select one to confirm.`,
        tone: "info",
      });
    }

    const preferredCandidateIndex = getPreferredValidationCandidateIndex(
      validationState.candidates
    );
    if (preferredCandidateIndex >= 0) {
      await resolveValidationCandidateAtIndex(preferredCandidateIndex, { auto: true });
    }

    if (result.note && validationElements?.note) {
      validationElements.note.textContent = result.note;
      validationElements.note.classList.remove("d-none");
    } else if (validationElements?.note) {
      validationElements.note.textContent = "";
      validationElements.note.classList.add("d-none");
    }
  } catch (error) {
    if (requestId !== validationState.requestId) {
      return;
    }
    setValidationStatus({
      icon: "fa-exclamation-circle",
      message: `Validation error: ${error.message}`,
      tone: "danger",
    });
  }
}

function isNodeValidationCandidate(candidate) {
  return (
    String(candidate?.osm_type || "")
      .trim()
      .toLowerCase() === "node"
  );
}

function prioritizeBoundaryCandidates(candidates) {
  if (!Array.isArray(candidates) || candidates.length <= 1) {
    return Array.isArray(candidates) ? candidates : [];
  }

  return candidates
    .map((candidate, index) => ({
      candidate,
      index,
      isNode: isNodeValidationCandidate(candidate),
    }))
    .sort((a, b) => {
      if (a.isNode !== b.isNode) {
        return a.isNode ? 1 : -1;
      }
      return a.index - b.index;
    })
    .map(({ candidate }) => candidate);
}

function getPreferredValidationCandidateIndex(candidates) {
  if (!Array.isArray(candidates) || candidates.length === 0) {
    return -1;
  }
  return candidates.findIndex((candidate) => !isNodeValidationCandidate(candidate));
}

async function resolveValidationCandidateAtIndex(index, { auto = false } = {}) {
  const candidate = validationState.candidates[index];
  if (!candidate) {
    return;
  }

  validationState.selectedCandidate = candidate;
  validationState.confirmedCandidate = null;
  validationState.confirmedBoundary = null;
  setAddButtonEnabled(false);
  if (validationElements?.confirmation) {
    validationElements.confirmation.classList.add("d-none");
    validationElements.confirmation.textContent = "";
  }

  // Mark selected
  validationElements?.candidates
    ?.querySelectorAll(".validation-candidate")
    .forEach((el, i) => {
      el.classList.toggle("is-selected", i === index);
      el.setAttribute("aria-selected", i === index ? "true" : "false");
    });

  setValidationStatus({
    icon: "fa-spinner fa-spin",
    message: auto ? "Resolving boundary for best match…" : "Resolving boundary…",
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
      message: `Confirmed: ${escapeHtml(
        resolvedCandidate.display_name || candidate.display_name
      )}`,
      tone: "success",
    });

    if (validationElements?.confirmation) {
      validationElements.confirmation.textContent = `Ready to add: ${
        resolvedCandidate.display_name || candidate.display_name
      }`;
      validationElements.confirmation.classList.remove("d-none");
    }

    setAddButtonEnabled(true);
  } catch (error) {
    if (resolveId !== validationState.resolveRequestId) {
      return;
    }
    setValidationStatus({
      icon: "fa-exclamation-circle",
      message: `Failed to resolve boundary: ${error.message}`,
      tone: "danger",
    });
  }
}

export function renderValidationCandidates(candidates) {
  if (!validationElements?.candidates) {
    return;
  }
  if (!candidates.length) {
    validationElements.candidates.innerHTML = "";
    return;
  }

  validationElements.candidates.innerHTML = candidates
    .map((c, idx) => {
      const typeMatch = c.type_match
        ? ""
        : '<span class="validation-badge badge-mismatch">Type mismatch</span>';
      const pointOnly = isNodeValidationCandidate(c)
        ? '<span class="validation-badge badge-node">Point only</span>'
        : "";
      const typeBadge = `<span class="validation-badge">${escapeHtml(c.osm_type || "")}</span>`;
      return `
        <button type="button"
                class="validation-candidate"
                data-candidate-index="${idx}"
                role="option"
                aria-selected="false">
          <div>
            <div class="candidate-title">${escapeHtml(c.display_name || "")}</div>
            <div class="candidate-meta">${typeBadge}${pointOnly}${typeMatch}</div>
          </div>
          <i class="fas fa-chevron-right text-secondary" aria-hidden="true"></i>
        </button>`;
    })
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
