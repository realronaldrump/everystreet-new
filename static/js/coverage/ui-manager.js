// static/js/coverage/ui-manager.js
class UIManager {
  constructor(notificationManager) {
    this.notificationManager = notificationManager;
    this.tooltips = [];
  }

  // Element utilities
  getElement(id) {
    return document.getElementById(id);
  }

  createElement(tag, className = "", content = "") {
    const el = document.createElement(tag);
    if (className) el.className = className;
    if (content) el.innerHTML = content;
    return el;
  }

  // Form utilities
  getFormData(formSelector) {
    const form =
      typeof formSelector === "string"
        ? document.querySelector(formSelector)
        : formSelector;

    if (!form) return {};

    const data = {};
    const inputs = form.querySelectorAll("input, select, textarea");

    inputs.forEach((input) => {
      if (input.type === "checkbox") {
        data[input.name || input.id] = input.checked;
      } else if (input.type === "radio") {
        if (input.checked) data[input.name || input.id] = input.value;
      } else {
        data[input.name || input.id] = input.value;
      }
    });

    return data;
  }

  setFormData(formSelector, data) {
    const form =
      typeof formSelector === "string"
        ? document.querySelector(formSelector)
        : formSelector;

    if (!form) return;

    Object.entries(data).forEach(([key, value]) => {
      const input = form.querySelector(`[name="${key}"], #${key}`);
      if (!input) return;

      if (input.type === "checkbox") {
        input.checked = Boolean(value);
      } else if (input.type === "radio") {
        const radio = form.querySelector(
          `input[name="${key}"][value="${value}"]`,
        );
        if (radio) radio.checked = true;
      } else {
        input.value = value;
      }
    });
  }

  // Validation utilities
  setValidationState(element, isValid, message = "") {
    if (!element) return;

    element.classList.remove("is-valid", "is-invalid");
    element.classList.add(isValid ? "is-valid" : "is-invalid");

    if (message) {
      let feedback = element.parentNode.querySelector(
        ".invalid-feedback, .valid-feedback",
      );
      if (!feedback) {
        feedback = this.createElement(
          "div",
          isValid ? "valid-feedback" : "invalid-feedback",
        );
        element.parentNode.appendChild(feedback);
      }
      feedback.textContent = message;
      feedback.className = isValid ? "valid-feedback" : "invalid-feedback";
    }
  }

  clearValidation(element) {
    if (!element) return;
    element.classList.remove("is-valid", "is-invalid");
    const feedback = element.parentNode.querySelector(
      ".invalid-feedback, .valid-feedback",
    );
    if (feedback) feedback.remove();
  }

  // Button state management
  setButtonLoading(button, loading = true, originalText = null) {
    if (!button) return;

    if (loading) {
      if (!button.dataset.originalText) {
        button.dataset.originalText = button.innerHTML;
      }
      button.disabled = true;
      button.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Loading...';
    } else {
      button.disabled = false;
      button.innerHTML =
        originalText || button.dataset.originalText || button.innerHTML;
      delete button.dataset.originalText;
    }
  }

  // Progress updates
  updateProgress(progressBar, percentage, text = null) {
    if (!progressBar) return;

    progressBar.style.width = `${percentage}%`;
    progressBar.setAttribute("aria-valuenow", percentage);

    if (text !== null) {
      progressBar.textContent = text;
    } else {
      progressBar.textContent = `${percentage}%`;
    }
  }

  // Table utilities
  updateTable(tableId, data, rowRenderer) {
    const table = this.getElement(tableId);
    if (!table) return;

    const tbody = table.querySelector("tbody");
    if (!tbody) return;

    if (!data.length) {
      tbody.innerHTML = this.createEmptyTableRow(
        table.querySelectorAll("thead th").length,
      );
      return;
    }

    tbody.innerHTML = "";
    data.forEach((item, index) => {
      const row = rowRenderer(item, index);
      tbody.appendChild(row);
    });
  }

  createEmptyTableRow(colCount, message = "No data available") {
    return `
        <tr>
          <td colspan="${colCount}" class="text-center py-4">
            <div class="empty-state">
              <i class="fas fa-inbox fa-2x mb-3 opacity-50"></i>
              <p class="mb-0">${message}</p>
            </div>
          </td>
        </tr>
      `;
  }

  // Loading states
  showLoading(element, message = "Loading...") {
    if (!element) return;

    element.innerHTML = `
        <div class="text-center py-4">
          <div class="spinner-border text-primary mb-2" role="status">
            <span class="visually-hidden">Loading...</span>
          </div>
          <p class="mb-0 text-muted">${message}</p>
        </div>
      `;
  }

  showError(element, message, actionButton = null) {
    if (!element) return;

    const actionHtml = actionButton
      ? `<button class="btn btn-sm btn-primary mt-2" onclick="${actionButton.onclick}">
             <i class="fas fa-redo me-1"></i>${actionButton.text}
           </button>`
      : "";

    element.innerHTML = `
        <div class="text-center py-4 text-danger">
          <i class="fas fa-exclamation-circle fa-2x mb-2"></i>
          <p class="mb-0">${message}</p>
          ${actionHtml}
        </div>
      `;
  }

