import apiClient from "../core/api-client.js";

export class OptimalRouteAPI {
  constructor(options = {}) {
    this.eventSource = null;
    this.progressPollTimer = null;
    this.progressPollInFlight = false;
    this.progressPollFailures = 0;
    this.currentTaskId = null;
    this.progressPollIntervalMs = options.progressPollIntervalMs || 2000;
    this.maxProgressPollFailures = options.maxProgressPollFailures || 20;
    this.onProgress = options.onProgress || (() => {});
    this.onComplete = options.onComplete || (() => {});
    this.onError = options.onError || (() => {});
    this.onCancel = options.onCancel || (() => {});
  }

  /**
   * Clear the cached coverage areas to force a fresh fetch.
   * Useful after areas are added/deleted in coverage management.
   */
  clearCoverageAreasCache() {
    if (window.coverageNavigatorAreas) {
      window.coverageNavigatorAreas = undefined;
    }
  }

  async loadCoverageAreas() {
    try {
      // Check cache, but only use it if it has data
      // This prevents empty arrays from being permanently cached
      if (window.coverageNavigatorAreas && window.coverageNavigatorAreas.length > 0) {
        return window.coverageNavigatorAreas;
      }

      const data = await apiClient.get("/api/coverage/areas");

      if (!data.success || !data.areas) {
        console.error("Failed to load coverage areas");
        return null;
      }

      // Only cache non-empty arrays to allow fresh fetches when areas are added
      if (data.areas.length > 0) {
        window.coverageNavigatorAreas = data.areas;
      }
      return data.areas;
    } catch (error) {
      console.error("Error loading coverage areas:", error);
      throw error;
    }
  }

  async loadStreetNetwork(areaId) {
    try {
      const data = await apiClient.get(`/api/coverage/areas/${areaId}/streets/all`);

      if (!data.features || !Array.isArray(data.features)) {
        throw new Error("Invalid street data format");
      }

      const drivenFeatures = [];
      const undrivenFeatures = [];

      data.features.forEach((feature) => {
        const status = feature.properties?.status;
        const isDriven = status === "driven" || feature.properties?.driven === true;
        const isUndriveable =
          status === "undriveable" || feature.properties?.undriveable === true;

        if (isDriven) {
          drivenFeatures.push(feature);
        } else if (!isUndriveable) {
          undrivenFeatures.push(feature);
        }
      });

      return { drivenFeatures, undrivenFeatures };
    } catch (error) {
      console.error("Error loading street network:", error);
      throw error;
    }
  }

  async loadExistingRoute(areaId) {
    try {
      const data = await apiClient.get(`/api/coverage/areas/${areaId}/optimal-route`);
      return data;
    } catch (error) {
      if (
        error?.status === 404 ||
        error?.message?.includes("No optimal route generated yet")
      ) {
        return null;
      }
      console.error("Error loading existing route:", error);
      throw error;
    }
  }

  async getAreaBounds(areaId) {
    try {
      const data = await apiClient.get(`/api/coverage/areas/${areaId}`);

      if (!data.success || !data.area) {
        return null;
      }

      const bbox = data.bounding_box;
      if (Array.isArray(bbox) && bbox.length === 4) {
        return [bbox[1], bbox[3], bbox[0], bbox[2]];
      }
      return null;
    } catch (error) {
      console.error("Error fetching area details:", error);
      return null;
    }
  }

  async checkForActiveTask(areaId) {
    try {
      const data = await apiClient.get(`/api/coverage/areas/${areaId}/active-task`);
      if (data.active && data.task_id) {
        return data;
      }
      return null;
    } catch (error) {
      console.debug("Could not check for active task:", error);
      return null;
    }
  }

  async checkWorkerStatus() {
    try {
      return await apiClient.get("/api/optimal-routes/worker-status");
    } catch (error) {
      console.warn("Could not check worker status:", error);
      return { status: "unknown", message: error.message };
    }
  }

  async generateRoute(areaId) {
    try {
      const data = await apiClient.post(`/api/coverage/areas/${areaId}/optimal-route`);
      return data.task_id;
    } catch (error) {
      console.error("Error starting route generation:", error);
      throw error;
    }
  }

  async cancelTask(taskId) {
    if (!taskId) {
      return null;
    }

    try {
      this.disconnectSSE();

      const data = await apiClient.delete(`/api/optimal-routes/${taskId}`);
      this.onCancel(data);
      return data;
    } catch (error) {
      console.error("Error cancelling task:", error);
      throw error;
    }
  }

