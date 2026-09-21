// Total Agentic Mode — the sidebar's dedicated script, deliberately
// SEPARATE from main.js (per this feature's "proper segregation"
// requirement). Owns only what this mode's own HTML (see
// objectSpyPanel.ts's getAgenticModeSidebarHtml()) renders: the file drop
// zone, the ingested-file count, the "Instant instructions to LLM" chat
// (a conversation with the LangChain agent: transcript, composer, send/stop,
// regenerate, and the cards the app itself adds — a retrieved Jira/Confluence
// resource, a "Connect securely" prompt, a link to a generated artifact), the
// Custom Instructions / RAG Data checkbox lists, and
// its own copy of the Token Monitoring renderer (same message SHAPE as
// Standard mode's main.js — see agentic/agenticModeController.ts's doc
// comment — but its own independent DOM/render code, since the two modes'
// sidebar layouts are otherwise unrelated).
(function () {
  const vscode = acquireVsCodeApi();

  const settingsBtn = document.getElementById('settingsBtn');
  const dropZone = document.getElementById('agenticDropZone');
  const fileInput = document.getElementById('agenticFileInput');
  const browseBtn = document.getElementById('agenticBrowseBtn');
  const fileCountLabel = document.getElementById('agenticFileCountLabel');
  const manageFilesBtn = document.getElementById('agenticManageFilesBtn');
  const rejectedList = document.getElementById('agenticRejectedList');
  const promptFilesList = document.getElementById('agenticPromptFilesList');
  const ragFilesList = document.getElementById('agenticRagFilesList');
  const refreshPromptFilesBtn = document.getElementById('agenticRefreshPromptFilesBtn');
  const chatInput = document.getElementById('agenticChatInput');
  const chatLog = document.getElementById('agenticChatLog');
  const chatSendBtn = document.getElementById('agenticChatSendBtn');
  const chatStopBtn = document.getElementById('agenticChatStopBtn');
  const instructionsSearch = document.getElementById('agenticInstructionsSearch');
  const ragSearch = document.getElementById('agenticRagSearch');
  const clearDataBtn = document.getElementById('agenticClearDataBtn');

  // ---- Token Monitoring (own copy — see file doc comment) ----
  const tokenBarFill = document.getElementById('tokenBarFill');
  const tokenPercentLabel = document.getElementById('tokenPercentLabel');
  const tokenModelLabel = document.getElementById('tokenModelLabel');
  const tokenUnavailableNote = document.getElementById('tokenUnavailableNote');
  const tokenBreakdown = document.getElementById('tokenBreakdown');
  const tokenSentValue = document.getElementById('tokenSentValue');
  const tokenReceivedValue = document.getElementById('tokenReceivedValue');
  const tokenTotalValue = document.getElementById('tokenTotalValue');
  const tokenMaxValue = document.getElementById('tokenMaxValue');

  let lastTokenState = null;
  function applyTokenEstimate(payload) {
    if (payload.available === false) {
      lastTokenState = null;
      tokenUnavailableNote.hidden = false;
      tokenUnavailableNote.textContent = payload.reason || 'Token usage unavailable.';
      tokenBreakdown.hidden = true;
      tokenBarFill.style.width = '0%';
      tokenPercentLabel.textContent = '—';
      tokenModelLabel.textContent = '';
      return;
    }
    lastTokenState = lastTokenState || {};
    if (payload.sentTokens !== null && payload.sentTokens !== undefined) lastTokenState.sentTokens = payload.sentTokens;
    if (payload.receivedTokens !== null && payload.receivedTokens !== undefined) lastTokenState.receivedTokens = payload.receivedTokens;
    if (payload.maxInputTokens) lastTokenState.maxInputTokens = payload.maxInputTokens;
    if (payload.modelId) lastTokenState.modelId = payload.modelId;
    if (lastTokenState.sentTokens === undefined) return;

    tokenUnavailableNote.hidden = true;
    tokenBreakdown.hidden = false;
    const sent = lastTokenState.sentTokens;
    const received = lastTokenState.receivedTokens || 0;
    const max = lastTokenState.maxInputTokens || 0;
    const percent = max > 0 ? Math.min(100, (sent / max) * 100) : 0;
    tokenBarFill.style.width = percent + '%';
    // The colour comes from agenticMode.css, keyed on this attribute.
    tokenBarFill.dataset.level = percent >= 85 ? 'high' : percent >= 60 ? 'mid' : 'low';
    tokenPercentLabel.textContent = percent.toFixed(1) + '% of context window';
    tokenModelLabel.textContent = lastTokenState.modelId || '';
    tokenSentValue.textContent = sent.toLocaleString();
    tokenReceivedValue.textContent = received.toLocaleString();
    tokenTotalValue.textContent = (sent + received).toLocaleString();
    tokenMaxValue.textContent = max.toLocaleString();
  }

  // ---- File drop / picker ----
  function arrayBufferToBase64(buffer) {
    let binary = '';
    const bytes = new Uint8Array(buffer);
    const chunkSize = 0x8000;
    for (let i = 0; i < bytes.length; i += chunkSize) {
      binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunkSize));
    }
    return btoa(binary);
  }

  function readAllAsBase64(fileList) {
    return Promise.all(
      Array.from(fileList).map(
        (file) =>
          new Promise((resolve) => {
            const reader = new FileReader();
            reader.onload = () => resolve({ fileName: file.name, base64: arrayBufferToBase64(reader.result) });
            reader.onerror = () => resolve(null);
            reader.readAsArrayBuffer(file);
          })
      )
    );
  }

  function ingest(fileList) {
    if (!fileList || fileList.length === 0) return;
    readAllAsBase64(fileList).then((results) => {
      const files = results.filter(Boolean);
      if (files.length > 0) {
        vscode.postMessage({ type: 'agentic:ingestFiles', payload: { files: files } });
      }
    });
  }

  settingsBtn.addEventListener('click', () => vscode.postMessage({ type: 'openSettings' }));

  browseBtn.addEventListener('click', () => fileInput.click());
  fileInput.addEventListener('change', () => {
    ingest(fileInput.files);
    fileInput.value = '';
  });
  ['dragenter', 'dragover'].forEach((evt) => dropZone.addEventListener(evt, (e) => { e.preventDefault(); dropZone.classList.add('dragover'); }));
  ['dragleave', 'drop'].forEach((evt) => dropZone.addEventListener(evt, (e) => { e.preventDefault(); dropZone.classList.remove('dragover'); }));
  dropZone.addEventListener('drop', (e) => {
    if (e.dataTransfer && e.dataTransfer.files) ingest(e.dataTransfer.files);
  });

  manageFilesBtn.addEventListener('click', () => vscode.postMessage({ type: 'agentic:openIngestionPanel' }));

  // "Clear Data" -- a genuine "start this batch of files over from
  // nothing", matching Standard mode's own Clear Data/Kill All Browsers
  // buttons: the extension host wipes every ingested file, cached parsed
  // content, custom-instruction selection, and generated output
  // (agentic/agenticModeController.ts's reset()); this click handler only
  // resets what's purely client-side state here (the chat box text, the
  // rejected-files list, the CSV status line) -- everything else arrives
  // back via the 'agentic:fileList'/'agentic:promptFiles'/'tokenEstimate'
  // messages reset() already sends.
  clearDataBtn.addEventListener('click', () => {
    chatInput.value = '';
    // The host also re-posts an empty chat; clearing here too means nothing
    // of the old conversation is left on screen even for a moment.
    chatEntries = [];
    chatBusy = false;
    renderChat();
    // Checkboxes and search boxes reset too (the host re-posts the lists with nothing checked).
    promptFiles.clear();
    ragFiles.clear();
    renderRejected([]);
    vscode.postMessage({ type: 'agentic:clearData' });
  });

  function renderFileList(files) {
    fileCountLabel.textContent = files.length === 0 ? 'No files ingested yet.' : files.length + ' file(s) ingested.';
    manageFilesBtn.hidden = files.length === 0;
  }

  function renderRejected(rejected) {
    rejectedList.innerHTML = '';
    if (!rejected || rejected.length === 0) {
      rejectedList.hidden = true;
      return;
    }
    rejectedList.hidden = false;
    rejected.forEach((r) => {
      const line = document.createElement('div');
      line.className = 'agentic-rejected-line';
      line.textContent = r.fileName + ' — ' + r.reason;
      rejectedList.appendChild(line);
    });
  }

  // ---- Custom Instructions & RAG Data (mirrors main.js's own Custom
  // Instructions & RAG Data segment — same checkbox-driven selection model,
  // its own independent DOM/render code per this feature's "proper
  // segregation" requirement) ----
  // How much context to show around a match found only in a recipe's body text.
  const MATCH_SNIPPET_RADIUS = 30;

  /** Why a recipe matched the search when its own path does not show it (title, tag or a snippet of its
   * body) — same behaviour as Standard mode's list, so a genuine match never looks unrelated. */
  function matchContext(item, query) {
    if (!query || item.path.toLowerCase().includes(query)) return '';
    if (item.title && item.title.toLowerCase().includes(query)) return item.title;
    const matchedTag = (item.tags || []).find((t) => t.toLowerCase().includes(query));
    if (matchedTag) return 'tag: ' + matchedTag;
    const body = item.body || '';
    const idx = body.toLowerCase().indexOf(query);
    if (idx === -1) return '';
    const start = Math.max(0, idx - MATCH_SNIPPET_RADIUS);
    const end = Math.min(body.length, idx + query.length + MATCH_SNIPPET_RADIUS);
    const snippet = body.slice(start, end).replace(/\s+/g, ' ').trim();
    return (start > 0 ? '…' : '') + snippet + (end < body.length ? '…' : '');
  }

  /** A search-filterable checkbox list. Search text and selection are TWO independent pieces of state:
   * filtering only changes which items are VISIBLE, never which are checked, so a check on a now-hidden
   * item is kept. The extension host is authoritative for the selection after a refresh — it says which
   * of the previously checked files still exist — and is told about every user change. `files` may be
   * plain paths (Custom Instructions) or `{relPath, title, tags, body}` (RAG recipes). */
  function makeCheckList(listEl, searchEl, emptyMessage, messageType) {
    let allItems = [];
    let selected = new Set();

    function toItems(files) {
      return files.map((f) =>
        typeof f === 'string'
          ? { path: f, searchText: f.toLowerCase() }
          : {
              path: f.relPath,
              title: f.title || '',
              tags: f.tags || [],
              body: f.body || '',
              searchText: (f.relPath + ' ' + (f.title || '') + ' ' + (f.tags || []).join(' ') + ' ' + (f.body || '')).toLowerCase()
            }
      );
    }

    function showMessage(text) {
      listEl.textContent = '';
      listEl.appendChild(el('div', 'prompt-files-empty', text));
    }

    function render() {
      if (!allItems.length) {
        showMessage(emptyMessage);
        return;
      }
      const query = searchEl.value.trim().toLowerCase();
      const visible = query ? allItems.filter((item) => item.searchText.includes(query)) : allItems;
      if (!visible.length) {
        showMessage('No files match your search.');
        return;
      }
      listEl.textContent = '';
      visible.forEach((item) => {
        const label = el('label', 'prompt-file-item');
        const checkbox = document.createElement('input');
        checkbox.type = 'checkbox';
        checkbox.value = item.path;
        checkbox.checked = selected.has(item.path);
        checkbox.addEventListener('change', () => {
          if (checkbox.checked) selected.add(item.path);
          else selected.delete(item.path);
          vscode.postMessage({ type: messageType, payload: Array.from(selected) });
        });
        label.appendChild(checkbox);
        label.appendChild(el('span', '', item.path));
        const context = matchContext(item, query);
        if (context) label.appendChild(el('span', 'prompt-file-match-hint', '— matched: "' + context + '"'));
        listEl.appendChild(label);
      });
    }

    searchEl.addEventListener('input', render);
    return {
      setFiles(files, selectedPaths) {
        allItems = toItems(files || []);
        selected = new Set(selectedPaths || []);
        render();
      },
      getSelected() {
        return Array.from(selected);
      },
      clear() {
        selected = new Set();
        searchEl.value = '';
        render();
      }
    };
  }

  const promptFiles = makeCheckList(promptFilesList, instructionsSearch, 'No .md files found under .github/ — click Refresh.', 'agentic:selectedInstructionFiles');
  const ragFiles = makeCheckList(ragFilesList, ragSearch, 'No recipes found under .github/rag/ — click Refresh.', 'agentic:selectedRagFiles');

  // ---- Chat ("Instant instructions to LLM") ----
  // The conversation itself lives in the extension host (it survives this
  // webview being hidden/re-created and is wiped by Clear Data); this script
  // only renders the transcript the host posts ('agentic:chatState') and
  // sends what the user types. Everything is built with textContent/DOM
  // nodes — never innerHTML — because a model's answer (and the files it read)
  // is untrusted text.
  let chatEntries = [];
  let chatBusy = false;
  let awaitingChatState = false;
  let awaitingTimer = null;
  const seenEntryIds = new Set();
  const openToolIds = new Set();

  function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  const ICON_COPY = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15V6a2 2 0 0 1 2-2h9"/></svg>';
  const ICON_REDO = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12a9 9 0 1 1-3-6.7"/><path d="M21 4v5h-5"/></svg>';
  function actionButton(iconSvg, label, title, onClick) {
    const btn = el('button', 'ag-action');
    btn.type = 'button';
    btn.title = title;
    // The icon markup is a constant defined above — never model output.
    btn.insertAdjacentHTML('afterbegin', iconSvg);
    btn.appendChild(document.createTextNode(label));
    btn.addEventListener('click', onClick);
    return btn;
  }

  function copyText(text, button) {
    const done = () => {
      const original = button.lastChild.textContent;
      button.lastChild.textContent = 'Copied';
      setTimeout(() => { button.lastChild.textContent = original; }, 1200);
    };
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(done, () => fallbackCopy(text, done));
    } else {
      fallbackCopy(text, done);
    }
  }
  function fallbackCopy(text, done) {
    const area = document.createElement('textarea');
    area.value = text;
    area.style.position = 'fixed';
    area.style.opacity = '0';
    document.body.appendChild(area);
    area.select();
    try { document.execCommand('copy'); done(); } catch (e) { /* nothing more to try */ }
    area.remove();
  }

  // Inline `code` and **bold** — everything else stays literal text.
  function appendInline(parent, text) {
    const re = /(`[^`\n]+`|\*\*[^*\n]+\*\*)/g;
    let last = 0;
    let m;
    while ((m = re.exec(text)) !== null) {
      if (m.index > last) parent.appendChild(document.createTextNode(text.slice(last, m.index)));
      const token = m[0];
      parent.appendChild(token[0] === '`' ? el('code', '', token.slice(1, -1)) : el('strong', '', token.slice(2, -2)));
      last = m.index + token.length;
    }
    if (last < text.length) parent.appendChild(document.createTextNode(text.slice(last)));
  }

  const RE_BULLET = /^\s*[-*]\s+/;
  const RE_NUMBER = /^\s*\d+[.)]\s+/;
  const RE_HEADING = /^#{1,6}\s+/;
  const RE_TABLE = /^\s*\|/;
  function startsBlock(line) {
    return RE_BULLET.test(line) || RE_NUMBER.test(line) || RE_HEADING.test(line) || RE_TABLE.test(line);
  }

  function renderTextBlock(container, text) {
    const lines = text.split(/\r?\n/);
    let i = 0;
    while (i < lines.length) {
      const line = lines[i];
      if (!line.trim()) { i++; continue; }
      if (RE_BULLET.test(line) || RE_NUMBER.test(line)) {
        const ordered = RE_NUMBER.test(line);
        const list = el(ordered ? 'ol' : 'ul');
        const re = ordered ? RE_NUMBER : RE_BULLET;
        while (i < lines.length && re.test(lines[i])) {
          const li = el('li');
          appendInline(li, lines[i].replace(re, ''));
          list.appendChild(li);
          i++;
        }
        container.appendChild(list);
      } else if (RE_TABLE.test(line)) {
        const rows = [];
        while (i < lines.length && RE_TABLE.test(lines[i])) { rows.push(lines[i]); i++; }
        container.appendChild(el('pre', 'ag-table', rows.join('\n')));
      } else if (RE_HEADING.test(line)) {
        const heading = el('span', 'ag-h');
        appendInline(heading, line.replace(RE_HEADING, ''));
        container.appendChild(heading);
        i++;
      } else {
        const paragraph = [];
        while (i < lines.length && lines[i].trim() && !startsBlock(lines[i])) { paragraph.push(lines[i]); i++; }
        const p = el('p');
        appendInline(p, paragraph.join('\n'));
        container.appendChild(p);
      }
    }
  }

  function renderMarkdown(container, source) {
    const fence = /```([^\n`]*)\n([\s\S]*?)(?:```|$)/g;
    let last = 0;
    let m;
    while ((m = fence.exec(source)) !== null) {
      renderTextBlock(container, source.slice(last, m.index));
      const code = m[2].replace(/\n$/, '');
      const block = el('div', 'ag-code');
      const head = el('div', 'ag-code-head');
      head.appendChild(el('span', '', (m[1] || 'code').trim() || 'code'));
      const copy = actionButton(ICON_COPY, 'Copy', 'Copy this code', () => copyText(code, copy));
      head.appendChild(copy);
      block.appendChild(head);
      const pre = el('pre');
      pre.appendChild(el('code', '', code));
      block.appendChild(pre);
      container.appendChild(block);
      last = m.index + m[0].length;
      if (m[0].length === 0) fence.lastIndex++;
    }
    renderTextBlock(container, source.slice(last));
  }

  function renderEntry(entry, isLatestAnswer) {
    const isNew = !seenEntryIds.has(entry.id);
    seenEntryIds.add(entry.id);
    const enter = isNew ? ' ag-new' : '';

    if (entry.kind === 'resource' && entry.resource) return renderResourceCard(entry, enter);
    if (entry.kind === 'action' && entry.action) return renderActionCard(entry, enter);
    if (entry.kind === 'artifact' && entry.artifact) return renderArtifactCard(entry, enter);
    if (entry.kind === 'tool') {
      const details = el('details', 'ag-tool' + enter);
      details.dataset.id = String(entry.id);
      details.open = openToolIds.has(entry.id);
      details.addEventListener('toggle', () => {
        if (details.open) openToolIds.add(entry.id); else openToolIds.delete(entry.id);
      });
      details.appendChild(el('summary', '', entry.text));
      details.appendChild(el('pre', '', entry.detail || ''));
      return details;
    }
    if (entry.kind === 'note') {
      return el('div', 'ag-note' + enter, entry.text);
    }

    const wrap = el('div', 'ag-msg ag-msg-' + entry.kind + enter);
    if (entry.kind === 'assistant') {
      const role = el('div', 'ag-role');
      role.appendChild(el('span', 'ag-orb'));
      role.appendChild(document.createTextNode('SoftPlay agent'));
      wrap.appendChild(role);
      if (typeof entry.regenerated === 'string') {
        wrap.appendChild(el('span', 'ag-regen-chip', entry.regenerated ? 'Regenerated — ' + entry.regenerated : 'Regenerated'));
      }
    }
    const bubble = el('div', 'ag-bubble');
    if (entry.kind === 'assistant') {
      renderMarkdown(bubble, entry.text);
    } else {
      bubble.textContent = entry.text;
    }
    wrap.appendChild(bubble);

    if (entry.kind === 'assistant' && isLatestAnswer && !chatBusy) {
      const actions = el('div', 'ag-actions');
      const copyBtn = actionButton(ICON_COPY, 'Copy', 'Copy this answer', () => copyText(entry.text, copyBtn));
      const regenBtn = actionButton(
        ICON_REDO,
        'Regenerate',
        "Ask for this answer again. Type a preference in the box first (for example 'shorter, as a table') to steer the new answer.",
        () => {
          vscode.postMessage({ type: 'agentic:chatRegenerate', payload: chatInput.value.trim() });
          chatInput.value = '';
          vscode.postMessage({ type: 'agentic:updateDraftInstructions', payload: '' });
          updateComposerState();
        }
      );
      actions.appendChild(copyBtn);
      actions.appendChild(regenBtn);
      wrap.appendChild(actions);
    }
    return wrap;
  }

  function renderChat() {
    const nearBottom = chatLog.scrollHeight - chatLog.scrollTop - chatLog.clientHeight < 80;
    chatLog.textContent = '';
    if (chatEntries.length === 0) {
      seenEntryIds.clear();
      openToolIds.clear();
      if (!chatBusy) {
        const empty = el('div', 'ag-chat-empty');
        empty.appendChild(el('strong', '', 'Ask anything about your files'));
        empty.appendChild(document.createTextNode('Follow up on any answer, ask for it again with a preference, paste a Jira ticket or Confluence page link, or tell the agent to create a feature file, automation code or a test-case CSV.'));
        chatLog.appendChild(empty);
      }
    }
    // The action buttons belong under the newest answer only, and only until
    // the user asks something new.
    let latestAnswerId = -1;
    for (let i = chatEntries.length - 1; i >= 0; i--) {
      if (chatEntries[i].kind === 'user') break;
      if (chatEntries[i].kind === 'assistant') { latestAnswerId = chatEntries[i].id; break; }
    }
    chatEntries.forEach((entry) => chatLog.appendChild(renderEntry(entry, entry.id === latestAnswerId)));
    if (chatBusy) {
      const typing = el('div', 'ag-typing');
      typing.setAttribute('aria-label', 'The agent is working');
      typing.appendChild(el('span'));
      typing.appendChild(el('span'));
      typing.appendChild(el('span'));
      chatLog.appendChild(typing);
    }
    if (nearBottom) chatLog.scrollTop = chatLog.scrollHeight;
    updateComposerState();
  }

  function updateComposerState() {
    const hasText = chatInput.value.trim().length > 0;
    chatSendBtn.hidden = chatBusy;
    chatStopBtn.hidden = !chatBusy;
    chatSendBtn.disabled = !hasText || awaitingChatState;
  }

  function applyChatState(payload) {
    awaitingChatState = false;
    clearTimeout(awaitingTimer);
    chatEntries = payload.entries || [];
    chatBusy = !!payload.busy;
    renderChat();
  }

  // Sends `text` as an ordinary chat message. Used by the Send button/Enter AND by the suggestion chips:
  // a chip is nothing more than a shortcut for typing that sentence — it never invokes anything by itself.
  function submitChat(text) {
    if (!text || chatBusy || awaitingChatState) return false;
    awaitingChatState = true;
    // If the host never answers, don't leave Send disabled forever.
    clearTimeout(awaitingTimer);
    awaitingTimer = setTimeout(() => { awaitingChatState = false; updateComposerState(); }, 4000);
    vscode.postMessage({ type: 'agentic:chatSend', payload: text });
    return true;
  }

  function sendChat() {
    if (!submitChat(chatInput.value.trim())) return;
    chatInput.value = '';
    // What was typed is now a sent message, not a draft.
    vscode.postMessage({ type: 'agentic:updateDraftInstructions', payload: '' });
    updateComposerState();
  }

  chatSendBtn.addEventListener('click', sendChat);
  chatStopBtn.addEventListener('click', () => vscode.postMessage({ type: 'agentic:chatStop' }));
  chatInput.addEventListener('keydown', (e) => {
    // Enter sends, Shift+Enter is a new line (and never mid-IME-composition).
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      sendChat();
    }
  });

  // What is typed but not sent is only used for the token estimate.
  let chatDebounceTimer = null;
  chatInput.addEventListener('input', () => {
    updateComposerState();
    clearTimeout(chatDebounceTimer);
    chatDebounceTimer = setTimeout(() => {
      vscode.postMessage({ type: 'agentic:updateDraftInstructions', payload: chatInput.value });
    }, 500);
  });

  // ---- Cards the host adds to the conversation ----
  // All text comes from the extension host and may include Jira/Confluence content: textContent only.
  function formatSize(bytes) {
    if (typeof bytes !== 'number') return '';
    if (bytes < 1024) return bytes + ' B';
    if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
    return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
  }

  function formatWhen(iso) {
    const date = new Date(iso);
    return Number.isNaN(date.getTime()) ? String(iso) : date.toLocaleString();
  }

  function cardButton(label, disabled, onClick, secondary) {
    const btn = el('button', 'ag-card-btn' + (secondary ? ' ag-secondary' : ''), label);
    btn.type = 'button';
    btn.disabled = !!disabled;
    btn.addEventListener('click', onClick);
    return btn;
  }

  function attachmentBadge(status) {
    if (status === 'imported') return el('span', 'ag-badge ag-ok', 'Read');
    if (status === 'importable') return el('span', 'ag-badge', 'Not read yet');
    return el('span', 'ag-badge ag-no', "Can't read");
  }

  function renderResourceCard(entry, enter) {
    const r = entry.resource;
    const card = el('div', 'ag-card ag-resource' + enter);
    const head = el('div', 'ag-card-head');
    head.appendChild(el('span', 'ag-card-kicker', (r.product === 'jira' ? 'Jira' : 'Confluence') + ' · ' + r.connectionLabel + ' · ' + r.key));
    card.appendChild(head);
    card.appendChild(el('div', 'ag-card-title', r.title));
    (r.summaryLines || []).slice(1).forEach((line) => card.appendChild(el('div', 'ag-card-line', line)));
    card.appendChild(
      el('div', 'ag-card-meta', 'Retrieved ' + formatWhen(r.retrievedAt) + (r.fromCache ? ' (a copy from earlier in this session — ask me to refresh for the latest)' : '') + ' · ' + r.url)
    );
    if (r.truncated) card.appendChild(el('div', 'ag-card-warn', 'Long content: only the first part was kept (size cap).'));
    (r.conversionNotes || []).forEach((note) => card.appendChild(el('div', 'ag-card-warn', note)));

    const attachments = r.attachments || [];
    if (attachments.length === 0) {
      card.appendChild(el('div', 'ag-card-line', 'No attachments.'));
    } else {
      card.appendChild(el('div', 'ag-card-question', 'Attachments (' + attachments.length + ')' + (r.attachmentListingComplete ? '' : ' — the list is INCOMPLETE: more exist than could be listed')));
      const list = el('ul', 'ag-attach-list');
      attachments.forEach((a) => {
        const row = el('li', 'ag-attach-row');
        const name = el('span', 'ag-attach-name', a.filename);
        if (a.reason && a.status !== 'importable' && a.status !== 'imported') name.appendChild(el('span', 'ag-attach-reason', a.reason));
        row.appendChild(name);
        const right = el('span', '');
        right.appendChild(el('span', 'ag-attach-size', formatSize(a.sizeBytes) + ' '));
        right.appendChild(attachmentBadge(a.status));
        row.appendChild(right);
        list.appendChild(row);
      });
      card.appendChild(list);
      const canImport = attachments.some((a) => a.status === 'importable');
      if (canImport) {
        card.appendChild(el('div', 'ag-card-question', 'Do you want me to read any of these attachments?'));
        const actions = el('div', 'ag-card-actions');
        actions.appendChild(cardButton('Read attachments…', chatBusy, () => vscode.postMessage({ type: 'agentic:importAttachments', payload: { sourceId: r.sourceId } })));
        card.appendChild(actions);
      }
    }
    card.appendChild(el('div', 'ag-card-question', 'What would you like to do next?'));
    const chips = el('div', 'ag-chips');
    (r.suggestions || []).concat(['Refresh from the server']).forEach((text) => {
      const chip = el('button', 'ag-chip', text);
      chip.type = 'button';
      chip.disabled = chatBusy;
      chip.addEventListener('click', () => submitChat(text === 'Refresh from the server' ? 'Please refresh ' + r.key + ' from the server.' : text));
      chips.appendChild(chip);
    });
    card.appendChild(chips);
    return card;
  }

  function renderActionCard(entry, enter) {
    const a = entry.action;
    // NOT "ag-action": that class styles the small Copy / Regenerate pills under an answer.
    const card = el('div', 'ag-card ag-connect' + (a.resolved ? ' ag-resolved' : '') + enter);
    card.appendChild(el('div', 'ag-card-kicker', a.kind === 'reconnect' ? 'Reconnect' : 'Secure connection'));
    card.appendChild(el('div', 'ag-card-line', entry.text));
    const actions = el('div', 'ag-card-actions');
    actions.appendChild(
      cardButton(a.resolved ? 'Done' : a.kind === 'reconnect' ? 'Reconnect securely' : 'Connect securely', a.resolved || chatBusy, () =>
        vscode.postMessage({ type: 'agentic:connect', payload: { actionId: a.actionId } })
      )
    );
    card.appendChild(actions);
    return card;
  }

  const ARTIFACT_LABELS = { feature: 'Open feature file', code: 'Open automation code', csv: 'Open test cases (CSV)' };
  function renderArtifactCard(entry, enter) {
    const a = entry.artifact;
    const card = el('div', 'ag-card ag-artifact' + enter);
    card.appendChild(el('div', 'ag-card-kicker', 'Generated'));
    card.appendChild(el('div', 'ag-card-line', a.label));
    const actions = el('div', 'ag-card-actions');
    actions.appendChild(cardButton(ARTIFACT_LABELS[a.artifactKind] || 'Open', false, () => vscode.postMessage({ type: 'agentic:openArtifact', payload: { artifactId: a.artifactId } }), true));
    card.appendChild(actions);
    return card;
  }

  refreshPromptFilesBtn.addEventListener('click', () => vscode.postMessage({ type: 'agentic:refreshInstructionFiles' }));

  window.addEventListener('message', (event) => {
    const message = event.data;
    switch (message.type) {
      case 'tokenEstimate':
        applyTokenEstimate(message.payload);
        break;
      case 'agentic:fileList':
        renderFileList(message.payload);
        break;
      case 'agentic:promptFiles':
        promptFiles.setFiles(message.payload.files, message.payload.selected);
        break;
      case 'agentic:ragFiles':
        ragFiles.setFiles(message.payload.files, message.payload.selected);
        break;
      case 'agentic:ingestResult':
        renderRejected(message.payload.rejected);
        break;
      case 'agentic:chatState':
        applyChatState(message.payload);
        break;
    }
  });

  promptFiles.setFiles([], []);
  ragFiles.setFiles([], []);
  renderChat();
  vscode.postMessage({ type: 'agentic:ready' });
  vscode.postMessage({ type: 'agentic:refreshInstructionFiles' });
})();
