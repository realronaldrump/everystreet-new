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

export function formatMiles(value) {
  return Math.round(value).toLocaleString();
}

export function formatNumber(value) {
  return Math.round(value).toLocaleString();
}

export function formatTimeAgo(date) {
  const now = new Date();
  const diffMs = now - date;
  const diffSec = Math.floor(diffMs / 1000);
  const diffMin = Math.floor(diffSec / 60);
  const diffHour = Math.floor(diffMin / 60);
  const diffDay = Math.floor(diffHour / 24);

  if (diffSec < 60) {
    return "just now";
  }
  if (diffMin < 60) {
    return `${diffMin}m`;
  }
  if (diffHour < 24) {
    return `${diffHour}h`;
  }
  if (diffDay < 7) {
    return `${diffDay}d`;
  }
  if (diffDay < 30) {
    return `${Math.floor(diffDay / 7)}w`;
  }
  return `${Math.floor(diffDay / 30)}mo`;
}
