import * as vscode from 'vscode';
import * as path from 'path';

type InboundMessage = { type: 'saveFeature'; payload: string } | { type: 'regenerate' };

/**
 * "Generate Gherkin Feature File" as its own full-size editor-area panel
 * (ViewColumn.Beside), mirroring AiCodePanel's shape and behavior exactly
 * (streamed generation, editable Gherkin-highlighted textarea, Copy/Save,
 * Regenerate) but for the OPPOSITE direction of that feature: instead of
 * turning a linked .feature scenario + recorded code into refined
 * automation code, this turns recorded Playwright Codegen code alone (no
 * feature file needed — see the Control Panel's "Generate Gherkin Feature
 * File" button, for when the user hasn't linked one yet) into a NEW,
 * business-focused BDD .feature file (see
 * prompts/generate-feature-file.md). ObjectSpyPanel still owns the actual
 * Copilot request/response lifecycle; this is purely where the result gets
 * displayed.
 */
export class GeneratedFeaturePanel implements vscode.Disposable {
  private panel: vscode.WebviewPanel | undefined;
  private readonly disposables: vscode.Disposable[] = [];

  private featureText = '';
  private status: 'idle' | 'generating' | 'error' = 'idle';

  constructor(
    private readonly context: vscode.ExtensionContext,
    /** "Regenerate" — re-runs feature-file generation with whatever the
     * Playwright Code editor's live content is right now (including any
     * manual edits) and whatever's currently in the chat composer. */
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
      'softPlayGeneratedFeature',
      'Generated Feature File',
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

  startGenerating(): void {
    this.status = 'generating';
    this.featureText = '';
    this.panel?.webview.postMessage({ type: 'start' });
  }

  appendChunk(chunk: string): void {
    this.featureText += chunk;
    this.panel?.webview.postMessage({ type: 'chunk', payload: chunk });
  }

  finish(finalText: string): void {
    this.status = 'idle';
    this.featureText = finalText;
    this.panel?.webview.postMessage({ type: 'done', payload: finalText });
  }

  showError(message: string): void {
    this.status = 'error';
    this.panel?.webview.postMessage({ type: 'error', payload: message });
  }

  private async handleMessage(message: InboundMessage): Promise<void> {
    if (message.type === 'saveFeature') {
      const uri = await vscode.window.showSaveDialog({
        defaultUri: vscode.Uri.file('GeneratedFeature.feature'),
        filters: { 'Cucumber Feature': ['feature'] }
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
    const escapedText = escapeHtml(this.featureText);

    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Generated Feature File</title>
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
    .tok-keyword { color: #ff7ab6; font-weight: bold; font-style: italic; }
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
    <h1>Generated Feature File</h1>
    <span id="status" class="status"></span>
    <button id="regenerateBtn" class="btn btn-primary" title="Re-send the current Playwright Code (including any manual edits) and chat box content to the LLM">Regenerate</button>
    <button id="copyBtn" class="btn">Copy</button>
    <button id="saveBtn" class="btn">Save .feature</button>
  </div>
  <div class="editor-wrap">
    <div id="gutter" class="gutter"></div>
    <pre id="highlight" class="highlight" aria-hidden="true"><code></code></pre>
    <textarea id="editArea" class="edit-area" spellcheck="false">${escapedText}</textarea>
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
      editor.setLanguage('gherkin');
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
        vscode.postMessage({ type: 'saveFeature', payload: editor.getValue() });
      });

      regenerateBtn.addEventListener('click', () => {
        vscode.postMessage({ type: 'regenerate' });
      });

      window.addEventListener('message', (event) => {
        const message = event.data;
        switch (message.type) {
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
            editor.setValue('# ' + message.payload);
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