  // Tooltips
  initTooltips(container = document) {
    // Clean up existing tooltips
    this.tooltips.forEach((tooltip) => {
      if (tooltip && typeof tooltip.dispose === "function") {
        tooltip.dispose();
      }
    });
    this.tooltips = [];

    // Initialize new tooltips
    const tooltipElements = container.querySelectorAll(
      '[data-bs-toggle="tooltip"]',
    );
    this.tooltips = Array.from(tooltipElements).map((el) => {
      return new bootstrap.Tooltip(el, {
        animation: true,
        delay: { show: 500, hide: 100 },
        html: true,
        placement: "auto",
      });
    });
  }

  // Statistics display
  createStatItem(value, label, className = "") {
    return `
        <div class="col-md-4 col-6">
          <div class="stat-item ${className}">
            <div class="stat-value">${value}</div>
            <div class="stat-label">${label}</div>
          </div>
        </div>
      `;
  }

  updateStats(container, stats) {
    if (!container) return;

    const html = Object.entries(stats)
      .map(([key, { value, label, className }]) =>
        this.createStatItem(value, label, className),
      )
      .join("");

    container.innerHTML = `<div class="row g-3">${html}</div>`;
  }

  // Alert/notification helpers
  createAlert(type, title, message, dismissible = true) {
    const dismissHtml = dismissible
      ? '<button type="button" class="btn-close" data-bs-dismiss="alert"></button>'
      : "";

    return this.createElement(
      "div",
      `alert alert-${type} ${dismissible ? "alert-dismissible" : ""} fade show`,
      `
        <h5 class="alert-heading h6 mb-1">
          <i class="fas fa-${this.getAlertIcon(type)} me-2"></i>${title}
        </h5>
        <p class="small mb-0">${message}</p>
        ${dismissHtml}
      `,
    );
  }

  getAlertIcon(type) {
    const icons = {
      success: "check-circle",
      danger: "exclamation-circle",
      warning: "exclamation-triangle",
      info: "info-circle",
      secondary: "question-circle",
    };
    return icons[type] || "info-circle";
  }

  // Modal utilities
  showModal(modalId, options = {}) {
    const modal = this.getElement(modalId);
    if (!modal) return null;

    const bsModal = bootstrap.Modal.getOrCreateInstance(modal, options);
    bsModal.show();
    return bsModal;
  }

  hideModal(modalId) {
    const modal = this.getElement(modalId);
    if (!modal) return;

    const bsModal = bootstrap.Modal.getInstance(modal);
    if (bsModal) bsModal.hide();
  }

  // Filter button state management
  updateFilterButtons(buttons, activeFilter) {
    buttons.forEach((btn) => {
      const isActive = btn.dataset.filter === activeFilter;

      // Remove all button classes
      btn.classList.remove(
        "active",
        "btn-primary",
        "btn-outline-primary",
        "btn-success",
        "btn-outline-success",
        "btn-danger",
        "btn-outline-danger",
        "btn-warning",
        "btn-outline-warning",
      );

      // Add appropriate class
      const baseClass = this.getFilterButtonClass(btn.dataset.filter);
      btn.classList.add(
        isActive ? baseClass : `btn-outline-${baseClass.split("-")[1]}`,
      );

      if (isActive) btn.classList.add("active");
    });
  }

  getFilterButtonClass(filter) {
    const classes = {
      all: "btn-primary",
      driven: "btn-success",
      undriven: "btn-danger",
      undriveable: "btn-warning",
    };
    return classes[filter] || "btn-primary";
  }

  // Distance formatting
  static distanceInUserUnits(meters, fixed = 2) {
    if (typeof meters !== "number" || isNaN(meters)) return "0 ft";

    const miles = meters * 0.000621371;
    return miles < 0.1
      ? `${(meters * 3.28084).toFixed(0)} ft`
      : `${miles.toFixed(fixed)} mi`;
  }

  // Time formatting
  static formatRelativeTime(dateString) {
    if (!dateString) return "Never";

    const date = new Date(dateString);
    const now = new Date();
    const diff = now - date;
    const seconds = Math.floor(diff / 1000);
    const minutes = Math.floor(seconds / 60);
    const hours = Math.floor(minutes / 60);
    const days = Math.floor(hours / 24);

    if (days > 7) return date.toLocaleDateString();
    if (days > 0) return `${days} day${days > 1 ? "s" : ""} ago`;
    if (hours > 0) return `${hours} hour${hours > 1 ? "s" : ""} ago`;
    if (minutes > 0) return `${minutes} minute${minutes > 1 ? "s" : ""} ago`;
    return "Just now";
  }

  // Street type formatting
  static formatStreetType(type) {
    if (!type) return "Unknown";
    return type.replace(/_/g, " ").replace(/\b\w/g, (l) => l.toUpperCase());
  }
}
