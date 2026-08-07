import apiClient from "../../core/api-client.js";
import { withSignal as withAbortSignal } from "../../core/feature-api.js";
import confirmationDialog from "../../ui/confirmation-dialog.js";
import notificationManager from "../../ui/notifications.js";
import {
  escapeHtml,
  formatDateTime,
  formatRelativeTimeLong,
  isAbortError,
} from "../../utils.js";

const OVERVIEW_API = "/api/status/overview";
const HEALTH_API = "/api/status/health";
const CHATGPT_API = "/api/chatgpt/status";
const POLL_INTERVAL_MS = 30000;

const STATUS_VARIANTS = {
  healthy: {
    badgeClass: "bg-success",
    label: "Healthy",
  },
  warning: {
    badgeClass: "bg-warning",
    label: "Warning",
  },
  error: {
    badgeClass: "bg-danger",
    label: "Error",
  },
};

const SERVICE_ORDER = [
  "mongodb",
  "redis",
  "worker",
  "bouncie",
  "nominatim",
  "valhalla",
];
const RESTARTABLE_SERVICES = new Set(["nominatim", "valhalla"]);
const SERVICE_NAMES = {
  mongodb: "MongoDB",
  redis: "Redis",
  worker: "Worker",
  bouncie: "Bouncie",
  nominatim: "Nominatim",
  valhalla: "Valhalla",
};

function formatStatusVariant(statusValue) {
  return (
    STATUS_VARIANTS[statusValue] || {
      badgeClass: "bg-secondary",
      label: String(statusValue || "Unknown"),
    }
  );
}

function formatServiceDateTime(value) {
  const absolute = formatDateTime(value, {
    formatOptions: {
      year: "numeric",
      month: "short",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
      second: "2-digit",
      timeZoneName: "short",
    },
  });
  const relative = formatRelativeTimeLong(value, {
    default: absolute,
    maxDays: Number.MAX_SAFE_INTEGER,
  });
  const rawValue = String(value);

  return `<time datetime="${escapeHtml(rawValue)}" title="${escapeHtml(
    `${absolute} (${rawValue})`
  )}">${escapeHtml(relative)}</time>`;
}

function renderServiceDetail(detail) {
  const label = String(detail?.label || "Detail");
  const value = detail?.value;
  const format = String(detail?.format || "text");
  let valueMarkup;

  if (format === "relative_datetime") {
    valueMarkup = formatServiceDateTime(value);
  } else if (format === "integer") {
    const numericValue = Number(value);
    valueMarkup = escapeHtml(
      Number.isFinite(numericValue)
        ? new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 }).format(
            numericValue
          )
        : value
    );
  } else {
    valueMarkup = escapeHtml(value);
  }

  const valueClass =
    format === "url"
      ? "control-center-service-detail-value is-url"
      : "control-center-service-detail-value";
  const copyButton = detail?.copyable
    ? `
      <button type="button"
              class="control-center-service-copy-btn"
              data-copy-value="${escapeHtml(value)}"
              title="Copy ${escapeHtml(label.toLowerCase())}"
              aria-label="Copy ${escapeHtml(label.toLowerCase())}">
        <i class="fas fa-copy" aria-hidden="true"></i>
      </button>
    `
    : "";

  return `
    <div class="control-center-service-detail-row" data-format="${escapeHtml(format)}">
      <dt>${escapeHtml(label)}</dt>
      <dd>
        <span class="control-center-service-detail-line">
          <span class="${valueClass}"${format === "url" ? ` title="${escapeHtml(value)}"` : ""}>${valueMarkup}</span>
          ${copyButton}
        </span>
      </dd>
    </div>
  `;
}

export function renderServiceDetails(details) {
  const entries = Array.isArray(details)
    ? details.filter((detail) => detail?.value !== null && detail?.value !== undefined)
    : [];
  if (!entries.length) {
    return "";
  }

  return `<dl class="control-center-service-details">${entries
    .map(renderServiceDetail)
    .join("")}</dl>`;
}

