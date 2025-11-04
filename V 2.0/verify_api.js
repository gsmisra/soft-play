(function () {
  // --- NEW: Helper function to clear old verify highlights ---
  function clearVerifyHighlights() {
    const oldHighlights = document.querySelectorAll(".spy-verify-highlighter");
    oldHighlights.forEach((box) => box.remove());
  }

  // --- NEW: Helper function to draw highlights ---
  function drawVerifyHighlights(elements) {
    // Clear any old ones first
    clearVerifyHighlights();

    if (!elements || elements.length === 0) return;

    elements.forEach((el) => {
      const rect = el.getBoundingClientRect();

      const box = document.createElement("div");
      box.className = "spy-verify-highlighter"; // Use class for multiple

      // Set position
      box.style.top = `${rect.top + window.scrollY}px`;
      box.style.left = `${rect.left + window.scrollX}px`;
      box.style.width = `${rect.width}px`;
      box.style.height = `${rect.height}px`;

      document.body.appendChild(box);

      // Scroll the first element into view
      if (elements.indexOf(el) === 0) {
        el.scrollIntoView({ behavior: "smooth", block: "center" });
      }

      // Remove the box after the animation finishes
      setTimeout(() => {
        box.remove();
      }, 1500); // Must match animation duration in styles.css
    });
  }

  // --- UPDATED: Message listener ---
  function attachVerifyListener() {
    chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
      if (request.action === "verify-locator" && request.locator) {
        try {
          const { type, value } = request.locator;
          let count = 0;
          let elements = []; // We will store found elements here

          if (type === "xpath" || type === "xpath-abs") {
            const result = document.evaluate(
              value,
              document,
              null,
              XPathResult.ORDERED_NODE_SNAPSHOT_TYPE,
              null
            );
            count = result.snapshotLength;
            // Get all elements from the snapshot
            for (let i = 0; i < count; i++) {
              elements.push(result.snapshotItem(i));
            }
          } else {
            const sel = type === "id" ? `#${CSS.escape(value)}` : value;
            elements = Array.from(document.querySelectorAll(sel));
            count = elements.length;
          }

          // --- NEW: Draw the highlights on the page ---
          drawVerifyHighlights(elements);

          // Send the response back to the side panel (as before)
          sendResponse({ ok: true, count });
        } catch (e) {
          sendResponse({ ok: false, error: e.message });
        }
        return true; // Keep message port open for async response
      }
    });
  }

  try {
    attachVerifyListener();
  } catch (e) {
    console.error("Failed to attach verify listener:", e);
  }
  window.attachVerifyListener = attachVerifyListener;
})();
