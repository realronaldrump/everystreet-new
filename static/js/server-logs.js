import apiClient from "./modules/core/api-client.js";
import confirmationDialog from "./modules/ui/confirmation-dialog.js";
import notificationManager from "./modules/ui/notifications.js";
import { escapeHtml, onPageLoad } from "./modules/utils.js";

onPageLoad(
  ({ signal, cleanup } = {}) => {
    // DOM elements
    const logsContainer = document.getElementById("logs-container");
    const logsInfo = document.getElementById("logs-info");
    const refreshLogsBtn = document.getElementById("refresh-logs");
    const refreshStatsBtn = document.getElementById("refresh-stats");
    const clearLogsBtn = document.getElementById("clear-logs");
    const exportLogsBtn = document.getElementById("export-logs");
    const applyFiltersBtn = document.getElementById("apply-logs-filters");
    const autoRefreshToggle = document.getElementById("auto-refresh-toggle");
    const copyAllLogsBtn = document.getElementById("copy-all-logs");

    const levelFilter = document.getElementById("level-filter");
    const limitFilter = document.getElementById("limit-filter");
    const searchFilter = document.getElementById("search-filter");

    // Guard: bail out if required elements are not found
    if (
      !logsContainer
      || !refreshLogsBtn
      || !refreshStatsBtn
      || !clearLogsBtn
      || !exportLogsBtn
      || !applyFiltersBtn
      || !autoRefreshToggle
      || !levelFilter
      || !limitFilter
      || !searchFilter
    ) {
      console.warn(
        "Server logs page: Required DOM elements not found, skipping initialization"
      );
      return;
    }

    // State
    let autoRefreshInterval = null;
    let autoRefreshEnabled = false;
    let currentLogs = [];

    // Initialize
    loadStats();
    loadLogs();

    // Event listeners
    refreshLogsBtn.addEventListener(
      "click",
      (e) => {
        e.preventDefault();
        loadLogs();
      },
      signal ? { signal } : false
    );
    refreshStatsBtn.addEventListener(
      "click",
      (e) => {
        e.preventDefault();
        loadStats();
      },
      signal ? { signal } : false
    );
    clearLogsBtn.addEventListener(
      "click",
      (e) => {
        e.preventDefault();
        clearLogs();
      },
      signal ? { signal } : false
    );
    exportLogsBtn.addEventListener(
      "click",
      (e) => {
        e.preventDefault();
        exportLogs();
      },
      signal ? { signal } : false
    );
    applyFiltersBtn.addEventListener(
      "click",
      (e) => {
        e.preventDefault();
        loadLogs();
      },
      signal ? { signal } : false
    );
    autoRefreshToggle.addEventListener(
      "click",
      (e) => {
        e.preventDefault();
        toggleAutoRefresh();
      },
      signal ? { signal } : false
    );
    if (copyAllLogsBtn) {
      copyAllLogsBtn.addEventListener(
        "click",
        (e) => {
          e.preventDefault();
          copyAllLogs();
        },
        signal ? { signal } : false
      );
    }

    // Allow Enter key in search filter
    searchFilter.addEventListener(
      "keypress",
      (e) => {
        if (e.key === "Enter") {
          loadLogs();
        }
      },
      signal ? { signal } : false
    );

    /**
     * Load log statistics
     */
    async function loadStats() {
      try {
        const data = await apiClient.get("/api/server-logs/stats");
        updateStatsDisplay(data);
      } catch {
        notificationManager.show("Failed to load log statistics", "warning");
      }
    }

    /**
     * Update statistics display
     */
    function updateStatsDisplay(data) {
      document.getElementById("total-count").textContent = data.total_count || 0;
      document.getElementById("debug-count").textContent = data.by_level?.DEBUG || 0;
      document.getElementById("info-count").textContent = data.by_level?.INFO || 0;
      document.getElementById("warning-count").textContent
        = data.by_level?.WARNING || 0;
      document.getElementById("error-count").textContent = data.by_level?.ERROR || 0;
      document.getElementById("critical-count").textContent
        = data.by_level?.CRITICAL || 0;
    }

    /**
     * Load logs from server
     */
    async function loadLogs() {
      try {
        // Show loading state
        logsContainer.innerHTML = `
        <div class="text-center py-5">
          <div class="spinner-border text-primary" role="status">
            <span class="visually-hidden">Loading...</span>
          </div>
          <p class="mt-2">Loading logs...</p>
        </div>
      `;

        // Build query parameters
        const params = new URLSearchParams();
        params.append("limit", limitFilter.value);

        if (levelFilter.value) {
          params.append("level", levelFilter.value);
        }

        if (searchFilter.value.trim()) {
          params.append("search", searchFilter.value.trim());
        }

        const data = await apiClient.get(`/api/server-logs?${params.toString()}`);
        currentLogs = data.logs;
        displayLogs(data);
      } catch {
        logsContainer.innerHTML = `
        <div class="text-center py-5 text-danger">
          <i class="fas fa-exclamation-triangle fa-3x mb-3"></i>
          <p>Failed to load logs. Please try again.</p>
          <button class="btn btn-primary" onclick="location.reload()">
            <i class="fas fa-sync-alt"></i> Retry
          </button>
        </div>
      `;
        notificationManager.show("Failed to load logs", "danger");
      }
    }

    /**
     * Display logs in the container
     */
    function displayLogs(data) {
      const { logs, returned_count, total_count } = data;

      // Update info text
      logsInfo.textContent = `Showing ${returned_count} of ${total_count} logs`;

      // If no logs, show empty state
      if (logs.length === 0) {
        logsContainer.innerHTML = `
        <div class="text-center py-5 text-muted">
          <i class="fas fa-inbox fa-3x mb-3"></i>
          <p>No logs found matching your filters.</p>
        </div>
      `;
        return;
      }

      // Build logs HTML
      const logsHtml = logs
        .map((log) => {
          const timestamp = new Date(log.timestamp).toLocaleString("en-US", {
            hour12: true,
          });
          const level = log.level || "INFO";
          const logger = log.logger_name || "unknown";
          const message = escapeHtml(log.message || "");
          const module = log.module || "";
          const func = log.function || "";
          const line = log.line || "";

          let detailsHtml = "";
          if (module || func || line) {
            detailsHtml = `
            <div class="log-details">
              ${module ? module : ""}${func ? `.${func}()` : ""}${line ? `:${line}` : ""}
            </div>
          `;
          }

          let exceptionHtml = "";
          if (log.exception) {
            exceptionHtml = `
            <div class="log-exception">
              ${escapeHtml(log.exception)}
            </div>
          `;
          }

          // Store log data in data attribute for copying
          const logData = JSON.stringify({
            timestamp,
            level,
            logger,
            message: log.message,
            module,
            function: func,
            line,
            exception: log.exception,
          });

          return `
          <div class="log-entry log-${level}" data-log='${escapeHtml(logData)}'>
            <div class="d-flex justify-content-between align-items-start">
              <div class="flex-grow-1">
                <div>
                  <span class="log-timestamp">${timestamp}</span>
                  <span class="log-level ${level}">${level}</span>
                  <span class="log-logger ms-2">[${logger}]</span>
                </div>
                <div class="log-message">${message}</div>
                ${detailsHtml}
                ${exceptionHtml}
              </div>
              <button class="btn btn-sm btn-outline-secondary copy-log-btn ms-2" title="Copy log entry" aria-label="Copy log entry">
                <i class="fas fa-copy"></i>
              </button>
            </div>
          </div>
        `;
        })
        .join("");

      logsContainer.innerHTML = logsHtml;

      // Add event listeners to copy buttons
      const copyButtons = logsContainer.querySelectorAll(".copy-log-btn");
      copyButtons.forEach((btn) => {
        btn.addEventListener("click", (e) => {
          e.preventDefault();
          e.stopPropagation();
          const logEntry = btn.closest(".log-entry");
          copyLogEntry(logEntry);
        });
      });
    }

    /**
     * Copy a single log entry to clipboard
     */
    async function copyLogEntry(logEntry) {
      try {
        const logDataStr = logEntry.getAttribute("data-log");
        const logData = JSON.parse(logDataStr);

        // Format log for copying
        let logText = `[${logData.timestamp}] [${logData.level}] [${logData.logger}]\n`;
        logText += `${logData.message}\n`;

        if (logData.module || logData.function || logData.line) {
          logText += `Location: ${logData.module || ""}${logData.function ? `.${logData.function}()` : ""}${logData.line ? `:${logData.line}` : ""}\n`;
        }

        if (logData.exception) {
          logText += `\nException:\n${logData.exception}\n`;
        }

        await navigator.clipboard.writeText(logText);

        // Visual feedback
        const copyBtn = logEntry.querySelector(".copy-log-btn");
        const originalHtml = copyBtn.innerHTML;
        copyBtn.innerHTML = '<i class="fas fa-check"></i>';
        copyBtn.classList.add("btn-success");
        copyBtn.classList.remove("btn-outline-secondary");

        setTimeout(() => {
          copyBtn.innerHTML = originalHtml;
          copyBtn.classList.remove("btn-success");
          copyBtn.classList.add("btn-outline-secondary");
        }, 1500);

        notificationManager.show("Log entry copied to clipboard", "success");
      } catch {
        notificationManager.show("Failed to copy log entry", "danger");
      }
    }

    /**
     * Copy all visible logs to clipboard
     */
    async function copyAllLogs() {
      if (currentLogs.length === 0) {
        notificationManager.show("No logs to copy. Please load logs first.", "warning");
        return;
      }

      try {
        let allLogsText = "Server Logs Export\n";
        allLogsText += `Generated: ${new Date().toLocaleString("en-US", {
          hour12: true,
        })}\n`;
        allLogsText += `Total Logs: ${currentLogs.length}\n`;
        allLogsText += `${"=".repeat(80)}\n\n`;

        currentLogs.forEach((log, index) => {
          const timestamp = new Date(log.timestamp).toLocaleString("en-US", {
            hour12: true,
          });
          const level = log.level || "INFO";
          const logger = log.logger_name || "unknown";
          const message = log.message || "";

          allLogsText += `[${index + 1}/${currentLogs.length}] [${timestamp}] [${level}] [${logger}]\n`;
          allLogsText += `${message}\n`;

          if (log.module || log.function || log.line) {
            allLogsText += `Location: ${log.module || ""}${log.function ? `.${log.function}()` : ""}${log.line ? `:${log.line}` : ""}\n`;
          }

          if (log.exception) {
            allLogsText += `Exception:\n${log.exception}\n`;
          }

          allLogsText += `${"-".repeat(80)}\n\n`;
        });

        await navigator.clipboard.writeText(allLogsText);

        notificationManager.show(
          `Copied ${currentLogs.length} log entries to clipboard`,
          "success"
        );
      } catch {
        notificationManager.show("Failed to copy logs", "danger");
      }
    }

    /**
     * Clear all logs
     */
    async function clearLogs() {
      try {
        const confirmed = await confirmationDialog.show({
          title: "Clear Server Logs",
          message:
            "Are you sure you want to clear all server logs? This action cannot be undone.",
          confirmText: "Clear Logs",
          confirmButtonClass: "btn-danger",
        });

        if (!confirmed) {
          return;
        }

        setButtonLoading(clearLogsBtn, true);

        const result = await apiClient.delete("/api/server-logs");

        notificationManager.show(
          `Successfully cleared ${result.deleted_count} log entries`,
          "success"
        );

        // Reload logs and stats
        await Promise.all([loadLogs(), loadStats()]);
      } catch {
        notificationManager.show("Failed to clear logs", "danger");
      } finally {
        setButtonLoading(clearLogsBtn, false);
      }
    }

    /**
     * Export logs to JSON file
     */
    function exportLogs() {
      if (currentLogs.length === 0) {
        notificationManager.show(
          "No logs to export. Please load logs first.",
          "warning"
        );
        return;
      }

      try {
        const dataStr = JSON.stringify(currentLogs, null, 2);
        const dataBlob = new Blob([dataStr], { type: "application/json" });
        const url = URL.createObjectURL(dataBlob);
        const link = document.createElement("a");
        link.href = url;
        link.download = `server-logs-${new Date().toISOString()}.json`;
        document.body.appendChild(link);
        link.click();
        document.body.removeChild(link);
        URL.revokeObjectURL(url);

        notificationManager.show("Logs exported successfully", "success");
      } catch {
        notificationManager.show("Failed to export logs", "danger");
      }
    }

    /**
     * Toggle auto-refresh
     */
    function toggleAutoRefresh() {
      autoRefreshEnabled = !autoRefreshEnabled;

      if (autoRefreshEnabled) {
        autoRefreshToggle.classList.remove("btn-outline-success");
        autoRefreshToggle.classList.add("btn-success");
        autoRefreshToggle.innerHTML
          = '<i class="fas fa-clock"></i> Auto-Refresh: ON (30s)';

        // Refresh every 30 seconds
        autoRefreshInterval = setInterval(() => {
          loadLogs();
          loadStats();
        }, 30000);

        notificationManager.show("Auto-refresh enabled (every 30 seconds)", "info");
      } else {
        autoRefreshToggle.classList.remove("btn-success");
        autoRefreshToggle.classList.add("btn-outline-success");
        autoRefreshToggle.innerHTML = '<i class="fas fa-clock"></i> Auto-Refresh: OFF';

        if (autoRefreshInterval) {
          clearInterval(autoRefreshInterval);
          autoRefreshInterval = null;
        }

        notificationManager.show("Auto-refresh disabled", "info");
      }
    }

    /**
     * Set button loading state
     */
    function setButtonLoading(button, isLoading) {
      if (!button) {
        return;
      }

      button.disabled = isLoading;

      if (isLoading) {
        const originalContent = button.innerHTML;
        button.setAttribute("data-original-content", originalContent);
        button.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Processing...';
      } else {
        const originalContent = button.getAttribute("data-original-content");
        if (originalContent) {
          button.innerHTML = originalContent;
        }
      }
    }

    // =========================================================================
    // Docker Container Logs Functionality
    // =========================================================================

    // Docker logs DOM elements
    const containerSelect = document.getElementById("container-select");
    const dockerSelectAllBtn = document.getElementById("docker-select-all");
    const dockerClearSelectionBtn = document.getElementById("docker-clear-selection");
    const dockerLimitFilter = document.getElementById("docker-limit-filter");
    const dockerSinceFilter = document.getElementById("docker-since-filter");
    const refreshDockerLogsBtn = document.getElementById("refresh-docker-logs");
    const dockerAutoRefreshToggle = document.getElementById("docker-auto-refresh-toggle");
    const copyDockerLogsBtn = document.getElementById("copy-docker-logs");
    const exportDockerLogsBtn = document.getElementById("export-docker-logs");
    const dockerLogsContainer = document.getElementById("docker-logs-container");
    const dockerLogsInfo = document.getElementById("docker-logs-info");
    const containerStatusCard = document.getElementById("container-status-card");
    const containerStatusBadge = document.getElementById("container-status-badge");
    const containerImageInfo = document.getElementById("container-image-info");
    const dockerLogsTab = document.getElementById("docker-logs-tab");

    // Docker logs state
    let dockerAutoRefreshInterval = null;
    let dockerAutoRefreshEnabled = false;
    let currentDockerLogs = [];
    let containersData = [];

    // Initialize Docker logs when tab is clicked
    if (dockerLogsTab) {
      dockerLogsTab.addEventListener(
        "click",
        () => {
          if (containersData.length === 0) {
            loadContainers();
          }
        },
        signal ? { signal } : false
      );
    }

    // Docker logs event listeners
    if (containerSelect) {
      containerSelect.addEventListener(
        "change",
        () => {
          loadDockerLogs();
        },
        signal ? { signal } : false
      );
    }

    if (dockerSelectAllBtn) {
      dockerSelectAllBtn.addEventListener(
        "click",
        (e) => {
          e.preventDefault();
          selectAllContainers();
          loadDockerLogs();
        },
        signal ? { signal } : false
      );
    }

    if (dockerClearSelectionBtn) {
      dockerClearSelectionBtn.addEventListener(
        "click",
        (e) => {
          e.preventDefault();
          clearContainerSelection();
          loadDockerLogs();
        },
        signal ? { signal } : false
      );
    }

    if (refreshDockerLogsBtn) {
      refreshDockerLogsBtn.addEventListener(
        "click",
        (e) => {
          e.preventDefault();
          loadDockerLogs();
        },
        signal ? { signal } : false
      );
    }

    if (dockerAutoRefreshToggle) {
      dockerAutoRefreshToggle.addEventListener(
        "click",
        (e) => {
          e.preventDefault();
          toggleDockerAutoRefresh();
        },
        signal ? { signal } : false
      );
    }

    if (copyDockerLogsBtn) {
      copyDockerLogsBtn.addEventListener(
        "click",
        (e) => {
          e.preventDefault();
          copyDockerLogs();
        },
        signal ? { signal } : false
      );
    }

    if (exportDockerLogsBtn) {
      exportDockerLogsBtn.addEventListener(
        "click",
        (e) => {
          e.preventDefault();
          exportDockerLogs();
        },
        signal ? { signal } : false
      );
    }

    function getSelectedContainerNames() {
      if (!containerSelect) {
        return [];
      }

      return Array.from(containerSelect.selectedOptions)
        .map((option) => option.value)
        .filter((value) => value);
    }

    function setContainerSelectionEnabled(isEnabled) {
      const shouldEnable = Boolean(isEnabled);

      if (containerSelect) {
        containerSelect.disabled = !shouldEnable;
      }

      if (dockerSelectAllBtn) {
        dockerSelectAllBtn.disabled = !shouldEnable;
      }

      if (dockerClearSelectionBtn) {
        dockerClearSelectionBtn.disabled = !shouldEnable;
      }
    }

    function selectAllContainers() {
      if (!containerSelect) {
        return;
      }

      Array.from(containerSelect.options).forEach((option) => {
        if (!option.disabled) {
          option.selected = true;
        }
      });
    }

    function clearContainerSelection() {
      if (!containerSelect) {
        return;
      }

      Array.from(containerSelect.options).forEach((option) => {
        option.selected = false;
      });
    }

    /**
     * Load available Docker containers
     */
    async function loadContainers() {
      if (!containerSelect) {
        return;
      }

      try {
        setContainerSelectionEnabled(false);
        containerSelect.innerHTML = '<option value="" disabled>Loading containers...</option>';

        const data = await apiClient.get("/api/docker-logs/containers");
        containersData = data.containers || [];

        if (containersData.length === 0) {
          containerSelect.innerHTML = '<option value="" disabled>No containers found</option>';
          return;
        }

        // Build options with running containers first
        const runningContainers = containersData.filter((c) =>
          c.status.toLowerCase().includes("up")
        );
        const stoppedContainers = containersData.filter(
          (c) => !c.status.toLowerCase().includes("up")
        );

        let optionsHtml = "";

        if (runningContainers.length > 0) {
          optionsHtml += '<optgroup label="Running">';
          runningContainers.forEach((c) => {
            optionsHtml += `<option value="${escapeHtml(c.name)}">${escapeHtml(c.name)}</option>`;
          });
          optionsHtml += "</optgroup>";
        }

        if (stoppedContainers.length > 0) {
          optionsHtml += '<optgroup label="Stopped">';
          stoppedContainers.forEach((c) => {
            optionsHtml += `<option value="${escapeHtml(c.name)}">${escapeHtml(c.name)}</option>`;
          });
          optionsHtml += "</optgroup>";
        }

        containerSelect.innerHTML = optionsHtml;
        setContainerSelectionEnabled(true);
      } catch {
        containerSelect.innerHTML = '<option value="" disabled>Error loading containers</option>';
        setContainerSelectionEnabled(false);
        notificationManager.show("Failed to load Docker containers", "warning");
      }
    }

    /**
     * Load Docker container logs
     */
    async function loadDockerLogs() {
      if (!containerSelect || !dockerLogsContainer) {
        return;
      }

      const selectedContainers = getSelectedContainerNames();
      if (selectedContainers.length === 0) {
        dockerLogsContainer.innerHTML = `
          <div class="text-center py-5 text-muted">
            <i class="fab fa-docker fa-3x mb-3"></i>
            <p>Select one or more containers from the list above to view logs.</p>
          </div>
        `;
        if (dockerLogsInfo) {
          dockerLogsInfo.textContent = "Select one or more containers to view logs";
        }
        if (containerStatusCard) {
          containerStatusCard.style.display = "none";
        }
        return;
      }

      try {
        // Show loading state
        const loadingLabel = selectedContainers.length === 1
          ? `Loading logs for ${escapeHtml(selectedContainers[0])}...`
          : `Loading logs for ${selectedContainers.length} containers...`;

        dockerLogsContainer.innerHTML = `
          <div class="text-center py-5">
            <div class="spinner-border text-primary" role="status">
              <span class="visually-hidden">Loading...</span>
            </div>
            <p class="mt-2">${loadingLabel}</p>
          </div>
        `;

        // Build query parameters
        const params = new URLSearchParams();
        params.append("tail", dockerLimitFilter?.value || "500");

        if (dockerSinceFilter?.value) {
          params.append("since", dockerSinceFilter.value);
        }

        const logRequests = selectedContainers.map((containerName) =>
          apiClient.get(
            `/api/docker-logs/${encodeURIComponent(containerName)}?${params.toString()}`
          )
        );

        const results = await Promise.allSettled(logRequests);
        const logGroups = [];
        const failedContainers = [];

        results.forEach((result, index) => {
          const containerName = selectedContainers[index];
          if (result.status === "fulfilled") {
            const data = result.value || {};
            logGroups.push({
              container: data.container || containerName,
              logs: data.logs || [],
              line_count: Number.isFinite(data.line_count)
                ? data.line_count
                : (data.logs || []).length,
              truncated: Boolean(data.truncated),
            });
          } else {
            failedContainers.push(containerName);
          }
        });

        currentDockerLogs = logGroups;

        if (selectedContainers.length === 1) {
          updateContainerStatus(selectedContainers[0]);
        } else if (containerStatusCard) {
          containerStatusCard.style.display = "none";
        }

        if (logGroups.length === 0) {
          dockerLogsContainer.innerHTML = `
            <div class="text-center py-5 text-danger">
              <i class="fas fa-exclamation-triangle fa-3x mb-3"></i>
              <p>Failed to load logs for the selected containers.</p>
            </div>
          `;
          if (dockerLogsInfo) {
            dockerLogsInfo.textContent = "No logs loaded";
          }
          return;
        }

        displayDockerLogs(logGroups, {
          selectedContainers,
          failedContainers,
        });

        if (failedContainers.length > 0) {
          notificationManager.show(
            `Failed to load logs for: ${failedContainers.join(", ")}`,
            "warning"
          );
        }
      } catch {
        dockerLogsContainer.innerHTML = `
          <div class="text-center py-5 text-danger">
            <i class="fas fa-exclamation-triangle fa-3x mb-3"></i>
            <p>Failed to load Docker logs. Please try again.</p>
          </div>
        `;
        notificationManager.show("Failed to load Docker logs", "danger");
      }
    }

    /**
     * Update container status display
     */
    function updateContainerStatus(containerName) {
      if (!containerStatusCard || !containerStatusBadge || !containerImageInfo) {
        return;
      }

      const container = containersData.find((c) => c.name === containerName);
      if (!container) {
        containerStatusCard.style.display = "none";
        return;
      }

      containerStatusCard.style.display = "block";

      const isRunning = container.status.toLowerCase().includes("up");
      containerStatusBadge.className = `badge rounded-pill me-2 ${isRunning ? "bg-success" : "bg-secondary"}`;
      containerStatusBadge.textContent = container.status;
      containerImageInfo.textContent = `Image: ${container.image}`;
    }

    /**
     * Display Docker logs in the container
     */
    function renderDockerLogLine(line) {
      // Try to parse timestamp and message
      let timestamp = "";
      let message = line;

      // Docker timestamps look like: 2024-01-22T16:00:00.000000000Z
      const timestampMatch = line.match(/^(\d{4}-\d{2}-\d{2}T[\d:.]+Z?)\s+(.*)$/);
      if (timestampMatch) {
        try {
          const date = new Date(timestampMatch[1]);
          timestamp = date.toLocaleString("en-US", { hour12: true });
          message = timestampMatch[2];
        } catch {
          // Keep original line
        }
      }

      // Determine log level for styling
      let levelClass = "";
      const lowerMessage = message.toLowerCase();
      if (lowerMessage.includes("error") || lowerMessage.includes("exception")) {
        levelClass = "log-ERROR";
      } else if (lowerMessage.includes("warn")) {
        levelClass = "log-WARNING";
      } else if (lowerMessage.includes("debug")) {
        levelClass = "log-DEBUG";
      }

      return `
        <div class="log-entry ${levelClass}">
          ${timestamp ? `<span class="log-timestamp">${escapeHtml(timestamp)}</span>` : ""}
          <span class="log-message">${escapeHtml(message)}</span>
        </div>
      `;
    }

    function displayDockerLogs(logGroups, { selectedContainers = [] } = {}) {
      if (!dockerLogsContainer || !dockerLogsInfo) {
        return;
      }

      if (!Array.isArray(logGroups) || logGroups.length === 0) {
        dockerLogsInfo.textContent = "No logs loaded";
        dockerLogsContainer.innerHTML = `
          <div class="text-center py-5 text-muted">
            <i class="fas fa-inbox fa-3x mb-3"></i>
            <p>No logs found for the selected containers.</p>
          </div>
        `;
        return;
      }

      const isMulti = selectedContainers.length > 1 || logGroups.length > 1;

      if (!isMulti) {
        const group = logGroups[0];
        const lineCount = Number.isFinite(group.line_count)
          ? group.line_count
          : group.logs.length;
        dockerLogsInfo.textContent = `Showing ${lineCount} lines${group.truncated ? " (truncated)" : ""}`;

        if (group.logs.length === 0) {
          dockerLogsContainer.innerHTML = `
            <div class="text-center py-5 text-muted">
              <i class="fas fa-inbox fa-3x mb-3"></i>
              <p>No logs found for this container with the current filters.</p>
            </div>
          `;
          return;
        }

        dockerLogsContainer.innerHTML = group.logs.map(renderDockerLogLine).join("");
        return;
      }

      const totalLines = logGroups.reduce(
        (sum, group) => sum + (group.logs?.length || 0),
        0
      );
      const truncatedCount = logGroups.filter((group) => group.truncated).length;
      const selectedCount = selectedContainers.length || logGroups.length;
      const loadedCount = logGroups.length;

      let infoText = `Showing ${totalLines} lines across ${loadedCount} container${loadedCount !== 1 ? "s" : ""}`;
      if (selectedCount > 0 && loadedCount !== selectedCount) {
        infoText += ` (loaded ${loadedCount} of ${selectedCount})`;
      }
      if (truncatedCount > 0) {
        infoText += `, ${truncatedCount} truncated`;
      }
      dockerLogsInfo.textContent = infoText;

      const logsHtml = logGroups
        .map((group) => {
          const lineCount = Number.isFinite(group.line_count)
            ? group.line_count
            : group.logs.length;
          const containerInfo = containersData.find((c) => c.name === group.container);
          let statusBadgeHtml = "";
          if (containerInfo?.status) {
            const isRunning = containerInfo.status.toLowerCase().includes("up");
            statusBadgeHtml = `
              <span class="badge ${isRunning ? "bg-success" : "bg-secondary"}">
                ${escapeHtml(containerInfo.status)}
              </span>
            `;
          }

          const groupLogsHtml = group.logs.length > 0
            ? group.logs.map(renderDockerLogLine).join("")
            : `
              <div class="px-3 pb-3 text-muted">
                No logs found for this container with the current filters.
              </div>
            `;

          return `
            <div class="docker-log-group">
              <div class="docker-log-group-header">
                <div class="d-flex align-items-center gap-2">
                  <span class="docker-log-group-title">${escapeHtml(group.container)}</span>
                  ${statusBadgeHtml}
                </div>
                <small class="text-muted">
                  ${lineCount} lines${group.truncated ? " (truncated)" : ""}
                </small>
              </div>
              <div class="docker-log-group-body">
                ${groupLogsHtml}
              </div>
            </div>
          `;
        })
        .join("");

      dockerLogsContainer.innerHTML = logsHtml;
    }

    /**
     * Toggle Docker auto-refresh
     */
    function toggleDockerAutoRefresh() {
      if (!dockerAutoRefreshToggle) {
        return;
      }

      dockerAutoRefreshEnabled = !dockerAutoRefreshEnabled;

      if (dockerAutoRefreshEnabled) {
        dockerAutoRefreshToggle.classList.remove("btn-outline-success");
        dockerAutoRefreshToggle.classList.add("btn-success");
        dockerAutoRefreshToggle.innerHTML
          = '<i class="fas fa-clock"></i> Auto-Refresh: ON (10s)';

        // Refresh every 10 seconds for Docker logs
        dockerAutoRefreshInterval = setInterval(() => {
          loadDockerLogs();
        }, 10000);

        notificationManager.show("Auto-refresh enabled (every 10 seconds)", "info");
      } else {
        dockerAutoRefreshToggle.classList.remove("btn-success");
        dockerAutoRefreshToggle.classList.add("btn-outline-success");
        dockerAutoRefreshToggle.innerHTML = '<i class="fas fa-clock"></i> Auto-Refresh: OFF';

        if (dockerAutoRefreshInterval) {
          clearInterval(dockerAutoRefreshInterval);
          dockerAutoRefreshInterval = null;
        }

        notificationManager.show("Auto-refresh disabled", "info");
      }
    }

    /**
     * Copy all Docker logs to clipboard
     */
    async function copyDockerLogs() {
      const totalLines = currentDockerLogs.reduce(
        (sum, group) => sum + (group.logs?.length || 0),
        0
      );

      if (currentDockerLogs.length === 0 || totalLines === 0) {
        notificationManager.show("No logs to copy. Please load logs first.", "warning");
        return;
      }

      try {
        const containerNames = currentDockerLogs
          .map((group) => group.container)
          .filter(Boolean);
        const containerLabel = containerNames.length > 1
          ? `Containers: ${containerNames.join(", ")}`
          : `Container: ${containerNames[0] || "unknown"}`;

        let allLogsText = "Docker Container Logs\n";
        allLogsText += `${containerLabel}\n`;
        allLogsText += `Generated: ${new Date().toLocaleString("en-US", {
          hour12: true,
        })}\n`;
        allLogsText += `Total Lines: ${totalLines}\n`;
        allLogsText += `${"=".repeat(80)}\n\n`;

        currentDockerLogs.forEach((group) => {
          const lineCount = group.logs?.length || 0;
          allLogsText += `Container: ${group.container}\n`;
          allLogsText += `Lines: ${lineCount}${group.truncated ? " (truncated)" : ""}\n`;
          allLogsText += `${"-".repeat(80)}\n`;

          group.logs.forEach((line) => {
            allLogsText += `${line}\n`;
          });

          allLogsText += "\n";
        });

        await navigator.clipboard.writeText(allLogsText);

        notificationManager.show(
          `Copied ${totalLines} log lines to clipboard`,
          "success"
        );
      } catch {
        notificationManager.show("Failed to copy logs", "danger");
      }
    }

    /**
     * Export Docker logs to file
     */
    function exportDockerLogs() {
      const totalLines = currentDockerLogs.reduce(
        (sum, group) => sum + (group.logs?.length || 0),
        0
      );

      if (currentDockerLogs.length === 0 || totalLines === 0) {
        notificationManager.show(
          "No logs to export. Please load logs first.",
          "warning"
        );
        return;
      }

      try {
        const containerNames = currentDockerLogs
          .map((group) => group.container)
          .filter(Boolean);
        const fileSuffix = containerNames.length === 1
          ? `docker-${containerNames[0]}-logs`
          : "docker-containers-logs";
        const containerLabel = containerNames.length > 1
          ? `Containers: ${containerNames.join(", ")}`
          : `Container: ${containerNames[0] || "unknown"}`;

        let dataStr = "Docker Container Logs\n";
        dataStr += `${containerLabel}\n`;
        dataStr += `Generated: ${new Date().toLocaleString("en-US", {
          hour12: true,
        })}\n`;
        dataStr += `Total Lines: ${totalLines}\n`;
        dataStr += `${"=".repeat(80)}\n\n`;

        currentDockerLogs.forEach((group) => {
          const lineCount = group.logs?.length || 0;
          dataStr += `Container: ${group.container}\n`;
          dataStr += `Lines: ${lineCount}${group.truncated ? " (truncated)" : ""}\n`;
          dataStr += `${"-".repeat(80)}\n`;
          dataStr += `${group.logs.join("\n")}\n\n`;
        });
        const dataBlob = new Blob([dataStr], { type: "text/plain" });
        const url = URL.createObjectURL(dataBlob);
        const link = document.createElement("a");
        link.href = url;
        link.download = `${fileSuffix}-${new Date().toISOString()}.log`;
        document.body.appendChild(link);
        link.click();
        document.body.removeChild(link);
        URL.revokeObjectURL(url);

        notificationManager.show("Docker logs exported successfully", "success");
      } catch {
        notificationManager.show("Failed to export logs", "danger");
      }
    }

    if (typeof cleanup === "function") {
      cleanup(() => {
        if (autoRefreshInterval) {
          clearInterval(autoRefreshInterval);
          autoRefreshInterval = null;
        }
        autoRefreshEnabled = false;
        if (dockerAutoRefreshInterval) {
          clearInterval(dockerAutoRefreshInterval);
          dockerAutoRefreshInterval = null;
        }
        dockerAutoRefreshEnabled = false;
      });
    }
  },
  { route: "/server-logs" }
);
