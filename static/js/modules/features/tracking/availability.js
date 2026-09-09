/** Server-owned tracking switch. Missing flags and public viewers stay off. */
export function isBouncieLiveTrackingEnabled() {
  return (
    globalThis.window?.APP_SETTINGS_FLAGS?.bouncieLiveTrackingEnabled === true &&
    globalThis.window?.AUTH_CONTEXT?.isOwner === true
  );
}

export function disableBouncieLiveTracking() {
  if (globalThis.window?.APP_SETTINGS_FLAGS) {
    window.APP_SETTINGS_FLAGS.bouncieLiveTrackingEnabled = false;
  }
}
