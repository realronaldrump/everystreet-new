/**
 * Global Job Tracker
 *
 * Manages background job persistence, polling, and UI across the entire application.
 * Handles "minimize" (background mode) and "cancel" operations.
 */

const JOB_TRACKER_STORAGE_KEY = "coverage.activeJob";
const JOB_POLL_INTERVAL_MS = 1500;
const API_BASE = "/api/coverage";

// State
let activeJob = null;
let pollTimeout = null;

// =============================================================================
// Initialization
// =============================================================================

function initGlobalJobTracker() {
  console.log("Global Job Tracker initialized");
  setupGlobalUI();
  
  // Check for stored job or active jobs on server
  resumeJobTracking();
}

function setupGlobalUI() {
  const minimizeBtn = document.getElementById("minimize-progress-modal");
  const cancelBtn = document.getElementById("cancel-progress-modal");
  const badgeEl = document.getElementById("minimized-progress-badge");

  minimizeBtn?.addEventListener("click", minimizeJob);
  cancelBtn?.addEventListener("click", cancelActiveJob);

  badgeEl?.addEventListener("click", restoreJobModal);
  
  // Listen for custom events to start tracking from other pages
  document.addEventListener("coverage:job-started", (e) => {
    if (e.detail?.jobId) {
      startGlobalTracking(e.detail);
    }
  });
}

// =============================================================================
// Job Management
// =============================================================================

function saveJobState() {
  if (activeJob) {
    localStorage.setItem(JOB_TRACKER_STORAGE_KEY, JSON.stringify(activeJob));
  } else {
    localStorage.removeItem(JOB_TRACKER_STORAGE_KEY);
  }
}

function loadJobState() {
  const stored = localStorage.getItem(JOB_TRACKER_STORAGE_KEY);
  return stored ? JSON.parse(stored) : null;
}

async function resumeJobTracking() {
  const stored = loadJobState();
  if (stored && stored.jobId) {
    try {
      // Validate with server
      const job = await fetchJobStatus(stored.jobId);
      if (isJobActive(job.status)) {
        activeJob = { ...stored, ...mapJobToState(job) };
        saveJobState();
        
        // Decide whether to show modal or badge based on previous state
        if (activeJob.minimized) {
          showMinimizedBadge();
        } else {
          showProgressModal();
        }
        
        startPolling(activeJob.jobId);
      } else {
        handleJobFinished(job);
      }
    } catch (e) {
      console.warn("Failed to resume active job", e);
      clearJobState();
    }
  } else {
    // Optional: Check server for any active jobs if nothing stored locally?
    // For now, relying on local storage to know "we" own the job.
  }
}

function startGlobalTracking(config) {
  // config: { jobId, jobType, areaId, areaName, initialMessage }
  activeJob = {
    jobId: config.jobId,
    jobType: config.jobType || "unknown",
    areaId: config.areaId,
    areaName: config.areaName,
    message: config.initialMessage || "Starting...",
    progress: 0,
    status: "pending",
    minimized: false // Default to open
  };

  saveJobState();
  updateModalUI();
  showProgressModal();
  startPolling(activeJob.jobId);
}

function stopTracking() {
  clearTimeout(pollTimeout);
  activeJob = null;
  saveJobState();
  hideProgressModal();
  hideMinimizedBadge();
}

function clearJobState() {
  activeJob = null;
  localStorage.removeItem(JOB_TRACKER_STORAGE_KEY);
}

// =============================================================================
// Polling
// =============================================================================

function startPolling(jobId) {
  clearTimeout(pollTimeout);
  
  const poll = async () => {
    if (!activeJob || activeJob.jobId !== jobId) return;

    try {
      const job = await fetchJobStatus(jobId);
      activeJob = { ...activeJob, ...mapJobToState(job) };
      saveJobState();

      if (isJobActive(job.status)) {
        updateUI();
        pollTimeout = setTimeout(poll, JOB_POLL_INTERVAL_MS);
      } else {
        handleJobFinished(job);
      }
    } catch (e) {
      console.warn("Polling error:", e);
      // Back off a bit but keep trying unless it's a 404
      pollTimeout = setTimeout(poll, JOB_POLL_INTERVAL_MS * 2);
    }
  };

  poll();
}

async function fetchJobStatus(jobId) {
  const res = await fetch(`${API_BASE}/jobs/${jobId}`);
  if (!res.ok) throw new Error("Job not found");
  return res.json();
}

// =============================================================================
// Actions
// =============================================================================

