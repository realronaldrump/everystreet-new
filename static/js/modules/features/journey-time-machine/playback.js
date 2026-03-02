const BASE_STEP_INTERVAL_MS = 1200;

export function createPlaybackController({
  getEvents,
  getActiveIndex,
  onSelectIndex,
  onPlayStateChange,
  getSpeed,
}) {
  let timerId = null;

  const stop = () => {
    if (timerId) {
      clearInterval(timerId);
      timerId = null;
    }
  };

  const stepForward = () => {
    const events = getEvents();
    if (!events.length) {
      stop();
      onPlayStateChange(false);
      return;
    }

    const activeIndex = getActiveIndex();
    if (activeIndex >= events.length - 1) {
      stop();
      onPlayStateChange(false);
      return;
    }

    onSelectIndex(activeIndex + 1);
  };

  const start = () => {
    stop();
    const speed = Math.max(0.25, Number(getSpeed()) || 1);
    const interval = Math.max(220, Math.round(BASE_STEP_INTERVAL_MS / speed));
    timerId = setInterval(stepForward, interval);
    onPlayStateChange(true);
  };

  const toggle = () => {
    if (timerId) {
      stop();
      onPlayStateChange(false);
      return false;
    }

    start();
    return true;
  };

  return {
    start,
    stop,
    toggle,
    isPlaying: () => Boolean(timerId),
    restart: () => {
      if (!timerId) {
        return;
      }
      start();
    },
  };
}

export function findClosestIndexByTimestamp(events, targetIso) {
  if (!Array.isArray(events) || events.length === 0 || !targetIso) {
    return 0;
  }

  const target = new Date(targetIso).getTime();
  if (!Number.isFinite(target)) {
    return 0;
  }

  let bestIndex = 0;
  let bestDelta = Number.POSITIVE_INFINITY;

  events.forEach((event, index) => {
    const stamp = new Date(event.timestamp).getTime();
    if (!Number.isFinite(stamp)) {
      return;
    }
    const delta = Math.abs(stamp - target);
    if (delta < bestDelta) {
      bestDelta = delta;
      bestIndex = index;
    }
  });

  return bestIndex;
}

export function findIndexWithMinuteOffset(events, activeIndex, offsetMinutes) {
  if (!Array.isArray(events) || events.length === 0) {
    return -1;
  }

  const startEvent = events[Math.max(0, Math.min(activeIndex, events.length - 1))];
  const startTs = new Date(startEvent?.timestamp || "").getTime();
  if (!Number.isFinite(startTs)) {
    return -1;
  }

  const targetTs = startTs + offsetMinutes * 60 * 1000;

  let bestIndex = activeIndex;
  let bestDelta = Number.POSITIVE_INFINITY;

  events.forEach((event, index) => {
    const ts = new Date(event.timestamp).getTime();
    if (!Number.isFinite(ts)) {
      return;
    }
    const delta = Math.abs(ts - targetTs);
    if (delta < bestDelta) {
      bestDelta = delta;
      bestIndex = index;
    }
  });

  return bestIndex;
}
