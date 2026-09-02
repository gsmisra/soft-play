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
  const codeRefreshBanner = document.getElementById('codeRefreshBanner');
  const codeRefreshBtn = document.getElementById('codeRefreshBtn');
  const playwrightCodePanel = document.getElementById('playwrightCodePanel');
  const collapseCodeBtn = document.getElementById('collapseCodeBtn');
  const collapseLlmCodeBtn = document.getElementById('collapseLlmCodeBtn');
  const aiAssistSection = document.getElementById('aiAssistSection');
  const promptFilesList = document.getElementById('promptFilesList');
  const chatComposer = document.getElementById('chatComposer');
  const chatMessages = document.getElementById('chatMessages');
  const chatInput = document.getElementById('chatInput');
  const chatSendBtn = document.getElementById('chatSendBtn');
  const refreshPromptFilesBtn = document.getElementById('refreshPromptFilesBtn');
  const llmCodePanel = document.getElementById('llmCodePanel');
  const llmStatusLabel = document.getElementById('llmStatusLabel');
  const saveLlmCodeBtn = document.getElementById('saveLlmCodeBtn');
  const copyLlmCodeBtn = document.getElementById('copyLlmCodeBtn');
  const llmCodeEditArea = document.getElementById('llmCodeEditArea');
  const llmCodeHighlightPre = document.getElementById('llmCodeHighlight');
  const LLM_PLACEHOLDER =
    '// Enable "Link with GitHub Copilot LLM" in Settings and pick a model, then check a .md file below or type instructions in the chat — the AI Generated Code view fills in automatically as code is recorded.';

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

  saveLlmCodeBtn.addEventListener('click', () => {
    vscode.postMessage({ type: 'saveLlmCode', payload: llmEditor.getValue() });
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

  copyLlmCodeBtn.addEventListener('click', () => {
    copyToClipboard(llmEditor.getValue(), copyLlmCodeBtn);
  });

  // Collapse either code panel independently -- lets one be viewed at full
  // height without the other (in its default, uncollapsed size) still
  // taking up sidebar space alongside it.
  function toggleCollapse(panel, btn) {
    const collapsed = panel.classList.toggle('collapsed');
    btn.textContent = collapsed ? '▸' : '▾';
    btn.title = collapsed ? 'Expand this panel' : 'Collapse this panel';
  }

  collapseCodeBtn.addEventListener('click', () => toggleCollapse(playwrightCodePanel, collapseCodeBtn));
  collapseLlmCodeBtn.addEventListener('click', () => toggleCollapse(llmCodePanel, collapseLlmCodeBtn));

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

  // No "Send to Copilot"/"Send Anyway" buttons: checking a .md file below is
  // itself the action -- the extension host tracks the current checkbox
  // selection (see the 'change' listener in renderPromptFiles()) and folds
  // it into every AI refinement automatically, manual or the automatic
  // post-recording pipeline, so there's nothing left to separately "send".
  // The chat composer below is still a genuinely separate, deliberate
  // action: free-text instructions typed there and sent explicitly.

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

  linkFeatureBtn.addEventListener('click', () => {
    vscode.postMessage({ type: 'linkFeatureFile' });
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
    linkedScenarioText.textContent = scenario.featureName + ' › ' + scenario.scenarioKind + ': ' + scenario.scenarioName;
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
    // aiAssistSection nests chatComposer, so hiding it here already hides
    // the composer too -- no need to separately toggle chatComposer.hidden.
    aiAssistSection.hidden = !enabled;
    llmCodePanel.hidden = !enabled;
    if (enabled) {
      vscode.postMessage({ type: 'refreshPromptFiles' });
    } else {
      chatMessages.innerHTML = '';
      chatInput.value = '';
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

  function llmStart() {
    llmStatusLabel.textContent = '(generating…)';
    llmStatusLabel.className = 'llm-status llm-status-active';
    llmEditor.setValue('');
  }

  function llmDone(finalCode) {
    llmStatusLabel.textContent = '';
    llmStatusLabel.className = 'llm-status';
    llmEditor.setValue(finalCode);
  }

  function llmError(message) {
    llmStatusLabel.textContent = 'Error';
    llmStatusLabel.className = 'llm-status llm-status-error';
    llmEditor.setValue('// ' + message);
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

  function clearAll() {
    userEditedCode = false;
    pendingFreshCode = null;
    codeRefreshBanner.hidden = true;
    playwrightEditor.setValue('// Click "Start" and interact with the codegen browser window.');
    llmEditor.setValue(LLM_PLACEHOLDER);
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
