function showModal(title, message, confirmCallback) {
  const modalTitle = document.getElementById('customModalLabel');
  const modalBody = document.querySelector('#customModal .modal-body');
  const confirmButton = document.getElementById('modalConfirmButton');

  modalTitle.textContent = title;
  modalBody.textContent = message;

  // Show the modal
  const modal = new bootstrap.Modal(document.getElementById('customModal'));
  modal.show();

  // Handle confirm button click
  confirmButton.onclick = () => {
    if (confirmCallback) confirmCallback();
    modal.hide();
  };
}

