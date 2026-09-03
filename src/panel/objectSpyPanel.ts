import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { CodegenManager, CodegenStatus } from '../browser/codegenManager';
import { SettingsStore } from '../settings/settingsStore';
import { SettingsPanel } from './settingsPanel';
import { FeatureFilePanel, LinkedScenario } from './featureFilePanel';
import { AiCodePanel } from './aiCodePanel';
import { CopilotUnavailableError, extractCodeBlock, sendPrompt } from '../llm/copilotClient';

type InboundMessage =
  | { type: 'start'; payload?: string }
  | { type: 'stop' }
  | { type: 'openSettings' }
  | { type: 'saveCode'; payload: string }
  | { type: 'killAllBrowsers' }
  | { type: 'refreshPromptFiles' }
  | { type: 'sendToLlm'; payload: { selectedFiles: string[]; code: string; customInstructions: string } }
  | { type: 'openAiCodePanel' }
  | { type: 'linkFeatureFile' }
  | { type: 'reopenFeatureFile' }
  | { type: 'unlinkFeatureFile' }
  | { type: 'selectedInstructionFiles'; payload: string[] }
  | { type: 'currentCodeReport'; payload: string };

/** Status shape the webview renders (status pill, Start/Stop enablement) —
 * translated 1:1 from CodegenStatus (see mapCodegenStatus()). Kept as its
 * own type/wire-shape (rather than just using CodegenStatus's state names
 * directly) mainly because "connecting"/"connected" read better in the UI
 * than "starting"/"running", and it's one less thing for the webview to
 * need to know came from "codegen" specifically. */
type PanelStatus =
  | { state: 'idle' }
  | { state: 'connecting'; detail?: string }
  | { state: 'connected'; url: string }
  | { state: 'error'; message: string };

export const OBJECT_SPY_VIEW_ID = 'objectSpy.mainView';

/**
 * Owns softPlay's main UI and bridges it to CodegenManager.
 *
 * Lives in the Activity Bar as a sidebar view (vscode.WebviewViewProvider),
 * not a floating editor-tab panel — so it's always one click away, the way
 * a testing tool's primary UI is expected to be, rather than only reachable
 * via the Command Palette.
 *
 * Start/Stop launches Playwright's own real `codegen` tool (CodegenManager)
 * in its own separate browser window — the sole way this extension scans
 * elements and records actions into generated code (an earlier CDP-attach
 * architecture with its own custom Object Spy/locator engine/recorder has
 * been removed entirely as redundant, per an explicit decision to keep
 * native `codegen` as the only path). "Generated Code" streams codegen's
 * output file verbatim; "Link Feature File" ties a Cucumber Gherkin
 * scenario to it (see featureFilePanel.ts); "Custom md files" sends
 * whatever's checked, plus the bundled senior-QE instructions, to GitHub
 * Copilot for an AI-refined second version, automatically as code is
 * recorded.
 */
export class ObjectSpyPanel implements vscode.Disposable, vscode.WebviewViewProvider {
  private view: vscode.WebviewView | undefined;
  private readonly codegenManager = new CodegenManager();
  // The most recent raw code `codegen` wrote, verbatim — what "Generated
  // Code" shows. Never reformatted or otherwise processed; that's the
  // whole point of using codegen's own output directly.
  private nativeGeneratedCode = '';
  private readonly disposables: vscode.Disposable[] = [];

  private readonly settingsPanel: SettingsPanel;
  private readonly featureFilePanel: FeatureFilePanel;
  // "AI Generated Code" — its own full-size editor-area panel, not a
  // cramped half of the sidebar. ObjectSpyPanel still owns the actual
  // Copilot request/response lifecycle (runLlmRefinement()); this is purely
  // where the result gets displayed.
  private readonly aiCodePanel: AiCodePanel;
  // The Gherkin Scenario/Scenario Outline currently linked via "Link
  // Feature file" (Control Panel) — folded into every LLM refinement
  // request (manual or automatic) so the generated step definitions are
  // tied to this exact scenario's step lines. Persists across Start/Stop
  // and even Kill All Browsers, and across regenerating code from the same
  // or a fresh codegen session — by design, so "regenerate with the same
  // scenario" (explicitly asked for) doesn't require re-picking it every
  // time. Cleared only when the user explicitly unlinks it or links a
  // different one.
  private linkedScenario: LinkedScenario | undefined;
  // Workspace-relative paths of whichever "Custom md files" (.github/*.md)
  // checkboxes are currently checked in the webview — kept in sync via the
  // 'selectedInstructionFiles' message every time the user (un)checks one.
  // There is no more "Send to Copilot"/"Send Anyway" button: checking a box
  // IS the action now, folded automatically into the next AI refinement
  // (manual chat send or the automatic post-recording pipeline) rather than
  // requiring a separate explicit send.
  private selectedInstructionFiles: string[] = [];
  // Resolves a pending requestCurrentPlaywrightCode() call (see
  // "Regenerate AI Code") once the sidebar webview reports its Playwright
  // Code editor's live content back via 'currentCodeReport'.
  private pendingCodeRequestResolve: ((code: string) => void) | undefined;

