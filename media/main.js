(function () {
  const vscode = acquireVsCodeApi();

  const startBtn = document.getElementById('startBtn');
  const stopBtn = document.getElementById('stopBtn');
  const urlInput = document.getElementById('urlInput');
  const statusPill = document.getElementById('statusPill');
  const settingsBtn = document.getElementById('settingsBtn');
  const killAllBtn = document.getElementById('killAllBtn');
  const linkFeatureBtn = document.getElementById('linkFeatureBtn');
  const linkedScenarioBadge = document.getElementById('linkedScenarioBadge');
  const linkedScenarioText = document.getElementById('linkedScenarioText');
  const unlinkScenarioBtn = document.getElementById('unlinkScenarioBtn');
  const saveCodeBtn = document.getElementById('saveCodeBtn');
  const copyCodeBtn = document.getElementById('copyCodeBtn');
  const codeLanguageLabel = document.getElementById('codeLanguageLabel');
  const newCodeFlash = document.getElementById('newCodeFlash');
  const codeEditArea = document.getElementById('codeEditArea');
  const codeHighlightPre = document.getElementById('codeHighlight');
  const codeGutter = document.getElementById('codeGutter');
  const codeRefreshBanner = document.getElementById('codeRefreshBanner');
  const codeRefreshBtn = document.getElementById('codeRefreshBtn');
  const collapseCodeBtn = document.getElementById('collapseCodeBtn');
  const playwrightCodePanel = document.getElementById('playwrightCodePanel');
  const aiAssistSection = document.getElementById('aiAssistSection');
  const promptFilesList = document.getElementById('promptFilesList');
  const chatComposer = document.getElementById('chatComposer');
  const chatMessages = document.getElementById('chatMessages');
  const chatInput = document.getElementById('chatInput');
  const chatSendBtn = document.getElementById('chatSendBtn');
  const refreshPromptFilesBtn = document.getElementById('refreshPromptFilesBtn');
  const startAiProcessingBtn = document.getElementById('startAiProcessingBtn');
  const openAiCodeBtn = document.getElementById('openAiCodeBtn');
  const generateFeatureFileBtn = document.getElementById('generateFeatureFileBtn');
  const codeCorrectnessBanner = document.getElementById('codeCorrectnessBanner');
  const aiStatusLabel = document.getElementById('aiStatusLabel');
  const aiGeneratingBanner = document.getElementById('aiGeneratingBanner');
  const copilotEnabledToggle = document.getElementById('copilotEnabledToggle');
  const uiModeControls = document.getElementById('uiModeControls');
  const apiModeControls = document.getElementById('apiModeControls');

  // ---------------------------------------------------------------------
  // API Automation mode — Postman-styled request builder. Switching modes
  // never touches Playwright/codegen state; it only shows/hides which half
  // of the Control Panel is visible (see applyAutomationMode() below) and
  // changes what "Start AI Processing"/"Generate Gherkin Feature File"
  // bundle into their request (see collectApiRequestDetails() and the
  // click handlers further down).
  // ---------------------------------------------------------------------

  function applyAutomationMode(mode) {
    const isApi = mode === 'api';
    uiModeControls.hidden = isApi;
    apiModeControls.hidden = !isApi;
    // "Playwright Code" is never used in API Automation -- nothing records
    // it there (no browser is ever launched). "Start AI Processing"/"Open
    // AI Generated Code" stay put; they read from the API request builder
    // instead in this mode (see collectApiRequestDetails()).
    playwrightCodePanel.hidden = isApi;
  }

  /** Builds one Params/Headers/form-data/urlencoded key-value-description
   * table: renders from `rows`, and keeps exactly one trailing blank row
   * available to type into (Postman's own "add a row by typing in the last
   * one" pattern) — a filled-in last row spawns a fresh blank one below it;
   * an emptied non-last row is removed. Returns {getRows} to read back
   * only the genuinely filled-in rows (blank trailing row excluded).
   */
  function createKvTable(tableEl) {
    const tbody = tableEl.querySelector('tbody');
    let rows = [{ key: '', value: '', description: '' }];

    function isBlank(row) {
      return !row.key && !row.value && !row.description;
    }

    function render() {
      tbody.innerHTML = '';
      rows.forEach((row, index) => {
        const tr = document.createElement('tr');

        const keyTd = document.createElement('td');
        const keyInput = document.createElement('input');
        keyInput.type = 'text';
        keyInput.placeholder = 'Key';
        keyInput.value = row.key;
        keyInput.addEventListener('input', () => onEdit(index, 'key', keyInput.value));
        keyTd.appendChild(keyInput);

        const valueTd = document.createElement('td');
        const valueInput = document.createElement('input');
        valueInput.type = 'text';
        valueInput.placeholder = 'Value';
        valueInput.value = row.value;
        valueInput.addEventListener('input', () => onEdit(index, 'value', valueInput.value));
        valueTd.appendChild(valueInput);

        const descTd = document.createElement('td');
        const descInput = document.createElement('input');
        descInput.type = 'text';
        descInput.placeholder = 'Description';
        descInput.value = row.description;
        descInput.addEventListener('input', () => onEdit(index, 'description', descInput.value));
        descTd.appendChild(descInput);

        const removeTd = document.createElement('td');
        if (index < rows.length - 1) {
          const removeBtn = document.createElement('button');
          removeBtn.type = 'button';
          removeBtn.className = 'api-row-remove';
          removeBtn.textContent = '✕';
          removeBtn.title = 'Remove this row';
          removeBtn.addEventListener('click', () => {
            rows.splice(index, 1);
            render();
          });
          removeTd.appendChild(removeBtn);
        }

        tr.appendChild(keyTd);
        tr.appendChild(valueTd);
        tr.appendChild(descTd);
        tr.appendChild(removeTd);
        tbody.appendChild(tr);
      });
    }

    function onEdit(index, field, value) {
      rows[index] = { ...rows[index], [field]: value };
      const isLastRow = index === rows.length - 1;
      if (isLastRow && !isBlank(rows[index])) {
        rows.push({ key: '', value: '', description: '' });
        render();
        return;
      }
      // A non-last row emptied out entirely -- drop it rather than leave a
      // dead blank row in the middle of the table.
      if (!isLastRow && isBlank(rows[index])) {
        rows.splice(index, 1);
        render();
        return;
      }
      // In-place edit -- re-render is unnecessary (would steal focus), the
      // input's own value already reflects what the user typed.
    }

    render();

    return {
      getRows() {
        return rows.filter((r) => !isBlank(r));
      }
    };
  }

  /** form-data's own table — a Key/Value/Description/remove table like
   * createKvTable() above, EXCEPT each row's Value cell also carries a
   * Text/File dropdown (matching Postman): "Text" is the same plain input
   * createKvTable() already has; "File" swaps it for a "Select File"
   * button that hands off to the extension host's native OS file dialog
   * (see the 'browseApiFormFile'/'apiFormFileSelected' round trip below —
   * a webview `<input type="file">` cannot reveal the real absolute path
   * the generated multipart-upload code needs, only the OS dialog can). A
   * separate function from createKvTable() on purpose: the other three
   * tables (Params/Headers/x-www-form-urlencoded) never need this and stay
   * completely unaffected. */
  function createFormDataTable(tableEl) {
    const tbody = tableEl.querySelector('tbody');
    let nextRowId = 1;
    let rows = [{ id: nextRowId++, key: '', value: '', valueType: 'text', description: '' }];

    function isBlank(row) {
      return !row.key && !row.value && !row.description;
    }

    function indexOfRowId(rowId) {
      return rows.findIndex((r) => r.id === rowId);
    }

    function render() {
      tbody.innerHTML = '';
      rows.forEach((row, index) => {
        const tr = document.createElement('tr');

        const keyTd = document.createElement('td');
        const keyInput = document.createElement('input');
        keyInput.type = 'text';
        keyInput.placeholder = 'Key';
        keyInput.value = row.key;
        keyInput.addEventListener('input', () => onEdit(index, { key: keyInput.value }));
        keyTd.appendChild(keyInput);

        const valueTd = document.createElement('td');
        valueTd.className = 'api-formdata-value-cell';
        if (row.valueType === 'file') {
          const browseBtn = document.createElement('button');
          browseBtn.type = 'button';
          browseBtn.className = 'api-browse-btn';
          browseBtn.textContent = row.value ? fileBaseName(row.value) : 'Select File';
          browseBtn.title = row.value || 'Select a file to upload';
          browseBtn.addEventListener('click', () => {
            vscode.postMessage({ type: 'browseApiFormFile', payload: { rowId: row.id } });
          });
          valueTd.appendChild(browseBtn);
        } else {
          const valueInput = document.createElement('input');
          valueInput.type = 'text';
          valueInput.placeholder = 'Value';
          valueInput.value = row.value;
          valueInput.addEventListener('input', () => onEdit(index, { value: valueInput.value }));
          valueTd.appendChild(valueInput);
        }
        const typeSelect = document.createElement('select');
        typeSelect.className = 'api-formdata-type-select';
        [
          ['text', 'Text'],
          ['file', 'File']
        ].forEach(([value, label]) => {
          const opt = document.createElement('option');
          opt.value = value;
          opt.textContent = label;
          if (row.valueType === value) opt.selected = true;
          typeSelect.appendChild(opt);
        });
        typeSelect.addEventListener('change', () => {
          // Switching type discards whatever the old value held -- a file
          // path is meaningless as text and vice versa.
          onEdit(index, { valueType: typeSelect.value, value: '' });
        });
        valueTd.appendChild(typeSelect);

        const descTd = document.createElement('td');
        const descInput = document.createElement('input');
        descInput.type = 'text';
        descInput.placeholder = 'Description';
        descInput.value = row.description;
        descInput.addEventListener('input', () => onEdit(index, { description: descInput.value }));
        descTd.appendChild(descInput);

        const removeTd = document.createElement('td');
        if (index < rows.length - 1) {
          const removeBtn = document.createElement('button');
          removeBtn.type = 'button';
          removeBtn.className = 'api-row-remove';
          removeBtn.textContent = '✕';
          removeBtn.title = 'Remove this row';
          removeBtn.addEventListener('click', () => {
            rows.splice(index, 1);
            render();
          });
          removeTd.appendChild(removeBtn);
        }

        tr.appendChild(keyTd);
        tr.appendChild(valueTd);
        tr.appendChild(descTd);
        tr.appendChild(removeTd);
        tbody.appendChild(tr);
      });
    }

    function onEdit(index, patch) {
      rows[index] = { ...rows[index], ...patch };
      const isLastRow = index === rows.length - 1;
      if (isLastRow && !isBlank(rows[index])) {
        rows.push({ id: nextRowId++, key: '', value: '', valueType: 'text', description: '' });
        render();
        return;
      }
      if (!isLastRow && isBlank(rows[index])) {
        rows.splice(index, 1);
        render();
        return;
      }
      // A file selection always needs the button's label refreshed; a
      // plain text edit doesn't need a re-render (would steal focus).
      if (patch.value !== undefined && rows[index].valueType === 'file') {
        render();
      }
    }

    render();

    return {
      getRows() {
        return rows.filter((r) => !isBlank(r)).map(({ id, ...row }) => row);
      },
      /** Applies a file path the user just picked via the native OS dialog
       * back onto whichever row asked for it (see the
       * 'browseApiFormFile'/'apiFormFileSelected' round trip). A no-op if
       * that row was removed while the dialog was open. */
      applyFileSelection(rowId, filePath) {
        const index = indexOfRowId(rowId);
        if (index === -1) {
          return;
        }
        onEdit(index, { value: filePath });
      }
    };
  }

  function fileBaseName(filePath) {
    const parts = filePath.split(/[\\/]/);
    return parts[parts.length - 1] || filePath;
  }

  const apiParamsTable = createKvTable(document.getElementById('apiParamsTable'));
  const apiHeadersTable = createKvTable(document.getElementById('apiHeadersTable'));
  const apiFormDataTable = createFormDataTable(document.getElementById('apiFormDataTable'));
  const apiUrlencodedTable = createKvTable(document.getElementById('apiUrlencodedTable'));

  // Tab strip (Params/Authorization/Headers/Body) -- one panel visible at a time.
  document.querySelectorAll('.api-tab').forEach((tabBtn) => {
    tabBtn.addEventListener('click', () => {
      document.querySelectorAll('.api-tab').forEach((b) => b.classList.remove('active'));
      tabBtn.classList.add('active');
      const target = tabBtn.getAttribute('data-tab');
      document.querySelectorAll('.api-tab-panel').forEach((panel) => {
        panel.hidden = panel.getAttribute('data-panel') !== target;
      });
    });
  });

  // Authorization type -> show only the matching fields.
  const apiAuthType = document.getElementById('apiAuthType');
  apiAuthType.addEventListener('change', () => {
    document.querySelectorAll('.api-auth-fields').forEach((el) => {
      el.hidden = el.getAttribute('data-auth') !== apiAuthType.value;
    });
  });

  // Body mode (none/form-data/x-www-form-urlencoded/raw) -> show only the matching panel.
  document.querySelectorAll('input[name="apiBodyMode"]').forEach((radio) => {
    radio.addEventListener('change', () => {
      if (!radio.checked) return;
      document.querySelectorAll('.api-body-panel').forEach((el) => {
        el.hidden = el.getAttribute('data-body') !== radio.value;
      });
    });
  });

  // ---------------------------------------------------------------------
  // Raw request body — a real code-editor experience (line-numbered
  // gutter, syntax color coding, directly editable) via the same
  // createCodeEditor() factory the Playwright Code/AI Generated Code
  // editors already use, rather than a plain <textarea>. JSON/XML also
  // get auto-formatted (pretty-printed) on language switch and via the
  // Beautify button — never silently on every keystroke, which would
  // fight the user's cursor while they're still typing.
  // ---------------------------------------------------------------------

  const apiRawLanguageSelect = document.getElementById('apiRawLanguage');
  const apiRawBeautifyBtn = document.getElementById('apiRawBeautifyBtn');
  const apiRawBodyEditor = window.createCodeEditor(
    document.getElementById('apiRawBody'),
    document.getElementById('apiRawHighlight'),
    document.getElementById('apiRawGutter')
  );
  // Re-highlights live as the user types -- createCodeEditor() only wires
  // that up when a caller actually asks for it via onEdit().
  apiRawBodyEditor.onEdit(() => {});

  function rawBodyEditorLanguage() {
    const value = apiRawLanguageSelect.value;
    return value === 'JSON' ? 'json' : value === 'XML' ? 'xml' : 'text';
  }

  /** Pretty-prints the raw body in place for whichever language is
   * currently selected. Silently leaves the content untouched if it isn't
   * valid JSON/XML (a mid-edit or deliberately non-JSON JSON body is not
   * an error condition worth interrupting the user over) or the language
   * is plain Text (nothing to format). */
  function beautifyRawBody() {
    const lang = rawBodyEditorLanguage();
    const current = apiRawBodyEditor.getValue();
    const formatted = lang === 'json' ? beautifyJson(current) : lang === 'xml' ? beautifyXml(current) : null;
    if (formatted !== null && formatted !== current) {
      apiRawBodyEditor.setValue(formatted);
    }
  }

  function beautifyJson(text) {
    if (!text.trim()) return null;
    try {
      return JSON.stringify(JSON.parse(text), null, 2);
    } catch (e) {
      return null;
    }
  }

  /** Best-effort XML pretty-printer: not a real parser (no attribute/entity
   * validation) -- just enough to turn well-formed-but-unindented XML into
   * something readable, the same modest bar Postman's own Beautify holds
   * itself to. Left alone (returns the original text) on anything that
   * doesn't look like it has real tags to indent. */
  function beautifyXml(text) {
    const trimmed = text.trim();
    if (!trimmed || trimmed.indexOf('<') === -1) return null;

    function classify(line) {
      if (/^<\?/.test(line) || /^<!--[\s\S]*-->$/.test(line) || /\/>$/.test(line)) {
        return 'leaf';
      }
      if (/^<([A-Za-z_][-\w:.]*)[^>]*>.*<\/\1>$/.test(line)) {
        return 'leaf'; // e.g. <name>John</name> on one line -- doesn't nest further
      }
      if (/^<\//.test(line)) return 'close';
      if (/^</.test(line)) return 'open';
      return 'leaf'; // plain text content
    }

    const lines = trimmed
      .replace(/>\s*</g, '>\n<')
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean);

    let indent = 0;
    const out = [];
    for (const line of lines) {
      const kind = classify(line);
      if (kind === 'close') indent = Math.max(indent - 1, 0);
      out.push('  '.repeat(indent) + line);
      if (kind === 'open') indent++;
    }
    return out.join('\n');
  }

  apiRawLanguageSelect.addEventListener('change', () => {
    apiRawBodyEditor.setLanguage(rawBodyEditorLanguage());
    beautifyRawBody();
  });
  apiRawBeautifyBtn.addEventListener('click', beautifyRawBody);
  apiRawBodyEditor.setLanguage(rawBodyEditorLanguage());

  /** Everything currently in the API request builder, as one structured
   * object -- sent verbatim (minus redaction of secret VALUES, applied
   * server-side, never here) as the "API Request Details" context for
   * "Start AI Processing" and "Generate Gherkin Feature File" in API mode.
   * Harmless to compute in UI mode too (the extension host only reads it
   * when settings.automationMode === 'api'). */
  function collectApiRequestDetails() {
    const checkedBodyMode = document.querySelector('input[name="apiBodyMode"]:checked');
    return {
      method: document.getElementById('apiMethod').value,
      url: document.getElementById('apiUrl').value.trim(),
      params: apiParamsTable.getRows(),
      headers: apiHeadersTable.getRows(),
      authType: apiAuthType.value,
      auth: {
        apiKeyName: document.getElementById('apiAuthApiKeyName').value,
        apiKeyValue: document.getElementById('apiAuthApiKeyValue').value,
        apiKeyAddTo: document.getElementById('apiAuthApiKeyAddTo').value,
        bearerToken: document.getElementById('apiAuthBearerToken').value,
        basicUsername: document.getElementById('apiAuthBasicUser').value,
        basicPassword: document.getElementById('apiAuthBasicPass').value
      },
      bodyMode: checkedBodyMode ? checkedBodyMode.value : 'none',
      bodyFormFields: apiFormDataTable.getRows(),
      bodyUrlencodedFields: apiUrlencodedTable.getRows(),
      bodyRawLanguage: apiRawLanguageSelect.value,
      bodyRaw: apiRawBodyEditor.getValue()
    };
  }

  let killConfirmPending = false;
  let killConfirmTimer = null;

  startBtn.addEventListener('click', () => {
    // The URL is only usable at spawn time (Playwright's own `codegen` CLI
    // takes it as a positional argument) -- there's no way to change it
    // once its browser window is already open from outside that window.
    vscode.postMessage({ type: 'start', payload: urlInput.value.trim() });
  });

  stopBtn.addEventListener('click', () => {
    vscode.postMessage({ type: 'stop' });
  });

  settingsBtn.addEventListener('click', () => {
    vscode.postMessage({ type: 'openSettings' });
  });

  saveCodeBtn.addEventListener('click', () => {
    vscode.postMessage({ type: 'saveCode', payload: playwrightEditor.getValue() });
  });

  openAiCodeBtn.addEventListener('click', () => {
    vscode.postMessage({ type: 'openAiCodePanel' });
  });

  function flashCopyBtn(btn, label) {
    const original = btn.textContent;
    btn.textContent = label;
    btn.disabled = true;
    setTimeout(() => {
      btn.textContent = original;
      btn.disabled = false;
    }, 1200);
  }

  async function copyToClipboard(text, btn) {
    try {
      await navigator.clipboard.writeText(text);
      flashCopyBtn(btn, 'Copied!');
    } catch (err) {
      // Fallback for environments where the async Clipboard API is blocked
      // (e.g. focus/permission restrictions inside a webview).
      try {
        const textarea = document.createElement('textarea');
        textarea.value = text;
        textarea.style.position = 'fixed';
        textarea.style.opacity = '0';
        document.body.appendChild(textarea);
        textarea.focus();
        textarea.select();
        document.execCommand('copy');
        document.body.removeChild(textarea);
        flashCopyBtn(btn, 'Copied!');
      } catch (fallbackErr) {
        flashCopyBtn(btn, 'Copy failed');
      }
    }
  }

  copyCodeBtn.addEventListener('click', () => {
    copyToClipboard(playwrightEditor.getValue(), copyCodeBtn);
  });

  // Collapse the Playwright Code panel down to just its header -- useful
  // once the AI Generated Code panel is open beside this sidebar and this
  // half of the picture isn't needed for a moment.
  collapseCodeBtn.addEventListener('click', () => {
    const collapsed = playwrightCodePanel.classList.toggle('collapsed');
    collapseCodeBtn.textContent = collapsed ? '▸' : '▾';
    collapseCodeBtn.title = collapsed ? 'Expand this panel' : 'Collapse this panel';
  });

  refreshPromptFilesBtn.addEventListener('click', () => {
    vscode.postMessage({ type: 'refreshPromptFiles' });
  });

  function selectedPromptFiles() {
    return Array.from(promptFilesList.querySelectorAll('input[type="checkbox"]:checked')).map((cb) => cb.value);
  }

  // AI processing never starts on its own — checking a .md file below,
  // typing in the chat composer, or a fresh Playwright recording all only
  // ever stage context. Nothing reaches the LLM until "Start AI Processing"
  // is explicitly clicked (see below), which bundles: the current
  // Playwright Code, whichever .md files are checked (selectedPromptFiles()
  // below, read fresh at click time), the linked scenario/selected steps
  // and current Settings (both read on the extension-host side), and
  // everything staged in the chat composer.
  let stagedInstructions = [];

  // Messenger-style composer: Enter/the ➤ button stages the message as a
  // bubble (does NOT send anything to the LLM), Shift+Enter inserts a
  // newline, and the textarea grows with content up to a few lines (see
  // main.css).
  function stageChatMessage() {
    const text = chatInput.value.trim();
    if (!text) {
      return;
    }
    appendChatBubble(text);
    stagedInstructions.push(text);
    chatInput.value = '';
    autoResizeChatInput();
  }

  function appendChatBubble(text) {
    const bubble = document.createElement('div');
    bubble.className = 'chat-bubble chat-bubble-sent';
    bubble.textContent = text;
    chatMessages.appendChild(bubble);
    chatMessages.scrollTop = chatMessages.scrollHeight;
  }

  function autoResizeChatInput() {
    chatInput.style.height = 'auto';
    chatInput.style.height = Math.min(chatInput.scrollHeight, 90) + 'px';
  }

  chatSendBtn.addEventListener('click', stageChatMessage);

  chatInput.addEventListener('input', autoResizeChatInput);

  chatInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      stageChatMessage();
    }
  });

  // Bundles every staged chat bubble plus whatever's still sitting unsent
  // in the input box (so the user doesn't have to remember to hit ➤ first)
  // into one customInstructions string, then clears the stage so the next
  // run starts fresh. Shared by both "Start AI Processing" and "Generate
  // Gherkin Feature File" — the two only differ in which message type they
  // post and which extension-host method picks it up from there.
  function collectAndClearStagedInstructions() {
    const unsent = chatInput.value.trim();
    const allInstructions = unsent ? [...stagedInstructions, unsent] : stagedInstructions;
    const customInstructions = allInstructions.join('\n\n');

    stagedInstructions = [];
    chatMessages.innerHTML = '';
    chatInput.value = '';
    autoResizeChatInput();

    return customInstructions;
  }

  // "Start AI Processing" — the ONLY trigger for AI code generation.
  // Bundles staged chat instructions, the current Playwright Code, and
  // checked .md files; the extension host adds Settings and the linked
  // scenario/selected steps on its own. `apiDetails` is always included —
  // harmless in UI mode, where the extension host simply ignores it (see
  // sendToLlm()/runLlmRefinement() there, gated on settings.automationMode).
  startAiProcessingBtn.addEventListener('click', () => {
    const customInstructions = collectAndClearStagedInstructions();
    vscode.postMessage({
      type: 'sendToLlm',
      payload: {
        selectedFiles: selectedPromptFiles(),
        code: playwrightEditor.getValue(),
        customInstructions,
        apiDetails: collectApiRequestDetails()
      }
    });
  });

  // "Generate Gherkin Feature File" — for when no .feature file has been
  // linked yet: turns whatever Playwright Codegen recorded (UI mode) or the
  // API request just described above (API mode) — plus staged chat
  // instructions — into a brand-new BDD feature file instead of refined
  // automation code. See generateFeatureFile() on the extension host.
  generateFeatureFileBtn.addEventListener('click', () => {
    const customInstructions = collectAndClearStagedInstructions();
    vscode.postMessage({
      type: 'generateFeatureFile',
      payload: { code: playwrightEditor.getValue(), customInstructions, apiDetails: collectApiRequestDetails() }
    });
  });

  // Kill All Browsers needs a confirmation, but VS Code webviews don't
  // reliably support window.confirm()/alert() -- a two-click "arm, then
  // confirm" pattern on the button itself avoids depending on that.
  killAllBtn.addEventListener('click', () => {
    if (!killConfirmPending) {
      armKillConfirm();
      return;
    }
    disarmKillConfirm();
    vscode.postMessage({ type: 'killAllBrowsers' });
  });

  function armKillConfirm() {
    killConfirmPending = true;
    killAllBtn.textContent = 'Click again to confirm';
    killAllBtn.classList.add('btn-danger-confirm');
    clearTimeout(killConfirmTimer);
    killConfirmTimer = setTimeout(disarmKillConfirm, 3000);
  }

  function disarmKillConfirm() {
    killConfirmPending = false;
    killAllBtn.textContent = 'Kill All Browsers';
    killAllBtn.classList.remove('btn-danger-confirm');
    clearTimeout(killConfirmTimer);
  }

  linkFeatureBtn.addEventListener('click', () => {
    vscode.postMessage({ type: 'linkFeatureFile' });
  });

  // "Link with GitHub Copilot LLM" — moved here from the Settings menu; the
  // Settings panel still owns the model picker, kept in sync via the shared
  // SettingsStore regardless of which webview flips this switch.
  copilotEnabledToggle.addEventListener('change', () => {
    vscode.postMessage({ type: 'setCopilotEnabled', payload: copilotEnabledToggle.checked });
  });

  unlinkScenarioBtn.addEventListener('click', (e) => {
    e.stopPropagation(); // don't also trigger the badge's own reopen click below
    vscode.postMessage({ type: 'unlinkFeatureFile' });
  });

  linkedScenarioText.addEventListener('click', () => {
    vscode.postMessage({ type: 'reopenFeatureFile' });
  });
  linkedScenarioText.style.cursor = 'pointer';
  linkedScenarioText.title = linkedScenarioText.title || 'Click to reopen this feature file and pick a different scenario';

  function applyLinkedScenario(scenario) {
    if (!scenario) {
      linkedScenarioBadge.hidden = true;
      linkedScenarioText.textContent = '';
      return;
    }
    linkedScenarioBadge.hidden = false;
    // Only worth calling out when it's actually a subset — a full
    // selection is the common case and needs no extra noise in the badge.
    var stepSuffix =
      typeof scenario.selectedStepCount === 'number' &&
      typeof scenario.totalStepCount === 'number' &&
      scenario.selectedStepCount < scenario.totalStepCount
        ? ' (' + scenario.selectedStepCount + '/' + scenario.totalStepCount + ' steps)'
        : '';
    linkedScenarioText.textContent =
      scenario.featureName + ' › ' + scenario.scenarioKind + ': ' + scenario.scenarioName + stepSuffix;
    linkedScenarioText.title = linkedScenarioText.textContent + ' — click to pick a different scenario from this file';
  }

  // A feature file becomes "available" the moment it's successfully
  // parsed — independent of whether a scenario has been picked from it yet
  // — and stays available (this button just reopens it, no OS dialog) for
  // the rest of the session, until a different file is linked or VS Code
  // closes. Relabeling makes that persistence discoverable instead of
  // surprising.
  function applyFeatureFileAvailable(available) {
    linkFeatureBtn.textContent = available ? 'View Feature File' : 'Link Feature File';
    linkFeatureBtn.title = available
      ? 'Reopen the linked feature file to pick a different Scenario/Scenario Outline'
      : 'Browse and select a Cucumber .feature file and pick a Scenario/Scenario Outline to link to the generated code';
  }

  // See media/codeEditor.js for the shared editor factory (line-number
  // gutter, Tab-indent, syntax highlighting) used here and by the
  // standalone AI Generated Code panel.
  const playwrightEditor = window.createCodeEditor(codeEditArea, codeHighlightPre, codeGutter);

  // Once the user hand-edits the code, a newly recorded action must not
  // silently clobber their edits -- offer a refresh instead.
  let userEditedCode = false;
  let pendingFreshCode = null;

  playwrightEditor.onEdit(() => {
    userEditedCode = true;
  });

  codeRefreshBtn.addEventListener('click', () => {
    if (pendingFreshCode) {
      applyFreshCode(pendingFreshCode);
      pendingFreshCode = null;
    }
    codeRefreshBanner.hidden = true;
  });

  function applyFreshCode(payload) {
    userEditedCode = false;
    playwrightEditor.setLanguage(payload.language);
    playwrightEditor.setValue(payload.code);
  }

  window.addEventListener('message', (event) => {
    const message = event.data;
    switch (message.type) {
      case 'status':
        applyStatus(message.payload);
        break;
      case 'code':
        applyCode(message.payload);
        break;
      case 'clearAll':
        clearAll();
        break;
      case 'copilotEnabledState':
        applyCopilotEnabledState(message.payload);
        break;
      case 'linkedScenario':
        applyLinkedScenario(message.payload);
        break;
      case 'featureFileAvailable':
        applyFeatureFileAvailable(message.payload);
        break;
      case 'promptFiles':
        renderPromptFiles(message.payload);
        break;
      case 'aiStatus':
        applyAiStatus(message.payload);
        break;
      case 'requestCurrentCode':
        // "Regenerate AI Code" (AI Generated Code panel) asking for the
        // Playwright Code editor's live content, manual edits included.
        vscode.postMessage({ type: 'currentCodeReport', payload: playwrightEditor.getValue() });
        break;
      case 'codeCorrectness':
        codeCorrectnessBanner.hidden = !message.payload;
        break;
      case 'apiFormFileSelected':
        apiFormDataTable.applyFileSelection(message.payload.rowId, message.payload.filePath);
        break;
    }
  });

  function applyCopilotEnabledState(enabled) {
    // Setting .checked programmatically does not fire 'change', so this
    // never loops back into the listener above — safe to always sync it
    // here, whether this update originated from this toggle, the Settings
    // panel, or extension activation.
    copilotEnabledToggle.checked = enabled;
    // aiAssistSection nests chatComposer, so hiding it here already hides
    // the composer too -- no need to separately toggle chatComposer.hidden.
    aiAssistSection.hidden = !enabled;
    if (enabled) {
      vscode.postMessage({ type: 'refreshPromptFiles' });
    } else {
      chatMessages.innerHTML = '';
      chatInput.value = '';
      stagedInstructions = [];
    }
  }

  function applyAiStatus(status) {
    aiGeneratingBanner.hidden = status.state !== 'generating';
    if (status.state === 'generating') {
      aiStatusLabel.textContent = '';
      aiStatusLabel.className = 'llm-status';
      aiStatusLabel.title = '';
    } else if (status.state === 'error') {
      aiStatusLabel.textContent = 'Error';
      aiStatusLabel.className = 'llm-status llm-status-error';
      aiStatusLabel.title = status.message || '';
    } else {
      aiStatusLabel.textContent = '';
      aiStatusLabel.className = 'llm-status';
      aiStatusLabel.title = '';
    }
  }

  // Tells the extension host which .md files are currently checked, so the
  // automatic AI refinement pipeline (fires on every new codegen output
  // update, no button needed) always uses the up-to-date selection. Also
  // fired once right after a re-render, since rebuilding the checkbox DOM
  // always starts unchecked -- keeps the host's tracked selection from
  // silently going stale relative to what's actually visible.
  function postSelectedInstructionFiles() {
    vscode.postMessage({ type: 'selectedInstructionFiles', payload: selectedPromptFiles() });
  }

  function renderPromptFiles(files) {
    if (!files.length) {
      promptFilesList.innerHTML = '<div class="prompt-files-empty">No .md files found under .github/.</div>';
      postSelectedInstructionFiles();
      return;
    }
    promptFilesList.innerHTML = '';
    for (const file of files) {
      const label = document.createElement('label');
      label.className = 'prompt-file-item';
      const checkbox = document.createElement('input');
      checkbox.type = 'checkbox';
      checkbox.value = file;
      checkbox.addEventListener('change', postSelectedInstructionFiles);
      label.appendChild(checkbox);
      const text = document.createElement('span');
      text.textContent = file;
      label.appendChild(text);
      promptFilesList.appendChild(label);
    }
    postSelectedInstructionFiles();
  }

  function applyCode(payload) {
    applyAutomationMode(payload.automationMode);
    codeLanguageLabel.textContent =
      '(' + payload.language[0].toUpperCase() + payload.language.slice(1) + ' ' + payload.languageVersion + ')';

    if (payload.isNewRecording) {
      flashNewCodeLabel();
    }

    if (userEditedCode) {
      // Don't silently clobber manual edits -- offer a refresh instead.
      pendingFreshCode = payload;
      codeRefreshBanner.hidden = false;
      return;
    }
    applyFreshCode(payload);
  }

  let newCodeFlashTimer = null;
  function flashNewCodeLabel() {
    newCodeFlash.hidden = false;
    clearTimeout(newCodeFlashTimer);
    newCodeFlashTimer = setTimeout(() => {
      newCodeFlash.hidden = true;
    }, 2500);
  }

  function clearAll() {
    userEditedCode = false;
    pendingFreshCode = null;
    codeRefreshBanner.hidden = true;
    playwrightEditor.setValue('// Click Start and interact with the codegen browser window.');
    clearTimeout(newCodeFlashTimer);
    newCodeFlash.hidden = true;
  }

  function applyStatus(status) {
    statusPill.className = 'status-pill';
    statusPill.title = '';

    switch (status.state) {
      case 'idle':
        statusPill.classList.add('status-idle');
        statusPill.textContent = 'Idle';
        startBtn.disabled = false;
        stopBtn.disabled = true;
        break;
      case 'connecting':
        statusPill.classList.add('status-connecting');
        statusPill.textContent = status.detail || 'Connecting…';
        startBtn.disabled = true;
        stopBtn.disabled = false;
        break;
      case 'connected':
        statusPill.classList.add('status-connected');
        statusPill.textContent = 'Connected';
        startBtn.disabled = true;
        stopBtn.disabled = false;
        if (status.url) {
          urlInput.value = status.url;
        }
        break;
      case 'error':
        statusPill.classList.add('status-error');
        statusPill.textContent = 'Error';
        statusPill.title = status.message;
        startBtn.disabled = false;
        stopBtn.disabled = true;
        break;
    }
  }
})();
