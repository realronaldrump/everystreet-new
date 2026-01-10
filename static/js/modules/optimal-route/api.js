export class OptimalRouteAPI {
  constructor(options = {}) {
    this.eventSource = null;
    this.onProgress = options.onProgress || (() => {});
    this.onComplete = options.onComplete || (() => {});
    this.onError = options.onError || (() => {});
    this.onCancel = options.onCancel || (() => {});
  }

  async loadCoverageAreas() {
    try {
      if (window.coverageNavigatorAreas) {
        return window.coverageNavigatorAreas;
      }

      const response = await fetch("/api/coverage_areas");
      const data = await response.json();

      if (!data.success || !data.areas) {
        console.error("Failed to load coverage areas");
        return null;
      }
      window.coverageNavigatorAreas = data.areas;
      return data.areas;
    } catch (error) {
      console.error("Error loading coverage areas:", error);
      throw error;
    }
  }

  async loadStreetNetwork(areaId) {
    try {
      const response = await fetch(`/api/coverage_areas/${areaId}/streets`);
      if (!response.ok) {
        throw new Error("Failed to load streets");
      }

      const data = await response.json();
      if (!data.features || !Array.isArray(data.features)) {
        throw new Error("Invalid street data format");
      }

      const drivenFeatures = [];
      const undrivenFeatures = [];

      data.features.forEach((feature) => {
        if (feature.properties?.driven) {
          drivenFeatures.push(feature);
        } else if (!feature.properties?.undriveable) {
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
      const response = await fetch(
        `/api/coverage_areas/${areaId}/optimal-route`,
      );

      if (response.status === 404) {
        return null;
      }

      if (!response.ok) {
        throw new Error("Failed to load route");
      }

      return await response.json();
    } catch (error) {
      console.error("Error loading existing route:", error);
      throw error;
    }
  }

  async getAreaBounds(areaId) {
    try {
      const response = await fetch(`/api/coverage_areas/${areaId}`);
      const data = await response.json();

      if (!data.success || !data.coverage) return null;

      const { location } = data.coverage;
      if (location?.boundingbox) {
        return location.boundingbox.map(parseFloat);
      }
      return null;
    } catch (error) {
      console.error("Error fetching area details:", error);
      return null;
    }
  }

  async checkForActiveTask(areaId) {
    try {
      const response = await fetch(`/api/coverage_areas/${areaId}/active-task`);
      if (!response.ok) return null;

      const data = await response.json();
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
      const response = await fetch("/api/optimal-routes/worker-status");
      return await response.json();
    } catch (error) {
      console.warn("Could not check worker status:", error);
      return { status: "unknown", message: error.message };
    }
  }

  async generateRoute(areaId) {
    try {
      const response = await fetch(
        `/api/coverage_areas/${areaId}/generate-optimal-route`,
        { method: "POST" },
      );

      if (!response.ok) {
        const error = await response.json();
        throw new Error(error.detail || "Failed to start route generation");
      }

      const data = await response.json();
      return data.task_id;
    } catch (error) {
      console.error("Error starting route generation:", error);
      throw error;
    }
  }

  async cancelTask(taskId) {
    if (!taskId) return;

    try {
      if (this.eventSource) {
        this.eventSource.close();
        this.eventSource = null;
      }

      const response = await fetch(`/api/optimal-routes/${taskId}`, {
        method: "DELETE",
      });

      const data = await response.json();
      this.onCancel(data);
      return data;
    } catch (error) {
      console.error("Error cancelling task:", error);
      throw error;
    }
  }

  async clearRoute(areaId) {
    try {
      await fetch(`/api/coverage_areas/${areaId}/optimal-route`, {
        method: "DELETE",
      });
    } catch (error) {
      console.warn("Failed to clear route from backend:", error);
    }
  }

  connectSSE(taskId) {
    if (this.eventSource) {
      this.eventSource.close();
    }

    this.eventSource = new EventSource(
      `/api/optimal-routes/${taskId}/progress/sse`,
    );

    this.eventSource.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data);
        this.onProgress(data);

        const status = (data.status || "").toLowerCase();
        const stage = (data.stage || "").toLowerCase();

        if (
          status === "completed" ||
          stage === "complete" ||
          data.progress >= 100
        ) {
          this.eventSource.close();
          this.eventSource = null;
          this.onComplete(data);
        } else if (status === "failed") {
          this.eventSource.close();
          this.eventSource = null;
          this.onError(data.error || data.message || "Route generation failed");
        } else if (status === "cancelled") {
          this.eventSource.close();
          this.eventSource = null;
          this.onCancel(data);
        }
      } catch (e) {
        console.error("SSE parse error:", e);
      }
    };

    this.eventSource.addEventListener("done", () => {
      if (this.eventSource) {
        this.eventSource.close();
        this.eventSource = null;
      }
    });

    this.eventSource.onerror = (error) => {
      console.error("SSE connection error:", error);
      if (this.eventSource) {
        this.eventSource.close();
        this.eventSource = null;
      }
      // Depending on logic, we might want to treat this as an error or just a disconnect
      // The original code handled "waiting" timeout logic separately in the UI layer roughly
      // We'll let the UI handle the "stopped receiving updates" implication if needed, or emit an error here.
      // For now, let's treat it as a stream error.
      this.onError("Connection lost");
    };
  }

  disconnectSSE() {
    if (this.eventSource) {
      this.eventSource.close();
      this.eventSource = null;
    }
  }
}