  // Tracks the in-flight LLM refinement request, if any (manual chat send
  // or the automatic pipeline), so a second one starting (or the view
  // closing) can cancel the previous one cleanly instead of leaving two
  // streams writing into the same AI code view.
  private llmCancellation: vscode.CancellationTokenSource | undefined;

  // Debounces the automatic "refine with AI" pipeline (try/catch, logging,
  // explicit waits, zero hardcoded values — see prompts/senior-qe-instructions.md)
  // that fires whenever codegen's output file updates and Copilot is
  // linked, so a burst of updates doesn't fire one Copilot request per
  // update — only once activity settles for a moment.
  private autoRefineTimer: ReturnType<typeof setTimeout> | undefined;
  private static readonly AUTO_REFINE_DEBOUNCE_MS = 1500;

  // Diagnostic/informational messages (codegen launch, etc.) go to a proper
  // VS Code Output channel rather than a panel of their own — frees up the
  // sidebar for the code editors, and is the idiomatic place for this kind
  // of log anyway.
  private readonly outputChannel = vscode.window.createOutputChannel('softPlay');

  constructor(private readonly context: vscode.ExtensionContext, private readonly settingsStore: SettingsStore) {
    this.settingsPanel = new SettingsPanel(context, settingsStore);
    this.aiCodePanel = new AiCodePanel(context, () => void this.regenerateAiCode());
    this.featureFilePanel = new FeatureFilePanel(
      (scenario) => {
        this.linkedScenario = scenario;
        this.postLinkedScenario();
        this.outputChannel.appendLine(
          `Linked ${scenario.scenarioKind} "${scenario.scenarioName}" from ${scenario.featureFilePath}`
        );
      },
      (filePath) => {
        this.postFeatureFileAvailable(true);
        this.outputChannel.appendLine(`Feature file available for this session: ${filePath}`);
      }
    );

    this.disposables.push(
      this.codegenManager.onStatusChange((status) => this.postStatus(mapCodegenStatus(status))),
      this.codegenManager.onLog((message) => this.outputChannel.appendLine(message)),
      this.codegenManager.onCodeUpdate((code) => {
        this.nativeGeneratedCode = code;
        this.postCode(true);
      }),
      this.settingsStore.onChange((settings) => {
        this.postCode();
        this.postCopilotEnabledState(settings.copilotEnabled);
      })
    );
  }

  /** Brings the sidebar view into focus — e.g. from the "softPlay: Open Panel" command. */
  show(): void {
    void vscode.commands.executeCommand(`${OBJECT_SPY_VIEW_ID}.focus`);
  }

