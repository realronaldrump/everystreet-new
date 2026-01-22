export function animateValue(element, endValue, formatter, duration = 500) {
  if (!element) {
    return;
  }

  const startValue = parseFloat(element.textContent.replace(/[^0-9.-]/g, "")) || 0;
  const startTime = performance.now();

  element.classList.add("updating");

  function update(currentTime) {
    const elapsed = currentTime - startTime;
    const progress = Math.min(elapsed / duration, 1);

    // Easing function (ease-out cubic)
    const eased = 1 - (1 - progress) ** 3;
    const current = startValue + (endValue - startValue) * eased;

    element.textContent = formatter(current);

    if (progress < 1) {
      requestAnimationFrame(update);
    } else {
      element.classList.remove("updating");
    }
  }

  requestAnimationFrame(update);
}
