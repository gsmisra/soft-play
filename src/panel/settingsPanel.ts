import * as vscode from 'vscode';
import { LANGUAGE_VERSIONS, Language, ObjectSpySettings, SettingsStore } from '../settings/settingsStore';
import { listCopilotModels } from '../llm/copilotClient';

type InboundMessage =
  | { type: 'update'; payload: Partial<ObjectSpySettings> }
  | { type: 'listModels' };

/**
 * The Settings menu — deliberately a separate webview panel from the main
 * UI, not a section bolted onto it. Controls the browser channel, the
 * generated code's language/runtime version, and GitHub Copilot linking,
 * all persisted via SettingsStore (context.globalState).
 */
export class SettingsPanel implements vscode.Disposable {
  private panel: vscode.WebviewPanel | undefined;
  private readonly disposables: vscode.Disposable[] = [];

  constructor(private readonly context: vscode.ExtensionContext, private readonly settingsStore: SettingsStore) {
    this.disposables.push(this.settingsStore.onChange((settings) => this.postSettings(settings)));
  }

  show(): void {
    if (this.panel) {
      this.panel.reveal(vscode.ViewColumn.Beside);
      return;
    }

    this.panel = vscode.window.createWebviewPanel(
      'objectSpySettings',
      'softPlay: Settings',
      vscode.ViewColumn.Beside,
      { enableScripts: true, retainContextWhenHidden: true }
    );

    this.panel.webview.html = this.getHtml();

    this.panel.webview.onDidReceiveMessage(
      (message: InboundMessage) => void this.handleMessage(message),
      undefined,
      this.disposables
    );

    this.panel.onDidDispose(
      () => {
        this.panel = undefined;
      },
      undefined,
      this.disposables
    );

    this.postSettings(this.settingsStore.get());
  }

  dispose(): void {
    this.panel?.dispose();
    this.disposables.forEach((d) => d.dispose());
  }

  private async handleMessage(message: InboundMessage): Promise<void> {
    if (message.type === 'update') {
      await this.settingsStore.update(message.payload);
    } else if (message.type === 'listModels') {
      const models = await listCopilotModels();
      this.panel?.webview.postMessage({ type: 'models', payload: models });
    }
  }

  private postSettings(settings: ObjectSpySettings): void {
    this.panel?.webview.postMessage({
      type: 'settings',
      payload: settings,
      languageVersions: LANGUAGE_VERSIONS
    });
  }

