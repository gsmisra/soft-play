import * as vscode from 'vscode';

/**
 * Total Agentic Mode's sidebar HTML — a deliberately SEPARATE template from
 * ObjectSpyPanel's own Standard-mode markup (its own file, its own script
 * `media/agenticMode.js`, never main.js) per this feature's "proper
 * segregation" requirement. ObjectSpyPanel.getHtml() picks between the two
 * templates based on `settings.agenticModeEnabled`; nothing else about
 * Standard mode's own HTML changes because this file exists.
 *
 * Layout, top to bottom: the header; the collapsible context sections (Input
 * Files, Custom Instructions & RAG Data, Token Monitoring) — collapse them to
 * give the conversation more room — and the "Instant instructions to LLM" chat,
 * a standalone panel that takes the remaining height. There is no Generate
 * section: a feature file, automation code or a test-case CSV is requested in
 * the chat (the agent's tools run the same generation pipelines) and reopened
 * from links the chat shows.
 *
 * Reuses `media/main.css` for its structural classes (sections, buttons, the
 * Token Monitoring bar — a stylesheet is inert markup, not behavior, so
 * sharing it carries none of the coupling risk sharing main.js's DOM-wiring
 * would), then loads `media/agenticMode.css` on top: Agentic Mode's own white
 * claymorphic theme, scoped to `body.agentic-theme` so Standard mode's look
 * is untouched.
 */
