export function detailParent(path) {
  if (/^\/trips\/[^/]+$/.test(path)) return "/trips";
  if (/^\/coverage-management\/[^/]+\/journal$/.test(path))
    return "/coverage-management";
  return null;
}

export function transitionKind(
  from,
  to,
  { backwards = false, detail = false, closing = false } = {}
) {
  if (closing) return "detail-close";
  if (detail) return "detail-open";
  if (to === "/live-navigation") return "drive";
  if (
    [from, to].every((path) =>
      ["/coverage-management", "/coverage-route-planner"].includes(path)
    )
  )
    return "explore";
  return backwards ? "back" : "forward";
}

export function shouldSkipPopState(event, renderedPath, targetPath) {
  return Boolean(
    event?.state?.source && event.state.source !== "swup" && renderedPath === targetPath
  );
}