  private getHtml(): string {
    const nonce = getNonce();
    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>softPlay Settings</title>
  <style>
    body {
      font-family: var(--vscode-font-family);
      color: var(--vscode-foreground);
      background-color: var(--vscode-editor-background);
      padding: 16px 20px;
    }
    h2 {
      font-size: 1em;
      text-transform: uppercase;
      letter-spacing: 0.04em;
      color: var(--vscode-descriptionForeground);
      margin: 20px 0 8px;
      border-bottom: 1px solid var(--vscode-panel-border);
      padding-bottom: 4px;
    }
    h2:first-of-type { margin-top: 0; }
    .field {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 12px;
      padding: 6px 0;
    }
    .field label { flex: 1; }
    .field .hint {
      display: block;
      font-size: 0.8em;
      color: var(--vscode-descriptionForeground);
      margin-top: 2px;
    }
    select {
      min-width: 160px;
      padding: 3px 6px;
      background: var(--vscode-dropdown-background);
      color: var(--vscode-dropdown-foreground);
      border: 1px solid var(--vscode-dropdown-border, transparent);
      border-radius: 2px;
    }
    .radio-group { display: flex; gap: 14px; }
    .radio-group label { display: flex; align-items: center; gap: 4px; flex: none; }
    .note {
      margin-top: 24px;
      font-size: 0.85em;
      color: var(--vscode-descriptionForeground);
    }
    /* Toggle switch, matching common editor styling — a styled checkbox.
       Fixed: the track used to fall back to --vscode-dropdown-border, which
       is unset (fully transparent) in several built-in themes — the switch
       was there and functioned, but its "off" state was nearly invisible.
       --vscode-checkbox-border is the variable VS Code itself defines
       specifically for checkbox-like controls and always has real contrast,
       so both states stay visible in every theme. */
    .switch {
      position: relative;
      display: inline-block;
      width: 36px;
      height: 20px;
      flex: none;
    }
    .switch input {
      position: absolute;
      inset: 0;
      opacity: 0;
      margin: 0;
      cursor: pointer;
      z-index: 1;
    }
    .switch-track {
      position: absolute;
      inset: 0;
      background: var(--vscode-checkbox-border, #767676);
      border: 1px solid var(--vscode-contrastBorder, transparent);
      border-radius: 10px;
      transition: background 0.15s;
      pointer-events: none;
    }
    .switch-track::before {
      content: '';
      position: absolute;
      width: 14px;
      height: 14px;
      left: 3px;
      top: 2px;
      background: #fff;
      border-radius: 50%;
      transition: transform 0.15s;
    }
    .switch input:checked + .switch-track {
      background: var(--vscode-button-background, #0b6bb8);
    }
    .switch input:checked + .switch-track::before {
      transform: translateX(16px);
    }
    #copilotModelRow, #copilotStatus { display: none; }
    #copilotModelRow.visible, #copilotStatus.visible { display: flex; }
    .status-text {
      font-size: 0.82em;
      color: var(--vscode-descriptionForeground);
    }
  </style>
</head>
<body>
  <h2>Browser</h2>
  <div class="field">
    <label>
      Browser
      <span class="hint">Chrome or Edge only — this extension never downloads a browser of its own.</span>
    </label>
    <div class="radio-group">
      <label><input type="radio" name="browserChannel" value="chrome" /> Chrome</label>
      <label><input type="radio" name="browserChannel" value="edge" /> Edge</label>
    </div>
  </div>

  <h2>Code Generation</h2>
  <div class="field">
    <label>
      Language
      <span class="hint">Playwright codegen (Start) emits automation in this language — passed through as its own --target flag.</span>
    </label>
    <select id="language">
      <option value="java">Java</option>
      <option value="python">Python</option>
    </select>
  </div>
  <div class="field">
    <label>
      Language / runtime version
      <span class="hint">Affects generated syntax idioms only — never the extension's own runtime.</span>
    </label>
    <select id="languageVersion"></select>
  </div>

  <h2>AI Assist</h2>
  <div class="field">
    <label>
      Link with GitHub Copilot LLM
      <span class="hint">Lets Generate Code send its output and captured locators to a Copilot chat model for a second, AI-generated version to compare side by side. Requires the GitHub Copilot Chat extension.</span>
    </label>
    <label class="switch">
      <input type="checkbox" id="copilotEnabled" />
      <span class="switch-track"></span>
    </label>
  </div>
  <div class="field" id="copilotModelRow">
    <label>Model</label>
    <select id="copilotModel"></select>
  </div>
  <div class="field" id="copilotStatus">
    <span class="status-text" id="copilotStatusText"></span>
  </div>

  <p class="note">Changes apply immediately and persist across VS Code restarts.</p>

  <script nonce="${nonce}">
    (function () {
      const vscode = acquireVsCodeApi();
      const languageSelect = document.getElementById('language');
      const versionSelect = document.getElementById('languageVersion');
      const copilotEnabled = document.getElementById('copilotEnabled');
      const copilotModelRow = document.getElementById('copilotModelRow');
      const copilotModelSelect = document.getElementById('copilotModel');
      const copilotStatus = document.getElementById('copilotStatus');
      const copilotStatusText = document.getElementById('copilotStatusText');
      let languageVersions = {};
      let pendingModelId = '';

      document.querySelectorAll('input[name="browserChannel"]').forEach((radio) => {
        radio.addEventListener('change', () => {
          if (radio.checked) {
            vscode.postMessage({ type: 'update', payload: { browserChannel: radio.value } });
          }
        });
      });

      languageSelect.addEventListener('change', () => {
        vscode.postMessage({ type: 'update', payload: { language: languageSelect.value } });
      });

      versionSelect.addEventListener('change', () => {
        vscode.postMessage({ type: 'update', payload: { languageVersion: versionSelect.value } });
      });

      copilotEnabled.addEventListener('change', () => {
        const enabled = copilotEnabled.checked;
        copilotModelRow.classList.toggle('visible', enabled);
        copilotStatus.classList.toggle('visible', enabled);
        vscode.postMessage({ type: 'update', payload: { copilotEnabled: enabled } });
        if (enabled) {
          copilotStatusText.textContent = 'Looking for GitHub Copilot chat models…';
          vscode.postMessage({ type: 'listModels' });
        }
      });

      copilotModelSelect.addEventListener('change', () => {
        vscode.postMessage({ type: 'update', payload: { copilotModelId: copilotModelSelect.value } });
      });

      function renderModels(models) {
        copilotModelSelect.innerHTML = '';
        if (!models.length) {
          copilotStatusText.textContent =
            'No Copilot chat models found. Is GitHub Copilot Chat installed and are you signed in?';
          return;
        }
        copilotStatusText.textContent = models.length + ' model(s) available.';
        for (const m of models) {
          const opt = document.createElement('option');
          opt.value = m.id;
          opt.textContent = m.name + ' (' + m.family + ')';
          if (m.id === pendingModelId) {
            opt.selected = true;
          }
          copilotModelSelect.appendChild(opt);
        }
        // No prior selection, or it's no longer offered -- persist whichever
        // the browser defaulted to (the first model) so Settings and the
        // main panel agree on what will actually be used.
        if (!models.some((m) => m.id === pendingModelId)) {
          vscode.postMessage({ type: 'update', payload: { copilotModelId: copilotModelSelect.value } });
        }
      }

      function renderVersions(language, selected) {
        const versions = languageVersions[language] || [];
        versionSelect.innerHTML = '';
        for (const v of versions) {
          const opt = document.createElement('option');
          opt.value = v;
          opt.textContent = v;
          if (v === selected) {
            opt.selected = true;
          }
          versionSelect.appendChild(opt);
        }
      }

      window.addEventListener('message', (event) => {
        const message = event.data;
        if (message.type === 'models') {
          renderModels(message.payload);
          return;
        }
        if (message.type !== 'settings') {
          return;
        }
        languageVersions = message.languageVersions;
        const settings = message.payload;

        document.querySelectorAll('input[name="browserChannel"]').forEach((radio) => {
          radio.checked = radio.value === settings.browserChannel;
        });
        languageSelect.value = settings.language;
        renderVersions(settings.language, settings.languageVersion);

        copilotEnabled.checked = settings.copilotEnabled;
        pendingModelId = settings.copilotModelId;
        copilotModelRow.classList.toggle('visible', settings.copilotEnabled);
        copilotStatus.classList.toggle('visible', settings.copilotEnabled);
        if (settings.copilotEnabled) {
          copilotStatusText.textContent = 'Looking for GitHub Copilot chat models…';
          vscode.postMessage({ type: 'listModels' });
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

// Re-exported for anything that only needs the type name from this module.
export type { Language };
