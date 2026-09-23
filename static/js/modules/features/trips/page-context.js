/**
 * The Trips page's navigation signal and API client, shared by the page
 * and the trip modal. Listeners bound here are removed when the page leaves.
 */

import { createFeatureApi } from "../../core/feature-api.js";

export let pageSignal = null;
let featureApi = createFeatureApi();

/** Bind the page to its navigation signal and API client. */
export function setPageContext({ signal, api } = {}) {
  pageSignal = signal || null;
  featureApi = api || createFeatureApi({ signal: pageSignal });
}

/** Drop the signal if it is still the current one; true when it was. */
export function releasePageSignal(signal) {
  if (pageSignal !== signal) {
    return false;
  }
  pageSignal = null;
  return true;
}

export const apiGet = (url, options = {}) => featureApi.get(url, options);
export const apiPost = (url, body, options = {}) => featureApi.post(url, body, options);
export const apiDelete = (url, options = {}) => featureApi.delete(url, options);

export function bindPageEvent(target, type, handler, options) {
  const el = typeof target === "string" ? document.getElementById(target) : target;
  el?.addEventListener(
    type,
    handler,
    pageSignal ? { ...(options || {}), signal: pageSignal } : options
  );
}
