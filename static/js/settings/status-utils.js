const STATUS_TONES = new Set(["info", "success", "warning", "danger"]);
const STATUS_ALIASES = {
  error: "danger",
  warn: "warning",
};

export function initInlineStatus(element) {
  if (!element) {
    return;
  }

  element.classList.add("settings-status");
  element.classList.remove("d-none");

  if (!element.hasAttribute("role")) {
    element.setAttribute("role", "status");
  }
  if (!element.hasAttribute("aria-live")) {
    element.setAttribute("aria-live", "polite");
  }
  if (!element.hasAttribute("aria-atomic")) {
    element.setAttribute("aria-atomic", "true");
  }
}

export function setInlineStatus(element, message, tone = "info") {
  if (!element) {
    return;
  }

  initInlineStatus(element);

  const text
    = typeof message === "string"
      ? message
      : message == null
        ? ""
        : String(message);

  if (!text) {
    clearInlineStatus(element);
    return;
  }

  const normalizedTone = STATUS_ALIASES[tone] || tone;
  const resolvedTone = STATUS_TONES.has(normalizedTone) ? normalizedTone : "info";

  element.textContent = text;
  element.dataset.tone = resolvedTone;
  element.classList.remove("is-hidden");
}

export function clearInlineStatus(element) {
  if (!element) {
    return;
  }

  initInlineStatus(element);
  element.textContent = "";
  element.classList.add("is-hidden");
  delete element.dataset.tone;
}
