// JSON-driven views update only their result regions. Controls stay mounted.
// Record focus/scroll before committing the result, then animate the changed region.
export function updateRegion(element, update) {
  if (!element) return update();
  const focused = element.contains(document.activeElement)
    ? document.activeElement
    : null;
  const key = focused?.id;
  const top = element.scrollTop;
  const left = element.scrollLeft;
  const result = update();
  element.scrollTop = top;
  element.scrollLeft = left;
  if (key && !focused.isConnected)
    document.getElementById(key)?.focus({ preventScroll: true });
  if (!matchMedia("(prefers-reduced-motion: reduce)").matches && element.animate) {
    element.getAnimations().forEach((animation) => animation.cancel());
    element.animate([{ opacity: 0.6 }, { opacity: 1 }], {
      duration: 160,
      easing: "ease-out",
    });
  }
  return result;
}
