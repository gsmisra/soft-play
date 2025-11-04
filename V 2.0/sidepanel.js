// PATCHED sidepanel.js
// Added search bar functionality

let currentLanguage = "java";
let allLocators = [];

document.addEventListener("DOMContentLoaded", () => {
  const languageSelector = document.getElementById("language-selector");
  const locatorList = document.getElementById("locator-list");
  const saveButton = document.getElementById("save-button");
  const clearButton = document.getElementById("clear-button");
  // --- NEW: Get search bar ---
  const searchBar = document.getElementById("search-bar");

  loadLocatorsFromStorage();

  chrome.storage.local.onChanged.addListener((changes) => {
    if (changes.recordedLocators) {
      allLocators = changes.recordedLocators.newValue || [];
      // Re-render the list, which will respect the current search term
      renderLocatorList();
    }
  });

  languageSelector.addEventListener("change", (e) => {
    currentLanguage = e.target.value;
    renderLocatorList();
  });

  // --- NEW: Add event listener for search bar ---
  // 'input' fires on every keystroke
  searchBar.addEventListener("input", () => {
    renderLocatorList();
  });
  // --- END OF NEW ---

  // Updated: Normal click -> JSON ; Ctrl/Cmd -> TXT
  saveButton.addEventListener("click", (e) => {
    const useTxt = e.metaKey || e.ctrlKey;
    chrome.runtime.sendMessage(
      { action: useTxt ? "save-all-locators" : "save-all-json" },
      () => {
        if (chrome.runtime.lastError)
          console.warn("save msg:", chrome.runtime.lastError.message);
      }
    );
  });

  clearButton.addEventListener("click", () => {
    // --- NEW: Confirmation Dialog ---
    if (confirm("Are you sure you want to delete all recorded locators?")) {
      chrome.storage.local.set({ recordedLocators: [] }, () => {
        // Clear search bar when clearing locators
        searchBar.value = "";
        renderLocatorList();
      });
    }
    // --- END OF NEW ---
  });

  locatorList.addEventListener("click", (e) => {
    const target = e.target;
    if (target.classList.contains("delete-btn")) {
      const card = target.closest(".locator-card");
      const id = card?.dataset.id;
      deleteLocatorById(id);
    }
    if (target.classList.contains("copy-btn")) {
      const code = target
        .closest(".locator-item")
        .querySelector(".code-snippet").textContent;
      copyToClipboard(code, target);
    }
    if (target.classList.contains("verify-btn")) {
      const type = target.dataset.type;
      const value = target.dataset.value;
      const card = target.closest(".locator-card");
      const id = card?.dataset.id;
      const entry = allLocators.find((x) => x.id === id);

      // --- NEW: Verify button UI feedback ---
      target.textContent = "...";
      target.className = "verify-btn loading";
      // --- END OF NEW ---

      sendToActive(
        {
          action: "verify-locator",
          locator: { type, value },
          hops: entry?.hops || null,
        },
        (res) => {
          if (!res || res.ok === false) {
            target.textContent = "Err";
            target.className = "verify-btn error";
          } else {
            target.textContent = `${res.count}`;
            if (res.count === 1) {
              target.className = "verify-btn success-1";
            } else if (res.count > 1) {
              target.className = "verify-btn success-multi";
            } else {
              target.className = "verify-btn error";
            }
          }
          setTimeout(() => {
            target.textContent = "Verify";
            target.className = "verify-btn";
          }, 2000);
        }
      );
    }
  });

  locatorList.addEventListener("mouseover", (e) => {
    const item = e.target.closest(".locator-item");
    let entry = null,
      loc = null;
    if (item) {
      const card = item.closest(".locator-card");
      const id = card?.dataset.id;
      entry = allLocators.find((x) => x.id === id);
      if (!entry) return;
      const type = item.dataset.type; // Get type from data-type
      loc = entry.locators.find((l) => l.type === type);
    } else {
      const card = e.target.closest(".locator-card");
      if (card) {
        const id = card.dataset.id;
        entry = allLocators.find((x) => x.id === id);
        if (!entry) return;
        loc = bestLocator(entry.locators);
      }
    }
    if (loc) {
      sendToActive(
        { action: "highlight-element-in-tab", locator: loc },
        () => {}
      );
    }
  });

  locatorList.addEventListener("mouseout", () => {
    sendToActive({ action: "clear-highlight" }, () => {});
  });

  function sendToActive(message, cb) {
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      const tab = tabs && tabs[0];
      if (!tab || !tab.id) {
        return safeCb(cb, null);
      }
      const url = tab.url || "";
      // Only try to message tabs our content script can run in
      if (!/^https?:|^file:/.test(url)) {
        // console.warn('Sidepanel: unsupported URL for messaging:', url);
        return safeCb(cb, null);
      }
      chrome.tabs.sendMessage(tab.id, message, (res) => {
        if (chrome.runtime.lastError) {
          // Receiving end missing — content script didn't load on this URL
          // console.warn('Sidepanel msg error:', chrome.runtime.lastError.message);
          return safeCb(cb, null);
        }
        safeCb(cb, res);
      });
    });
  }
  function safeCb(cb, res) {
    try {
      cb && cb(res);
    } catch (_) {}
  }

  function loadLocatorsFromStorage() {
    chrome.storage.local.get("recordedLocators", (res) => {
      allLocators = res.recordedLocators || [];
      renderLocatorList();
    });
  }

  // --- UPDATED: renderLocatorList now handles search ---
  function renderLocatorList() {
    const locatorList = document.getElementById("locator-list");
    const searchBar = document.getElementById("search-bar");
    const searchTerm = searchBar.value.toLowerCase();

    locatorList.innerHTML = "";

    // Filter locators based on search term
    let locatorsToRender = allLocators;
    if (searchTerm) {
      locatorsToRender = allLocators.filter((entry) =>
        entry.name.toLowerCase().includes(searchTerm)
      );
    }

    if (!locatorsToRender.length) {
      if (searchTerm) {
        locatorList.innerHTML =
          '<li class="empty-message">No locators match your search.</li>';
      } else {
        locatorList.innerHTML =
          '<li class="empty-message">Start spying to record locators.</li>';
      }
      return;
    }

    const scored = locatorsToRender
      .slice()
      .sort((a, b) => maxStability(b.locators) - maxStability(a.locators));
    scored.forEach((entry) => {
      const card = createLocatorCard(entry);
      locatorList.appendChild(card);
    });
  }
  // --- END OF UPDATE ---

  function createLocatorCard(entry) {
    const li = document.createElement("li");
    li.className = "locator-card";
    li.dataset.id = entry.id;

    const preferredOrder = ["id", "css", "xpath"];
    const sorted = entry.locators.slice().sort((a, b) => {
      const po =
        preferredOrder.indexOf(a.type) - preferredOrder.indexOf(b.type);
      if (po !== 0) return po;
      return (b.stability ?? 0) - (a.stability ?? 0);
    });

    let items = "";
    sorted.forEach((loc) => {
      const code = generateCodeSnippet(loc.type, loc.value);
      const typeDisplay = loc.type.toUpperCase();
      const stab =
        loc.stability != null
          ? ` <span style="font-size:11px;opacity:.7">[${loc.stability}]</span>`
          : "";
      items += `
<div class="locator-item" data-type="${loc.type}">
    <span class="locator-type ${loc.type}">${typeDisplay}${stab}</span>
    <pre class="code-snippet">${code}</pre>
    <div class="locator-buttons">
        <button class="copy-btn">Copy</button>
        <button class="verify-btn" data-type="${loc.type}" data-value="${loc.value}">Verify</button>
    </div>
</div>
`;
    });

    li.innerHTML = `
<div class="card-header">
    <span class="element-name" title="${entry.name}">${entry.name}</span>
    <span class="element-tag">&lt;${entry.tag}&gt;</span>
    <button class="delete-btn" title="Delete">X</button>
</div>
<div class="card-body">${items}</div>
`;
    return li;
  }

  function deleteLocatorById(id) {
    if (!id) return;
    const idx = allLocators.findIndex((e) => e.id === id);
    if (idx >= 0) {
      allLocators.splice(idx, 1);
      chrome.storage.local.set({ recordedLocators: allLocators }, () =>
        renderLocatorList()
      );
    }
  }

  function generateCodeSnippet(type, value) {
    value = value.replace(/"/g, "'");
    switch (currentLanguage) {
      case "java":
        if (type === "id") return `driver.findElement(By.id("${value}"))`;
        if (type === "css")
          return `driver.findElement(By.cssSelector("${value}"))`;
        if (type === "xpath") return `driver.findElement(By.xpath("${value}"))`;
        return value;
      case "python":
        if (type === "id") return `driver.find_element(By.ID, "${value}")`;
        if (type === "css")
          return `driver.find_element(By.CSS_SELECTOR, "${value}")`;
        if (type === "xpath")
          return `driver.find_element(By.XPATH, "${value}")`;
        return value;
      case "javascript":
        if (type === "id") return `driver.findElement(By.id("${value}"))`;
        if (type === "css") return `driver.findElement(By.css("${value}"))`;
        if (type === "xpath") return `driver.findElement(By.xpath("${value}"))`;
        return value;
      case "playwright":
        if (type === "id") return `page.locator("#${value}")`;
        if (type === "css") return `page.locator("${value}")`;
        if (type === "xpath") return `page.locator("xpath=${value}")`;
        return value;
      case "cypress":
        if (type === "id") return `cy.get("#${value}")`;
        if (type === "css") return `cy.get("${value}")`;
        if (type === "xpath") return `cy.xpath("${value}")`;
        return value;
      default:
        return value;
    }
  }

  function copyToClipboard(text, button) {
    navigator.clipboard
      .writeText(text)
      .then(() => {
        button.textContent = "Copied!";
        setTimeout(() => (button.textContent = "Copy"), 1500);
      })
      .catch(() => {
        try {
          const ta = document.createElement("textarea");
          ta.value = text;
          document.body.appendChild(ta);
          ta.select();
          document.execCommand("copy");
          document.body.removeChild(ta);
          button.textContent = "Copied!";
          setTimeout(() => (button.textContent = "Copy"), 1500);
        } catch (e) {
          console.error("copy failed", e);
        }
      });
  }

  function maxStability(locs) {
    return locs.reduce((m, l) => Math.max(m, l.stability ?? 0), 0);
  }
  function bestLocator(locs) {
    const nonAbs = locs.filter((l) => l.type !== "xpath-abs");
    const arr = nonAbs.length ? nonAbs : locs;
    return arr.reduce(
      (a, b) => ((a?.stability ?? 0) >= (b?.stability ?? 0) ? a : b),
      arr[0]
    );
  }
});
