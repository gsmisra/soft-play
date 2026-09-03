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
  const aiStatusLabel = document.getElementById('aiStatusLabel');
  const aiGeneratingBanner = document.getElementById('aiGeneratingBanner');
  const copilotEnabledToggle = document.getElementById('copilotEnabledToggle');

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

  // "Start AI Processing" — the ONLY trigger for AI code generation.
  // Bundles every staged chat bubble plus whatever's still sitting unsent
  // in the input box (so the user doesn't have to remember to hit ➤ first)
  // into one customInstructions string, along with the current Playwright
  // Code and checked .md files; the extension host adds Settings and the
  // linked scenario/selected steps on its own. Stages are cleared after
  // sending so the next run starts fresh.
  startAiProcessingBtn.addEventListener('click', () => {
    const unsent = chatInput.value.trim();
    const allInstructions = unsent ? [...stagedInstructions, unsent] : stagedInstructions;
    const customInstructions = allInstructions.join('\n\n');

    vscode.postMessage({
      type: 'sendToLlm',
      payload: { selectedFiles: selectedPromptFiles(), code: playwrightEditor.getValue(), customInstructions }
    });

    stagedInstructions = [];
    chatMessages.innerHTML = '';
    chatInput.value = '';
    autoResizeChatInput();
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
