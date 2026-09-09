/**
 * Move focus out of a modal before its aria-hidden state is applied.
 *
 * Bootstrap applies aria-hidden while hiding a modal. If the modal or one of
 * its descendants still owns focus at that point, browsers report an
 * accessibility violation and assistive technology can lose its focus target.
 */
export function moveFocusOutOfModal(
  modal,
  {
    documentRef = globalThis.document,
    preferredTarget = null,
    fallbackSelector = "#main-content",
  } = {}
) {
  if (!modal || !documentRef || !modal.contains?.(documentRef.activeElement)) {
    return false;
  }

  const target = [
    preferredTarget,
    documentRef.querySelector?.(fallbackSelector),
  ].find(
    (candidate) =>
      candidate &&
      candidate !== modal &&
      candidate.isConnected !== false &&
      typeof candidate.focus === "function"
  );

  if (!target) {
    return false;
  }

  try {
    target.focus({ preventScroll: true });
  } catch {
    target.focus();
  }

  return !modal.contains?.(documentRef.activeElement);
}
