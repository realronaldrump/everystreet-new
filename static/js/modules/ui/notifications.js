class NotificationManager {
  constructor(config = {}) {
    this.config = {
      position: config.position || "top-end",
      containerClass: config.containerClass || "notification-container",
      defaultDuration: config.defaultDuration || 5000,
      maxNotifications: config.maxNotifications || 5,
      animations: config.animations !== false,
    };

    this.notifications = [];
    this.container = this._getOrCreateContainer();
  }

  _getOrCreateContainer() {
    let container = document.querySelector(`.${this.config.containerClass}`);

    if (!container) {
      container = document.createElement("div");
      container.className = `${this.config.containerClass} position-fixed top-0 end-0 p-3`;
      container.setAttribute("aria-live", "polite");
      document.body.appendChild(container);
    }

    return container;
  }

  show(message, type = "info", duration = this.config.defaultDuration) {
    const typeClass = type === "danger" ? "error" : type;
    const iconMap = {
      success: "fa-check-circle",
      error: "fa-exclamation-triangle",
      warning: "fa-exclamation-circle",
      info: "fa-info-circle",
    };
    const iconName = iconMap[typeClass] || iconMap.info;
    const iconMarkup =
      typeClass === "success"
        ? '<span class="notification-check" aria-hidden="true"></span>'
        : `<i class="fas ${iconName}" aria-hidden="true"></i>`;

    const notification = document.createElement("div");
    notification.className = `notification notification-${typeClass} alert alert-${type} alert-dismissible fade show bg-dark text-white`;
    notification.role = "alert";
    notification.innerHTML = `
      <div class="notification-icon">${iconMarkup}</div>
      <div class="notification-content">
        <div class="notification-message">${message}</div>
      </div>
      <button type="button" class="btn-close btn-close-white notification-close" data-bs-dismiss="alert" aria-label="Close"></button>
    `;

    this.container.appendChild(notification);

    this.notifications.push(notification);
    this._trimNotifications();

    const timeout = setTimeout(() => {
      this._removeNotification(notification);
    }, duration);

    const closeButton = notification.querySelector(".btn-close");
    if (closeButton) {
      closeButton.addEventListener("mousedown", (e) => {
        if (e.button !== 0) {
          return;
        }
        clearTimeout(timeout);
        this._removeNotification(notification);
      });
    }

    return notification;
  }

  _removeNotification(notification) {
    if (!notification || !notification.parentNode) {
      return;
    }

    if (this.config.animations) {
      notification.classList.remove("show");
      setTimeout(() => {
        if (notification.parentNode) {
          notification.parentNode.removeChild(notification);
        }
        this.notifications = this.notifications.filter((n) => n !== notification);
      }, 150);
    } else {
      notification.parentNode.removeChild(notification);
      this.notifications = this.notifications.filter((n) => n !== notification);
    }
  }

  _trimNotifications() {
    if (this.notifications.length <= this.config.maxNotifications) {
      return;
    }

    const excess = this.notifications.length - this.config.maxNotifications;
    for (let i = 0; i < excess; i++) {
      const oldest = this.notifications.shift();
      if (oldest?.parentNode) {
        oldest.parentNode.removeChild(oldest);
      }
    }
  }

  clearAll() {
    [...this.notifications].forEach((notification) => {
      this._removeNotification(notification);
    });
  }
}

const notificationManager = new NotificationManager();

const notify = {
  show: (message, type = "info", duration) =>
    notificationManager.show(message, type, duration),
  success: (message, duration) =>
    notificationManager.show(message, "success", duration),
  warning: (message, duration) =>
    notificationManager.show(message, "warning", duration),
  error: (message, duration) => notificationManager.show(message, "danger", duration),
  info: (message, duration) => notificationManager.show(message, "info", duration),
};

export { NotificationManager, notificationManager, notify };
export default notificationManager;