  resolveWebviewView(webviewView: vscode.WebviewView): void {
    this.view = webviewView;

    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.joinPath(this.context.extensionUri, 'media')]
    };
    webviewView.webview.html = this.getHtml(webviewView.webview);

    webviewView.webview.onDidReceiveMessage(
      (message: InboundMessage) => void this.handleMessage(message),
      undefined,
      this.disposables
    );

    webviewView.onDidDispose(
      () => {
        this.view = undefined;
      },
      undefined,
      this.disposables
    );

    // Sync current state into the freshly (re-)resolved webview.
    this.postStatus(mapCodegenStatus(this.codegenManager.getStatus()));
    this.postLinkedScenario();
    this.postFeatureFileAvailable(this.featureFilePanel.hasLinkedFile());
    this.postCode();
    this.postCopilotEnabledState(this.settingsStore.get().copilotEnabled);
  }

  /** `url` is Playwright `codegen`'s own positional CLI argument, needed at
   * spawn time — the Command Palette's "softPlay: Start Browser" command
   * has no URL to offer, so it's optional; codegen simply opens blank and
   * the user types into its own address bar, same as running it by hand
   * with no URL. */
  async startBrowser(url?: string): Promise<void> {
    const settings = this.settingsStore.get();
    await this.codegenManager.start(url?.trim() ?? '', settings.language, settings.browserChannel);
  }

  async stopBrowser(): Promise<void> {
    await this.codegenManager.stop();
  }

  openSettings(): void {
    this.settingsPanel.show();
  }

  dispose(): void {
    if (this.autoRefineTimer) {
      clearTimeout(this.autoRefineTimer);
    }
    this.llmCancellation?.cancel();
    this.llmCancellation?.dispose();
    this.codegenManager.dispose();
    this.settingsPanel.dispose();
    this.aiCodePanel.dispose();
    this.featureFilePanel.dispose();
    this.outputChannel.dispose();
    this.disposables.forEach((d) => d.dispose());
  }

  private get webview(): vscode.Webview | undefined {
    return this.view?.webview;
  }

  private async handleMessage(message: InboundMessage): Promise<void> {
    switch (message.type) {
      case 'start':
        await this.startBrowser(message.payload);
        break;
      case 'stop':
        await this.stopBrowser();
        break;
      case 'openSettings':
        this.settingsPanel.show();
        break;
      case 'saveCode':
        await this.saveCode(message.payload);
        break;
      case 'killAllBrowsers':
        await this.killAllBrowsers();
        break;
      case 'refreshPromptFiles':
        await this.refreshPromptFiles();
        break;
      case 'sendToLlm':
        this.aiCodePanel.show(); // a manual send is a deliberate "show me the result" action
        await this.sendToLlm(message.payload.selectedFiles, message.payload.code, message.payload.customInstructions);
        break;
      case 'openAiCodePanel':
        this.aiCodePanel.show();
        break;
      case 'linkFeatureFile':
        // Once a file has been linked, this button reopens that SAME
        // cached file (no OS browse dialog) instead of forcing the user to
        // re-pick it — per the explicit ask that a linked file stay
        // available until a genuinely different one is linked (via the
        // feature view's own "Browse Different File…" button) or VS Code
        // closes, not just because this view was closed. Only browses when
        // nothing has been linked yet this session.
        if (this.featureFilePanel.hasLinkedFile()) {
          await this.featureFilePanel.reopenLastFile();
        } else {
          await this.featureFilePanel.browseAndOpen();
        }
        break;
      case 'reopenFeatureFile':
        await this.featureFilePanel.reopenLastFile();
        break;
      case 'unlinkFeatureFile':
        this.linkedScenario = undefined;
        this.postLinkedScenario();
        break;
      case 'selectedInstructionFiles':
        this.selectedInstructionFiles = message.payload;
        // Checking a box is itself the action now (no more "Send to
        // Copilot" button) — if there's already some generated code, give
        // immediate feedback rather than waiting for the next codegen
        // output update to trigger a refinement.
        this.scheduleAutoRefine();
        break;
      case 'currentCodeReport':
        this.pendingCodeRequestResolve?.(message.payload);
        this.pendingCodeRequestResolve = undefined;
        break;
    }
  }

  private async saveCode(code: string): Promise<void> {
    const settings = this.settingsStore.get();
    const isJava = settings.language === 'java';
    const defaultName = isJava ? 'GeneratedTest.java' : 'test_recorded_flow.py';
    const uri = await vscode.window.showSaveDialog({
      defaultUri: vscode.Uri.file(defaultName),
      filters: isJava ? { Java: ['java'] } : { Python: ['py'] }
    });
    if (!uri) {
      return;
    }
    await vscode.workspace.fs.writeFile(uri, Buffer.from(code, 'utf8'));
    void vscode.window.showInformationMessage(`softPlay: saved ${path.basename(uri.fsPath)}`);
  }

  private async killAllBrowsers(): Promise<void> {
    await this.codegenManager.stop();
    this.nativeGeneratedCode = '';
    // 'clearAll' resets the webview's code editor itself — no need to also
    // postCode() here, that would just be an empty-code message the client
    // immediately overwrites again anyway.
    this.webview?.postMessage({ type: 'clearAll' });
    this.outputChannel.appendLine('Killed the softPlay-launched codegen browser and cleared generated code.');
  }

  // -----------------------------------------------------------------------
  // "Custom md files" (GitHub Copilot AI Assist). There is no "Send to
  // Copilot"/"Send Anyway" button. Checking a .github/*.md file's checkbox
  // is itself the action (sendToLlm() and autoRefineWithLlm() both read
  // this.selectedInstructionFiles, kept in sync via the
  // 'selectedInstructionFiles' message on every checkbox change) — it's
  // folded automatically into the next refinement, either the chat
  // composer's manual send (free-text instructions + whatever's checked) or
  // the automatic pipeline debounced after codegen's output file updates
  // (scheduleAutoRefine() -> autoRefineWithLlm()). Either way it only ever
  // fires while "Link with GitHub Copilot LLM" is on and a model is picked
  // in Settings, which is itself an explicit, one-time opt-in; VS Code's
  // Language Model API separately shows its own one-time consent dialog the
  // first time this extension calls sendRequest, regardless of which path
  // triggers it.
  // -----------------------------------------------------------------------

  private async refreshPromptFiles(): Promise<void> {
    const files = await vscode.workspace.findFiles('.github/**/*.md');
    const relPaths = files.map((f) => vscode.workspace.asRelativePath(f)).sort();
    this.webview?.postMessage({ type: 'promptFiles', payload: relPaths });
  }

  private async sendToLlm(selectedFiles: string[], playwrightCode: string, customInstructions: string): Promise<void> {
    const instructions = await this.readInstructionFiles(selectedFiles);
    await this.runLlmRefinement(instructions, playwrightCode, customInstructions.trim());
  }

  /**
   * Fires automatically whenever codegen's output file updates, with no
   * button click required — the try/catch + logger + explicit-wait +
   * zero-hardcoded-values refinement (prompts/senior-qe-instructions.md) is
   * meant to keep the AI Generated Code panel current as the recording
   * grows, not require the user to remember to re-click Send. Debounced
   * (see AUTO_REFINE_DEBOUNCE_MS) so a burst of updates fires one Copilot
   * request once things settle, not one per update. Silently does nothing
   * if Copilot isn't linked.
   */
  private scheduleAutoRefine(): void {
    const settings = this.settingsStore.get();
    if (!settings.copilotEnabled || !settings.copilotModelId) {
      return;
    }
    if (this.autoRefineTimer) {
      clearTimeout(this.autoRefineTimer);
    }
    this.autoRefineTimer = setTimeout(() => {
      this.autoRefineTimer = undefined;
      void this.autoRefineWithLlm();
    }, ObjectSpyPanel.AUTO_REFINE_DEBOUNCE_MS);
  }

  private async autoRefineWithLlm(): Promise<void> {
    const settings = this.settingsStore.get();
    if (!settings.copilotEnabled || !settings.copilotModelId) {
      return;
    }
    const playwrightCode = this.nativeGeneratedCode;
    if (!playwrightCode.trim()) {
      return; // nothing recorded yet -- nothing to refine
    }
    // Uses whichever "Custom md files" checkboxes are currently checked in
    // the webview (see the 'selectedInstructionFiles' handler) — there is
    // no more "Send to Copilot" button to separately opt files in, so
    // automatic refinement respects exactly what's checked, same as a
    // manual chat send does. Proceeds fine with none checked too — the
    // bundled senior-QE instructions (readSeniorQeInstructions()) always
    // apply regardless.
    const instructions = await this.readInstructionFiles(this.selectedInstructionFiles);
    await this.runLlmRefinement(instructions, playwrightCode, '');
  }

  /** "Regenerate AI Code" (AI Generated Code panel) — re-runs the same
   * refinement with everything read fresh at click time: the Playwright
   * Code editor's live content (including manual edits — see
   * requestCurrentPlaywrightCode()), Settings (language/version/browser),
   * the linked Gherkin scenario, and the checked Custom md files. Unlike
   * autoRefineWithLlm(), this always runs regardless of debounce/timing —
   * it's an explicit, on-demand click, not a reaction to a codegen update. */
  private async regenerateAiCode(): Promise<void> {
    const settings = this.settingsStore.get();
    if (!settings.copilotEnabled || !settings.copilotModelId) {
      this.postLlmError('Enable "Link with GitHub Copilot LLM" and pick a model in Settings first.');
      return;
    }
    const playwrightCode = await this.requestCurrentPlaywrightCode();
    if (!playwrightCode.trim()) {
      this.postLlmError('Nothing recorded yet — start Playwright codegen and record something first.');
      return;
    }
    const instructions = await this.readInstructionFiles(this.selectedInstructionFiles);
    await this.runLlmRefinement(instructions, playwrightCode, '');
  }

  /** Asks the sidebar webview for its Playwright Code editor's CURRENT
   * content — which may include manual edits the user made, unlike
   * `this.nativeGeneratedCode` (only ever what `codegen` itself last
   * wrote) — so "Regenerate AI Code" reflects hand edits the same way a
   * manual chat send already does. Falls back to `this.nativeGeneratedCode`
   * if the sidebar view isn't currently resolved (rare — a WebviewView
   * normally stays alive once first shown) or doesn't answer within a
   * couple of seconds, so this can never hang the Regenerate button. */
  private requestCurrentPlaywrightCode(): Promise<string> {
    if (!this.webview) {
      return Promise.resolve(this.nativeGeneratedCode);
    }
    return new Promise<string>((resolve) => {
      let settled = false;
      const finish = (code: string) => {
        if (settled) {
          return;
        }
        settled = true;
        this.pendingCodeRequestResolve = undefined;
        resolve(code);
      };
      this.pendingCodeRequestResolve = finish;
      this.webview?.postMessage({ type: 'requestCurrentCode' });
      setTimeout(() => finish(this.nativeGeneratedCode), 3000);
    });
  }

  /** Shared by the chat composer's manual send and the automatic
   * post-recording refinement — always folds in the bundled senior-QE
   * instructions (try/catch, logger.info/warn/error, explicit visible+enabled
   * waits, zero hardcoded values, everything parameterized as top-level
   * static/class constants) on top of whatever project-specific `.github/`
   * files and free-text instructions were supplied. */
  private async runLlmRefinement(
    instructions: { path: string; content: string }[],
    playwrightCode: string,
    customInstructions: string
  ): Promise<void> {
    const settings = this.settingsStore.get();
    if (!settings.copilotEnabled || !settings.copilotModelId) {
      this.postLlmError('Enable "Link with GitHub Copilot LLM" and pick a model in Settings first.');
      return;
    }

    this.llmCancellation?.cancel();
    this.llmCancellation?.dispose();
    const cts = new vscode.CancellationTokenSource();
    this.llmCancellation = cts;

    this.postLlmStart();

    const builtIn = readSeniorQeInstructions();
    const prompt = buildLlmPrompt(
      settings.language,
      settings.languageVersion,
      builtIn,
      instructions,
      playwrightCode,
      customInstructions,
      this.linkedScenario
    );
    // Diagnostic trail for exactly the question "was X actually sent, and
    // did a response come back?" — check the softPlay Output channel
    // (View -> Output -> softPlay) rather than needing to guess from a
    // stuck "(generating…)" label with no other visible signal.
    this.outputChannel.appendLine(
      `Sending to Copilot model "${settings.copilotModelId}": target ${settings.language} ${settings.languageVersion}, ` +
        `senior-QE instructions ` +
        `${builtIn ? `(${builtIn.length} chars)` : '(MISSING — prompts/senior-qe-instructions.md failed to load)'}, ` +
        `${instructions.length} project .md file(s), ` +
        `${this.linkedScenario ? `linked scenario "${this.linkedScenario.scenarioName}"` : 'no linked scenario'}, ` +
        `${playwrightCode.length} chars of reference code — prompt is ${prompt.length} chars total.`
    );

    try {
      let accumulated = '';
      // No case observed so far where the Language Model API's own promise
      // neither resolves nor rejects — but nothing in its contract
      // *guarantees* that either, and a silent hang there would otherwise
      // show "(generating…)" forever with zero feedback. This timeout is a
      // last-resort safety net, not a substitute for whatever the real
      // per-request latency should be; it fires (and reports an explicit,
      // actionable error) only if NOTHING — not even the first
      // chunk — arrives within two minutes; each chunk received resets it.
      let timeoutHandle: ReturnType<typeof setTimeout>;
      const armTimeout = (onTimeout: () => void) => {
        clearTimeout(timeoutHandle);
        timeoutHandle = setTimeout(onTimeout, 120_000);
      };
      await new Promise<void>((resolve, reject) => {
        armTimeout(() => reject(new Error('Copilot did not respond within 2 minutes — no chunk of the response arrived in that window.')));
        sendPrompt(
          settings.copilotModelId,
          prompt,
          (chunk) => {
            armTimeout(() => reject(new Error('Copilot stopped responding mid-stream — no further chunk arrived within 2 minutes.')));
            accumulated += chunk;
            this.postLlmChunk(chunk);
          },
          cts.token
        )
          .then(() => {
            clearTimeout(timeoutHandle);
            resolve();
          })
          .catch((err) => {
            clearTimeout(timeoutHandle);
            reject(err);
          });
      });

      this.outputChannel.appendLine(`Copilot response received: ${accumulated.length} chars.`);
      this.postLlmDone(extractCodeBlock(accumulated));
    } catch (err) {
      if (!cts.token.isCancellationRequested) {
        const message = err instanceof CopilotUnavailableError ? err.message : describeError(err);
        this.outputChannel.appendLine(`Copilot request failed: ${message}`);
        this.postLlmError(message);
      }
    }
  }

  private async readInstructionFiles(relPaths: string[]): Promise<{ path: string; content: string }[]> {
    if (!vscode.workspace.workspaceFolders?.length) {
      return [];
    }
    const decoder = new TextDecoder('utf-8');
    const results: { path: string; content: string }[] = [];
    for (const relPath of relPaths) {
      try {
        const uri = vscode.Uri.joinPath(vscode.workspace.workspaceFolders[0].uri, relPath);
        const bytes = await vscode.workspace.fs.readFile(uri);
        results.push({ path: relPath, content: decoder.decode(bytes) });
      } catch {
        // Skip a file that vanished/moved between listing and sending.
      }
    }
    return results;
  }

  private postCopilotEnabledState(enabled: boolean): void {
    this.webview?.postMessage({ type: 'copilotEnabledState', payload: enabled });
  }

  private postLinkedScenario(): void {
    this.webview?.postMessage({
      type: 'linkedScenario',
      payload: this.linkedScenario
        ? { featureName: this.linkedScenario.featureName, scenarioName: this.linkedScenario.scenarioName, scenarioKind: this.linkedScenario.scenarioKind }
        : null
    });
  }

  /** A file has become available to reopen without a fresh browse dialog
   * (see FeatureFilePanel.hasLinkedFile()) — the Control Panel button
   * relabels itself accordingly. */
  private postFeatureFileAvailable(available: boolean): void {
    this.webview?.postMessage({ type: 'featureFileAvailable', payload: available });
  }

  // The actual code streams into AiCodePanel (its own full-size editor-area
  // panel — see "Open AI Generated Code"), not the sidebar; the sidebar
  // only gets a lightweight status so there's still feedback when that
  // panel isn't open.
  private postLlmStart(): void {
    this.aiCodePanel.setLanguage(this.settingsStore.get().language);
    this.aiCodePanel.startGenerating();
    this.webview?.postMessage({ type: 'aiStatus', payload: { state: 'generating' } });
  }

  private postLlmChunk(chunk: string): void {
    this.aiCodePanel.appendChunk(chunk);
  }

  private postLlmDone(finalCode: string): void {
    this.aiCodePanel.finish(finalCode);
    this.webview?.postMessage({ type: 'aiStatus', payload: { state: 'idle' } });
  }

  private postLlmError(message: string): void {
    this.aiCodePanel.showError(message);
    this.webview?.postMessage({ type: 'aiStatus', payload: { state: 'error', message } });
  }

  private postStatus(status: PanelStatus): void {
    this.webview?.postMessage({ type: 'status', payload: status });
  }

  /** `isNewRecording` flags a genuinely new codegen output update just
   * arrived (vs. a refresh triggered by, say, a Settings change) — the
   * panel uses it to flash the "New code recorded." indicator. */
  private postCode(isNewRecording = false): void {
    const settings = this.settingsStore.get();
    this.webview?.postMessage({
      type: 'code',
      payload: { code: this.nativeGeneratedCode, language: settings.language, languageVersion: settings.languageVersion, isNewRecording }
    });
    if (isNewRecording) {
      this.scheduleAutoRefine();
    }
  }

  private getVersion(): string {
    // context.extension carries this build's own package.json — always the
    // version actually running, no separate copy to fall out of sync with.
    return (this.context as any).extension?.packageJSON?.version ?? '0.0.0';
  }

  private getHtml(webview: vscode.Webview): string {
    const scriptUri = webview.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, 'media', 'main.js'));
    const highlightUri = webview.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, 'media', 'highlight.js'));
    const codeEditorUri = webview.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, 'media', 'codeEditor.js'));
    const styleUri = webview.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, 'media', 'main.css'));
    const nonce = getNonce();

    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${webview.cspSource} data:; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}';" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <link href="${styleUri}" rel="stylesheet" />
  <title></title>