  async clearRoute(areaId) {
    try {
      await apiClient.delete(`/api/coverage/areas/${areaId}/optimal-route`);
    } catch (error) {
      console.warn("Failed to clear route from backend:", error);
    }
  }

  async fetchActiveMission(areaId) {
    if (!areaId) {
      return null;
    }
    try {
      const data = await apiClient.get(
        `/api/coverage/missions/active?area_id=${encodeURIComponent(areaId)}`
      );
      return data?.mission || null;
    } catch {
      return null;
    }
  }

  async fetchMissionHistory(areaId, { limit = 20, status = null } = {}) {
    if (!areaId) {
      return [];
    }
    const params = new URLSearchParams({
      area_id: String(areaId),
      limit: String(limit),
      offset: "0",
    });
    if (status) {
      params.set("status", String(status));
    }
    try {
      const data = await apiClient.get(`/api/coverage/missions?${params.toString()}`);
      return Array.isArray(data?.missions) ? data.missions : [];
    } catch {
      return [];
    }
  }

  connectSSE(taskId) {
    this.disconnectSSE();
    this.currentTaskId = taskId;

    if (typeof EventSource === "undefined") {
      console.warn("EventSource unavailable, using progress polling default");
      this.startProgressPolling(taskId);
      return;
    }

    this.eventSource = new EventSource(`/api/optimal-routes/${taskId}/progress/sse`);

    this.eventSource.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data);
        this.progressPollFailures = 0;
        this.onProgress(data);
        this.handleTerminalState(data);
      } catch (e) {
        console.error("SSE parse error:", e);
      }
    };

    this.eventSource.addEventListener("done", () => {
      if (this.eventSource) {
        this.eventSource.close();
        this.eventSource = null;
      }
      if (this.currentTaskId === taskId) {
        this.startProgressPolling(taskId);
      }
    });

    this.eventSource.onerror = (error) => {
      console.warn("SSE connection error; switching to polling default:", error);
      if (this.eventSource) {
        this.eventSource.close();
        this.eventSource = null;
      }
      if (this.currentTaskId === taskId) {
        this.startProgressPolling(taskId);
      }
    };
  }

  handleTerminalState(data = {}) {
    const status = (data.status || "").toLowerCase();
    const stage = (data.stage || "").toLowerCase();

    if (status === "completed" || stage === "complete" || data.progress >= 100) {
      this.disconnectSSE();
      this.onComplete(data);
      return true;
    }

    if (status === "failed" || status === "error") {
      this.disconnectSSE();
      this.onError(data.error || data.message || "Route generation failed");
      return true;
    }

    if (status === "cancelled") {
      this.disconnectSSE();
      this.onCancel(data);
      return true;
    }

    return false;
  }

  startProgressPolling(taskId) {
    if (!taskId || this.progressPollTimer) {
      return;
    }

    const pollProgress = async () => {
      if (this.progressPollInFlight || this.currentTaskId !== taskId) {
        return;
      }

      this.progressPollInFlight = true;
      try {
        const data = await apiClient.get(`/api/optimal-routes/${taskId}/progress`, {
          retry: false,
          timeout: 15000,
        });
        this.progressPollFailures = 0;
        this.onProgress(data);
        this.handleTerminalState(data);
      } catch (error) {
        if (error?.status === 404) {
          return;
        }
        this.progressPollFailures += 1;
        console.warn("Progress polling error:", error);
        if (this.progressPollFailures >= this.maxProgressPollFailures) {
          this.disconnectSSE();
          this.onError("Connection lost");
        }
      } finally {
        this.progressPollInFlight = false;
      }
    };

    void pollProgress();
    this.progressPollTimer = setInterval(() => {
      void pollProgress();
    }, this.progressPollIntervalMs);
  }

  stopProgressPolling() {
    if (this.progressPollTimer) {
      clearInterval(this.progressPollTimer);
      this.progressPollTimer = null;
    }
    this.progressPollInFlight = false;
    this.progressPollFailures = 0;
  }

  disconnectSSE() {
    if (this.eventSource) {
      this.eventSource.close();
      this.eventSource = null;
    }
    this.stopProgressPolling();
    this.currentTaskId = null;
  }
}
