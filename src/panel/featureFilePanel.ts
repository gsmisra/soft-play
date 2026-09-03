import * as vscode from 'vscode';
import * as path from 'path';
import { parseFeatureFile, buildFilteredScenarioText, GherkinFeature, GherkinScenario } from '../bdd/gherkinParser';
import { highlightGherkin, escapeHtml } from '../bdd/gherkinHighlight';
import { deriveJavaClassName, derivePythonModuleName } from '../bdd/testNaming';

/** What gets handed back to ObjectSpyPanel when the user picks a scenario —
 * everything the LLM prompt (and the Control Panel's "linked scenario"
 * badge) need. `rawText` is the scenario reconstructed down to only the
 * steps the user left checked in the per-step checkboxes (see
 * gherkinParser.ts's buildFilteredScenarioText) — the exact Gherkin text
 * that's actually sent to the LLM, never the full scenario when some steps
 * were deselected. */
export interface LinkedScenario {
  featureName: string;
  featureFilePath: string;
  scenarioName: string;
  scenarioKind: GherkinScenario['kind'];
  rawText: string;
  /** The feature's Background steps, if any — prepended when building the
   * LLM prompt, since a scenario's steps alone don't include setup that
   * Background implies but every scenario in the file still runs. Always
   * sent in full — Background steps aren't individually selectable, only a
   * scenario's own steps are. */
  backgroundRawText: string | undefined;
  /** How many of the scenario's own steps the user left checked / how many
   * it has in total — surfaced in the Control Panel badge and the Output
   * channel log so it's always visible when the AI context is a subset. */
  selectedStepCount: number;
  totalStepCount: number;
  /** Scenario name transformed into a valid class name — PascalCase for
   * Java (`SearchTermOpenFirstResult`), snake_case for Python
   * (`search_term_open_first_result`) — see testNaming.ts. Resolved to
   * both up front since which one applies depends on the target language in
   * Settings, which can change after this scenario was linked. */
  javaClassName: string;
  pythonModuleName: string;
}

type InboundMessage =
  | { type: 'select'; payload: { index: number; selectedStepIndices: number[] } }
  | { type: 'close' }
  | { type: 'browseNew' };

/**
 * "Link Feature file" (Control Panel) — browses to a .feature file, parses
 * it (gherkinParser.ts), and shows every Scenario/Scenario Outline as an
 * individually selectable, syntax-highlighted segment (gherkinHighlight.ts).
 * Picking one calls back into ObjectSpyPanel with a LinkedScenario, then
 * this panel can just be closed/switched away from (VS Code's own tab UI —
 * nothing special needed here for "minimize") — the selection lives in
 * ObjectSpyPanel, not in this panel's own webview state, so closing this
 * view never loses it.
 *
 * The linked FILE itself (`filePath`/`feature`) is equally durable — see
 * `hasLinkedFile()`. Once a file has been opened, it stays cached and
 * available for the rest of the VS Code session: closing this view and
 * clicking "Link Feature File" again reopens the SAME file instantly (no OS
 * browse dialog), and only linking a genuinely different file (via this
 * view's own "Browse Different File…" button) or closing VS Code itself
 * changes it. ObjectSpyPanel is what actually decides browseAndOpen() vs.
 * reopenLastFile() based on hasLinkedFile() — see its "Link Feature File"
 * button handler.
 */
export class FeatureFilePanel implements vscode.Disposable {
  private panel: vscode.WebviewPanel | undefined;
  private feature: GherkinFeature | undefined;
  private filePath = '';
  private readonly disposables: vscode.Disposable[] = [];

  constructor(
    private readonly onScenarioSelected: (scenario: LinkedScenario) => void,
    /** Fired once a file has been successfully parsed — independent of
     * whether the user goes on to pick a scenario — so the Control Panel
     * can relabel its button ("Link Feature File" -> "View Feature File")
     * the moment a file becomes available to reopen without a dialog. */
    private readonly onFileLinked: (filePath: string) => void
  ) {}

  /** True once a file has been successfully parsed at least once this
   * session — stays true even after the user closes the view or picks a
   * scenario, and even if they never picked one at all. Drives the Control
   * Panel's "Link Feature File" button: reopen the cached file (no OS
   * dialog) once this is true, only browse when it's still false. Reset
   * only by linking a genuinely different file, never by closing the view —
   * per the explicit ask that the file stay available until a new one is
   * linked or VS Code itself closes. */
  hasLinkedFile(): boolean {
    return this.filePath !== '';
  }

  getLinkedFilePath(): string {
    return this.filePath;
  }