export function getAgenticModeSidebarHtml(params: {
  webview: vscode.Webview;
  styleUri: vscode.Uri;
  /** media/agenticMode.css — Total Agentic Mode's own white/claymorphic theme. */
  themeUri: vscode.Uri;
  scriptUri: vscode.Uri;
  nonce: string;
  version: string;
}): string {
  const { webview, styleUri, themeUri, scriptUri, nonce, version } = params;
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${webview.cspSource} data:; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}';" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <link href="${styleUri}" rel="stylesheet" />
  <link href="${themeUri}" rel="stylesheet" />
  <title></title>
  <style>
    /* Agentic Mode's own small additions on top of main.css — kept here
       rather than added to main.css itself so Standard mode's stylesheet
       stays completely untouched by this feature. */
    .note { font-size: 0.82em; color: var(--vscode-descriptionForeground); margin: 6px 0; }
    .status-text { font-size: 0.82em; color: var(--vscode-descriptionForeground); }
    .btn-secondary {
      background: var(--vscode-button-secondaryBackground, transparent);
      color: var(--vscode-button-secondaryForeground, var(--vscode-foreground));
      border: 1px solid var(--vscode-panel-border);
      padding: 6px 14px; border-radius: 4px; cursor: pointer; font-size: 0.9em;
    }
    .rag-dropzone {
      display: flex; align-items: center; justify-content: center; flex-direction: column; gap: 10px;
      padding: 22px 16px; border: 2px dashed var(--vscode-panel-border); border-radius: 6px;
      text-align: center; color: var(--vscode-descriptionForeground); font-size: 0.88em;
      transition: border-color 0.15s ease, background 0.15s ease;
    }
    .rag-dropzone.dragover { border-color: var(--td-green, #54b948); background: rgba(84, 185, 72, 0.08); }
    .agentic-rejected-list { margin-top: 10px; font-size: 0.8em; color: var(--vscode-errorForeground, #f14c4c); }
    .agentic-rejected-line { padding: 2px 0; }
  </style>
</head>
<body class="agentic-theme">
  <div class="toolbar-row title-row app-title-row">
    <span class="title-group">
      <span class="title-line">
        <span class="title">TD Securities Agentic Test Automation</span>
        <span class="version-badge">v${version}</span>
      </span>
      <span class="title-subtitle">Total Agentic Mode — LangChain-powered</span>
    </span>
    <button id="settingsBtn" class="btn-icon-top" title="Settings (language, browser, GitHub Copilot, Total Agentic Mode)">⚙</button>
  </div>

  <details class="section" id="agenticIngestSection" open>
    <summary>Input Files</summary>
    <div class="section-body">
      <div class="toolbar-row" style="justify-content: flex-end;">
        <button id="agenticClearDataBtn" class="btn btn-danger clear-data-btn" title="Wipe every ingested file, the chat and the LLM's memory of it, retrieved Jira/Confluence pages, saved connections, selections and generated output — so nothing from this session carries over into the next one">Clear Data</button>
      </div>
      <p class="note" style="margin-top: 0;">
        Drop one or more requirement/data files (.csv, .json, .xml, .yml, .txt, .md, .log, .xlsx, .docx, .pdf).
        After ingesting, open Ingestion Configuration to choose exactly which sheet/columns/rows/lines of each file
        reach the LLM. Files read from Jira/Confluence attachments appear here too.
      </p>
      <div id="agenticDropZone" class="rag-dropzone">
        <span>Drop input files here, or</span>
        <button type="button" id="agenticBrowseBtn" class="btn btn-secondary">Choose Files…</button>
        <input type="file" id="agenticFileInput" multiple hidden accept=".csv,.json,.xml,.yml,.yaml,.txt,.md,.log,.xlsx,.docx,.pdf" />
      </div>
      <div class="toolbar-row" style="margin-top: 10px; justify-content: space-between;">
        <span id="agenticFileCountLabel" class="status-text">No files ingested yet.</span>
        <button id="agenticManageFilesBtn" class="btn btn-small btn-silver" hidden>Manage Ingested Files…</button>
      </div>
      <div id="agenticRejectedList" class="agentic-rejected-list" hidden></div>
    </div>
  </details>

  <details class="section" id="agenticCustomInstructionsRagSection" open>
    <summary>Custom Instructions &amp; RAG Data</summary>
    <div class="section-body">
      <details class="ai-assist" id="agenticCustomInstructionsSubsection">
        <summary>Custom Instructions</summary>
        <div class="ai-assist-body">
          <div class="ai-files-header">Instruction / skill / prompt files (<code>.github/*.md</code>) — check the ones the agent must follow</div>
          <input id="agenticInstructionsSearch" class="file-search-input" type="search" placeholder="Search instruction files…" aria-label="Search instruction files" />
          <div id="agenticPromptFilesList" class="prompt-files-list">
            <div class="prompt-files-empty">No .md files found yet — click Refresh.</div>
          </div>
          <p class="note">Checked files take priority over everything else, including what you type. <strong>Nothing checked = no instruction files are sent</strong> in Total Agentic Mode.</p>
        </div>
      </details>

      <details class="ai-assist" id="agenticRagDataSubsection">
        <summary>RAG Data</summary>
        <div class="ai-assist-body">
          <div class="ai-files-header">Reusable component recipes (<code>.github/rag/*.md</code>) — check the ones to use</div>
          <input id="agenticRagSearch" class="file-search-input" type="search" placeholder="Search recipes (name, title, tags, code)…" aria-label="Search RAG recipes" />
          <div id="agenticRagFilesList" class="prompt-files-list">
            <div class="prompt-files-empty">No recipes found yet — click Refresh.</div>
          </div>
          <p class="note">Checked recipes are the <strong>only</strong> ones sent, in full, with the same top priority as checked instruction files. <strong>Nothing checked = recipes are matched automatically</strong> (when enabled in Settings).</p>
        </div>
      </details>

      <div class="toolbar-row">
        <button id="agenticRefreshPromptFilesBtn" class="btn btn-small btn-silver" title="Re-scan .github/*.md (Custom Instructions) and .github/rag/*.md (RAG Data). Checked files that still exist stay checked.">Refresh file list</button>
      </div>
    </div>
  </details>

  <details class="section" id="tokenMonitoringSection">
    <summary>Token Monitoring</summary>
    <div class="section-body">
      <div class="token-bar-track">
        <div id="tokenBarFill" class="token-bar-fill"></div>
      </div>
      <div class="token-stats-row">
        <span id="tokenPercentLabel" class="token-percent-label">—</span>
        <span id="tokenModelLabel" class="token-model-label"></span>
      </div>
      <div id="tokenUnavailableNote" class="token-unavailable-note">Enable "Link with GitHub Copilot LLM" and pick a model in Settings to see token usage.</div>
      <div id="tokenBreakdown" class="token-breakdown" hidden>
        <div class="token-breakdown-item"><span class="token-breakdown-label">Sent</span><span id="tokenSentValue" class="token-breakdown-value">0</span></div>
        <div class="token-breakdown-item"><span class="token-breakdown-label">Received</span><span id="tokenReceivedValue" class="token-breakdown-value">0</span></div>
        <div class="token-breakdown-item"><span class="token-breakdown-label">Total</span><span id="tokenTotalValue" class="token-breakdown-value">0</span></div>
        <div class="token-breakdown-item"><span class="token-breakdown-label">Context limit</span><span id="tokenMaxValue" class="token-breakdown-value">0</span></div>
      </div>
    </div>
  </details>

  <section class="ag-chat-panel" id="agenticChatSection" aria-labelledby="agenticChatTitle">
    <h2 id="agenticChatTitle" class="ag-chat-title">Instant instructions to LLM</h2>
    <div id="agenticChatLog" class="ag-chat-log" role="log" aria-live="polite" aria-label="Conversation with the LLM"></div>
    <div id="agenticComposer" class="ag-composer" title="Drag the bottom-right corner to make this box bigger or smaller">
      <textarea id="agenticChatInput" class="ag-composer-input" rows="3" placeholder="Ask about your files, paste a Jira or Confluence link, or tell the agent what to create…" aria-label="Instant instructions to LLM"></textarea>
      <div class="ag-composer-bar">
        <span class="ag-composer-hint">Enter = send · Shift+Enter = new line</span>
        <button type="button" id="agenticChatStopBtn" class="ag-send-btn ag-stop" title="Stop" aria-label="Stop" hidden>
          <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><rect x="5" y="5" width="14" height="14" rx="3"/></svg>
        </button>
        <button type="button" id="agenticChatSendBtn" class="ag-send-btn" title="Send" aria-label="Send" disabled>
          <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M2.01 21 23 12 2.01 3 2 10l15 2-15 2z"/></svg>
        </button>
      </div>
    </div>
  </section>

  <script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
}
