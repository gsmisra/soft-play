import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { CodegenManager, CodegenStatus } from '../browser/codegenManager';
import { SettingsStore } from '../settings/settingsStore';
import { SettingsPanel } from './settingsPanel';
import { FeatureFilePanel, LinkedScenario } from './featureFilePanel';
import { AiCodePanel } from './aiCodePanel';
import { GeneratedFeaturePanel } from './generatedFeaturePanel';
import { CopilotUnavailableError, extractCodeBlock, sendPrompt } from '../llm/copilotClient';
import { checkEnvironment, checkPythonEnvironment } from '../execution/environmentCheck';
import { executeGeneratedCode } from '../execution/testExecutor';
import { ApiRequestDetails, buildApiRequestSummary, hasApiRequest } from '../api/apiRequestDetails';

type InboundMessage =
  | { type: 'start'; payload?: string }
  | { type: 'stop' }
  | { type: 'openSettings' }
  | { type: 'saveCode'; payload: string }
  | { type: 'killAllBrowsers' }
  | { type: 'refreshPromptFiles' }
  | { type: 'sendToLlm'; payload: { selectedFiles: string[]; code: string; customInstructions: string; apiDetails?: ApiRequestDetails } }
  | { type: 'openAiCodePanel' }
  | { type: 'generateFeatureFile'; payload: { code: string; customInstructions: string; apiDetails?: ApiRequestDetails } }
  | { type: 'linkFeatureFile' }
  | { type: 'reopenFeatureFile' }
  | { type: 'unlinkFeatureFile' }
  | { type: 'selectedInstructionFiles'; payload: string[] }
  | { type: 'currentCodeReport'; payload: string }
  | { type: 'setCopilotEnabled'; payload: boolean }
  | { type: 'browseApiFormFile'; payload: { rowId: number } };

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
 * scenario to it (see featureFilePanel.ts); "Generate Gherkin Feature File"
 * is the reverse direction for when no .feature file exists yet — it turns
 * a Playwright Codegen recording alone into a brand-new BDD feature file
 * (see generateFeatureFile()/prompts/generate-feature-file.md). AI
 * processing (Copilot) never starts on its own — recording code, checking a
 * "Custom md files" box, or typing in the chat composer only ever stages
 * context; nothing is sent to the LLM until the user explicitly clicks
 * "Start AI Processing" or "Generate Gherkin Feature File", each of which
 * bundles its own relevant context together (see
 * runLlmRefinement()/sendToLlm() and generateFeatureFile()).
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
  // "Generate Gherkin Feature File" — the OPPOSITE direction of the above:
  // recorded Playwright Codegen code alone (no linked .feature file
  // needed) turned into a NEW BDD feature file. Its own full-size
  // editor-area panel, same shape as aiCodePanel; see
  // generateFeatureFile()/prompts/generate-feature-file.md.
  private readonly generatedFeaturePanel: GeneratedFeaturePanel;
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
  // API Automation mode's Control Panel request builder, as last sent by
  // "Start AI Processing"/"Generate Gherkin Feature File" — kept around
  // purely so "Regenerate" (AI Generated Code / Generated Feature File
  // panels, which don't have their own copy of the API form) can replay
  // the same request without the user re-entering it. Never read in UI
  // mode.
  private lastApiRequestDetails: ApiRequestDetails | undefined;
  // Workspace-relative paths of whichever "Custom md files" (.github/*.md)
  // checkboxes are currently checked in the webview — kept in sync via the
  // 'selectedInstructionFiles' message every time the user (un)checks one.
  // Purely staged context: checking a box does NOT itself trigger anything
  // — it's folded in the next time "Start AI Processing" is clicked.
  private selectedInstructionFiles: string[] = [];
  // Resolves a pending requestCurrentPlaywrightCode() call (see
  // "Regenerate AI Code") once the sidebar webview reports its Playwright
  // Code editor's live content back via 'currentCodeReport'.
  private pendingCodeRequestResolve: ((code: string) => void) | undefined;

  // Tracks the in-flight LLM refinement request, if any, so a second one
  // starting (or the view closing) can cancel the previous one cleanly
  // instead of leaving two streams writing into the same AI code view.
  private llmCancellation: vscode.CancellationTokenSource | undefined;
  // Same, but for an in-flight "Generate Gherkin Feature File" request —
  // kept separate from llmCancellation so starting one kind of generation
  // never cancels an unrelated one already in flight for the other panel.
  private featureGenCancellation: vscode.CancellationTokenSource | undefined;

  // How long to wait for the FIRST chunk of a Copilot response before
  // giving up — this is "thinking" time on a genuinely large prompt (the
  // bundled senior-QE instructions, browser-channel/class-name requirements,
  // any linked Gherkin scenario, plus the reference Playwright code, easily
  // several thousand tokens), not a stalled connection, so it gets a
  // generous allowance. Once streaming has actually started, a real stall
  // is far more likely than the model still "thinking" between tokens, so
  // INTER_CHUNK_TIMEOUT_MS stays much tighter.
  private static readonly FIRST_CHUNK_TIMEOUT_MS = 240_000;
  private static readonly INTER_CHUNK_TIMEOUT_MS = 90_000;

  // Diagnostic/informational messages (codegen launch, etc.) go to a proper
  // VS Code Output channel rather than a panel of their own — frees up the
  // sidebar for the code editors, and is the idiomatic place for this kind
  // of log anyway.
  private readonly outputChannel = vscode.window.createOutputChannel('softPlay');

  constructor(private readonly context: vscode.ExtensionContext, private readonly settingsStore: SettingsStore) {
    this.settingsPanel = new SettingsPanel(context, settingsStore);
    this.aiCodePanel = new AiCodePanel(context, () => void this.regenerateAiCode(), () => void this.verifyAndFixCode());
    this.generatedFeaturePanel = new GeneratedFeaturePanel(context, () => void this.regenerateFeatureFile());
    this.featureFilePanel = new FeatureFilePanel(
      (scenario) => {
        this.linkedScenario = scenario;
        this.postLinkedScenario();
        this.outputChannel.appendLine(
          `Linked ${scenario.scenarioKind} "${scenario.scenarioName}" from ${scenario.featureFilePath} — ` +
            `${scenario.selectedStepCount}/${scenario.totalStepCount} step(s) selected for AI analysis.`
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
    this.llmCancellation?.cancel();
    this.llmCancellation?.dispose();
    this.featureGenCancellation?.cancel();
    this.featureGenCancellation?.dispose();
    this.codegenManager.dispose();
    this.settingsPanel.dispose();
    this.aiCodePanel.dispose();
    this.generatedFeaturePanel.dispose();
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
        await this.sendToLlm(message.payload.selectedFiles, message.payload.code, message.payload.customInstructions, message.payload.apiDetails);
        break;
      case 'openAiCodePanel':
        this.aiCodePanel.show();
        break;
      case 'generateFeatureFile':
        this.generatedFeaturePanel.show(); // a manual send is a deliberate "show me the result" action
        await this.generateFeatureFile(message.payload.code, message.payload.customInstructions, message.payload.apiDetails);
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
        // Purely staged context — checking a box does not itself trigger
        // anything; it's read fresh the next time "Start AI Processing" is
        // clicked (sendToLlm()/runLlmRefinement()).
        this.selectedInstructionFiles = message.payload;
        break;
      case 'currentCodeReport':
        this.pendingCodeRequestResolve?.(message.payload);
        this.pendingCodeRequestResolve = undefined;
        break;
      case 'setCopilotEnabled':
        // The "Link with GitHub Copilot LLM" toggle now lives in the
        // Control Panel (moved from the Settings menu — same setting,
        // same SettingsStore, same behavior, just a different webview
        // hosting the switch). Settings' own webview still owns the model
        // picker/status and stays in sync via SettingsStore.onChange like
        // any other settings change, regardless of which panel made it.
        await this.settingsStore.update({ copilotEnabled: message.payload });
        break;
      case 'browseApiFormFile':
        await this.browseApiFormFile(message.payload.rowId);
        break;
    }
  }

  /** API Automation mode's form-data body — a row switched to "File" gets
   * a native OS file picker (never a webview `<input type="file">`, whose
   * sandboxing hides the real absolute path from the page — exactly the
   * path the generated multipart-upload code needs) instead of a text
   * field. No file-type filter: "should be able to pass all applicable
   * file types" — any file is valid form-data. Silently does nothing if
   * the user cancels the dialog; `rowId` (not an array index, which shifts
   * as rows are added/removed) tells the webview which row to update. */
  private async browseApiFormFile(rowId: number): Promise<void> {
    const uris = await vscode.window.showOpenDialog({ canSelectMany: false, openLabel: 'Select File' });
    if (!uris || uris.length === 0) {
      return;
    }
    this.webview?.postMessage({ type: 'apiFormFileSelected', payload: { rowId, filePath: uris[0].fsPath } });
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
  // "Custom md files" (GitHub Copilot AI Assist). Checking a .github/*.md
  // file's checkbox is purely staged context — this.selectedInstructionFiles
  // is kept in sync via the 'selectedInstructionFiles' message on every
  // checkbox change, but nothing is sent to the LLM until the user
  // explicitly clicks "Start AI Processing" (sendToLlm(), below), same as
  // the chat composer's free-text box. This only ever fires while "Link
  // with GitHub Copilot LLM" is on and a model is picked in Settings, which
  // is itself an explicit, one-time opt-in; VS Code's Language Model API
  // separately shows its own one-time consent dialog the first time this
  // extension calls sendRequest.
  // -----------------------------------------------------------------------

  private async refreshPromptFiles(): Promise<void> {
    const files = await vscode.workspace.findFiles('.github/**/*.md');
    const relPaths = files.map((f) => vscode.workspace.asRelativePath(f)).sort();
    this.webview?.postMessage({ type: 'promptFiles', payload: relPaths });
  }

  /** "Start AI Processing" (Control Panel) — the ONLY way AI processing
   * starts. Bundles everything currently staged: the Playwright Code
   * editor's live content (`code`, including manual edits), whichever
   * Custom md files are checked (`selectedFiles`), anything typed into the
   * chat box (`customInstructions`), the linked scenario/selected steps
   * (this.linkedScenario, read inside runLlmRefinement()), and the current
   * Settings (browser channel, language, language version — also read
   * inside runLlmRefinement()). Recording code, checking a box, or typing
   * in chat never triggers this on their own. */
  private async sendToLlm(
    selectedFiles: string[],
    playwrightCode: string,
    customInstructions: string,
    apiDetails?: ApiRequestDetails
  ): Promise<void> {
    if (apiDetails) {
      this.lastApiRequestDetails = apiDetails;
    }
    const instructions = await this.readInstructionFiles(selectedFiles);
    await this.runLlmRefinement(instructions, playwrightCode, customInstructions.trim(), apiDetails);
  }

  /** "Regenerate AI Code" (AI Generated Code panel) — re-runs the same
   * refinement with everything read fresh at click time: the Playwright
   * Code editor's live content (including manual edits — see
   * requestCurrentPlaywrightCode()), Settings (language/version/browser),
   * the linked Gherkin scenario, and the checked Custom md files. An
   * explicit, on-demand click, same as "Start AI Processing" — just from
   * the AI Generated Code panel instead of the Control Panel, and without
   * whatever's currently sitting in the chat box (that's specific to
   * "Start AI Processing"). */
  private async regenerateAiCode(): Promise<void> {
    const settings = this.settingsStore.get();
    if (!settings.copilotEnabled || !settings.copilotModelId) {
      this.postLlmError('Enable "Link with GitHub Copilot LLM" (Control Panel) and pick a model in Settings first.');
      return;
    }
    // Empty/no-op guard (and its warning alert) lives centrally in
    // runLlmRefinement() — reached below regardless of whether anything was
    // actually recorded, so every trigger path (this button, manual chat
    // send, the automatic pipeline) enforces it the same way.
    const playwrightCode = await this.requestCurrentPlaywrightCode();
    const instructions = await this.readInstructionFiles(this.selectedInstructionFiles);
    await this.runLlmRefinement(instructions, playwrightCode, '', this.lastApiRequestDetails);
  }

  /** "Generate Gherkin Feature File" (Control Panel) — the counterpart to
   * "Start AI Processing" for when the user has NOT linked a .feature file:
   * sends whatever Playwright Codegen recorded (UI mode) or the API request
   * described in the Control Panel (API mode) — plus anything currently in
   * the chat box — to the LLM with prompts/generate-feature-file.md's
   * instructions, producing a brand-new BDD .feature file in the Generated
   * Feature File panel instead of refined automation code. */
  private async generateFeatureFile(playwrightCode: string, customInstructions: string, apiDetails?: ApiRequestDetails): Promise<void> {
    const settings = this.settingsStore.get();
    if (!settings.copilotEnabled || !settings.copilotModelId) {
      this.generatedFeaturePanel.showError('Enable "Link with GitHub Copilot LLM" (Control Panel) and pick a model in Settings first.');
      return;
    }
    const isApiMode = settings.automationMode === 'api';
    if (apiDetails) {
      this.lastApiRequestDetails = apiDetails;
    }
    // Same empty/no-op guard as runLlmRefinement(), for whichever mode's
    // own notion of "there's nothing here yet" applies.
    if (isApiMode ? !hasApiRequest(apiDetails ?? this.lastApiRequestDetails) : !playwrightCode.trim()) {
      void vscode.window.showWarningMessage(
        isApiMode
          ? 'Enter an API request URL in the Control Panel first before generating a feature file'
          : 'Record some user action first before generating a feature file'
      );
      return;
    }

    this.featureGenCancellation?.cancel();
    this.featureGenCancellation?.dispose();
    const cts = new vscode.CancellationTokenSource();
    this.featureGenCancellation = cts;

    this.generatedFeaturePanel.startGenerating();

    const builtIn = readFeatureFileGenInstructions();
    const prompt = isApiMode
      ? buildApiFeatureFilePrompt(builtIn, (apiDetails ?? this.lastApiRequestDetails)!, customInstructions.trim(), this.linkedScenario)
      : buildFeatureFilePrompt(builtIn, playwrightCode, customInstructions.trim());
    this.outputChannel.appendLine(
      `Sending to Copilot model "${settings.copilotModelId}" for feature-file generation (${isApiMode ? 'API' : 'UI'} mode): ` +
        `${builtIn ? `instructions (${builtIn.length} chars)` : '(MISSING — prompts/generate-feature-file.md failed to load)'} — ` +
        `prompt is ${prompt.length} chars total.`
    );

    try {
      const accumulated = await this.streamCopilotResponse(prompt, settings.copilotModelId, cts, (chunk) =>
        this.generatedFeaturePanel.appendChunk(chunk)
      );
      this.outputChannel.appendLine(`Copilot response received: ${accumulated.length} chars.`);
      this.generatedFeaturePanel.finish(extractCodeBlock(accumulated));
    } catch (err) {
      if (!cts.token.isCancellationRequested) {
        const message = err instanceof CopilotUnavailableError ? err.message : describeError(err);
        this.outputChannel.appendLine(`Copilot feature-file request failed: ${message}`);
        this.generatedFeaturePanel.showError(message);
      }
    }
  }

  /** "Regenerate" (Generated Feature File panel) — re-runs with the
   * Playwright Code editor's live content (UI mode) or the last-sent API
   * request (API mode) at click time; no chat-box text (that's specific to
   * the Control Panel's "Generate Gherkin Feature File" button — same
   * asymmetry as regenerateAiCode() vs. sendToLlm()). */
  private async regenerateFeatureFile(): Promise<void> {
    const playwrightCode = await this.requestCurrentPlaywrightCode();
    await this.generateFeatureFile(playwrightCode, '', this.lastApiRequestDetails);
  }

  private static readonly MAX_VERIFY_ATTEMPTS = 5;

  /**
   * "Verify & Fix Code" (AI Generated Code panel) — actually EXECUTES the
   * AI-generated code in a disposable scratch project (never the user's
   * workspace), and loops: run -> if it's a genuine code defect, hand the
   * error (plus the ORIGINAL context — the Playwright Codegen output in UI
   * mode, or the API request details in API mode — kept in context on
   * every attempt so the LLM can always re-derive what's correct, per the
   * explicit ask) to the LLM for a fix -> confirm with the user (modal
   * Yes/No) before every single run, including the first -> repeat, up to
   * MAX_VERIFY_ATTEMPTS. "No" at any confirmation stops immediately and
   * leaves the current errors visible for manual fixing.
   *
   * UI mode: "success" = a real headless Playwright run passing. API mode:
   * "success" = the code compiling/parsing cleanly — a live API call that
   * then fails with an HTTP error is reported separately and never treated
   * as a defect to fix (see testExecutor.ts's doc comment).
   *
   * A clean, non-compile-only, non-"API error" result shows a big green
   * "Code Correctness Confirmed" banner on the sidebar (postCodeCorrectness()).
   */
  private async verifyAndFixCode(): Promise<void> {
    const settings = this.settingsStore.get();
    const isApiMode = settings.automationMode === 'api';
    if (!settings.copilotEnabled || !settings.copilotModelId) {
      this.aiCodePanel.setVerifyStatus('Enable "Link with GitHub Copilot LLM" (Control Panel) and pick a model in Settings first.', 'error');
      return;
    }

    const initialCode = await this.aiCodePanel.requestCurrentCode();
    if (!initialCode.trim()) {
      void vscode.window.showWarningMessage('Nothing to verify — generate some AI code first.');
      return;
    }

    this.aiCodePanel.setVerifyButtonEnabled(false);
    this.postCodeCorrectness(false);
    try {
      this.aiCodePanel.setVerifyStatus('Checking the local environment…', 'info');
      const env = await checkEnvironment(settings.language, settings.automationMode);
      this.outputChannel.appendLine(
        `Verify & Fix Code — environment check (${settings.language}, ${isApiMode ? 'API' : 'UI'} mode): ${env.ok ? 'OK' : 'FAILED'} — ${env.message}`
      );
      if (!env.ok) {
        this.aiCodePanel.setVerifyStatus(env.message, 'error');
        void vscode.window.showErrorMessage(`softPlay: ${env.message}`);
        return;
      }
      const pythonCommand =
        settings.language === 'python' ? (await checkPythonEnvironment(settings.automationMode)).pythonCommand ?? 'python' : '';

      // Kept fresh on every attempt (re-read, not snapshotted once) so a
      // recording made WHILE the fix loop is running still counts — but in
      // practice this is whatever was last recorded/entered, exactly the
      // "keep the original context in LLM memory" ask.
      const scratchDir = path.join(this.context.globalStorageUri.fsPath, 'test-runner', settings.automationMode, settings.language);
      await fs.promises.mkdir(scratchDir, { recursive: true });

      let code = initialCode;
      for (let attempt = 1; attempt <= ObjectSpyPanel.MAX_VERIFY_ATTEMPTS; attempt++) {
        const choice = await vscode.window.showWarningMessage(
          attempt === 1
            ? `Run the AI-generated code now to verify it ${isApiMode ? 'compiles/parses' : 'executes headless'} without errors?`
            : `Attempt ${attempt} of ${ObjectSpyPanel.MAX_VERIFY_ATTEMPTS}: re-run the LLM-fixed code to verify it now ${isApiMode ? 'compiles/parses' : 'executes headless'} without errors?`,
          { modal: true },
          'Yes',
          'No'
        );
        if (choice !== 'Yes') {
          this.aiCodePanel.setVerifyStatus(
            `Stopped before attempt ${attempt} — current code's errors are shown in the softPlay Output channel for manual fixing.`,
            'error'
          );
          return;
        }

        this.aiCodePanel.setVerifyStatus(`Running attempt ${attempt} of ${ObjectSpyPanel.MAX_VERIFY_ATTEMPTS}…`, 'info');
        const result = await executeGeneratedCode(
          settings.language,
          code,
          scratchDir,
          this.linkedScenario?.featureFilePath,
          pythonCommand,
          settings.automationMode
        );
        this.outputChannel.appendLine(
          `Verify & Fix Code — attempt ${attempt}: ${result.success ? 'PASSED' : 'FAILED'}` +
            `${result.compileOnly ? ' (compile/collect-only check)' : ''}` +
            `${result.apiCallOutcome !== 'not-run' ? ` — live API call ${result.apiCallOutcome}` : ''}\n${result.output}`
        );

        if (result.success) {
          if (result.compileOnly) {
            this.aiCodePanel.setVerifyStatus(
              'Compiled successfully — BDD step definitions have no generated runner to fully execute yet, so this is a compile check, not a confirmed run.',
              'success'
            );
          } else if (isApiMode) {
            if (result.apiCallOutcome === 'failed') {
              this.aiCodePanel.setVerifyStatus(
                'Code Correctness Confirmed — no syntax errors. The live API call itself returned an error response ' +
                  '(see the softPlay Output channel) — recheck the endpoint URL/credentials and try again in your own IDE/test package.',
                'success'
              );
            } else {
              this.aiCodePanel.setVerifyStatus('Code Correctness Confirmed — compiled cleanly and the API call succeeded.', 'success');
            }
            this.postCodeCorrectness(true);
          } else {
            this.aiCodePanel.setVerifyStatus('Code Correctness Confirmed — ran headless without errors.', 'success');
            this.postCodeCorrectness(true);
          }
          return;
        }

        if (attempt === ObjectSpyPanel.MAX_VERIFY_ATTEMPTS) {
          this.aiCodePanel.setVerifyStatus(
            `Still failing after ${ObjectSpyPanel.MAX_VERIFY_ATTEMPTS} attempts — see the softPlay Output channel for the exact error and fix manually.`,
            'error'
          );
          return;
        }

        this.aiCodePanel.setVerifyStatus(`Attempt ${attempt} failed — asking the LLM to fix it…`, 'info');
        const originalContext = isApiMode
          ? {
              label: 'Original API Request Details (the ground truth for this request — refer back to this if the error suggests one was used incorrectly)',
              content: this.lastApiRequestDetails ? buildApiRequestSummary(this.lastApiRequestDetails) : '(not available)'
            }
          : {
              label:
                'Original Playwright Codegen output (real, unmodified recording — the ground truth for which locators and actions are actually correct; refer back to this if the error suggests one was used incorrectly)',
              content: `\`\`\`${settings.language}\n${this.nativeGeneratedCode}\n\`\`\``
            };
        const fixPrompt = buildFixPrompt(
          isApiMode ? readApiAutomationInstructions() : readSeniorQeInstructions(),
          originalContext,
          code,
          result.output,
          settings.language,
          settings.automationMode
        );
        this.outputChannel.appendLine(
          `Verify & Fix Code — sending fix request to Copilot model "${settings.copilotModelId}": prompt is ${fixPrompt.length} chars.`
        );
        this.aiCodePanel.startGenerating();
        const cts = new vscode.CancellationTokenSource();
        try {
          const fixed = await this.streamCopilotResponse(fixPrompt, settings.copilotModelId, cts, (chunk) =>
            this.aiCodePanel.appendChunk(chunk)
          );
          code = extractCodeBlock(fixed);
          this.aiCodePanel.finish(code);
        } catch (err) {
          const message = err instanceof CopilotUnavailableError ? err.message : describeError(err);
          this.outputChannel.appendLine(`Verify & Fix Code — Copilot fix request failed: ${message}`);
          this.aiCodePanel.showError(message);
          this.aiCodePanel.setVerifyStatus(`Could not get a fix from Copilot: ${message}`, 'error');
          return;
        } finally {
          cts.dispose();
        }
      }
    } finally {
      this.aiCodePanel.setVerifyButtonEnabled(true);
    }
  }

  /** Big green "Code Correctness Confirmed" banner on the sidebar's main UI
   * — shown only after a genuine headless run passed (never for a
   * compile-only BDD check). Cleared (`false`) the moment the AI-generated
   * code changes again — a fresh generation, a fix-loop attempt, or a
   * verification failure — since a stale "confirmed" would be misleading. */
  private postCodeCorrectness(confirmed: boolean): void {
    this.webview?.postMessage({ type: 'codeCorrectness', payload: confirmed });
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
    customInstructions: string,
    apiDetails?: ApiRequestDetails
  ): Promise<void> {
    const settings = this.settingsStore.get();
    if (!settings.copilotEnabled || !settings.copilotModelId) {
      this.postLlmError('Enable "Link with GitHub Copilot LLM" (Control Panel) and pick a model in Settings first.');
      return;
    }
    const isApiMode = settings.automationMode === 'api';
    // Single choke point for every path into this method (manual chat send,
    // the automatic post-recording pipeline, and "Regenerate AI Code") —
    // never send an empty/no-op context to the LLM, and tell the user why
    // instead of silently doing nothing. Which "empty" means depends on the
    // mode: API mode has no Playwright code at all, ever — its own request
    // details are what must not be empty.
    if (isApiMode ? !hasApiRequest(apiDetails) : !playwrightCode.trim()) {
      void vscode.window.showWarningMessage(
        isApiMode
          ? 'Enter an API request URL in the Control Panel first before triggering AI analysis'
          : 'Record some user action first before triggering AI analysis'
      );
      return;
    }

    this.llmCancellation?.cancel();
    this.llmCancellation?.dispose();
    const cts = new vscode.CancellationTokenSource();
    this.llmCancellation = cts;

    this.postLlmStart();

    const builtIn = isApiMode ? readApiAutomationInstructions() : readSeniorQeInstructions();
    const prompt = isApiMode
      ? buildApiLlmPrompt(
          settings.language,
          settings.languageVersion,
          builtIn,
          instructions,
          apiDetails!,
          customInstructions,
          this.linkedScenario,
          this.currentSuggestedBaseName()
        )
      : buildLlmPrompt(
          settings.language,
          settings.languageVersion,
          settings.browserChannel,
          builtIn,
          instructions,
          playwrightCode,
          customInstructions,
          this.linkedScenario,
          this.currentSuggestedBaseName()
        );
    // Diagnostic trail for exactly the question "was X actually sent, and
    // did a response come back?" — check the softPlay Output channel
    // (View -> Output -> softPlay) rather than needing to guess from a
    // stuck "(generating…)" label with no other visible signal.
    this.outputChannel.appendLine(
      `Sending to Copilot model "${settings.copilotModelId}" (${isApiMode ? 'API' : 'UI'} mode): target ` +
        `${settings.language} ${settings.languageVersion}, mandatory standard ` +
        `${builtIn ? `(${builtIn.length} chars)` : '(MISSING — instructions .md failed to load)'}, ` +
        `${instructions.length} project .md file(s), ` +
        `${this.linkedScenario ? `linked scenario "${this.linkedScenario.scenarioName}"` : 'no linked scenario'}, ` +
        `${isApiMode ? `API request to ${apiDetails?.url}` : `${playwrightCode.length} chars of reference code`} — ` +
        `prompt is ${prompt.length} chars total.`
    );

    try {
      const accumulated = await this.streamCopilotResponse(prompt, settings.copilotModelId, cts, (chunk) => this.postLlmChunk(chunk));
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

  /**
   * The actual streaming request/timeout/cancellation core, shared by
   * runLlmRefinement() (AI Generated Code) and generateFeatureFile()
   * (Generated Feature File) — the two differ only in which prompt they
   * build and which panel/status sink the result goes to, both handled by
   * the caller. Returns the full accumulated response text, or rejects with
   * the same errors sendPrompt()/the timeouts above would.
   */
  private async streamCopilotResponse(
    prompt: string,
    copilotModelId: string,
    cts: vscode.CancellationTokenSource,
    onChunk: (chunk: string) => void
  ): Promise<string> {
    let accumulated = '';
    let receivedAnyChunk = false;
    // No case observed so far where the Language Model API's own promise
    // neither resolves nor rejects — but nothing in its contract
    // *guarantees* that either, and a silent hang there would otherwise
    // show "(generating…)" forever with zero feedback. This timeout is a
    // last-resort safety net, not a substitute for whatever the real
    // per-request latency should be — see FIRST_CHUNK_TIMEOUT_MS /
    // INTER_CHUNK_TIMEOUT_MS for why the two phases get different
    // allowances; each chunk received re-arms it for the next one.
    let timeoutHandle: ReturnType<typeof setTimeout>;
    const armTimeout = (onTimeout: () => void) => {
      clearTimeout(timeoutHandle);
      const ms = receivedAnyChunk ? ObjectSpyPanel.INTER_CHUNK_TIMEOUT_MS : ObjectSpyPanel.FIRST_CHUNK_TIMEOUT_MS;
      timeoutHandle = setTimeout(onTimeout, ms);
    };
    await new Promise<void>((resolve, reject) => {
      armTimeout(() =>
        reject(
          new Error(
            `Copilot did not respond within ${ObjectSpyPanel.FIRST_CHUNK_TIMEOUT_MS / 60_000} minutes — no chunk of the response arrived in that window. A large prompt (a big linked scenario, a lot of reference code, or several Custom md files checked) can genuinely take a while — try again, or trim what's being sent.`
          )
        )
      );
      sendPrompt(
        copilotModelId,
        prompt,
        (chunk) => {
          receivedAnyChunk = true;
          armTimeout(() =>
            reject(
              new Error(
                `Copilot stopped responding mid-stream — no further chunk arrived within ${ObjectSpyPanel.INTER_CHUNK_TIMEOUT_MS / 1000} seconds.`
              )
            )
          );
          accumulated += chunk;
          onChunk(chunk);
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
    return accumulated;
  }

  /** The class name (Java) / module base name (Python) the linked
   * scenario's own name derives into (see testNaming.ts) for whichever
   * language is currently selected — undefined when no scenario is linked,
   * in which case callers fall back to their own generic default. */
  private currentSuggestedBaseName(): string | undefined {
    if (!this.linkedScenario) {
      return undefined;
    }
    return this.settingsStore.get().language === 'java'
      ? this.linkedScenario.javaClassName
      : this.linkedScenario.pythonModuleName;
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
        ? {
            featureName: this.linkedScenario.featureName,
            scenarioName: this.linkedScenario.scenarioName,
            scenarioKind: this.linkedScenario.scenarioKind,
            selectedStepCount: this.linkedScenario.selectedStepCount,
            totalStepCount: this.linkedScenario.totalStepCount
          }
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
    this.aiCodePanel.setSuggestedFileName(this.currentSuggestedBaseName());
    this.aiCodePanel.startGenerating();
    this.webview?.postMessage({ type: 'aiStatus', payload: { state: 'generating' } });
    // Fresh generation incoming — any prior "Code Correctness Confirmed"
    // was about a now-superseded version of the code.
    this.postCodeCorrectness(false);
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
   * panel uses it to flash the "New code recorded." indicator. Purely
   * informational: a new recording never triggers AI processing on its
   * own — only "Start AI Processing" does. */
  private postCode(isNewRecording = false): void {
    const settings = this.settingsStore.get();
    this.webview?.postMessage({
      type: 'code',
      payload: {
        code: this.nativeGeneratedCode,
        language: settings.language,
        languageVersion: settings.languageVersion,
        automationMode: settings.automationMode,
        isNewRecording
      }
    });
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

  <div id="codeCorrectnessBanner" class="code-correctness-banner" hidden>✓ Code Correctness Confirmed</div>

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
      <div id="uiModeControls">
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
      ${getApiPanelHtml()}
      <div class="toolbar-row copilot-toggle-row">
        <span class="copilot-toggle-label">
          Link with GitHub Copilot LLM
          <span class="hint">Lets Generate Code send its output and captured locators to a Copilot chat model for a second, AI-generated version to compare side by side. Requires the GitHub Copilot Chat extension. Pick a model in Settings.</span>
        </span>
        <label class="switch">
          <input type="checkbox" id="copilotEnabledToggle" />
          <span class="switch-track"></span>
        </label>
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
                <button id="chatSendBtn" class="chat-send-btn" title="Add to the request — click 'Start AI Processing' below to actually send" aria-label="Add">➤</button>
              </div>
            </div>
          </div>
        </details>
        <div class="toolbar-row ai-open-row">
          <button id="generateFeatureFileBtn" class="btn btn-silver" title="No feature file to link yet? Record a flow with Start above, then send the recorded Playwright Code (plus anything in the chat box) to the LLM to generate a brand-new BDD Gherkin feature file">Generate Gherkin Feature File</button>
          <button id="startAiProcessingBtn" class="btn btn-silver" title="Send the current Playwright Code, Settings (browser/language/version), linked scenario or selected steps, checked Custom md files, and anything in the chat box below to the LLM for AI code generation">Start AI Processing</button>
          <button id="openAiCodeBtn" class="btn btn-silver">Open AI Generated Code</button>
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

/**
 * The "API Automation" mode's Control Panel content — a Postman-styled
 * request builder (method+URL, Params/Authorization/Headers/Body tabs),
 * black background with orange accents per the explicit ask, built from
 * scratch as plain HTML/CSS (no bundling a real HTTP-client UI library) —
 * this extension never actually SENDS the request itself; it only collects
 * the request shape and hands it to the LLM as context (see
 * collectApiRequestDetails() in main.js and buildApiRequestSummary() below).
 * Deliberately a practical subset of Postman's own surface, not a pixel
 * clone: Pre-request Script/Tests/Settings tabs, GraphQL body, binary file
 * upload, and the more exotic auth types (NTLM, AWS Signature, Hawk,
 * Akamai EdgeGrid, OAuth) are out of scope — none of them add information
 * an LLM needs to generate correct REST Assured/requests code, which is
 * this feature's actual purpose.
 */
function getApiPanelHtml(): string {
  return `
      <div id="apiModeControls" class="api-panel" hidden>
        <div class="api-request-row">
          <select id="apiMethod" class="api-method-select">
            <option value="GET">GET</option>
            <option value="POST">POST</option>
            <option value="PUT">PUT</option>
            <option value="PATCH">PATCH</option>
            <option value="DELETE">DELETE</option>
            <option value="HEAD">HEAD</option>
            <option value="OPTIONS">OPTIONS</option>
          </select>
          <input id="apiUrl" class="api-url-input" type="text" placeholder="Enter request URL" />
        </div>
        <div class="api-tabs">
          <button type="button" class="api-tab active" data-tab="params">Params</button>
          <button type="button" class="api-tab" data-tab="auth">Authorization</button>
          <button type="button" class="api-tab" data-tab="headers">Headers</button>
          <button type="button" class="api-tab" data-tab="body">Body</button>
        </div>

        <div class="api-tab-panel" data-panel="params">
          <div class="api-kv-header">Query Params</div>
          <table class="api-kv-table" id="apiParamsTable">
            <thead><tr><th>Key</th><th>Value</th><th>Description</th><th></th></tr></thead>
            <tbody></tbody>
          </table>
        </div>

        <div class="api-tab-panel" data-panel="auth" hidden>
          <div class="api-field-row">
            <label>Type</label>
            <select id="apiAuthType">
              <option value="noauth">No Auth</option>
              <option value="apikey">API Key</option>
              <option value="bearer">Bearer Token</option>
              <option value="basic">Basic Auth</option>
            </select>
          </div>
          <div class="api-auth-fields" data-auth="apikey" hidden>
            <div class="api-field-row"><label>Key</label><input id="apiAuthApiKeyName" type="text" placeholder="e.g. X-API-Key" /></div>
            <div class="api-field-row"><label>Value</label><input id="apiAuthApiKeyValue" type="password" placeholder="Value" /></div>
            <div class="api-field-row">
              <label>Add to</label>
              <select id="apiAuthApiKeyAddTo">
                <option value="header">Header</option>
                <option value="query">Query Params</option>
              </select>
            </div>
          </div>
          <div class="api-auth-fields" data-auth="bearer" hidden>
            <div class="api-field-row"><label>Token</label><input id="apiAuthBearerToken" type="password" placeholder="Token" /></div>
          </div>
          <div class="api-auth-fields" data-auth="basic" hidden>
            <div class="api-field-row"><label>Username</label><input id="apiAuthBasicUser" type="text" placeholder="Username" /></div>
            <div class="api-field-row"><label>Password</label><input id="apiAuthBasicPass" type="password" placeholder="Password" /></div>
          </div>
        </div>

        <div class="api-tab-panel" data-panel="headers" hidden>
          <div class="api-kv-header">Headers</div>
          <table class="api-kv-table" id="apiHeadersTable">
            <thead><tr><th>Key</th><th>Value</th><th>Description</th><th></th></tr></thead>
            <tbody></tbody>
          </table>
        </div>

        <div class="api-tab-panel" data-panel="body" hidden>
          <div class="api-body-mode-row">
            <label><input type="radio" name="apiBodyMode" value="none" checked /> none</label>
            <label><input type="radio" name="apiBodyMode" value="form-data" /> form-data</label>
            <label><input type="radio" name="apiBodyMode" value="x-www-form-urlencoded" /> x-www-form-urlencoded</label>
            <label><input type="radio" name="apiBodyMode" value="raw" /> raw</label>
          </div>
          <div class="api-body-panel" data-body="form-data" hidden>
            <table class="api-kv-table" id="apiFormDataTable">
              <thead><tr><th>Key</th><th>Value</th><th>Description</th><th></th></tr></thead>
              <tbody></tbody>
            </table>
          </div>
          <div class="api-body-panel" data-body="x-www-form-urlencoded" hidden>
            <table class="api-kv-table" id="apiUrlencodedTable">
              <thead><tr><th>Key</th><th>Value</th><th>Description</th><th></th></tr></thead>
              <tbody></tbody>
            </table>
          </div>
          <div class="api-body-panel" data-body="raw" hidden>
            <div class="api-raw-toolbar">
              <select id="apiRawLanguage" class="api-raw-lang-select">
                <option value="Text">Text</option>
                <option value="JSON" selected>JSON</option>
                <option value="XML">XML</option>
              </select>
              <button type="button" id="apiRawBeautifyBtn" class="api-raw-beautify-btn" title="Auto-format (pretty-print) the body">Beautify</button>
            </div>
            <div class="api-raw-editor-wrap">
              <div id="apiRawGutter" class="api-raw-gutter"></div>
              <pre id="apiRawHighlight" class="api-raw-highlight" aria-hidden="true"><code></code></pre>
              <textarea id="apiRawBody" class="api-raw-edit-area" spellcheck="false" placeholder="Request body"></textarea>
            </div>
          </div>
        </div>
      </div>`;
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

// Same pattern as readSeniorQeInstructions() above, for the "Generate
// Gherkin Feature File" prompt (prompts/generate-feature-file.md) instead.
let cachedFeatureFileGenInstructions: string | undefined;
function readFeatureFileGenInstructions(): string {
  if (cachedFeatureFileGenInstructions !== undefined) {
    return cachedFeatureFileGenInstructions;
  }
  try {
    cachedFeatureFileGenInstructions = fs.readFileSync(
      path.join(__dirname, '..', '..', 'prompts', 'generate-feature-file.md'),
      'utf8'
    );
  } catch {
    cachedFeatureFileGenInstructions = '';
  }
  return cachedFeatureFileGenInstructions;
}

/**
 * Builds the single user message sent to the Copilot model for "Generate
 * Gherkin Feature File" — the bundled instructions (see
 * prompts/generate-feature-file.md) plus, when present, any free-text the
 * user typed into the chat box, plus the raw Playwright Codegen output to
 * analyze. Deliberately much simpler than buildLlmPrompt(): no linked
 * scenario, no Settings (language/version/browser are irrelevant to
 * producing a Gherkin feature file), no Custom md files — this is a
 * standalone "code in, feature file out" request.
 */
function buildFeatureFilePrompt(builtInInstructions: string, playwrightCode: string, customInstructions: string): string {
  const parts: string[] = [];

  if (builtInInstructions) {
    parts.push(builtInInstructions);
  } else {
    parts.push(
      'Analyze the following Playwright Codegen-generated code and produce a complete, business-focused BDD ' +
        'Gherkin feature file. Output ONLY the feature file in a single fenced `gherkin` code block, no other commentary.'
    );
  }

  if (customInstructions) {
    parts.push(`\n## Additional instructions from the user — follow these too\n${customInstructions}`);
  }

  parts.push(
    `\n## Playwright Codegen output to analyze\n\`\`\`\n${playwrightCode}\n\`\`\``
  );

  return parts.join('\n');
}

// Same pattern as readSeniorQeInstructions()/readFeatureFileGenInstructions()
// above, for API Automation mode's prompts/api-automation-instructions.md.
let cachedApiAutomationInstructions: string | undefined;
function readApiAutomationInstructions(): string {
  if (cachedApiAutomationInstructions !== undefined) {
    return cachedApiAutomationInstructions;
  }
  try {
    cachedApiAutomationInstructions = fs.readFileSync(
      path.join(__dirname, '..', '..', 'prompts', 'api-automation-instructions.md'),
      'utf8'
    );
  } catch {
    cachedApiAutomationInstructions = '';
  }
  return cachedApiAutomationInstructions;
}

/** API Automation mode's counterpart to buildFeatureFilePrompt() — same
 * "code/request in, feature file out" shape, just fed the Control Panel's
 * API request details (buildApiRequestSummary()) instead of Playwright
 * Codegen output. A linked scenario (if any) is folded in as additional
 * business context per the explicit ask that a linked feature file be
 * handled "the same way" in API mode as in UI mode. */
function buildApiFeatureFilePrompt(
  builtInInstructions: string,
  apiDetails: ApiRequestDetails,
  customInstructions: string,
  linkedScenario?: LinkedScenario
): string {
  const parts: string[] = [];

  if (builtInInstructions) {
    parts.push(builtInInstructions);
  } else {
    parts.push(
      'Analyze the following API request details and produce a complete, business-focused BDD Gherkin feature ' +
        'file. Output ONLY the feature file in a single fenced `gherkin` code block, no other commentary.'
    );
  }

  if (customInstructions) {
    parts.push(`\n## Additional instructions from the user — follow these too\n${customInstructions}`);
  }

  if (linkedScenario) {
    const gherkinBlock = [linkedScenario.backgroundRawText, linkedScenario.rawText].filter(Boolean).join('\n\n');
    parts.push(
      `\n## Existing linked Gherkin ${linkedScenario.scenarioKind} — "${linkedScenario.scenarioName}" (from ${linkedScenario.featureName})`,
      `The user has this Cucumber ${linkedScenario.scenarioKind} already linked via "Link Feature file" — use it as ` +
        `additional business context (naming/terminology consistency, existing coverage to avoid duplicating) when ` +
        `generating the new feature file below; it is not itself the thing to regenerate.`,
      `\`\`\`gherkin\n${gherkinBlock}\n\`\`\``
    );
  }

  parts.push(`\n## API Request Details to analyze\n${buildApiRequestSummary(apiDetails)}`);

  return parts.join('\n');
}

/**
 * API Automation mode's counterpart to buildLlmPrompt() — same overall
 * shape and section ordering (opening ask, mandatory standard, project
 * .md files, user's free-text, the thing to analyze, linked Gherkin last
 * for recency — see buildLlmPrompt()'s own comment for why that order
 * matters), just built around an API request instead of a Playwright
 * recording: no "Reference Playwright-generated code" section (there is
 * none — no browser, no codegen, in this mode) and no browser-executable
 * requirement (API automation never launches a browser).
 */
function buildApiLlmPrompt(
  language: 'java' | 'python',
  languageVersion: string,
  builtInInstructions: string,
  instructions: { path: string; content: string }[],
  apiDetails: ApiRequestDetails,
  customInstructions: string,
  linkedScenario?: LinkedScenario,
  suggestedClassName?: string
): string {
  const languageName = language === 'java' ? 'Java (JUnit 5, REST Assured)' : 'Python (pytest, requests)';
  const versionGuidance = languageVersionGuidance(language, languageVersion);
  const isPartialSelection = !!linkedScenario && linkedScenario.selectedStepCount < linkedScenario.totalStepCount;

  const parts: string[] = [
    `You are an expert API test automation engineer working on an enterprise QA codebase.`,
    `Generate ${languageName} API test automation code, targeting exactly **${language === 'java' ? 'Java' : 'Python'} ` +
      `${languageVersion}** — the specific language/runtime version the user selected in Settings, and it must ` +
      `compile/run correctly under it, using only language features actually available in that version (never a ` +
      `newer version's syntax, no need to stay compatible with anything older either). ${versionGuidance} ` +
      `Follow the enterprise structure described in the mandatory refinement standard below. This is API test ` +
      `automation — there is no browser, no Playwright, no UI of any kind involved anywhere in the output. ` +
      `Respond with ONLY the final code in a single fenced code block and no other commentary.`
  ];

  if (isPartialSelection && linkedScenario) {
    parts.push(
      `\n## ⚠ Restricted scope for this request — OVERRIDES the mandatory refinement standard below wherever they conflict\n` +
        `The user checked only ${linkedScenario.selectedStepCount} of ${linkedScenario.totalStepCount} steps in the ` +
        `linked scenario (see the "Linked Gherkin" section near the end of this prompt) and wants a bare, minimal ` +
        `snippet — NOT a complete runnable file. Output ONLY:\n` +
        `  (a) one BDD step definition method for each checked step, and\n` +
        `  (b) whatever API client method(s) that step definition directly calls.\n` +
        `Do NOT include a class declaration/wrapper, any setup/teardown hooks, a step definition for the ` +
        `Background, or a step/API-client method for any step the user left unchecked — even indirectly (e.g. a ` +
        `prior API call a checked step might seem to depend on). The refinement standard's STYLE rules still apply ` +
        `to whatever you DO output; only its single-complete-file, hook, and Background-related instructions are ` +
        `overridden here.`
    );
  }

  if (builtInInstructions) {
    parts.push(`\n## Mandatory refinement standard — apply every part of this\n${builtInInstructions}`);
  }

  if (instructions.length) {
    parts.push(
      `\n## Project instructions/skills/prompts (from .github/) — follow these`,
      ...instructions.map((f) => `### ${f.path}\n${f.content}`)
    );
  }

  if (customInstructions) {
    parts.push(`\n## Additional instructions from the user — follow these too\n${customInstructions}`);
  }

  parts.push(`\n## API Request Details — the request to build test automation around\n${buildApiRequestSummary(apiDetails)}`);

  if (linkedScenario) {
    parts.push(
      `\n## Linked Gherkin ${linkedScenario.scenarioKind} — "${linkedScenario.scenarioName}" (from ${linkedScenario.featureName})`,
      `The user has linked this Cucumber ${linkedScenario.scenarioKind} to the API request above via "Link Feature ` +
        `file". Every Given/When/Then/And/But/* line below must get its own properly linked BDD step definition ` +
        `per section 7 of the mandatory refinement standard — do not just append the Gherkin as a comment. Produce ` +
        `exactly ONE file, in exactly ONE fenced code block: the API client AND its BDD step definitions together.`,
      `\`\`\`gherkin\n${[linkedScenario.backgroundRawText, linkedScenario.rawText].filter(Boolean).join('\n\n')}\n\`\`\``
    );
    if (suggestedClassName && !isPartialSelection) {
      parts.push(
        `\n## Required ${language === 'java' ? 'class' : 'module/file'} name (non-negotiable)\n` +
          (language === 'java'
            ? `Name the primary public class exactly \`${suggestedClassName}\` (and its file \`${suggestedClassName}.java\`) — ` +
              `derived from this scenario's own name, so it stays recognizable as the test for THIS scenario.`
            : `Name the module (test file, without the \`.py\` extension) exactly \`${suggestedClassName}\` — derived ` +
              `from this scenario's own name, so it stays recognizable as the test for THIS scenario.`)
      );
    }
  }

  return parts.join('\n');
}

/**
 * Builds the fix-up request sent to the LLM after a "Verify & Fix Code"
 * attempt actually failed to execute — deliberately keeps the ORIGINAL,
 * unmodified Playwright Codegen output in context on every single attempt
 * (per the explicit ask), so the LLM can always re-derive the correct
 * locator/action if the failure turns out to be a wrong one, no matter how
 * many fix iterations have already happened to the AI-refined code since.
 */
function buildFixPrompt(
  builtInInstructions: string,
  originalContext: { label: string; content: string },
  brokenCode: string,
  errorOutput: string,
  language: 'java' | 'python',
  automationMode: 'ui' | 'api'
): string {
  const languageName = language === 'java' ? 'Java' : 'Python';
  const domain = automationMode === 'api' ? 'API' : 'UI/Playwright';
  const parts: string[] = [
    `You are an expert ${domain} test automation engineer working on an enterprise QA codebase. The following ` +
      `${languageName} code was AI-generated and just FAILED to compile/parse when actually run in a real test ` +
      `attempt (a real API-side error response is handled separately and never reaches this prompt — this is a ` +
      `genuine code defect). Fix it so it compiles cleanly — respond with ONLY the corrected, complete code in a ` +
      `single fenced code block, no commentary.`
  ];

  if (builtInInstructions) {
    parts.push(`\n## Mandatory refinement standard — the fixed code must still follow every part of this\n${builtInInstructions}`);
  }

  parts.push(`\n## ${originalContext.label}\n${originalContext.content}`);

  parts.push(`\n## AI-generated code that failed\n\`\`\`${language}\n${brokenCode}\n\`\`\``);

  parts.push(`\n## Exact error output from the failed attempt\n\`\`\`\n${errorOutput}\n\`\`\``);

  parts.push(
    `\n## Task\nFix ONLY what's necessary to resolve this specific error. Do not restructure or rewrite parts of ` +
      `the code that aren't implicated by it. Keep the same class/file name, the same target language/runtime ` +
      `version${automationMode === 'ui' ? ', the same browser-executable launch override (never remove or weaken it)' : ''}, ` +
      `and the overall structure — this is a targeted fix, not a rewrite.`
  );

  return parts.join('\n');
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
  browserChannel: 'chrome' | 'edge',
  builtInInstructions: string,
  instructions: { path: string; content: string }[],
  playwrightCode: string,
  customInstructions: string,
  linkedScenario?: LinkedScenario,
  suggestedClassName?: string
): string {
  const languageName = language === 'java' ? 'Java (JUnit 5, Playwright for Java)' : 'Python (pytest, Playwright for Python)';
  const versionGuidance = languageVersionGuidance(language, languageVersion);
  const isPartialSelection = !!linkedScenario && linkedScenario.selectedStepCount < linkedScenario.totalStepCount;

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

  if (isPartialSelection && linkedScenario) {
    // Stated up front (primacy) AND repeated as the very last instruction
    // right before the reference code (recency) — see the "Linked Gherkin"
    // section below. A single mention easily loses to the mandatory
    // refinement standard's own "preserve the reference code's structure"
    // and "produce a complete, runnable file" instructions, which — left
    // unqualified — pull the model toward reproducing the FULL recorded
    // flow (hooks, Background, every step) regardless of what was checked.
    //
    // A partial selection means the user explicitly wants a BARE SNIPPET —
    // not the usual complete, standalone-runnable file — to paste into
    // their own existing framework. This is a deliberate, explicit product
    // decision (not the default "Generated Code" behavior, which still
    // produces a full file when every step is checked) — see the parallel
    // list this overrides, below.
    parts.push(
      `\n## ⚠ Restricted scope for this request — OVERRIDES the mandatory refinement standard below wherever they conflict\n` +
        `The user checked only ${linkedScenario.selectedStepCount} of ${linkedScenario.totalStepCount} steps in the ` +
        `linked scenario (see the "Linked Gherkin" section near the end of this prompt) and wants a bare, minimal ` +
        `snippet — NOT a complete runnable file. Output ONLY:\n` +
        `  (a) one BDD step definition method for each checked step, and\n` +
        `  (b) whatever page-object method(s) that step definition directly calls — the specific Playwright ` +
        `action(s)/assertion(s) it needs in order to do its job — reusing the reference code's own locators/actions ` +
        `for exactly those methods.\n` +
        `Do NOT include, even though the mandatory refinement standard below would otherwise call for them: a class ` +
        `declaration/wrapper around the output, \`@Before\`/\`@After\` hooks or any other browser/Playwright launch ` +
        `or teardown code, a step definition for the Background, imports/constants/locators for anything unrelated ` +
        `to (a)/(b) above, or a step/page-object method for any step the user left unchecked — even indirectly (e.g. ` +
        `a prior navigation/click a checked step might seem to depend on to reach the right page state; leave it ` +
        `out and let the checked step stand on its own, incomplete as a standalone runnable test). The refinement ` +
        `standard's STYLE rules still apply to whatever you DO output (naming, explicit visible+enabled waits before ` +
        `each interaction, real logging, zero hardcoded values, try/catch around the method itself) — only its ` +
        `single-complete-file, hook, and Background-related instructions are overridden here. Necessary imports for ` +
        `exactly what you output are expected; nothing beyond that.`
    );
  }

  if (builtInInstructions) {
    parts.push(`\n## Mandatory refinement standard — apply every part of this\n${builtInInstructions}`);
  }

  // Skipped entirely for a partial-step-selection ("bare snippet") request —
  // the "Restricted scope" section above already forbids ANY browser
  // launch/teardown code there, and this section would otherwise
  // contradict that by demanding the launch override be kept. Full-file
  // requests (the default, all steps checked) still get it.
  if (!isPartialSelection) {
    parts.push(
      `\n## Browser executable requirement (non-negotiable)\n` +
        `The user selected **${browserChannel === 'edge' ? 'Microsoft Edge' : 'Google Chrome'}** in softPlay ` +
        `Settings. A Chromium/Firefox/WebKit download is blocked by company policy in this environment, so the ` +
        `output must launch the real, already-installed ${browserChannel === 'edge' ? 'Edge' : 'Chrome'} executable ` +
        `on the local machine — found on disk by \`executablePath\` (never by \`channel\`, which still depends on ` +
        `Playwright's own resolution of the install), and must never trigger — or leave a code path that could ` +
        `trigger — a Playwright browser download or a launch with no \`executablePath\` set at all. The reference ` +
        `code below already carries this exact override: a \`_resolve_${browserChannel === 'edge' ? 'edge' : 'chrome'}_executable()\` ` +
        `helper (Python) checking, in order, an env-var override then the standard Windows install locations ` +
        `(\`Program Files\`, \`Program Files (x86)\`, per-user \`LOCALAPPDATA\`) for ` +
        `${browserChannel === 'edge' ? 'msedge.exe' : 'chrome.exe'}, wired into a \`browser_type_launch_args\` ` +
        `pytest fixture's \`"executable_path"\` — or the equivalent \`resolve${browserChannel === 'edge' ? 'Edge' : 'Chrome'}Executable()\` ` +
        `helper (Java) wired into an \`OptionsFactory\` passed to \`@UsePlaywright\`, calling ` +
        `\`.setExecutablePath(Paths.get(...))\`. Keep this override in the output exactly as-is — same candidate ` +
        `paths in the same order, same env-var name, same "throw/raise if none found" behavior (never silently ` +
        `fall back to a default launch) — even as you restructure everything else around it.`
    );
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

  // Placed BEFORE the "Linked Gherkin" section on purpose: the Gherkin
  // section (and its exclusion instruction, when only some steps are
  // checked) is deliberately the LAST thing the model reads before it has
  // to start generating — a model weighs what it read most recently more
  // heavily, and this reference block is large enough that ending on it
  // instead would drown out the exclusion instruction (observed in
  // practice: unchecked steps' click/navigation actions got folded back in
  // as "setup" even when no step definition was generated for them).
  parts.push(
    `\n## Reference Playwright-generated code (real, unmodified \`codegen\` output) — match this structure and style, reuse its locators as-is\n\`\`\`${language}\n${playwrightCode}\n\`\`\``
  );

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
    // Background is never individually selectable and a bare snippet must
    // not get a step definition for it either (see the "Restricted scope"
    // override above) — leaving it out of the Gherkin block entirely is a
    // stronger guarantee than relying on the model to notice it wasn't a
    // "checked" step.
    const gherkinBlock = isPartialSelection
      ? linkedScenario.rawText
      : [linkedScenario.backgroundRawText, linkedScenario.rawText].filter(Boolean).join('\n\n');
    parts.push(
      `\n## Linked Gherkin ${linkedScenario.scenarioKind} — "${linkedScenario.scenarioName}" (from ${linkedScenario.featureName})`,
      `The user has linked this Cucumber ${linkedScenario.scenarioKind} to the recorded flow above via ` +
        `"Link Feature file"` +
        (isPartialSelection
          ? `, and explicitly checked only ${linkedScenario.selectedStepCount} of its ${linkedScenario.totalStepCount} ` +
            `steps to include — the Gherkin block below is ONLY those checked steps (Background deliberately left ` +
            `out; do not generate a step definition for it). **This is a hard scope boundary, restated from earlier ` +
            `in this prompt:** the reference Playwright-generated code above is the full recorded flow — treat it ` +
            `purely as a pool of already-correct locators/actions to match against the steps below. Use ONLY ` +
            `whichever of its actions correspond to a step below; silently drop every other action, INCLUDING one a ` +
            `checked step might seem to need in order to reach the right page state (e.g. a prior navigation/click ` +
            `that belongs to a step the user did NOT check) — do not reintroduce it as a "setup" helper, a hook, or ` +
            `anything else. Output ONLY a step definition method per checked step below plus the page-object ` +
            `method(s) each one directly calls — no class wrapper, no hooks, nothing for an unchecked step, even ` +
            `indirectly, per the "Restricted scope" section above.`
          : `. Every Given/When/Then/And/But/* line below must get its own properly linked BDD step definition per ` +
            `the "BDD Gherkin Step Definition Linking" instructions — do not just append the Gherkin as a comment. ` +
            `Produce exactly ONE file, in exactly ONE fenced code block: the refined page object/test code AND its ` +
            `BDD step definitions together, correctly organized and imported as idiomatic for the target language's ` +
            `real BDD framework (Cucumber-JVM for Java, pytest-bdd for Python) — never split this into multiple ` +
            `files or code blocks.`),
      `\`\`\`gherkin\n${gherkinBlock}\n\`\`\``
    );
    // A snippet has no class of its own to name — this requirement only
    // makes sense for the full-file case.
    if (suggestedClassName && !isPartialSelection) {
      parts.push(
        `\n## Required ${language === 'java' ? 'class' : 'module/file'} name (non-negotiable)\n` +
          (language === 'java'
            ? `Name the primary public class exactly \`${suggestedClassName}\` (and its file \`${suggestedClassName}.java\`) — ` +
              `derived from this scenario's own name, so it stays recognizable as the test for THIS scenario. ` +
              `Any nested/step-definition class may be named sensibly relative to it, but the primary class itself ` +
              `must use exactly this name, unchanged.`
            : `Name the module (test file, without the \`.py\` extension) exactly \`${suggestedClassName}\` and its ` +
              `top-level test function(s) accordingly (e.g. \`test_${suggestedClassName}\` or similarly derived) — ` +
              `derived from this scenario's own name, so it stays recognizable as the test for THIS scenario.`)
      );
    }
  }

  return parts.join('\n');
}
