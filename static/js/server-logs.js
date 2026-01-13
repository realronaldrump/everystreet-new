window.utils?.onPageLoad(
  () => {
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

    // State
    let autoRefreshInterval = null;
    let autoRefreshEnabled = false;
    let currentLogs = [];

    // Initialize
    loadStats();
    loadLogs();

    // Event listeners
    refreshLogsBtn.addEventListener("click", (e) => {
      e.preventDefault();
      loadLogs();
    });
    refreshStatsBtn.addEventListener("click", (e) => {
      e.preventDefault();
      loadStats();
    });
    clearLogsBtn.addEventListener("click", (e) => {
      e.preventDefault();
      clearLogs();
    });
    exportLogsBtn.addEventListener("click", (e) => {
      e.preventDefault();
      exportLogs();
    });
    applyFiltersBtn.addEventListener("click", (e) => {
      e.preventDefault();
      loadLogs();
    });
    autoRefreshToggle.addEventListener("click", (e) => {
      e.preventDefault();
      toggleAutoRefresh();
    });
    if (copyAllLogsBtn) {
      copyAllLogsBtn.addEventListener("click", (e) => {
        e.preventDefault();
        copyAllLogs();
      });
    }

    // Allow Enter key in search filter
    searchFilter.addEventListener("keypress", (e) => {
      if (e.key === "Enter") {
        loadLogs();
      }
    });

    /**
     * Load log statistics
     */
    async function loadStats() {
      try {
        const response = await fetch("/api/server-logs/stats");
        if (!response.ok) {
          throw new Error(`HTTP error! status: ${response.status}`);
        }

        const data = await response.json();
        updateStatsDisplay(data);
      } catch {
        window.notificationManager?.show("Failed to load log statistics", "warning");
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

        const response = await fetch(`/api/server-logs?${params.toString()}`);
        if (!response.ok) {
          throw new Error(`HTTP error! status: ${response.status}`);
        }

        const data = await response.json();
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
        window.notificationManager?.show("Failed to load logs", "danger");
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
          const logger = log.logger || "unknown";
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

        window.notificationManager?.show("Log entry copied to clipboard", "success");
      } catch {
        window.notificationManager?.show("Failed to copy log entry", "danger");
      }
    }

    /**
     * Copy all visible logs to clipboard
     */
    async function copyAllLogs() {
      if (currentLogs.length === 0) {
        window.notificationManager?.show(
          "No logs to copy. Please load logs first.",
          "warning"
        );
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
          const logger = log.logger || "unknown";
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

        window.notificationManager?.show(
          `Copied ${currentLogs.length} log entries to clipboard`,
          "success"
        );
      } catch {
        window.notificationManager?.show("Failed to copy logs", "danger");
      }
    }

    /**
     * Clear all logs
     */
    async function clearLogs() {
      try {
        const confirmed = await window.confirmationDialog.show({
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

        const response = await fetch("/api/server-logs", {
          method: "DELETE",
        });

        if (!response.ok) {
          throw new Error(`HTTP error! status: ${response.status}`);
        }

        const result = await response.json();

        window.notificationManager?.show(
          `Successfully cleared ${result.deleted_count} log entries`,
          "success"
        );

        // Reload logs and stats
        await Promise.all([loadLogs(), loadStats()]);
      } catch {
        window.notificationManager?.show("Failed to clear logs", "danger");
      } finally {
        setButtonLoading(clearLogsBtn, false);
      }
    }

    /**
     * Export logs to JSON file
     */
    function exportLogs() {
      if (currentLogs.length === 0) {
        window.notificationManager?.show(
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

        window.notificationManager?.show("Logs exported successfully", "success");
      } catch {
        window.notificationManager?.show("Failed to export logs", "danger");
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

        window.notificationManager?.show(
          "Auto-refresh enabled (every 30 seconds)",
          "info"
        );
      } else {
        autoRefreshToggle.classList.remove("btn-success");
        autoRefreshToggle.classList.add("btn-outline-success");
        autoRefreshToggle.innerHTML = '<i class="fas fa-clock"></i> Auto-Refresh: OFF';

        if (autoRefreshInterval) {
          clearInterval(autoRefreshInterval);
          autoRefreshInterval = null;
        }

        window.notificationManager?.show("Auto-refresh disabled", "info");
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

    /**
     * Escape HTML to prevent XSS
     */
    function escapeHtml(text) {
      const div = document.createElement("div");
      div.textContent = text;
      return div.innerHTML;
    }

    // Clean up on page unload
    window.addEventListener("beforeunload", () => {
      if (autoRefreshInterval) {
        clearInterval(autoRefreshInterval);
      }
    });

    document.addEventListener(
      "es:page-unload",
      () => {
        if (autoRefreshInterval) {
          clearInterval(autoRefreshInterval);
          autoRefreshInterval = null;
        }
        autoRefreshEnabled = false;
      },
      { once: true }
    );
  },
  { route: "/server-logs" }
);
