/**
 * Unified API Client
 * Centralizes all HTTP requests with consistent error handling, retry logic, and caching
 */

class APIClient {
  constructor() {
    this.baseURL = "";
    this.defaultTimeout = 30000;
    this.retryAttempts = 3;
    this.retryDelay = 1000;
    this.cache = new Map();
    this.cacheDuration = 5 * 60 * 1000; // 5 minutes default
  }

  /**
   * Main request method with unified error handling
   */
  async request(url, options = {}) {
    const {
      method = "GET",
      body = null,
      headers = {},
      timeout = this.defaultTimeout,
      retry = true,
      cache = false,
      cacheDuration = this.cacheDuration,
      signal = null,
    } = options;

    // Check cache for GET requests
    if (method === "GET" && cache) {
      const cached = this._getFromCache(url);
      if (cached) {
        return cached;
      }
    }

    // Build request options
    const fetchOptions = {
      method,
      headers: {
        "Content-Type": "application/json",
        ...headers,
      },
      signal,
    };

    if (body) {
      fetchOptions.body = typeof body === "string" ? body : JSON.stringify(body);
    }

    // Execute with timeout and retry
    const controller = new AbortController();
    const activeSignal = signal || controller.signal;
    let timeoutTriggered = false;
    const timeoutId = timeout && !signal
      ? setTimeout(() => {
        timeoutTriggered = true;
        controller.abort();
      }, timeout)
      : null;

    try {
      const response = await this._fetchWithRetry(
        url,
        { ...fetchOptions, signal: activeSignal },
        retry ? this.retryAttempts : 1
      );

      if (timeoutId) {
        clearTimeout(timeoutId);
      }

      // Handle response
      const data = options.parseResponse
        ? await options.parseResponse(response)
        : await this._handleResponse(response);

      // Cache successful GET requests
      if (method === "GET" && cache) {
        this._setCache(url, data, cacheDuration);
      }

      return data;
    } catch (error) {
      if (timeoutId) {
        clearTimeout(timeoutId);
      }
      if (timeoutTriggered && error?.name === "AbortError") {
        const timeoutError = new Error(`Request timeout: ${url}`);
        timeoutError.name = "TimeoutError";
        throw timeoutError;
      }
      throw this._handleError(error, url);
    }
  }

  /**
   * Raw fetch that returns Response (used for non-JSON flows like HTML/SW)
   */
  async raw(url, options = {}) {
    const {
      timeout = this.defaultTimeout,
      retry = true,
      signal,
      ...fetchOptions
    } = options;
    const controller = new AbortController();
    const activeSignal = signal || controller.signal;
    let timeoutTriggered = false;
    const timeoutId = timeout && !signal
      ? setTimeout(() => {
        timeoutTriggered = true;
        controller.abort();
      }, timeout)
      : null;

    try {
      const response = await this._fetchWithRetry(
        url,
        { ...fetchOptions, signal: activeSignal },
        retry ? this.retryAttempts : 1
      );
      return response;
    } catch (error) {
      if (timeoutTriggered && error?.name === "AbortError") {
        const timeoutError = new Error(`Request timeout: ${url}`);
        timeoutError.name = "TimeoutError";
        throw timeoutError;
      }
      throw this._handleError(error, url);
    } finally {
      if (timeoutId) {
        clearTimeout(timeoutId);
      }
    }
  }

  /**
   * Fetch with automatic retry logic
   */
  async _fetchWithRetry(url, options, attempts) {
    for (let i = 0; i < attempts; i++) {
      try {
        const response = await fetch(url, options);

        // Don't retry on client errors (4xx), only server errors (5xx) and network failures
        if (response.ok || (response.status >= 400 && response.status < 500)) {
          return response;
        }

        // If this wasn't the last attempt and we got a 5xx error, retry
        if (i < attempts - 1) {
          await this._delay(this.retryDelay * 2 ** i); // Exponential backoff
          continue;
        }

        return response;
      } catch (error) {
        // Network errors - retry
        if (i < attempts - 1 && error.name !== "AbortError") {
          await this._delay(this.retryDelay * 2 ** i);
          continue;
        }
        throw error;
      }
    }
    throw new Error("Retry attempts exhausted");
  }

  /**
   * Handle response and extract data
   */
  async _handleResponse(response) {
    if (!response.ok) {
      let errorDetail = `HTTP ${response.status}`;

      try {
        const contentType = response.headers.get("content-type");
        if (contentType?.includes("application/json")) {
          const errorData = await response.json();
          errorDetail
            = errorData.detail || errorData.error || errorData.message || errorDetail;
        } else {
          const text = await response.text();
          errorDetail = text || errorDetail;
        }
      } catch {
        // If we can't parse the error, use the status code
      }

      const error = new Error(errorDetail);
      error.status = response.status;
      error.statusText = response.statusText;
      throw error;
    }

    // Handle empty responses
    const contentType = response.headers.get("content-type");
    if (!contentType) {
      return null;
    }

    // Parse response based on content type
    if (contentType.includes("application/json") || contentType.includes("geo+json")) {
      // For streaming responses, we need to read the full body first
      // This handles both regular JSON and streamed GeoJSON
      try {
        const text = await response.text();
        if (!text || text.trim() === "") {
          console.warn("Empty response body received from:", response.url);
          return null;
        }
        return JSON.parse(text);
      } catch (parseError) {
        if (parseError?.name === "AbortError") {
          throw parseError;
        }
        console.error("JSON parse error:", parseError, "Response URL:", response.url);
        throw new Error(`Failed to parse JSON response: ${parseError.message}`);
      }
    }
    if (contentType.includes("text/")) {
      return response.text();
    }
    return response.blob();
  }

  /**
   * Handle and normalize errors
   */
  _handleError(error, url) {
    if (error?.name === "AbortError") {
      return error;
    }

    if (error instanceof TypeError && error.message.includes("Failed to fetch")) {
      return new Error(`Network error - please check your connection`);
    }

    return error;
  }

  /**
   * GET request
   */
  get(url, options = {}) {
    return this.request(url, { ...options, method: "GET" });
  }

  /**
   * POST request
   */
  post(url, body, options = {}) {
    return this.request(url, { ...options, method: "POST", body });
  }

  /**
   * PUT request
   */
  put(url, body, options = {}) {
    return this.request(url, { ...options, method: "PUT", body });
  }

  /**
   * PATCH request
   */
  patch(url, body, options = {}) {
    return this.request(url, { ...options, method: "PATCH", body });
  }

  /**
   * DELETE request
   */
  delete(url, options = {}) {
    return this.request(url, { ...options, method: "DELETE" });
  }

  /**
   * Cache management
   */
  _getFromCache(key) {
    const cached = this.cache.get(key);
    if (!cached) {
      return null;
    }

    if (Date.now() - cached.timestamp > cached.duration) {
      this.cache.delete(key);
      return null;
    }

    return cached.data;
  }

  _setCache(key, data, duration) {
    this.cache.set(key, {
      data,
      timestamp: Date.now(),
      duration,
    });
  }

  clearCache(pattern = null) {
    if (!pattern) {
      this.cache.clear();
    } else {
      const regex = new RegExp(pattern);
      for (const key of this.cache.keys()) {
        if (regex.test(key)) {
          this.cache.delete(key);
        }
      }
    }
  }

  /**
   * Utility: delay for retry logic
   */
  _delay(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}

// Create singleton instance
const apiClient = new APIClient();

// Export both the class and singleton
export { APIClient, apiClient };
export default apiClient;
