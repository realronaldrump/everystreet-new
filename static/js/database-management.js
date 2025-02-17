/* global bootstrap, notificationManager */
document.addEventListener('DOMContentLoaded', function() {
    const refreshStorageBtn = document.getElementById('refresh-storage');
    const optimizeAllBtn = document.getElementById('optimize-all');
    const repairIndexesBtn = document.getElementById('repair-indexes');
    const confirmationModal = new bootstrap.Modal(document.getElementById('confirmationModal'));
    const confirmActionBtn = document.getElementById('confirmAction');
    
    let currentAction = null;
    let currentCollection = null;

    // Refresh storage info
    refreshStorageBtn.addEventListener('click', async function() {
        try {
            const response = await fetch('/api/database/storage-info');
            const data = await response.json();
            
            // Update the progress bar and text
            const progressBar = document.querySelector('.progress-bar');
            progressBar.style.width = `${data.usage_percent}%`;
            progressBar.setAttribute('aria-valuenow', data.usage_percent);
            progressBar.textContent = `${data.usage_percent}%`;
            
            // Update storage text
            document.querySelector('p').textContent = 
                `Using ${data.used_mb}MB of ${data.limit_mb}MB`;
            
            // Update progress bar color
            progressBar.className = 'progress-bar';
            if (data.usage_percent > 95) {
                progressBar.classList.add('bg-danger');
            } else if (data.usage_percent > 80) {
                progressBar.classList.add('bg-warning');
            } else {
                progressBar.classList.add('bg-success');
            }
            
            notificationManager.show('Storage information updated successfully', 'success');
        } catch (error) {
            console.error('Error refreshing storage info:', error);
            notificationManager.show('Failed to refresh storage information', 'danger');
        }
    });

    // Optimize collection buttons
    document.querySelectorAll('.optimize-collection').forEach(button => {
        button.addEventListener('click', function() {
            currentAction = 'optimize';
            currentCollection = this.dataset.collection;
            document.querySelector('#confirmationModal .modal-body').textContent = 
                `Are you sure you want to optimize the ${currentCollection} collection?`;
            confirmationModal.show();
        });
    });

    // Clear collection buttons
    document.querySelectorAll('.clear-collection').forEach(button => {
        button.addEventListener('click', function() {
            currentAction = 'clear';
            currentCollection = this.dataset.collection;
            document.querySelector('#confirmationModal .modal-body').textContent = 
                `Are you sure you want to clear all documents from the ${currentCollection} collection? This action cannot be undone.`;
            confirmationModal.show();
        });
    });

    // Optimize all collections
    optimizeAllBtn.addEventListener('click', function() {
        currentAction = 'optimize-all';
        document.querySelector('#confirmationModal .modal-body').textContent = 
            'Are you sure you want to optimize all collections? This may take a while.';
        confirmationModal.show();
    });

    // Repair indexes
    repairIndexesBtn.addEventListener('click', function() {
        currentAction = 'repair-indexes';
        document.querySelector('#confirmationModal .modal-body').textContent = 
            'Are you sure you want to repair all database indexes?';
        confirmationModal.show();
    });

    // Handle confirmation
    confirmActionBtn.addEventListener('click', async function() {
        confirmationModal.hide();
        
        try {
            let endpoint = '';
            let body = {};
            
            switch(currentAction) {
                case 'optimize':
                    endpoint = '/api/database/optimize-collection';
                    body = { collection: currentCollection };
                    break;
                case 'clear':
                    endpoint = '/api/database/clear-collection';
                    body = { collection: currentCollection };
                    break;
                case 'optimize-all':
                    endpoint = '/api/database/optimize-all';
                    break;
                case 'repair-indexes':
                    endpoint = '/api/database/repair-indexes';
                    break;
            }

            // Show loading state
            const button = document.querySelector(`button[data-collection="${currentCollection}"]`);
            if (button) {
                button.disabled = true;
                button.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Processing...';
            }
            
            const response = await fetch(endpoint, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify(body)
            });
            
            if (!response.ok) {
                const errorData = await response.json();
                throw new Error(errorData.detail || `HTTP error! status: ${response.status}`);
            }
            
            const result = await response.json();
            notificationManager.show(result.message, 'success');
            
            // Refresh the page to show updated stats
            setTimeout(() => window.location.reload(), 1500);
        } catch (error) {
            console.error('Error performing database action:', error);
            notificationManager.show(error.message || 'Failed to perform database action', 'danger');
            
            // Reset button state if action failed
            const button = document.querySelector(`button[data-collection="${currentCollection}"]`);
            if (button) {
                button.disabled = false;
                button.innerHTML = currentAction === 'optimize' ? 
                    '<i class="fas fa-compress-arrows-alt"></i> Optimize' :
                    '<i class="fas fa-trash"></i> Clear';
            }
        }
    });
}); 