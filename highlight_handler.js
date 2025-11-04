/**
 * This file listens for messages from the sidepanel.js to show
 * and hide the "hover-to-verify" highlight.
 *
 * It creates and manages the highlighter div defined in your styles.css.
 */

(function() {
    let highlighterDiv = null;

    /**
     * Creates the highlighter div and appends it to the body.
     */
    function createHighlighter() {
        if (highlighterDiv) return;
        highlighterDiv = document.createElement('div');
        highlighterDiv.id = 'spy-hover-highlighter';
        document.body.appendChild(highlighterDiv);
    }

    /**
     * Hides the highlighter div.
     */
    function hideHighlighter() {
        if (highlighterDiv) {
            highlighterDiv.style.display = 'none';
        }
    }

    /**
     * Shows and positions the highlighter div over a target element.
     * @param {Element} targetElement - The element to highlight.
     */
    function showHighlighter(targetElement) {
        if (!targetElement) return;
        
        createHighlighter(); // Ensure it exists

        const rect = targetElement.getBoundingClientRect();
        
        highlighterDiv.style.display = 'block';
        highlighterDiv.style.width = `${rect.width}px`;
        highlighterDiv.style.height = `${rect.height}px`;
        highlighterDiv.style.top = `${rect.top + window.scrollY}px`;
        highlighterDiv.style.left = `${rect.left + window.scrollX}px`;
    }

    /**
     * Finds an element in the document based on a locator object.
     * @param {object} locator - The { type, value } locator object.
     * @returns {Element|null} - The found element or null.
     */
    function findElementByLocator(locator) {
        if (!locator || !locator.type || !locator.value) {
            return null;
        }

        try {
            const { type, value } = locator;
            if (type === 'xpath' || type === 'xpath-abs') {
                return document.evaluate(value, document, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null).singleNodeValue;
            } else if (type === 'id') {
                return document.getElementById(value);
            } else if (type === 'css') {
                return document.querySelector(value);
            }
        } catch (e) {
            console.error("Error finding element for highlight:", e);
            return null;
        }
        return null;
    }

    // --- Message Listener ---
    // This is the core fix. It listens for the new messages from your sidepanel.js.
    
    chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
        
        // Listen for the new highlight action
        if (request.action === 'highlight-element-in-tab') {
            const element = findElementByLocator(request.locator);
            if (element) {
                showHighlighter(element);
                element.scrollIntoView({ behavior: 'smooth', block: 'center' });
            } else {
                hideHighlighter();
            }
            sendResponse({ ok: true });
            return true;
        }

        // Listen for the clear action
        if (request.action === 'clear-highlight') {
            hideHighlighter();
            sendResponse({ ok: true });
            return true;
        }
    });

})();