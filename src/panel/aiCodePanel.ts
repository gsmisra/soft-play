import * as vscode from 'vscode';
import * as path from 'path';
import { Language } from '../settings/settingsStore';

type InboundMessage = { type: 'saveCode'; payload: string } | { type: 'regenerate' };

/**
 * "AI Generated Code" as its own full-size editor-area panel (ViewColumn.Beside),
 * not a cramped half of the sidebar — opened from the main Control Panel's
 * "Open AI Generated Code" button/status line. This is purely a presentation
 * change: ObjectSpyPanel still owns the actual Copilot request/response
 * lifecycle (runLlmRefinement()) and just pushes updates in via this class's
 * methods instead of postMessage-ing its own sidebar webview directly.
 *
 * Keeps its own copy of the current code/status so that closing this panel
 * and reopening it (or a fresh "Open AI Generated Code" click after VS Code
 * restarts the extension host) shows the last-known state immediately,
 * rather than resetting to nothing.
 */
export class AiCodePanel implements vscode.Disposable {
  private panel: vscode.WebviewPanel | undefined;
  private readonly disposables: vscode.Disposable[] = [];

  private language: Language = 'java';
  private code = '';
  private status: 'idle' | 'generating' | 'error' = 'idle';
  private errorMessage = '';

  constructor(
    private readonly context: vscode.ExtensionContext,
    /** "Regenerate AI Code" — re-runs the same refinement pipeline with
     * whatever's current right now: the Playwright Code editor's live
     * content (including manual edits), Settings (language/version/browser),
     * the linked Gherkin scenario, and the checked Custom md files. Always
     * re-reads all of these fresh at the time of the click rather than
     * reusing anything cached from the last run, so a language/version
     * switch, a manual code edit, a fresh re-recording, or a change to
     * which instructions are checked all take effect on the next click. */
    private readonly onRegenerate: () => void
  ) {}

  isOpen(): boolean {
    return this.panel !== undefined;
  }