async function cancelActiveJob() {
  if (!activeJob) return;
  
  const jobId = activeJob.jobId;
  const oldText = document.getElementById("task-progress-message")?.textContent;
  if(document.getElementById("task-progress-message")) {
      document.getElementById("task-progress-message").textContent = "Cancelling...";
  }

  try {
    await fetch(`${API_BASE}/jobs/${jobId}`, { method: "DELETE" });
    // UI update handled by polling or immediate cleanup
    stopTracking();
    showNotification("Job cancelled", "info");
    
    // Dispatch event so page can refresh if needed
    document.dispatchEvent(new CustomEvent("coverage:job-cancelled", { detail: { jobId } }));
  } catch (e) {
    console.error("Failed to cancel job:", e);
    showNotification("Failed to cancel job", "danger");
    if(document.getElementById("task-progress-message")) {
         document.getElementById("task-progress-message").textContent = oldText || "Error cancelling";
    }
  }
}

function minimizeJob() {
  if (!activeJob) return;
  activeJob.minimized = true;
  saveJobState();
  
  hideProgressModal();
  showMinimizedBadge();
}

function restoreJobModal() {
  if (!activeJob) return;
  activeJob.minimized = false;
  saveJobState();
  
  hideMinimizedBadge();
  showProgressModal();
  updateModalUI();
}

function handleJobFinished(job) {
  stopTracking();
  
  const success = job.status === "completed";
  const title = getJobTitle(job.job_type);
  const msg = success ? "completed successfully" : `failed: ${job.error || job.message}`;
  
  showNotification(`${title} ${msg}`, success ? "success" : "danger");
  
  // Dispatch event so current page can refresh data
  document.dispatchEvent(new CustomEvent("coverage:job-finished", { 
    detail: { job, success } 
  }));
}

// =============================================================================
// UI Helpers
// =============================================================================

function updateUI() {
  if (activeJob.minimized) {
    updateBadgeUI();
  } else {
    updateModalUI();
  }
}

function updateModalUI() {
  const modal = document.getElementById("taskProgressModal");
  if (!modal || !modal.classList.contains("show")) return;

  const titleEl = document.getElementById("task-progress-title");
  const barEl = modal.querySelector(".progress-bar");
  const msgEl = document.getElementById("task-progress-message");
  const stageEl = document.getElementById("task-progress-stage");

  if (titleEl) {
      const baseTitle = getJobTitle(activeJob.jobType);
      titleEl.textContent = activeJob.areaName ? `${baseTitle}: ${activeJob.areaName}` : baseTitle;
  }
  
  if (barEl) {
    const pct = Math.round(activeJob.progress || 0);
    barEl.style.width = `${pct}%`;
    barEl.textContent = `${pct}%`;
  }
  
  if (msgEl) msgEl.textContent = activeJob.message || "Working...";
  if (stageEl) stageEl.textContent = activeJob.stage || "";
}

function updateBadgeUI() {
  const badge = document.getElementById("minimized-progress-badge");
  if (!badge) return;
  
  const nameEl = badge.querySelector(".minimized-location-name");
  const pctEl = badge.querySelector(".minimized-progress-percent");
  
  if (nameEl) nameEl.textContent = activeJob.areaName || "Background Job";
  if (pctEl) pctEl.textContent = `${Math.round(activeJob.progress || 0)}%`;
}

function showProgressModal() {
  const el = document.getElementById("taskProgressModal");
  if (!el) return;
  const modal = bootstrap.Modal.getOrCreateInstance(el);
  modal.show();
}

function hideProgressModal() {
  const el = document.getElementById("taskProgressModal");
  if (!el) return;
  const modal = bootstrap.Modal.getInstance(el);
  modal?.hide();
}

function showMinimizedBadge() {
  const badge = document.getElementById("minimized-progress-badge");
  badge?.classList.remove("d-none");
  updateBadgeUI();
}

function hideMinimizedBadge() {
  const badge = document.getElementById("minimized-progress-badge");
  badge?.classList.add("d-none");
}

function getJobTitle(type) {
  if (type === "area_rebuild") return "Rebuilding Area";
  return "Setting Up Area";
}

function isJobActive(status) {
  return ["pending", "running"].includes(status);
}

function mapJobToState(job) {
  return {
    status: job.status,
    progress: job.progress,
    message: job.message,
    stage: job.stage,
    error: job.error
  };
}

// Export for usage
window.GlobalJobTracker = {
  start: startGlobalTracking
};

// Auto-init
if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", initGlobalJobTracker);
} else {
  initGlobalJobTracker();
}
