import { escapeHtml } from "../utils.js";
import { notificationHistory } from "./notifications.js";

const ICON_MAP = {
  success: "fa-check-circle",
  error: "fa-exclamation-triangle",
  warning: "fa-exclamation-circle",
  info: "fa-info-circle",
};

function formatTimestamp(ts) {
  const d = new Date(ts);
  const now = new Date();
  const diffMs = now - d;
  const diffMin = Math.floor(diffMs / 60000);
  const diffHr = Math.floor(diffMs / 3600000);
  const diffDay = Math.floor(diffMs / 86400000);

  if (diffMin < 1) return "just now";
  if (diffMin < 60) return `${diffMin}m ago`;
  if (diffHr < 24) return `${diffHr}h ago`;
  if (diffDay === 1) return "yesterday";
  if (diffDay < 7) return `${diffDay}d ago`;
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

function fullTimestamp(ts) {
  const d = new Date(ts);
  return d.toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

class NotificationBell {
  constructor() {
    this._btn = null;
    this._panel = null;
    this._badge = null;
    this._list = null;
    this._empty = null;
    this._open = false;
    this._boundClose = this._handleOutsideClick.bind(this);
    this._boundKey = this._handleKey.bind(this);
  }

  init() {
    this._btn = document.getElementById("notif-bell-btn");
    this._panel = document.getElementById("notif-history-panel");
    this._badge = document.getElementById("notif-unread-badge");
    this._list = document.getElementById("notif-history-list");
    this._empty = document.getElementById("notif-empty-state");

    if (!this._btn || !this._panel) return;

    this._btn.addEventListener("click", (e) => {
      e.stopPropagation();
      this._toggle();
    });

    document.getElementById("notif-clear-all-btn")?.addEventListener("click", () => {
      notificationHistory.clearAll();
    });

    notificationHistory.onChange(() => {
      this._updateBadge();
      if (this._open) this._renderList();
    });

    this._updateBadge();
  }

  _toggle() {
    if (this._open) {
      this._close();
    } else {
      this._openPanel();
    }
  }

  _openPanel() {
    this._open = true;
    this._panel.hidden = false;
    this._btn.setAttribute("aria-expanded", "true");
    this._renderList();
    notificationHistory.markAllRead();
    this._updateBadge();
    document.addEventListener("click", this._boundClose, true);
    document.addEventListener("keydown", this._boundKey, true);
  }

  _close() {
    this._open = false;
    this._panel.hidden = true;
    this._btn.setAttribute("aria-expanded", "false");
    document.removeEventListener("click", this._boundClose, true);
    document.removeEventListener("keydown", this._boundKey, true);
  }

  _handleOutsideClick(e) {
    if (
      !this._panel.contains(e.target) &&
      e.target !== this._btn &&
      !this._btn.contains(e.target)
    ) {
      this._close();
    }
  }

  _handleKey(e) {
    if (e.key === "Escape") {
      this._close();
      this._btn.focus();
    }
  }

  _updateBadge() {
    const count = notificationHistory.unreadCount();
    if (count > 0) {
      this._badge.hidden = false;
      this._badge.textContent = count > 9 ? "9+" : String(count);
    } else {
      this._badge.hidden = true;
    }
  }

  _renderList() {
    const items = notificationHistory.getAll();
    this._list.innerHTML = "";

    if (items.length === 0) {
      this._empty.hidden = false;
      return;
    }
    this._empty.hidden = true;

    for (const item of items) {
      const row = document.createElement("div");
      row.className = `notif-history-item notif-history-item--${item.type}`;
      row.setAttribute("role", "listitem");

      const icon = ICON_MAP[item.type] || ICON_MAP.info;
      row.innerHTML = `
        <i class="fas ${icon} notif-history-icon" aria-hidden="true"></i>
        <div class="notif-history-body">
          <p class="notif-history-message">${escapeHtml(item.message)}</p>
          <time class="notif-history-time" datetime="${new Date(item.timestamp).toISOString()}" title="${fullTimestamp(item.timestamp)}">${formatTimestamp(item.timestamp)}</time>
        </div>
        <button class="notif-history-remove" aria-label="Dismiss notification" data-id="${item.id}" type="button">
          <i class="fas fa-times" aria-hidden="true"></i>
        </button>
      `;

      row.querySelector(".notif-history-remove").addEventListener("click", (e) => {
        e.stopPropagation();
        notificationHistory.remove(item.id);
      });

      this._list.appendChild(row);
    }
  }
}

const notificationBell = new NotificationBell();

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", () => notificationBell.init());
} else {
  notificationBell.init();
}

export default notificationBell;