  show(): void {
    if (this.panel) {
      this.panel.reveal(vscode.ViewColumn.Beside);
      return;
    }
    this.panel = vscode.window.createWebviewPanel(
      'softPlayAiCode',
      'AI Generated Code',
      vscode.ViewColumn.Beside,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [vscode.Uri.joinPath(this.context.extensionUri, 'media')]
      }
    );
    this.panel.webview.html = this.getHtml(this.panel.webview);
    this.panel.webview.onDidReceiveMessage(
      (message: InboundMessage) => void this.handleMessage(message),
      undefined,
      this.disposables
    );
    this.panel.onDidDispose(() => { this.panel = undefined; }, undefined, this.disposables);
  }

  setLanguage(language: Language): void {
    this.language = language;
    this.panel?.webview.postMessage({ type: 'setLanguage', payload: language });
  }

  startGenerating(): void {
    this.status = 'generating';
    this.code = '';
    this.errorMessage = '';
    this.panel?.webview.postMessage({ type: 'start' });
  }

  appendChunk(chunk: string): void {
    this.code += chunk;
    this.panel?.webview.postMessage({ type: 'chunk', payload: chunk });
  }

  finish(finalCode: string): void {
    this.status = 'idle';
    this.code = finalCode;
    this.panel?.webview.postMessage({ type: 'done', payload: finalCode });
  }

  showError(message: string): void {
    this.status = 'error';
    this.errorMessage = message;
    this.panel?.webview.postMessage({ type: 'error', payload: message });
  }

  private async handleMessage(message: InboundMessage): Promise<void> {
    if (message.type === 'saveCode') {
      const isJava = this.language === 'java';
      const defaultName = isJava ? 'GeneratedTestAI.java' : 'test_recorded_flow_ai.py';
      const uri = await vscode.window.showSaveDialog({
        defaultUri: vscode.Uri.file(defaultName),
        filters: isJava ? { Java: ['java'] } : { Python: ['py'] }
      });
      if (!uri) {
        return;
      }
      await vscode.workspace.fs.writeFile(uri, Buffer.from(message.payload, 'utf8'));
      void vscode.window.showInformationMessage(`softPlay: saved ${path.basename(uri.fsPath)}`);
    } else if (message.type === 'regenerate') {
      this.onRegenerate();
    }
  }

  dispose(): void {
    this.panel?.dispose();
    this.disposables.forEach((d) => d.dispose());
  }

  private getHtml(webview: vscode.Webview): string {
    const highlightUri = webview.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, 'media', 'highlight.js'));
    const codeEditorUri = webview.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, 'media', 'codeEditor.js'));
    const nonce = getNonce();
    const escapedCode = escapeHtml(this.code);

    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>AI Generated Code</title>
  <style>
    html, body {
      height: 100%;
      margin: 0;
      font-family: -apple-system, BlinkMacSystemFont, var(--vscode-font-family), 'Segoe UI', sans-serif;
      color: var(--vscode-foreground);
      background: var(--vscode-editor-background);
    }
    body { display: flex; flex-direction: column; padding: 18px; box-sizing: border-box; }
    .header {
      display: flex;
      align-items: center;
      gap: 12px;
      margin-bottom: 12px;
      flex: none;
    }
    .header h1 {
      font-size: 1.1em;
      font-weight: 700;
      margin: 0;
      flex: 1;
    }
    .status {
      font-size: 0.85em;
      font-style: italic;
      color: var(--vscode-descriptionForeground);
    }
    .status.error { color: #e06c75; font-style: normal; font-weight: 600; }
    button.btn {
      padding: 6px 16px;
      border: none;
      border-radius: 10px;
      background: var(--vscode-button-secondaryBackground);
      color: var(--vscode-button-secondaryForeground);
      cursor: pointer;
      font-size: 0.9em;
      transition: transform 0.12s ease;
    }
    button.btn:hover:not(:disabled) { background: var(--vscode-button-secondaryHoverBackground); transform: translateY(-1px); }
    button.btn:active:not(:disabled) { transform: translateY(0); }
    button.btn:disabled { opacity: 0.5; cursor: not-allowed; }
    button.btn.btn-primary {
      background: var(--vscode-button-background);
      color: var(--vscode-button-foreground);
    }
    button.btn.btn-primary:hover:not(:disabled) { background: var(--vscode-button-hoverBackground); }
    .editor-wrap {
      position: relative;
      flex: 1;
      min-height: 0;
      border-radius: 14px;
      background: #1e1e1e;
      overflow: hidden;
    }
    body.vscode-dark .editor-wrap {
      box-shadow: 6px 6px 14px rgba(0, 0, 0, 0.35), -4px -4px 10px rgba(255, 255, 255, 0.03);
    }
    body.vscode-light .editor-wrap {
      box-shadow: 5px 5px 12px rgba(0, 0, 0, 0.10), -4px -4px 10px rgba(255, 255, 255, 0.7);
    }
    .gutter {
      position: absolute;
      inset: 0 auto 0 0;
      width: 48px;
      overflow: hidden;
      margin: 0;
      padding: 12px 10px 12px 0;
      font-family: var(--vscode-editor-font-family, 'Courier New', monospace);
      font-size: 0.92em;
      line-height: 1.55;
      text-align: right;
      color: #6e7681;
      background: rgba(255, 255, 255, 0.03);
      border-right: 1px solid rgba(255, 255, 255, 0.08);
      white-space: pre;
      box-sizing: border-box;
      user-select: none;
      pointer-events: none;
    }
    .highlight, .edit-area {
      position: absolute;
      inset: 0 0 0 48px;
      margin: 0;
      padding: 12px 16px;
      font-family: var(--vscode-editor-font-family, 'Courier New', monospace);
      font-size: 0.92em;
      line-height: 1.55;
      white-space: pre;
      tab-size: 4;
      box-sizing: border-box;
    }
    .highlight { color: #d4d4d4; overflow: hidden; pointer-events: none; }
    .edit-area {
      overflow: auto;
      background: transparent;
      color: transparent;
      caret-color: #ffffff;
      border: none;
      outline: none;
      resize: none;
    }
    .tok-keyword { color: #569cd6; }
    .tok-string { color: #ce9178; }
    .tok-comment { color: #6a9955; font-style: italic; }
    .tok-number { color: #b5cea8; }
    .tok-annotation { color: #dcdcaa; }
    .tok-method { color: #dcdcaa; }
    .tok-class { color: #4ec9b0; }
  </style>
</head>
<body>
  <div class="header">
    <h1>AI Generated Code</h1>
    <span id="status" class="status"></span>
    <button id="regenerateBtn" class="btn btn-primary" title="Re-send the current Playwright Code (including any manual edits), Settings, linked scenario, and checked Custom md files to the LLM">Regenerate AI Code</button>
    <button id="copyBtn" class="btn">Copy Code</button>
    <button id="saveBtn" class="btn">Save Code</button>
  </div>
  <div class="editor-wrap">
    <div id="gutter" class="gutter"></div>
    <pre id="highlight" class="highlight" aria-hidden="true"><code></code></pre>
    <textarea id="editArea" class="edit-area" spellcheck="false">${escapedCode}</textarea>
  </div>

  <script nonce="${nonce}" src="${highlightUri}"></script>
  <script nonce="${nonce}" src="${codeEditorUri}"></script>
  <script nonce="${nonce}">
    (function () {
      const vscode = acquireVsCodeApi();
      const statusEl = document.getElementById('status');
      const regenerateBtn = document.getElementById('regenerateBtn');
      const copyBtn = document.getElementById('copyBtn');
      const saveBtn = document.getElementById('saveBtn');
      const editArea = document.getElementById('editArea');
      const highlightPre = document.getElementById('highlight');
      const gutter = document.getElementById('gutter');

      const editor = window.createCodeEditor(editArea, highlightPre, gutter);
      editor.setLanguage(${JSON.stringify(this.language)});
      ${this.status === 'error' ? `statusEl.textContent = 'Error'; statusEl.className = 'status error';` : ''}

      copyBtn.addEventListener('click', async () => {
        const text = editor.getValue();
        try {
          await navigator.clipboard.writeText(text);
        } catch (e) {
          const ta = document.createElement('textarea');
          ta.value = text;
          ta.style.position = 'fixed';
          ta.style.opacity = '0';
          document.body.appendChild(ta);
          ta.focus();
          ta.select();
          document.execCommand('copy');
          document.body.removeChild(ta);
        }
        const original = copyBtn.textContent;
        copyBtn.textContent = 'Copied!';
        copyBtn.disabled = true;
        setTimeout(() => { copyBtn.textContent = original; copyBtn.disabled = false; }, 1200);
      });

      saveBtn.addEventListener('click', () => {
        vscode.postMessage({ type: 'saveCode', payload: editor.getValue() });
      });

      // Re-sends whatever's current right now (Playwright Code with any
      // manual edits, Settings, linked scenario, checked Custom md files —
      // all re-read fresh on the extension host side, not cached from the
      // last run) to the LLM. Disabled while a request is already in
      // flight so a second click can't race the first.
      regenerateBtn.addEventListener('click', () => {
        vscode.postMessage({ type: 'regenerate' });
      });

      window.addEventListener('message', (event) => {
        const message = event.data;
        switch (message.type) {
          case 'setLanguage':
            editor.setLanguage(message.payload);
            break;
          case 'start':
            statusEl.textContent = '(generating…)';
            statusEl.className = 'status';
            regenerateBtn.disabled = true;
            editor.setValue('');
            break;
          case 'chunk':
            editor.appendValue(message.payload);
            break;
          case 'done':
            statusEl.textContent = '';
            statusEl.className = 'status';
            regenerateBtn.disabled = false;
            editor.setValue(message.payload);
            break;
          case 'error':
            statusEl.textContent = 'Error';
            statusEl.className = 'status error';
            regenerateBtn.disabled = false;
            editor.setValue('// ' + message.payload);
            break;
        }
      });
    })();
  </script>
</body>
</html>`;
  }
}

function getNonce(): string {
  let text = '';
  const possible = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  for (let i = 0; i < 32; i++) {
    text += possible.charAt(Math.floor(Math.random() * possible.length));
  }
  return text;
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}
