(function () {
  const vscode = acquireVsCodeApi();

  const startBtn = document.getElementById('startBtn');
  const stopBtn = document.getElementById('stopBtn');
  const navigateBtn = document.getElementById('navigateBtn');
  const urlInput = document.getElementById('urlInput');
  const statusPill = document.getElementById('statusPill');
  const spyBtn = document.getElementById('spyBtn');
  const settingsBtn = document.getElementById('settingsBtn');
  const killAllBtn = document.getElementById('killAllBtn');
  const resultsBody = document.querySelector('#resultsTable tbody');
  const selectAllCheckbox = document.getElementById('selectAllCheckbox');
  const deleteSelectedBtn = document.getElementById('deleteSelectedBtn');
  const highlightOnPageBtn = document.getElementById('highlightOnPageBtn');
  const saveLocatorsJsonBtn = document.getElementById('saveLocatorsJsonBtn');
  const saveLocatorsPropsBtn = document.getElementById('saveLocatorsPropsBtn');
  const genCodeBtn = document.getElementById('genCodeBtn');
  const stopCodeBtn = document.getElementById('stopCodeBtn');
  const saveCodeBtn = document.getElementById('saveCodeBtn');
  const codeLanguageLabel = document.getElementById('codeLanguageLabel');
  const newCodeFlash = document.getElementById('newCodeFlash');
  const codeEditArea = document.getElementById('codeEditArea');
  const codeHighlightPre = document.getElementById('codeHighlight');
  const codeRefreshBanner = document.getElementById('codeRefreshBanner');
  const codeRefreshBtn = document.getElementById('codeRefreshBtn');
  const ambiguousBanner = document.getElementById('ambiguousBanner');
  const ambiguousDetail = document.getElementById('ambiguousDetail');
  const ambiguousLocatorInput = document.getElementById('ambiguousLocatorInput');
  const ambiguousResumeBtn = document.getElementById('ambiguousResumeBtn');
  const ambiguousSkipBtn = document.getElementById('ambiguousSkipBtn');
  const aiAssistSection = document.getElementById('aiAssistSection');
  const promptFilesList = document.getElementById('promptFilesList');
  const noPromptWarning = document.getElementById('noPromptWarning');
  const sendAnywayBtn = document.getElementById('sendAnywayBtn');
  const chatComposer = document.getElementById('chatComposer');
  const chatMessages = document.getElementById('chatMessages');
  const chatInput = document.getElementById('chatInput');
  const chatSendBtn = document.getElementById('chatSendBtn');
  const refreshPromptFilesBtn = document.getElementById('refreshPromptFilesBtn');
  const sendToLlmBtn = document.getElementById('sendToLlmBtn');
  const llmCodePanel = document.getElementById('llmCodePanel');
  const llmStatusLabel = document.getElementById('llmStatusLabel');
  const saveLlmCodeBtn = document.getElementById('saveLlmCodeBtn');
  const llmCodeEditArea = document.getElementById('llmCodeEditArea');
  const llmCodeHighlightPre = document.getElementById('llmCodeHighlight');
  const emptyRowHtml = '<td colspan="5">No elements captured yet. Turn on Object Spy and click an element in the real Chrome window.</td>';
  const LLM_PLACEHOLDER =
    '// Enable "Link with GitHub Copilot LLM" in Settings, pick any instruction files above, then click "Send to Copilot".';

  let connected = false;
  let generating = false;
  let killConfirmPending = false;
  let killConfirmTimer = null;

  startBtn.addEventListener('click', () => {
    vscode.postMessage({ type: 'start' });
  });

  stopBtn.addEventListener('click', () => {
    vscode.postMessage({ type: 'stop' });
  });

  navigateBtn.addEventListener('click', () => {
    const url = urlInput.value.trim();
    if (url) {
      vscode.postMessage({ type: 'navigate', payload: url });
    }
  });

  urlInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      navigateBtn.click();
    }
  });

  spyBtn.addEventListener('click', () => {
    vscode.postMessage({ type: 'toggleSpy' });
  });

  settingsBtn.addEventListener('click', () => {
    vscode.postMessage({ type: 'openSettings' });
  });

  genCodeBtn.addEventListener('click', () => {
    vscode.postMessage({ type: 'startGenerateCode' });
  });

  stopCodeBtn.addEventListener('click', () => {
    vscode.postMessage({ type: 'stopGenerateCode' });
  });

  ambiguousResumeBtn.addEventListener('click', () => {
    vscode.postMessage({ type: 'resolveAmbiguous', payload: { locator: ambiguousLocatorInput.value } });
  });

  ambiguousSkipBtn.addEventListener('click', () => {
    vscode.postMessage({ type: 'resolveAmbiguous', payload: null });
  });

  selectAllCheckbox.addEventListener('change', () => {
    resultsBody.querySelectorAll('.row-check').forEach((cb) => {
      cb.checked = selectAllCheckbox.checked;
    });
    updateRowSelectionButtons();
  });

  deleteSelectedBtn.addEventListener('click', () => {
    const keys = Array.from(resultsBody.querySelectorAll('.row-check:checked')).map((cb) => cb.closest('tr').dataset.key);
    if (keys.length) {
      vscode.postMessage({ type: 'deleteElements', payload: keys });
    }
  });

  highlightOnPageBtn.addEventListener('click', () => {
    const checked = resultsBody.querySelectorAll('.row-check:checked');
    if (checked.length === 1) {
      vscode.postMessage({ type: 'highlightElement', payload: checked[0].closest('tr').dataset.key });
    }
  });

  saveLocatorsJsonBtn.addEventListener('click', () => {
    vscode.postMessage({ type: 'saveLocators', payload: { format: 'json' } });
  });

  saveLocatorsPropsBtn.addEventListener('click', () => {
    vscode.postMessage({ type: 'saveLocators', payload: { format: 'properties' } });
  });

  saveCodeBtn.addEventListener('click', () => {
    vscode.postMessage({ type: 'saveCode', payload: playwrightEditor.getValue() });
  });

  saveLlmCodeBtn.addEventListener('click', () => {
    vscode.postMessage({ type: 'saveLlmCode', payload: llmEditor.getValue() });
  });

  refreshPromptFilesBtn.addEventListener('click', () => {
    vscode.postMessage({ type: 'refreshPromptFiles' });
  });

  function selectedPromptFiles() {
    return Array.from(promptFilesList.querySelectorAll('input[type="checkbox"]:checked')).map((cb) => cb.value);
  }

  function dispatchToLlm(customInstructions) {
    vscode.postMessage({
      type: 'sendToLlm',
      payload: { selectedFiles: selectedPromptFiles(), code: playwrightEditor.getValue(), customInstructions }
    });
  }

  // Item #2: sending to the LLM with nothing telling it what to follow
  // (no .md file, no free-text instructions) is easy to do by accident and
  // wastes a round trip -- warn instead of silently sending nothing useful.
  sendToLlmBtn.addEventListener('click', () => {
    if (selectedPromptFiles().length === 0) {
      noPromptWarning.hidden = false;
      chatComposer.hidden = false;
      chatInput.focus();
      return;
    }
    dispatchToLlm('');
  });

  sendAnywayBtn.addEventListener('click', () => {
    noPromptWarning.hidden = true;
    dispatchToLlm('');
  });

  // Messenger-style composer: Enter sends, Shift+Enter inserts a newline,
  // and the textarea grows with content up to a few lines (see main.css).
  function sendChatMessage() {
    const text = chatInput.value.trim();
    if (!text) {
      return;
    }
    appendChatBubble(text);
    chatInput.value = '';
    autoResizeChatInput();
    noPromptWarning.hidden = true;
    dispatchToLlm(text);
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

  chatSendBtn.addEventListener('click', sendChatMessage);

  chatInput.addEventListener('input', autoResizeChatInput);

  chatInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      sendChatMessage();
    }
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

  // ---------------------------------------------------------------------
  // Code editor: a transparent, editable <textarea> stacked exactly over a
  // syntax-highlighted <pre>, kept in sync on every keystroke and scroll —
  // see main.css's .code-editor-wrap for the overlay technique. Shared
  // factory since both the Playwright codegen view and the AI (Copilot)
  // view need the identical, independently-scrollable behavior.
  function createCodeEditor(textarea, pre) {
    const codeEl = pre.querySelector('code');
    let language = 'java';

    function render() {
      codeEl.innerHTML = window.softPlayHighlight(textarea.value, language);
    }

    textarea.addEventListener('scroll', () => {
      pre.scrollTop = textarea.scrollTop;
      pre.scrollLeft = textarea.scrollLeft;
    });

    render(); // placeholder text present in the markup on first load

    return {
      setLanguage(lang) {
        language = lang;
      },
      setValue(text) {
        textarea.value = text;
        render();
      },
      appendValue(text) {
        textarea.value += text;
        render();
        textarea.scrollTop = textarea.scrollHeight;
      },
      getValue() {
        return textarea.value;
      },
      onEdit(handler) {
        textarea.addEventListener('input', () => {
          render();
          handler();
        });
      }
    };
  }

  const playwrightEditor = createCodeEditor(codeEditArea, codeHighlightPre);
  const llmEditor = createCodeEditor(llmCodeEditArea, llmCodeHighlightPre);

  // Once the user hand-edits the code, a newly recorded action must not
  // silently clobber their edits -- see item #1 (editable code) + #11.
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
    // AI-generated code is asked to match the same language -- keep its
    // highlighting in sync with whatever's currently selected in Settings.
    llmEditor.setLanguage(payload.language);
  }

  window.addEventListener('message', (event) => {
    const message = event.data;
    switch (message.type) {
      case 'status':
        applyStatus(message.payload);
        break;
      case 'spyState':
        applySpyState(message.payload);
        break;
      case 'capture':
        appendCapture(message.payload);
        break;
      case 'removeElements':
        removeElements(message.payload);
        break;
      case 'generatingState':
        applyGeneratingState(message.payload);
        break;
      case 'code':
        applyCode(message.payload);
        break;
      case 'ambiguousAction':
        showAmbiguous(message.payload, message.note);
        break;
      case 'ambiguousResolved':
        hideAmbiguous();
        break;
      case 'clearAll':
        clearAll();
        break;
      case 'copilotEnabledState':
        applyCopilotEnabledState(message.payload);
        break;
      case 'promptFiles':
        renderPromptFiles(message.payload);
        break;
      case 'llmStart':
        llmStart();
        break;
      case 'llmChunk':
        llmEditor.appendValue(message.payload);
        break;
      case 'llmDone':
        llmDone(message.payload);
        break;
      case 'llmError':
        llmError(message.payload);
        break;
    }
  });

  function applyCopilotEnabledState(enabled) {
    aiAssistSection.hidden = !enabled;
    llmCodePanel.hidden = !enabled;
    if (enabled) {
      vscode.postMessage({ type: 'refreshPromptFiles' });
    } else {
      noPromptWarning.hidden = true;
      chatComposer.hidden = true;
      chatMessages.innerHTML = '';
      chatInput.value = '';
    }
  }

  function renderPromptFiles(files) {
    if (!files.length) {
      promptFilesList.innerHTML = '<div class="prompt-files-empty">No .md files found under .github/.</div>';
      return;
    }
    promptFilesList.innerHTML = '';
    for (const file of files) {
      const label = document.createElement('label');
      label.className = 'prompt-file-item';
      const checkbox = document.createElement('input');
      checkbox.type = 'checkbox';
      checkbox.value = file;
      label.appendChild(checkbox);
      const text = document.createElement('span');
      text.textContent = file;
      label.appendChild(text);
      promptFilesList.appendChild(label);
    }
  }

  function llmStart() {
    sendToLlmBtn.disabled = true;
    llmStatusLabel.textContent = '(generating…)';
    llmStatusLabel.className = 'llm-status llm-status-active';
    llmEditor.setValue('');
  }

  function llmDone(finalCode) {
    sendToLlmBtn.disabled = false;
    llmStatusLabel.textContent = '';
    llmStatusLabel.className = 'llm-status';
    llmEditor.setValue(finalCode);
  }

  function llmError(message) {
    sendToLlmBtn.disabled = false;
    llmStatusLabel.textContent = 'Error';
    llmStatusLabel.className = 'llm-status llm-status-error';
    llmEditor.setValue('// ' + message);
  }

  function applySpyState(enabled) {
    spyBtn.textContent = enabled ? 'Object Spy: On' : 'Object Spy: Off';
    spyBtn.classList.toggle('btn-active', enabled);
    spyBtn.disabled = !connected;
  }

  function applyGeneratingState(enabled) {
    generating = enabled;
    genCodeBtn.disabled = !connected || enabled;
    stopCodeBtn.disabled = !enabled;
    genCodeBtn.classList.toggle('btn-active', enabled);
    genCodeBtn.textContent = enabled ? 'Generating…' : 'Generate Code';
  }

  function applyCode(payload) {
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

  function showAmbiguous(action, note) {
    ambiguousBanner.hidden = false;
    ambiguousDetail.textContent =
      (note ? note + ' ' : '') +
      action.actionType + ' on <' + action.tag + '> "' + (action.text || '') + '" matched ' + action.matches + ' elements.';
    ambiguousLocatorInput.value = action.locator;
    ambiguousLocatorInput.focus();
  }

  function hideAmbiguous() {
    ambiguousBanner.hidden = true;
    ambiguousLocatorInput.value = '';
  }

  function keyFor(info) {
    return info.locatorType + '::' + info.locator;
  }

  function appendCapture(info) {
    const key = keyFor(info);
    if (resultsBody.querySelector('tr[data-key="' + cssAttrEscape(key) + '"]')) {
      return; // already present -- host already dedupes, this is just a safety net
    }

    const emptyRow = resultsBody.querySelector('.empty-row');
    if (emptyRow) {
      emptyRow.remove();
    }

    const row = document.createElement('tr');
    row.dataset.key = key;

    const qualityTier = info.qualityLabel.split(' · ')[0];
    const qualityClass = qualityTier === 'Excellent'
      ? 'quality-excellent'
      : qualityTier === 'Good'
      ? 'quality-good'
      : qualityTier === 'Fair'
      ? 'quality-fair'
      : 'quality-weak';

    row.innerHTML =
      '<td class="col-check"><input type="checkbox" class="row-check" /></td>' +
      '<td class="element-name-cell"></td>' +
      '<td class="locator-cell"></td>' +
      '<td></td>' +
      '<td></td>';

    const nameCell = row.children[1];
    const nameText = document.createElement('span');
    nameText.textContent = info.elementName;
    nameCell.appendChild(nameText);
    if (info.inIframe) {
      nameCell.appendChild(makeBadge('iframe', 'badge-iframe', 'Found inside an <iframe>'));
    }
    if (info.inShadowDom) {
      nameCell.appendChild(makeBadge('shadow', 'badge-shadow', 'Found inside a shadow root'));
    }

    row.children[2].textContent = info.locator;
    row.children[2].title = info.locatorType.toUpperCase() + ': ' + info.locator;

    const qualityBadge = document.createElement('span');
    qualityBadge.className = 'quality-badge ' + qualityClass;
    qualityBadge.textContent = qualityTier;
    row.children[3].appendChild(qualityBadge);

    row.children[4].textContent =
      info.matches === 1 ? 'Unique' : info.matches > 1 ? 'Ambiguous (' + info.matches + ')' : 'Not found';
    if (info.matches !== 1) {
      row.children[4].classList.add('matches-ambiguous');
    }

    row.querySelector('.row-check').addEventListener('change', updateRowSelectionButtons);

    resultsBody.appendChild(row);
    row.scrollIntoView({ block: 'nearest' });
  }

  function makeBadge(text, cls, title) {
    const badge = document.createElement('span');
    badge.className = 'badge ' + cls;
    badge.textContent = text;
    badge.title = title;
    return badge;
  }

  function cssAttrEscape(value) {
    if (window.CSS && typeof window.CSS.escape === 'function') {
      return window.CSS.escape(value);
    }
    return value.replace(/(["\\])/g, '\\$1');
  }

  function removeElements(keys) {
    const keySet = new Set(keys);
    Array.from(resultsBody.querySelectorAll('tr[data-key]')).forEach((row) => {
      if (keySet.has(row.dataset.key)) {
        row.remove();
      }
    });
    if (!resultsBody.querySelector('tr[data-key]')) {
      resultsBody.innerHTML = '<tr class="empty-row">' + emptyRowHtml + '</tr>';
    }
    selectAllCheckbox.checked = false;
    updateRowSelectionButtons();
  }

  function updateRowSelectionButtons() {
    const checkedCount = resultsBody.querySelectorAll('.row-check:checked').length;
    deleteSelectedBtn.disabled = checkedCount === 0;
    highlightOnPageBtn.disabled = checkedCount !== 1;
  }

  function clearAll() {
    resultsBody.innerHTML = '<tr class="empty-row">' + emptyRowHtml + '</tr>';
    selectAllCheckbox.checked = false;
    updateRowSelectionButtons();
    userEditedCode = false;
    pendingFreshCode = null;
    codeRefreshBanner.hidden = true;
    playwrightEditor.setValue('// Click "Generate Code" and interact with the real Chrome window.');
    llmEditor.setValue(LLM_PLACEHOLDER);
    hideAmbiguous();
    clearTimeout(newCodeFlashTimer);
    newCodeFlash.hidden = true;
  }

  function applyStatus(status) {
    statusPill.className = 'status-pill';
    statusPill.title = '';
    connected = status.state === 'connected';
    spyBtn.disabled = !connected;
    genCodeBtn.disabled = !connected || generating;
    if (!connected) {
      stopCodeBtn.disabled = true;
      hideAmbiguous();
    }

    switch (status.state) {
      case 'idle':
        statusPill.classList.add('status-idle');
        statusPill.textContent = 'Idle';
        startBtn.disabled = false;
        stopBtn.disabled = true;
        navigateBtn.disabled = true;
        break;
      case 'connecting':
        statusPill.classList.add('status-connecting');
        statusPill.textContent = status.detail || 'Connecting…';
        startBtn.disabled = true;
        stopBtn.disabled = false;
        navigateBtn.disabled = true;
        break;
      case 'connected':
        statusPill.classList.add('status-connected');
        statusPill.textContent = 'Connected';
        startBtn.disabled = true;
        stopBtn.disabled = false;
        navigateBtn.disabled = false;
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
        navigateBtn.disabled = true;
        break;
    }
  }
})();
