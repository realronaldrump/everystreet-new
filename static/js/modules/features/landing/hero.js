export function updateGreeting(elements = {}) {
  if (!elements.greetingTitle || !elements.greetingSubtitle) {
    return;
  }
  const hour = new Date().getHours();
  let title = "Welcome back";
  let subtitle = "Here is your latest drive snapshot.";

  if (hour >= 5 && hour < 12) {
    title = "Good morning";
    subtitle = "Plan your next drive while the roads are fresh.";
  } else if (hour >= 12 && hour < 17) {
    title = "Good afternoon";
    subtitle = "Your coverage journey is ready for another push.";
  } else if (hour >= 17 && hour < 22) {
    title = "Good evening";
    subtitle = "Wrap up the day with a quick route check.";
  } else {
    title = "Welcome back";
    subtitle = "Night drives still count toward coverage.";
  }

  elements.greetingTitle.textContent = title;
  elements.greetingSubtitle.textContent = subtitle;
}
