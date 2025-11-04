document.addEventListener('DOMContentLoaded', () => {
    const manualSpyBtn = document.getElementById('toggle-spy');
    const autoSpyToggle = document.getElementById('auto-spy-toggle');
    const autoSpyWrapper = document.getElementById('auto-mode-wrapper');
    const optionsLink = document.getElementById('options-link');

    let currentTabId = null;
    let canSpyOnPage = false;

    // --- START OF FIX ---
    // This "ping" checks if the content script is injected.
    async function sendMessageToTab(tabId, message) {
        return new Promise((resolve, reject) => {
            chrome.tabs.sendMessage(tabId, message, (response) => {
                if (chrome.runtime.lastError) {
                    reject(new Error(chrome.runtime.lastError.message));
                } else {
                    resolve(response);
                }
            });
        });
    }

    async function initializePopup(tabs) {
        if (!tabs || tabs.length === 0) {
            disableAll("No active tab found.");
            return;
        }
        currentTabId = tabs[0].id;

        // Check if we can even run on this page
        if (!/^https?:|^file:/.test(tabs[0].url)) {
            disableAll("Cannot spy on Chrome pages.");
            return;
        }

        // Try to ping the content script
        try {
            await sendMessageToTab(currentTabId, { action: "ping" });
            canSpyOnPage = true;
        } catch (e) {
            // Ping failed. Content script is not injected.
            console.warn("Quick Spy: Content script not injected or page not supported.");
            disableAll("Refresh page or spy on a valid website");
            return;
        }
        // --- END OF FIX ---

        // If ping succeeds, load state and enable buttons
        chrome.storage.local.get(['isSpying', 'isAutoSpying'], (res) => {
            updateManualSpyUI(res.isSpying);
            autoSpyToggle.checked = !!res.isAutoSpying;
        });

        // 2. Listen for changes from other sources
        chrome.storage.local.onChanged.addListener((changes) => {
            if (changes.isSpying) {
                updateManualSpyUI(changes.isSpying.newValue);
            }
            if (changes.isAutoSpying) {
                autoSpyToggle.checked = !!changes.isAutoSpying.newValue;
            }
        });

        // 3. Handle Manual Spy button click
        manualSpyBtn.addEventListener('click', () => {
            if (!canSpyOnPage) return;
            chrome.storage.local.get('isSpying', (res) => {
                const newState = !res.isSpying;
                chrome.storage.local.set({ isSpying: newState });
                sendMessageToTab(currentTabId, { action: 'toggle-spy', isSpying: newState });
                updateManualSpyUI(newState);
            });
        });

        // 4. Handle Auto Spy toggle change
        autoSpyToggle.addEventListener('change', () => {
            if (!canSpyOnPage) return;
            const newState = autoSpyToggle.checked;
            chrome.storage.local.set({ isAutoSpying: newState });
            sendMessageToTab(currentTabId, { action: 'toggle-auto-spy', isAutoSpying: newState });
        });
    }

    // Get the active tab to send messages to
    chrome.tabs.query({ active: true, currentWindow: true }, initializePopup);


    // 5. Handle Options link
    optionsLink.addEventListener('click', (e) => {
        e.preventDefault();
        chrome.runtime.openOptionsPage();
    });

    // Helper to disable all buttons
    function disableAll(message) {
        manualSpyBtn.disabled = true;
        manualSpyBtn.textContent = message;
        manualSpyBtn.classList.remove('enabled');
        manualSpyBtn.classList.add('disabled'); // This makes it red
        autoSpyToggle.disabled = true;
        autoSpyWrapper.classList.add('disabled');
    }

    // Helper function to update the Manual Spy button text and style
    function updateManualSpyUI(isSpying) {
        if (isSpying) {
            manualSpyBtn.textContent = 'Disable Manual Spy';
            manualSpyBtn.classList.remove('disabled');
            manualSpyBtn.classList.add('enabled'); // Red
        } else {
            manualSpyBtn.textContent = 'Enable Manual Spy';
            manualSpyBtn.classList.remove('enabled');
            manualSpyBtn.classList.add('disabled'); // Gray
        }
    }
});