export function buildServiceRowMarkup(key, entry = {}, index = 0) {
  const status = String(entry.status || "warning").toLowerCase();
  const variant = formatStatusVariant(status);
  const serviceName = SERVICE_NAMES[key] || String(key || "Unknown service");
  const canRestart = RESTARTABLE_SERVICES.has(key);
  const restartButton = canRestart
    ? `
      <button type="button"
              class="btn btn-outline-danger btn-sm cc-overview-restart-btn"
              data-service="${escapeHtml(key)}">
        <i class="fas fa-power-off" aria-hidden="true"></i>
        <span>Restart</span>
      </button>
    `
    : "";

  return `
    <article class="control-center-service-row"
             data-service-card="${escapeHtml(key)}"
             data-status="${escapeHtml(status)}">
      <div class="control-center-service-identity">
        <span class="control-center-service-ordinal" aria-hidden="true">${String(
          index + 1
        ).padStart(2, "0")}</span>
        <h4>${escapeHtml(serviceName)}</h4>
      </div>
      <div class="control-center-service-state" data-status="${escapeHtml(status)}">
        <span class="control-center-service-state-dot" aria-hidden="true"></span>
        <span>${escapeHtml(entry.label || variant.label)}</span>
      </div>
      <p class="control-center-service-message">${escapeHtml(
        entry.message || "No status message."
      )}</p>
      <div class="control-center-service-signals">
        ${renderServiceDetails(entry.details) || '<span class="control-center-service-empty" aria-hidden="true">—</span>'}
      </div>
      <div class="control-center-service-actions">
        ${restartButton || '<span class="control-center-service-empty" aria-hidden="true">—</span>'}
      </div>
    </article>
  `;
}

function renderOverviewHeader({ overviewData, healthData }) {
  const badge = document.getElementById("cc-overview-status-badge");
  const message = document.getElementById("cc-overview-status-message");
  const summary = document.getElementById("cc-overview-summary");
  const lastUpdated = document.getElementById("cc-overview-last-updated");

  const overall = overviewData?.overall || healthData?.overall || {};
  const status = String(overall.status || "warning").toLowerCase();
  const variant = formatStatusVariant(status);

  if (badge) {
    badge.className = `badge status-chip cc-overview-status-badge ${variant.badgeClass}`;
    badge.textContent = overall.label || variant.label;
  }

  if (message) {
    message.textContent =
      overall.message || healthData?.overall?.message || "System status unavailable.";
  }

  if (summary) {
    const taskSummary = overviewData?.tasks?.summary || {};
    const docker = overviewData?.docker || {};
    const integrationSummary = overviewData?.integrations?.summary || "";
    summary.textContent = [
      `Tasks: ${taskSummary.running || 0} running, ${taskSummary.failed || 0} failed`,
      `Docker: ${docker.available ? "online" : "offline"}`,
      integrationSummary,
    ]
      .filter(Boolean)
      .join(" | ");
  }

  if (lastUpdated) {
    lastUpdated.textContent = `Last updated: ${formatDateTime(
      overviewData?.last_updated || healthData?.overall?.last_updated
    )}`;
  }
}

function renderServiceCards(healthData) {
  const servicesContainer = document.getElementById("cc-overview-services");
  if (!servicesContainer) {
    return;
  }

  const services = healthData?.services || {};
  const availableKeys = SERVICE_ORDER.filter((key) => services[key]);
  const keysToRender = availableKeys.length > 0 ? availableKeys : Object.keys(services);

  if (!keysToRender.length) {
    servicesContainer.innerHTML =
      '<div class="text-muted small">No services available.</div>';
    return;
  }

  servicesContainer.innerHTML = `
    <div class="control-center-service-ledger-head" aria-hidden="true">
      <span>Service</span>
      <span>State</span>
      <span>Summary</span>
      <span>Signals</span>
      <span>Actions</span>
    </div>
    <div class="control-center-service-ledger-body">
      ${keysToRender
        .map((key, index) => buildServiceRowMarkup(key, services[key], index))
        .join("")}
    </div>
  `;
}

function renderFailures(healthData) {
  const failuresContainer = document.getElementById("cc-overview-failures");
  if (!failuresContainer) {
    return;
  }

  const entries = Array.isArray(healthData?.recent_errors)
    ? healthData.recent_errors
    : [];
  if (entries.length === 0) {
    failuresContainer.innerHTML =
      '<div class="text-muted small">No recent task failures. System looks stable.</div>';
    return;
  }

  failuresContainer.innerHTML = entries
    .map((entry) => {
      const taskId = entry.task_id || "unknown-task";
      const error = entry.error || "No error details";
      const stamp = formatDateTime(entry.timestamp);
      return `
        <div class="control-center-failure-item">
          <div class="control-center-failure-meta">
            <strong>${escapeHtml(taskId)}</strong>
            <span>${escapeHtml(stamp)}</span>
          </div>
          <p>${escapeHtml(error)}</p>
        </div>
      `;
    })
    .join("");
}

