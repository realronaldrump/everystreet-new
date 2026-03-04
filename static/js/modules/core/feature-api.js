import apiClient from "./api-client.js";

function withSignal(signal, options = {}) {
  if (!signal) {
    return options;
  }
  return { ...options, signal };
}

async function parseRawResponse(response, parser) {
  const data = await parser(response);
  if (response.ok) {
    return data;
  }
  const err = new Error(
    data?.detail || data?.error || data?.message || `HTTP ${response.status}`
  );
  err.status = response.status;
  err.statusText = response.statusText;
  err.body = data;
  throw err;
}

export function createFeatureApi({ signal = null } = {}) {
  return {
    withSignal: (options = {}) => withSignal(signal, options),

    get: (url, options = {}) => apiClient.get(url, withSignal(signal, options)),
    post: (url, body, options = {}) =>
      apiClient.post(url, body, withSignal(signal, options)),
    patch: (url, body, options = {}) =>
      apiClient.patch(url, body, withSignal(signal, options)),
    delete: (url, options = {}) => apiClient.delete(url, withSignal(signal, options)),

    raw: (url, options = {}) => apiClient.raw(url, withSignal(signal, options)),

    rawJson: async (url, options = {}) => {
      const response = await apiClient.raw(url, withSignal(signal, options));
      return parseRawResponse(response, async (res) => {
        try {
          return await res.json();
        } catch {
          return null;
        }
      });
    },

    rawText: async (url, options = {}) => {
      const response = await apiClient.raw(url, withSignal(signal, options));
      return parseRawResponse(response, (res) => res.text());
    },
  };
}

export default createFeatureApi;
