class NotificationManager {
  constructor() {
    this.container = this.createContainer();
  }

  createContainer() {
    let container = document.querySelector('.notification-container');
    if (!container) {
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
    this.createModal();
  }

  createModal() {
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

    let modalElement = document.getElementById(this.modalId);
    if (!modalElement) {
      const div = document.createElement('div');
      div.innerHTML = modalHtml;
      document.body.appendChild(div.firstChild);
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
      
      // Reset button classes and add the specified class
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