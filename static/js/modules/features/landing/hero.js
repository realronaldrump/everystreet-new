export function updateGreeting(elements = {}) {
  if (!elements.greetingTitle || !elements.greetingSubtitle) {
    return;
  }
  const now = new Date();
  const hour = now.getHours();
  let title = "Good evening";

  if (hour >= 5 && hour < 12) {
    title = "Good morning";
  } else if (hour >= 12 && hour < 17) {
    title = "Good afternoon";
  }

  elements.greetingTitle.textContent = title;
  elements.greetingSubtitle.textContent = now.toLocaleDateString(undefined, {
    weekday: "long",
    month: "long",
    day: "numeric",
  });
}
