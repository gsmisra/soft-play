// PATCHED background.js (TXT + CLEAN JSON export)

chrome.runtime.onInstalled.addListener(() => {
  chrome.storage.local.set({
    isSpying: false,
    isAutoSpying: false, // Ensure auto-spy is off by default
    recordedLocators: [],
  });
  chrome.storage.sync.get("preferredDataAttrs", (res) => {
    if (!res.preferredDataAttrs) {
      chrome.storage.sync.set({
        preferredDataAttrs: "data-testid, data-cy, data-qa, data-test",
      });
    }
  });
});

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.action === "open-side-panel") {
    chrome.sidePanel.open({ windowId: request.windowId });
    sendResponse({ status: "side panel opened" });
    return true;
  }
  if (request.action === "save-all-locators") {
    saveAllLocatorsTxt();
    sendResponse({ status: "success" });
    return true;
  }
  if (request.action === "save-all-json") {
    saveAllLocatorsCleanJson(); // Call the new clean JSON function
    sendResponse({ status: "success" });
    return true;
  }
});

function saveAllLocatorsTxt() {
  chrome.storage.local.get("recordedLocators", (res) => {
    const locs = res.recordedLocators;
    if (!locs || !locs.length) {
      console.warn("No locators to save");
      return;
    }
    const content = buildFileContent(locs);
    const url = "data:text/plain;charset=utf-8," + encodeURIComponent(content);
    const ts = new Date().toISOString().replace(/:/g, "-").slice(0, 19);
    chrome.downloads.download({
      url,
      filename: `auto-xpath-${ts}.txt`,
      saveAs: true,
    });
  });
}

// --- NEW FUNCTION TO SAVE CLEAN JSON (FIXED) ---
function saveAllLocatorsCleanJson() {
  chrome.storage.local.get("recordedLocators", ({ recordedLocators }) => {
    if (!recordedLocators || !recordedLocators.length) return;

    // Transform the data into the clean format
    const cleanData = recordedLocators.map((entry) => {
      // Create a simple key-value object for the locators
      const locatorsObject = entry.locators.reduce((acc, loc) => {
        // Use type as key (e.g., "xpath") and value as the locator string
        acc[loc.type] = loc.value;
        return acc;
      }, {});

      // Return the clean object for this element
      return {
        name: entry.name,
        tag: entry.tag,
        locators: locatorsObject,
      };
    });

    // --- THIS IS THE FIX ---
    // Create and download the JSON using a data URL
    const content = JSON.stringify(cleanData, null, 2);
    const url =
      "data:application/json;charset=utf-8," + encodeURIComponent(content);
    const ts = new Date().toISOString().replace(/:/g, "-").slice(0, 19);
    chrome.downloads.download({
      url,
      filename: `locators-${ts}.json`,
      saveAs: true,
    });
    // --- END OF FIX ---
  });
}
// --- END OF NEW FUNCTION ---

function buildFileContent(locs) {
  let s = `XPath Spy Report - ${new Date().toLocaleString()}\n`;
  s += `=================================================\n\n`;
  s += `Total Locators: ${locs.length}\n\n`;
  locs.forEach((entry, i) => {
    s += `--- Element ${i + 1} ---\n`;
    s += `ID: ${entry.id}\n`;
    s += `Name: ${entry.name}\n`;
    s += `Tag: <${entry.tag}>\n`;
    if (entry.hops) s += `Hops: ${JSON.stringify(entry.hops)}\n`;
    s += `\n`;
    entry.locators.forEach((loc) => {
      const stab = loc.stability != null ? ` [stability=${loc.stability}]` : "";
      s += ` [${loc.type.toUpperCase()}]${stab}\n ${loc.value}\n\n`;
    });
    s += `---------------------\n\n`;
  });
  return s;
}
