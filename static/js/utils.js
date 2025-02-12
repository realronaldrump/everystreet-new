/* global bootstrap */

class NotificationManager {
  constructor() {
    this.container = this._getOrCreateContainer();
  }

  _getOrCreateContainer() {
    let container = document.querySelector('.notification-container');
    if (!(container instanceof HTMLElement)) {
      container = document.createElement('div');
      container.className = 'notification-container position-fixed top-0 end-0 p-3';
      document.body.appendChild(container);
    }
    return container;
  }

  show(message, type = 'info', duration = 5000) {
    const notificationDiv = document.createElement('div');
    notificationDiv.className = `alert alert-${type} alert-dismissible fade show`;
    notificationDiv.innerHTML = `
      ${message}
      <button type="button" class="btn-close" data-bs-dismiss="alert" aria-label="Close"></button>
    `;
    this.container.appendChild(notificationDiv);
    setTimeout(() => notificationDiv.remove(), duration);
  }
}

class ConfirmationDialog {
  constructor() {
    this.modalId = 'confirmationModal';
    this._createModal();
  }

  _createModal() {
    const modalHtml = `
      <div class="modal fade" id="${this.modalId}" tabindex="-1" aria-hidden="true">
        <div class="modal-dialog">
          <div class="modal-content">
            <div class="modal-header">
              <h5 class="modal-title"></h5>
              <button type="button" class="btn-close" data-bs-dismiss="modal" aria-label="Close"></button>
            </div>
            <div class="modal-body"></div>
            <div class="modal-footer">
              <button type="button" class="btn btn-secondary" data-bs-dismiss="modal">Cancel</button>
              <button type="button" class="btn btn-primary confirm-btn">Confirm</button>
            </div>
          </div>
        </div>
      </div>
    `;

    if (!document.getElementById(this.modalId)) {
      const parser = new DOMParser();
      const doc = parser.parseFromString(modalHtml, 'text/html');
      document.body.appendChild(doc.body.firstChild);
    }
  }

  async show(options = {}) {
    const {
      title = 'Confirm',
      message = 'Are you sure?',
      confirmText = 'Confirm',
      cancelText = 'Cancel',
      confirmButtonClass = 'btn-primary'
    } = options;

    return new Promise((resolve) => {
      const modalElement = document.getElementById(this.modalId);
      const modal = new bootstrap.Modal(modalElement);

      modalElement.querySelector('.modal-title').textContent = title;
      modalElement.querySelector('.modal-body').textContent = message;

      const confirmBtn = modalElement.querySelector('.confirm-btn');
      const cancelBtn = modalElement.querySelector('.btn-secondary');

      confirmBtn.textContent = confirmText;
      cancelBtn.textContent = cancelText;
      confirmBtn.className = `btn confirm-btn ${confirmButtonClass}`;

      const cleanup = () => {
        confirmBtn.removeEventListener('click', handleConfirm);
        modalElement.removeEventListener('hidden.bs.modal', handleDismiss);
      };

      const handleConfirm = () => {
        cleanup();
        modal.hide();
        resolve(true);
      };

      const handleDismiss = () => {
        cleanup();
        resolve(false);
      };

      confirmBtn.addEventListener('click', handleConfirm);
      modalElement.addEventListener('hidden.bs.modal', handleDismiss);

      modal.show();
    });
  }
}

// Create global instances
window.notificationManager = new NotificationManager();
window.confirmationDialog = new ConfirmationDialog();