</head>
<body>
  <div class="toolbar-row title-row app-title-row">
    <span class="title-group">
      <span class="title">SOFT-PLAY AI POWERED TEST AUTOMATION PLUGIN</span>
      <span id="versionBadge" class="version-badge">v${this.getVersion()}</span>
    </span>
    <button id="settingsBtn" class="btn-icon-top" title="Settings (language, browser, GitHub Copilot)">⚙</button>
  </div>

  <details class="section" id="controlPanelSection" open>
    <summary>Control Panel</summary>
    <div class="section-body">
      <div class="toolbar-row">
        <button id="linkFeatureBtn" class="btn" title="Browse to a Cucumber .feature file and pick a Scenario/Scenario Outline to link to the generated code">Link Feature File</button>
        <span id="linkedScenarioBadge" class="linked-scenario-badge" hidden>
          <span id="linkedScenarioText"></span>
          <button id="unlinkScenarioBtn" class="btn-icon-small" title="Unlink this scenario">✕</button>
        </span>
      </div>
      <div class="toolbar-row">
        <input id="urlInput" type="text" placeholder="https://example.com" />
      </div>
      <div class="toolbar-row">
        <button id="startBtn" class="btn btn-primary">Start</button>
        <button id="stopBtn" class="btn" disabled>Stop</button>
        <button id="killAllBtn" class="btn btn-danger" title="Close the codegen browser this extension launched and clear the generated code">Kill All Browsers</button>
        <span id="statusPill" class="status-pill status-idle">Idle</span>
      </div>
    </div>
  </details>

  <details class="section" id="generatedCodeSection" open>
    <summary>Generated Code</summary>
    <div class="section-body">
      <div id="aiGeneratingBanner" class="ai-generating-banner" hidden>
        <span class="ai-generating-text">Generating AI code…</span>
        <span class="ai-generating-track"><span class="ai-generating-fill"></span></span>
      </div>
      <div id="aiAssistSection" class="ai-assist" hidden>
        <details>
          <summary>Custom md files</summary>
          <div class="ai-assist-body">
            <div class="ai-files-header">Instruction / skill / prompt files (<code>.github/*.md</code>)</div>
            <div id="promptFilesList" class="prompt-files-list">
              <div class="prompt-files-empty">No .md files found yet — click Refresh.</div>
            </div>
            <div class="ai-assist-actions">
              <button id="refreshPromptFilesBtn" class="btn btn-small">Refresh file list</button>
            </div>

            <div id="chatComposer" class="chat-composer">
              <div id="chatMessages" class="chat-messages"></div>
              <div class="chat-input-row">
                <textarea id="chatInput" class="chat-input" rows="1" placeholder="Add any details for the AI to follow…"></textarea>
                <button id="chatSendBtn" class="chat-send-btn" title="Send" aria-label="Send">➤</button>
              </div>
            </div>
          </div>
        </details>
        <div class="toolbar-row ai-open-row">
          <button id="openAiCodeBtn" class="btn">Open AI Generated Code</button>
          <span id="aiStatusLabel" class="llm-status"></span>
        </div>
      </div>

      <div class="code-panels">
        <div class="code-panel" id="playwrightCodePanel">
          <div class="code-header">
            <button id="collapseCodeBtn" class="btn-icon-small code-collapse-btn" title="Collapse this panel">▾</button>
            <h3 class="section-title">Playwright Code <span id="codeLanguageLabel"></span></h3>
            <span id="newCodeFlash" class="new-code-flash" hidden>New code recorded.</span>
            <button id="copyCodeBtn" class="btn btn-small">Copy Code</button>
            <button id="saveCodeBtn" class="btn">Save Code</button>
          </div>
          <div id="codeRefreshBanner" class="code-refresh-banner" hidden>
            New code recorded. <button id="codeRefreshBtn" class="btn btn-small">Refresh (discards manual edits)</button>
          </div>
          <div class="code-editor-wrap">
            <div id="codeGutter" class="code-gutter"></div>
            <pre id="codeHighlight" class="code-highlight" aria-hidden="true"><code></code></pre>
            <textarea id="codeEditArea" class="code-edit-area" spellcheck="false">// Click Start and interact with the codegen browser window.</textarea>
          </div>
        </div>
      </div>
    </div>
  </details>

  <script nonce="${nonce}" src="${highlightUri}"></script>
  <script nonce="${nonce}" src="${codeEditorUri}"></script>
  <script nonce="${nonce}" src="${scriptUri}"></script>
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

// Read once and cached — this is the built-in "think like a senior UI test
// automation engineer" refinement standard (try/catch, logger.info/warn/error,
// explicit visible+enabled waits, zero hardcoded values) sent to the LLM on
// every refinement, manual or automatic. Lives outside src/ deliberately:
// .vscodeignore excludes src/**/*.ts from the packaged extension, but this
// file must ship as plain markdown, not be compiled. Missing/unreadable is a
// benign "run without the extra standard" fallback, never a hard failure —
// the reference code and any .github/ project instructions still make it
// into the prompt either way.
let cachedSeniorQeInstructions: string | undefined;
function readSeniorQeInstructions(): string {
  if (cachedSeniorQeInstructions !== undefined) {
    return cachedSeniorQeInstructions;
  }
  try {
    cachedSeniorQeInstructions = fs.readFileSync(
      path.join(__dirname, '..', '..', 'prompts', 'senior-qe-instructions.md'),
      'utf8'
    );
  } catch {
    cachedSeniorQeInstructions = '';
  }
  return cachedSeniorQeInstructions;
}

/** Translates CodegenStatus into the PanelStatus shape the webview knows
 * how to render (status pill, Start/Stop enablement). */
function mapCodegenStatus(status: CodegenStatus): PanelStatus {
  switch (status.state) {
    case 'idle':
      return { state: 'idle' };
    case 'starting':
      return { state: 'connecting', detail: 'Launching Playwright codegen…' };
    case 'running':
      return { state: 'connected', url: status.url };
    case 'error':
      return { state: 'error', message: status.message };
  }
}

function describeError(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** A short, concrete nudge toward the syntax that's actually idiomatic for
 * the selected language/runtime version — stating the version number alone
 * leans on the model already knowing that history correctly, which a
 * capable model usually does, but a couple of the most test-code-relevant
 * landmarks spelled out here removes any doubt rather than leaving it to
 * inference. Not exhaustive by design — a full language changelog would
 * bloat the prompt for little marginal benefit. */
function languageVersionGuidance(language: 'java' | 'python', version: string): string {
  if (language === 'java') {
    const major = parseInt(version, 10);
    if (major >= 17) {
      return (
        `Java ${version} is a modern LTS release: text blocks (\`"""..."""\`) for any multi-line string, ` +
        `\`var\` for local variables with an inline initializer, and records are all safe to use where they ` +
        `genuinely improve readability.`
      );
    }
    return (
      `Java 11 predates text blocks, records, and pattern matching (all Java 15+) — do not use any of them. ` +
      `\`var\` for local variables is fine (available since Java 10); explicit types everywhere else.`
    );
  }
  const [minorRaw] = version.split('.').slice(1);
  const minor = parseInt(minorRaw ?? '0', 10);
  if (minor >= 10) {
    return (
      `Python ${version} supports the \`match\`/\`case\` statement and \`X | Y\` union type hints natively — ` +
      `use them where they read better than the older equivalents.`
    );
  }
  return (
    `Python ${version} predates the \`match\`/\`case\` statement and native \`X | Y\` union syntax (both Python ` +
    `3.10+) — do not use either; use \`Union[X, Y]\` from \`typing\` for union hints instead.`
  );
}

/**
 * Builds the single user message sent to the Copilot model — explicitly
 * asks for the same enterprise Page-Object style/structure/language the
 * bundled senior-QE instructions describe, using the raw Playwright codegen
 * output below as the reference for which locators/actions are actually
 * correct. LLM output can't be forced into an exact shape the way a
 * template can, hence the explicit, detailed ask plus extractCodeBlock()
 * cleaning up the response afterward — and why both code views stay
 * editable.
 */
function buildLlmPrompt(
  language: 'java' | 'python',
  languageVersion: string,
  builtInInstructions: string,
  instructions: { path: string; content: string }[],
  playwrightCode: string,
  customInstructions: string,
  linkedScenario?: LinkedScenario
): string {
  const languageName = language === 'java' ? 'Java (JUnit 5, Playwright for Java)' : 'Python (pytest, Playwright for Python)';
  const versionGuidance = languageVersionGuidance(language, languageVersion);

  const parts: string[] = [
    `You are an expert Playwright test automation engineer working on an enterprise QA codebase.`,
    `Generate ${languageName} automation code, targeting exactly **${language === 'java' ? 'Java' : 'Python'} ${languageVersion}** ` +
      `— this is the specific language/runtime version the user selected in Settings and it must compile/run correctly ` +
      `under it, using only language features actually available in that version (never a newer version's syntax, ` +
      `and no need to stay compatible with anything older either). ${versionGuidance} ` +
      `Follow the SAME enterprise Page-Object style described in the mandatory refinement standard below, based on the ` +
      `reference "Playwright-generated code" — real, unmodified output from Playwright's own \`codegen\` tool. Reuse the ` +
      `exact locators it already found — do not invent new ones or guess at different ones. ` +
      `Respond with ONLY the final code in a single fenced code block and no other commentary.`
  ];

  if (builtInInstructions) {
    parts.push(`\n## Mandatory refinement standard — apply every part of this\n${builtInInstructions}`);
  }

  if (instructions.length) {
    parts.push(
      `\n## Project instructions/skills/prompts (from .github/) — follow these`,
      ...instructions.map((f) => `### ${f.path}\n${f.content}`)
    );
  }

  // Free-text instructions from the chat composer — used when no .md file
  // was selected (or in addition to one).
  if (customInstructions) {
    parts.push(`\n## Additional instructions from the user — follow these too\n${customInstructions}`);
  }

  // "Link Feature file" (Control Panel) — a Gherkin Scenario/Scenario
  // Outline the user picked in the Feature File view. Present only when
  // one is currently linked; see the "BDD Gherkin Step Definition Linking"
  // section of the built-in instructions above for exactly how this must
  // be turned into step definitions. IMPORTANT: this extension has one
  // single AI Generated Code view, so the response must stay ONE file in
  // ONE fenced code block — extractCodeBlock() (copilotClient.ts) only
  // ever captures the first fenced block in the response, so asking for a
  // separate step-definitions file here would silently lose it.
  if (linkedScenario) {
    const gherkinBlock = [linkedScenario.backgroundRawText, linkedScenario.rawText].filter(Boolean).join('\n\n');
    parts.push(
      `\n## Linked Gherkin ${linkedScenario.scenarioKind} — "${linkedScenario.scenarioName}" (from ${linkedScenario.featureName})`,
      `The user has linked this exact Cucumber ${linkedScenario.scenarioKind} to the recorded flow above via ` +
        `"Link Feature file". Every Given/When/Then/And/But/* line below must get its own properly linked BDD ` +
        `step definition per the "BDD Gherkin Step Definition Linking" instructions — do not just append the ` +
        `Gherkin as a comment. Produce exactly ONE file, in exactly ONE fenced code block: the refined page ` +
        `object/test code AND its BDD step definitions together, correctly organized and imported as idiomatic ` +
        `for the target language's real BDD framework (Cucumber-JVM for Java, pytest-bdd for Python) — never ` +
        `split this into multiple files or code blocks.`,
      `\`\`\`gherkin\n${gherkinBlock}\n\`\`\``
    );
  }

  parts.push(
    `\n## Reference Playwright-generated code (real, unmodified \`codegen\` output) — match this structure and style, reuse its locators as-is\n\`\`\`${language}\n${playwrightCode}\n\`\`\``
  );

  return parts.join('\n');
}