  async browseAndOpen(): Promise<void> {
    const uris = await vscode.window.showOpenDialog({
      canSelectMany: false,
      filters: { 'Cucumber Feature': ['feature'] },
      openLabel: 'Link Feature File'
    });
    if (!uris || uris.length === 0) {
      return;
    }
    await this.openFile(uris[0]);
  }

  /** Reopens the scenario picker for whichever feature file was last
   * linked, re-reading it from disk (so edits since then show up) without
   * a fresh OS browse dialog — lets picking a different Scenario/Scenario
   * Outline from the SAME file (explicitly asked for: "select a new
   * scenario ... using the same feature file") stay a single click on the
   * Control Panel's linked-scenario badge. Falls back to the normal browse
   * dialog if nothing has been linked yet. */
  async reopenLastFile(): Promise<void> {
    if (!this.filePath) {
      await this.browseAndOpen();
      return;
    }
    await this.openFile(vscode.Uri.file(this.filePath));
  }

  private async openFile(uri: vscode.Uri): Promise<void> {
    let content: string;
    try {
      const bytes = await vscode.workspace.fs.readFile(uri);
      content = new TextDecoder('utf-8').decode(bytes);
    } catch (err) {
      void vscode.window.showErrorMessage(`softPlay: could not read feature file — ${describeError(err)}`);
      return;
    }

    this.filePath = uri.fsPath;
    this.feature = parseFeatureFile(content);
    this.onFileLinked(this.filePath);

    if (this.feature.scenarios.length === 0) {
      void vscode.window.showWarningMessage(
        'softPlay: no Scenario or Scenario Outline found in that file — check it\'s a valid .feature file.'
      );
      return;
    }

    this.show();
  }

  private show(): void {
    if (this.panel) {
      this.panel.reveal(vscode.ViewColumn.Beside);
      this.render();
      return;
    }
    this.panel = vscode.window.createWebviewPanel(
      'softPlayFeatureFile',
      `Feature: ${this.feature?.name || path.basename(this.filePath)}`,
      vscode.ViewColumn.Beside,
      { enableScripts: true, retainContextWhenHidden: true }
    );
    this.panel.onDidDispose(() => { this.panel = undefined; }, undefined, this.disposables);
    this.panel.webview.onDidReceiveMessage(
      (message: InboundMessage) => this.handleMessage(message),
      undefined,
      this.disposables
    );
    this.render();
  }

  private handleMessage(message: InboundMessage): void {
    if (message.type === 'close') {
      this.panel?.dispose();
      return;
    }
    if (message.type === 'browseNew') {
      // Explicit "switch to a different file" — the only other way to
      // change which file is linked besides picking a different scenario
      // stays a no-op; this genuinely replaces this.filePath/this.feature.
      void this.browseAndOpen();
      return;
    }
    if (message.type === 'select' && this.feature) {
      const scenario = this.feature.scenarios[message.payload.index];
      if (!scenario) {
        return;
      }
      // Defensive against a stale/tampered payload (e.g. an out-of-range or
      // duplicated index): clamp to this scenario's actual step indices
      // rather than trusting the webview's list verbatim.
      const validIndices = new Set(scenario.steps.map((_, idx) => idx));
      const selectedStepIndices = Array.from(new Set(message.payload.selectedStepIndices)).filter((idx) =>
        validIndices.has(idx)
      );
      this.onScenarioSelected({
        featureName: this.feature.name,
        featureFilePath: this.filePath,
        scenarioName: scenario.name,
        scenarioKind: scenario.kind,
        rawText: buildFilteredScenarioText(scenario, selectedStepIndices),
        backgroundRawText: this.feature.background?.rawText,
        selectedStepCount: selectedStepIndices.length,
        totalStepCount: scenario.steps.length,
        javaClassName: deriveJavaClassName(scenario.name),
        pythonModuleName: derivePythonModuleName(scenario.name)
      });
    }
  }

  dispose(): void {
    this.panel?.dispose();
    this.disposables.forEach((d) => d.dispose());
  }

  private render(): void {
    if (!this.panel || !this.feature) {
      return;
    }
    this.panel.webview.html = getHtml(this.feature, this.filePath);
  }
}

/**
 * Renders one scenario's tags/name line, then every one of its own steps as
 * its own syntax-highlighted, individually checkable row (checked by
 * default — "By default all steps will be selected, but user can deselect
 * any step"), then its Examples table(s) if it's a Scenario Outline
 * (not individually selectable — an Outline's steps only make sense
 * together with the placeholders their Examples table fills in). Each
 * checkbox's `data-step` is that step's index into `scenario.steps`,
 * exactly what buildFilteredScenarioText() (gherkinParser.ts) expects back
 * from the 'select' message's `selectedStepIndices`.
 */
