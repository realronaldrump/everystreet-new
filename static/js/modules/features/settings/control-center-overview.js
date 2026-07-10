import apiClient from "../../core/api-client.js";
import { formatDateTime, isAbortError } from "../../utils.js";
import { setActiveTab } from "./app-settings.js";

const STATUS_API = "/api/status/overview";
const POLL_INTERVAL_MS = 30000;
const SERVICE_ORDER = [
  "mongodb",
  "redis",
  "worker",
  "bouncie",
  "mapping_provider",
  "nominatim",
  "valhalla",
];
const SERVICE_ICONS = {
  mongodb: "fa-database",
  redis: "fa-bolt",
  worker: "fa-gears",
  bouncie: "fa-car-side",
  mapping_provider: "fa-map",
  nominatim: "fa-location-dot",
  valhalla: "fa-route",
};

function titleFor(key) {
  return {
    mongodb: "Historical data",
    redis: "Live state",
    worker: "Background engine",
    bouncie: "Bouncie",
    mapping_provider: "Mapping provider",
    nominatim: "Address lookup",
    valhalla: "Routing",
  }[key] || key.replaceAll("_", " ");
}

function renderHeader(data) {
  const overall = data?.overall || {};
  const state = overall.status || "recovering";
  const pill = document.getElementById("settings-system-pill");
  const hero = document.getElementById("system-hero");
  if (pill) pill.dataset.state = state;
  if (hero) hero.dataset.state = state;

  const pillLabel = document.getElementById("settings-system-pill-label");
  const label = document.getElementById("system-status-label");
  const message = document.getElementById("system-status-message");
  const detail = document.getElementById("system-status-detail");
  const updated = document.getElementById("system-last-updated");
  if (pillLabel) pillLabel.textContent = overall.label || "System status";
  if (label) label.textContent = overall.label || "System status";
  if (message) message.textContent = overall.message || "Status is temporarily unavailable.";
  if (detail) {
    detail.textContent =
      state === "healthy"
        ? "Trips and derived data stay current without this page being open."
        : state === "action_required"
          ? "Everything else will continue while you make this decision."
          : "Temporary failures are using bounded retries; no action is needed.";
  }
  if (updated) {
    updated.textContent = `Updated ${formatDateTime(data?.last_updated)}`;
  }

  const icon = hero?.querySelector(".system-hero-icon i");
  if (icon) {
    icon.className =
      state === "healthy"
        ? "fas fa-check"
        : state === "action_required"
          ? "fas fa-hand-pointer"
          : "fas fa-arrows-rotate fa-spin";
  }
}

function renderAutomation(data) {
  const automation = data?.automation || {};
  const total = document.getElementById("automation-total");
  const running = document.getElementById("automation-running");
  const recovering = document.getElementById("automation-recovering");
  if (total) total.textContent = String(automation.total ?? 0);
  if (running) running.textContent = String(automation.running ?? 0);
  if (recovering) recovering.textContent = String(automation.recovering ?? 0);
}

function renderActions(data) {
  const container = document.getElementById("system-actions");
  if (!container) return;
  const actions = Array.isArray(data?.actions) ? data.actions : [];
  container.classList.toggle("d-none", actions.length === 0);
  container.innerHTML = "";
  actions.forEach((action) => {
    const item = document.createElement("article");
    item.className = "system-action";
    const copy = document.createElement("div");
    const title = document.createElement("strong");
    title.textContent = action.label || "Action required";
    const message = document.createElement("p");
    message.textContent = action.message || "A decision is required.";
    copy.append(title, message);
    const link = document.createElement("a");
    link.className = "btn btn-primary";
    link.href = action.href || "#connections";
    link.textContent = action.label || "Review";
    if (link.href.includes("#connections")) {
      link.addEventListener("click", (event) => {
        event.preventDefault();
        setActiveTab("connections", { updateHash: true });
      });
    }
    item.append(copy, link);
    container.appendChild(item);
  });
}

function renderServices(data) {
  const container = document.getElementById("system-services");
  if (!container) return;
  const services = data?.services || {};
  container.innerHTML = "";
  SERVICE_ORDER.filter((key) => services[key] && !services[key].skipped).forEach(
    (key) => {
      const service = services[key];
      const state = service.status || "warning";
      const card = document.createElement("article");
      card.className = "service-card";
      card.dataset.state = state;
      const icon = document.createElement("span");
      icon.className = "service-card-icon";
      icon.innerHTML = `<i class="fas ${SERVICE_ICONS[key] || "fa-circle"}" aria-hidden="true"></i>`;
      const copy = document.createElement("div");
      const title = document.createElement("h3");
      title.textContent = titleFor(key);
      const message = document.createElement("p");
      message.textContent =
        service.message || (state === "healthy" ? "Ready" : "Recovering automatically");
      copy.append(title, message);
      card.append(icon, copy);
      container.appendChild(card);
    }
  );
  if (!container.children.length) {
    container.innerHTML = '<div class="service-placeholder">Capability status is temporarily unavailable.</div>';
  }
}

export default function initControlCenterOverview({ signal, cleanup } = {}) {
  let timer = null;
  const refresh = async () => {
    try {
      const data = await apiClient.get(STATUS_API, { signal, cache: "no-store" });
      renderHeader(data);
      renderAutomation(data);
      renderActions(data);
      renderServices(data);
    } catch (error) {
      if (isAbortError(error)) return;
      renderHeader({
        overall: {
          status: "recovering",
          label: "Reconnecting",
          message: "System status is temporarily unavailable.",
        },
      });
    }
  };

  refresh();
  timer = window.setInterval(refresh, POLL_INTERVAL_MS);
  const stop = () => {
    if (timer) window.clearInterval(timer);
    timer = null;
  };
  signal?.addEventListener("abort", stop, { once: true });
  cleanup?.(stop);
}
