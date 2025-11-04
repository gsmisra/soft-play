const saveBtn = document.getElementById('save-btn');
const dataAttrsInput = document.getElementById('data-attrs');
const statusEl = document.getElementById('status');

// 1. Load saved settings
function restoreOptions() {
    chrome.storage.sync.get('preferredDataAttrs', (data) => {
        dataAttrsInput.value = data.preferredDataAttrs || "data-testid, data-cy, data-qa";
    });
}

// 2. Save settings
function saveOptions() {
    const preferredDataAttrs = dataAttrsInput.value;
   
    chrome.storage.sync.set({
        preferredDataAttrs: preferredDataAttrs
    }, () => {
        // Update status to let user know options were saved.
        statusEl.textContent = 'Options saved!';
        setTimeout(() => {
            statusEl.textContent = '';
        }, 1500);
    });
}

document.addEventListener('DOMContentLoaded', restoreOptions);
saveBtn.addEventListener('click', saveOptions);