function renderScenarioBody(scenario: GherkinScenario, scenarioIndex: number): string {
  const headerLines: string[] = [];
  if (scenario.tags.length) {
    headerLines.push(`@${scenario.tags.join(' @')}`);
  }
  headerLines.push(`${scenario.kind}: ${scenario.name}`);
  const headerHtml = `<pre class="gk-scenario-headline">${highlightGherkin(headerLines.join('\n'))}</pre>`;

  const stepsHtml = scenario.steps
    .map(
      (step, stepIndex) => `
      <label class="gk-step-row">
        <input type="checkbox" class="gk-step-check" data-scenario="${scenarioIndex}" data-step="${stepIndex}" checked />
        <pre class="gk-step-line">${highlightGherkin(step.rawText)}</pre>
      </label>`
    )
    .join('\n');

  const examplesHtml = scenario.examples
    .map((ex) => `<pre class="gk-examples-block">${highlightGherkin(ex.rawText)}</pre>`)
    .join('\n');

  return `<div class="gk-text gk-scenario-body">${headerHtml}${stepsHtml}${examplesHtml}</div>`;
}

function getHtml(feature: GherkinFeature, filePath: string): string {
  const nonce = getNonce();

  const backgroundHtml = feature.background
    ? `<div class="gk-block gk-background">
        <div class="gk-block-label">Background</div>
        <pre class="gk-text">${highlightGherkin(feature.background.rawText)}</pre>
      </div>`
    : '';

  const scenariosHtml = feature.scenarios
    .map((scenario, index) => {
      const exampleCount = scenario.examples.reduce((sum, ex) => sum + ex.rows.length, 0);
      const meta =
        scenario.kind === 'Scenario Outline'
          ? `<span class="gk-block-meta">${exampleCount} example row${exampleCount === 1 ? '' : 's'}</span>`
          : '';
      return `
      <div class="gk-block gk-scenario">
        <label class="gk-scenario-header">
          <input type="radio" name="scenarioPick" value="${index}" />
          <span class="gk-block-label">${escapeHtml(scenario.kind)}: ${escapeHtml(scenario.name)}</span>
          ${meta}
        </label>
        ${renderScenarioBody(scenario, index)}
      </div>`;
    })
    .join('\n');

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Feature File</title>
  <style>
    body {
      font-family: var(--vscode-font-family);
      color: var(--vscode-foreground);
      background: var(--vscode-editor-background);
      margin: 0;
      padding: 0;
    }
    .gk-toolbar {
      position: sticky;
      top: 0;
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 10px;
      padding: 10px 16px;
      background: var(--vscode-editor-background);
      border-bottom: 1px solid var(--vscode-panel-border);
      z-index: 1;
    }
    .gk-file-path {
      font-size: 0.8em;
      color: var(--vscode-descriptionForeground);
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .gk-toolbar-actions { display: flex; gap: 8px; flex: none; }
    button.btn {
      background: var(--vscode-button-background);
      color: var(--vscode-button-foreground);
      border: none;
      border-radius: 2px;
      padding: 4px 12px;
      cursor: pointer;
      font-size: 0.9em;
    }
    button.btn:hover { background: var(--vscode-button-hoverBackground); }
    button.btn:disabled { opacity: 0.5; cursor: not-allowed; }
    button.btn-secondary {
      background: var(--vscode-button-secondaryBackground, transparent);
      color: var(--vscode-button-secondaryForeground, var(--vscode-foreground));
      border: 1px solid var(--vscode-panel-border);
    }
    .gk-feature-title {
      padding: 12px 16px 4px;
      font-size: 1.1em;
      font-weight: 600;
    }
    .gk-feature-desc {
      padding: 0 16px 10px;
      color: var(--vscode-descriptionForeground);
      white-space: pre-wrap;
      font-size: 0.9em;
    }
    .gk-block {
      margin: 0 16px 14px;
      border: 1px solid var(--vscode-panel-border);
      border-radius: 4px;
      overflow: hidden;
    }
    .gk-background .gk-block-label {
      padding: 6px 12px;
      background: rgba(127, 127, 127, 0.12);
    }
    .gk-scenario-header {
      display: flex;
      align-items: center;
      gap: 8px;
      padding: 8px 12px;
      background: rgba(127, 127, 127, 0.12);
      cursor: pointer;
    }
    .gk-scenario-header input { flex: none; }
    .gk-block-label { font-weight: 600; }
    .gk-block-meta {
      margin-left: auto;
      font-size: 0.8em;
      color: var(--vscode-descriptionForeground);
    }
    .gk-text {
      margin: 0;
      padding: 10px 14px;
      /* Black background regardless of the active VS Code theme — Gherkin
         keyword/param/table colors below are chosen against black
         specifically, per the requested "white text on black background". */
      background: #000;
      color: #e8e8e8;
      font-family: var(--vscode-editor-font-family, monospace);
      font-size: var(--vscode-editor-font-size, 13px);
      white-space: pre;
      overflow-x: auto;
    }
    .gk-keyword {
      font-weight: bold;
      font-style: italic;
      color: #ff7ab6;
    }
    .gk-colon { color: #e8e8e8; }
    .gk-tag { color: #4ec9b0; font-weight: bold; }
    .gk-comment { color: #6a9955; font-style: italic; }
    .gk-param { color: #9cdcfe; }
    .gk-pipe { color: #808080; }
    .gk-table-cell { color: #ffe600; font-weight: 600; }
    .gk-docstring-fence { color: #808080; }
    .gk-scenario-headline, .gk-step-line, .gk-examples-block {
      margin: 0;
      padding: 0;
      background: transparent;
      font: inherit;
      white-space: pre;
    }
    .gk-scenario-headline { margin-bottom: 4px; }
    .gk-examples-block { margin-top: 6px; }
    .gk-step-row {
      display: flex;
      align-items: flex-start;
      gap: 8px;
      padding: 2px 0;
      cursor: pointer;
    }
    .gk-step-check {
      flex: none;
      margin: 0.35em 0 0;
      cursor: pointer;
    }
    .gk-step-line { flex: 1; overflow-x: auto; }
  </style>
</head>
<body>
  <div class="gk-toolbar">
    <span class="gk-file-path" title="${escapeHtml(filePath)}">${escapeHtml(filePath)}</span>
    <div class="gk-toolbar-actions">
      <button id="useBtn" class="btn" disabled>Use Selected Scenario</button>
      <button id="browseNewBtn" class="btn btn-secondary" title="Link a different .feature file instead">Browse Different File…</button>
      <button id="closeBtn" class="btn btn-secondary">Close</button>
    </div>
  </div>
  <div class="gk-feature-title">Feature: ${escapeHtml(feature.name)}</div>
  ${feature.description ? `<div class="gk-feature-desc">${escapeHtml(feature.description)}</div>` : ''}
  ${backgroundHtml}
  ${scenariosHtml}

  <script nonce="${nonce}">
    (function () {
      const vscode = acquireVsCodeApi();
      const useBtn = document.getElementById('useBtn');
      const closeBtn = document.getElementById('closeBtn');
      const browseNewBtn = document.getElementById('browseNewBtn');
      let selectedIndex = null;

      // "Use Selected Scenario" needs both a scenario picked AND at least
      // one of its steps still checked — sending zero steps would mean
      // nothing at all gets analyzed or generated, which is never useful.
      function updateUseButtonState() {
        if (selectedIndex === null) {
          useBtn.disabled = true;
          return;
        }
        const anyStepChecked =
          document.querySelector('.gk-step-check[data-scenario="' + selectedIndex + '"]:checked') !== null;
        useBtn.disabled = !anyStepChecked;
      }

      document.querySelectorAll('input[name="scenarioPick"]').forEach((radio) => {
        radio.addEventListener('change', () => {
          selectedIndex = Number(radio.value);
          updateUseButtonState();
        });
      });

      // Each checkbox lives inside a <label class="gk-step-row">, so
      // clicking anywhere on the row (not just the small checkbox itself)
      // toggles it via the browser's normal label behavior — no extra
      // wiring needed for that, just react to the resulting 'change'.
      document.querySelectorAll('.gk-step-check').forEach((checkbox) => {
        checkbox.addEventListener('change', updateUseButtonState);
      });

      useBtn.addEventListener('click', () => {
        if (selectedIndex === null) return;
        const selectedStepIndices = Array.from(
          document.querySelectorAll('.gk-step-check[data-scenario="' + selectedIndex + '"]:checked')
        ).map((cb) => Number(cb.getAttribute('data-step')));
        if (selectedStepIndices.length === 0) return;
        vscode.postMessage({ type: 'select', payload: { index: selectedIndex, selectedStepIndices } });
      });

      closeBtn.addEventListener('click', () => {
        vscode.postMessage({ type: 'close' });
      });

      browseNewBtn.addEventListener('click', () => {
        vscode.postMessage({ type: 'browseNew' });
      });
    })();
  </script>
</body>
</html>`;
}

function getNonce(): string {
  let text = '';
  const possible = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  for (let i = 0; i < 32; i++) {
    text += possible.charAt(Math.floor(Math.random() * possible.length));
  }
  return text;
}

function describeError(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