export function renderChatGptStatus(data) {
  const container = document.getElementById("cc-chatgpt-status");
  if (!container) {
    return;
  }
  const latest = data?.latest_call;
  container.innerHTML = `
    <div class="control-center-chatgpt-state">
      <span class="badge bg-success">${escapeHtml(data?.status || "Ready")}</span>
      <strong>Anonymous MCP</strong>
      <span>${escapeHtml(data?.tools?.model_visible || 0)} conversational tools</span>
      <span>${escapeHtml(data?.activity_24h?.calls || 0)} calls in 24 hours</span>
    </div>
    <p>ChatGPT can analyze trips, places, routes, live driving, vehicle economics, and street coverage. Goal and mission changes still require an explicit click.</p>
    <dl class="control-center-chatgpt-details">
      <div><dt>Endpoint</dt><dd><code>${escapeHtml(data?.endpoint || "--")}</code></dd></div>
      <div><dt>Authentication</dt><dd>${escapeHtml(data?.authentication || "none")}</dd></div>
      <div><dt>OpenAI mTLS</dt><dd>${data?.mtls_required ? "Required" : "Optional / disabled"}</dd></div>
      <div><dt>Latest call</dt><dd>${latest ? `${escapeHtml(latest.tool)} · ${escapeHtml(formatDateTime(latest.at))}` : "None yet"}</dd></div>
    </dl>
  `;
}

export default function initControlCenterOverview({ signal } = {}) {
  const tab = document.getElementById("overview-tab");
  if (!tab) {
    return () => {};
  }

  let refreshTimer = null;

  const refreshOverview = async (isManual = false) => {
    try {
      const [overviewData, healthData, chatGptData] = await Promise.all([
        apiClient.get(OVERVIEW_API, withAbortSignal(signal)),
        apiClient.get(HEALTH_API, withAbortSignal(signal)),
        apiClient
          .get(CHATGPT_API, withAbortSignal(signal))
          .catch((error) => (isAbortError(error) ? Promise.reject(error) : null)),
      ]);

      renderOverviewHeader({ overviewData, healthData });
      renderServiceCards(healthData);
      renderFailures(healthData);
      if (chatGptData) {
        renderChatGptStatus(chatGptData);
      }
    } catch (error) {
      if (isAbortError(error)) {
        return;
      }
      if (isManual) {
        notificationManager.show(
          `Failed to refresh overview: ${error.message}`,
          "warning"
        );
      }
    }
  };

  const servicesContainer = document.getElementById("cc-overview-services");
  const serviceActionOptions = signal ? { signal } : false;

  servicesContainer?.addEventListener(
    "click",
    async (event) => {
      const copyButton = event.target.closest(".control-center-service-copy-btn");
      if (copyButton) {
        const value = copyButton.getAttribute("data-copy-value");
        if (!value) {
          return;
        }
        try {
          await navigator.clipboard.writeText(value);
          notificationManager.show("Webhook URL copied", "success");
        } catch (error) {
          notificationManager.show(
            `Could not copy webhook URL: ${error.message}`,
            "warning"
          );
        }
        return;
      }

      const button = event.target.closest(".cc-overview-restart-btn");
      if (!button) {
        return;
      }

      const service = button.getAttribute("data-service");
      if (!service) {
        return;
      }

      const serviceName = SERVICE_NAMES[service] || service;
      const confirmed = await confirmationDialog.show({
        title: `Restart ${serviceName}?`,
        message: `${serviceName} will be briefly unavailable while its container restarts.`,
        confirmText: "Restart service",
        confirmButtonClass: "btn-danger",
      });
      if (!confirmed) {
        return;
      }

      const originalMarkup = button.innerHTML;

      try {
        button.disabled = true;
        button.setAttribute("aria-busy", "true");
        button.innerHTML =
          '<i class="fas fa-spinner fa-spin" aria-hidden="true"></i><span>Restarting…</span>';
        await apiClient.post(
          `/api/services/${encodeURIComponent(service)}/restart`,
          {},
          withAbortSignal(signal)
        );
        notificationManager.show(`${serviceName} restart requested`, "success");
        await refreshOverview(true);
      } catch (error) {
        if (!isAbortError(error)) {
          notificationManager.show(
            `Failed to restart ${serviceName}: ${error.message}`,
            "danger"
          );
        }
      } finally {
        if (button.isConnected) {
          button.disabled = false;
          button.removeAttribute("aria-busy");
          button.innerHTML = originalMarkup;
        }
      }
    },
    serviceActionOptions
  );

  refreshOverview();
  refreshTimer = setInterval(() => {
    refreshOverview();
  }, POLL_INTERVAL_MS);

  return () => {
    if (refreshTimer) {
      clearInterval(refreshTimer);
      refreshTimer = null;
    }
  };
}
