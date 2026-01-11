/**
 * Step Indicators Module
 * Manages the visual step indicators in the progress modal
 */

import { STATUS } from "./constants.js";

/**
 * Mark a step as complete
 */
function markComplete(steps, stepKey) {
  if (steps[stepKey]) {
    steps[stepKey].classList.add("complete");
    steps[stepKey].style.transform = "scale(0.9)";
    const iconEl = steps[stepKey].querySelector(".step-icon i");
    if (iconEl) {
      iconEl.className = "fas fa-check-circle";
    }
  }
}

/**
 * Mark a step as active
 */
function markActive(steps, stepKey) {
  if (steps[stepKey]) {
    steps[stepKey].classList.add("active");
    steps[stepKey].style.transform = "scale(1.1)";
  }
}

/**
 * Mark a step as error
 */
function markError(steps, stepKey) {
  if (steps[stepKey]) {
    steps[stepKey].classList.add("error");
    steps[stepKey].style.transform = "scale(1.1)";
    const iconEl = steps[stepKey].querySelector(".step-icon i");
    if (iconEl) {
      iconEl.className = "fas fa-exclamation-triangle";
    }
  }
}

/**
 * Mark error step based on progress level and update previous steps
 */
function markErrorStepByProgress(progress, steps) {
  const errorSteps = [
    { threshold: 75, step: "calculating" },
    { threshold: 50, step: "indexing" },
    { threshold: 10, step: "preprocessing" },
    { threshold: 0, step: "initializing" },
  ];

  const errorStep = errorSteps.find((s) => progress > s.threshold && steps[s.step]);

  if (!errorStep) {
    return false;
  }

  markError(steps, errorStep.step);

  // Mark all previous steps as complete
  const stepOrder = ["initializing", "preprocessing", "indexing", "calculating"];
  const errorIndex = stepOrder.indexOf(errorStep.step);
  for (let i = 0; i < errorIndex; i++) {
    if (steps[stepOrder[i]]) {
      markComplete(steps, stepOrder[i]);
    }
  }

  return true;
}

/**
 * Mark error on active step for canceled tasks
 */
function markCanceledStep(steps) {
  const stepOrder = ["calculating", "indexing", "preprocessing", "initializing"];
  for (const stepKey of stepOrder) {
    if (steps[stepKey]?.classList.contains("active")) {
      markError(steps, stepKey);
      return;
    }
  }
  if (steps.initializing) {
    markError(steps, "initializing");
  }
}

/**
 * Mark steps based on progress percentage as fallback
 */
function markStepsByProgress(progress, stage, steps) {
  if (progress >= 100) {
    markComplete(steps, "initializing");
    markComplete(steps, "preprocessing");
    markComplete(steps, "indexing");
    markComplete(steps, "calculating");
    markComplete(steps, "complete");
  } else if (progress > 75) {
    markComplete(steps, "initializing");
    markComplete(steps, "preprocessing");
    markComplete(steps, "indexing");
    markActive(steps, "calculating");
  } else if (progress > 50 || stage?.toLowerCase().includes("preprocessing")) {
    markComplete(steps, "initializing");
    markActive(steps, "preprocessing");
  } else {
    markActive(steps, "initializing");
  }
}

/**
 * Mark steps based on completion stage
 */
function markStepsByStage(stage, progress, steps) {
  switch (stage) {
    case STATUS.INITIALIZING:
      markActive(steps, "initializing");
      break;
    case STATUS.PREPROCESSING:
    case STATUS.LOADING_STREETS:
      markComplete(steps, "initializing");
      markActive(steps, "preprocessing");
      break;
    case STATUS.POST_PREPROCESSING:
    case STATUS.INDEXING:
      markComplete(steps, "initializing");
      markComplete(steps, "preprocessing");
      markActive(steps, "indexing");
      break;
    case STATUS.COUNTING_TRIPS:
    case STATUS.PROCESSING_TRIPS:
    case STATUS.CALCULATING:
    case STATUS.FINALIZING:
    case STATUS.GENERATING_GEOJSON:
    case STATUS.COMPLETE_STATS:
      markComplete(steps, "initializing");
      markComplete(steps, "preprocessing");
      markComplete(steps, "indexing");
      markActive(steps, "calculating");
      break;
    case STATUS.COMPLETE:
    case STATUS.COMPLETED:
      markComplete(steps, "initializing");
      markComplete(steps, "preprocessing");
      markComplete(steps, "indexing");
      markComplete(steps, "calculating");
      markComplete(steps, "complete");
      break;
    default:
      markStepsByProgress(progress, stage, steps);
      break;
  }
}

/**
 * Update step indicators in the modal
 */
export function updateStepIndicators(modal, stage, progress) {
  if (!modal) {
    return;
  }

  const steps = {
    initializing: modal.querySelector(".step-initializing"),
    preprocessing: modal.querySelector(".step-preprocessing"),
    indexing: modal.querySelector(".step-indexing"),
    calculating: modal.querySelector(".step-calculating"),
    complete: modal.querySelector(".step-complete"),
  };

  // Reset all steps
  Object.values(steps).forEach((step) => {
    if (step) {
      step.classList.remove("active", "complete", "error");
      step.style.transform = "scale(1)";
    }
  });

  // Handle error state
  if (stage === STATUS.ERROR) {
    markErrorStepByProgress(progress, steps);
    return;
  }

  // Handle canceled state
  if (stage === STATUS.CANCELED) {
    markCanceledStep(steps);
    return;
  }

  // Mark steps based on stage
  markStepsByStage(stage, progress, steps);
}
