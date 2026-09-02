import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { BrowserManager, BrowserStatus, CapturedElement, RecordedActionEvent } from '../browser/browserManager';
import { CodegenManager, CodegenStatus } from '../browser/codegenManager';
import { SettingsStore } from '../settings/settingsStore';
import { SettingsPanel } from './settingsPanel';
import { FeatureFilePanel, LinkedScenario } from './featureFilePanel';
import { CodeGenerator, RecordedAction } from '../codegen/codeGenerator';
import { CopilotUnavailableError, extractCodeBlock, sendPrompt } from '../llm/copilotClient';

type InboundMessage =
  | { type: 'start'; payload?: string }
  | { type: 'stop' }
  | { type: 'navigate'; payload: string }
  | { type: 'toggleSpy' }
  | { type: 'openSettings' }
  | { type: 'startGenerateCode' }
  | { type: 'stopGenerateCode' }
  | { type: 'resolveAmbiguous'; payload: { locator: string } | null }
  | { type: 'deleteElements'; payload: string[] }
  | { type: 'saveCode'; payload: string }
  | { type: 'saveLocators'; payload: { format: 'json' | 'properties' } }
  | { type: 'killAllBrowsers' }
  | { type: 'refreshPromptFiles' }
  | { type: 'sendToLlm'; payload: { selectedFiles: string[]; code: string; customInstructions: string } }
  | { type: 'saveLlmCode'; payload: string }
  | { type: 'highlightElement'; payload: string }
  | { type: 'linkFeatureFile' }
  | { type: 'reopenFeatureFile' }
  | { type: 'unlinkFeatureFile' }
  | { type: 'selectedInstructionFiles'; payload: string[] };

/** Dedup/identity key for a captured element — see item #3: an element already
 * scanned (same locator type + locator string) is never added to the table twice. */
function elementKey(info: Pick<CapturedElement, 'locatorType' | 'locator'>): string {
  return `${info.locatorType}::${info.locator}`;
}

export const OBJECT_SPY_VIEW_ID = 'objectSpy.mainView';

/**
 * Owns softPlay's main UI and bridges it to the BrowserManager.
 *
 * Lives in the Activity Bar as a sidebar view (vscode.WebviewViewProvider),
 * not a floating editor-tab panel — so it's always one click away, the way
 * a testing tool's primary UI is expected to be, rather than only reachable
 * via the Command Palette.
 *
 * Start/Stop/Navigate, Object Spy, and the Settings panel are fully wired.
 * Generate Code records real user actions in the live Chrome page (click,
 * type, Enter/Tab/Escape, select, check/uncheck) and turns them into
 * Playwright automation code via CodeGenerator — an in-house template
 * layer, not Playwright's internal recorder (see codeGenerator.ts).
 */
export class ObjectSpyPanel implements vscode.Disposable, vscode.WebviewViewProvider {
  private view: vscode.WebviewView | undefined;
  private readonly browserManager = new BrowserManager();
  // "Use native Playwright feature" (Settings, default ON) — drives real
  // Playwright `codegen` in its OWN separate browser window instead of this
  // extension's CDP-attach + custom agent architecture. See codegenManager.ts
  // for why the two can't share a session, and startBrowser()/stopBrowser()
  // for how the panel picks between the two based on the current setting.
  private readonly codegenManager = new CodegenManager();
  // The most recent raw code `codegen` wrote, verbatim — what "Generated
  // Code" shows while native mode is active, entirely bypassing
  // CodeGenerator (see getCurrentGeneratedCode()).
  private nativeGeneratedCode = '';
  private readonly disposables: vscode.Disposable[] = [];

  // Captured elements persist across panel hide/reveal (retainContextWhenHidden
  // keeps the webview's own DOM alive, but a fresh `show()` after a full
  // dispose needs this to repopulate the table). Keyed by elementKey() so a
  // re-scanned element (same locator) is never added twice (#3), and
  // Generate Code's recorded actions can share the same table (#15).
  private readonly capturedElements = new Map<string, CapturedElement>();
  private readonly settingsPanel: SettingsPanel;
  private readonly featureFilePanel: FeatureFilePanel;
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

  private readonly codeGenerator = new CodeGenerator();
  private generating = false;
  // The action currently paused on an ambiguous (count > 1) locator, awaiting
  // the user's resolution in the panel — see §"Ambiguous locator" decision.
  private pendingAmbiguous: RecordedActionEvent | undefined;

  // Tracks the in-flight LLM refinement request, if any (manual chat send
  // or the automatic pipeline), so a second one starting (or the view
  // closing) can cancel the previous one cleanly instead of leaving two
  // streams writing into the same AI code view.
  private llmCancellation: vscode.CancellationTokenSource | undefined;

  // Debounces the automatic "refine with AI" pipeline (try/catch, logging,
  // explicit waits, zero hardcoded values — see prompts/senior-qe-instructions.md)
  // that fires whenever Generate Code records a new action and Copilot is
  // linked, so a burst of clicks doesn't fire one Copilot request per click —
  // only once activity settles for a moment.
  private autoRefineTimer: ReturnType<typeof setTimeout> | undefined;
  private static readonly AUTO_REFINE_DEBOUNCE_MS = 1500;

  // Diagnostic/informational messages (Chrome launch, recorded actions,
  // etc.) go to a proper VS Code Output channel rather than a panel of
  // their own — frees up the sidebar for the Elements table and code
  // editors, and is the idiomatic place for this kind of log anyway.
  private readonly outputChannel = vscode.window.createOutputChannel('softPlay');

  constructor(private readonly context: vscode.ExtensionContext, private readonly settingsStore: SettingsStore) {
    this.settingsPanel = new SettingsPanel(context, settingsStore);
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

    // Locator type lives in the Settings panel (context.globalState), not a
    // VS Code workspace setting — push the current value in now, and again
    // any time it changes, so a browser started later (or already running)
    // always reflects it.
    void this.browserManager.setLocatorType(this.settingsStore.get().locatorType);
    this.browserManager.setBrowserChannel(this.settingsStore.get().browserChannel);
    void this.browserManager.setNativeLocatorMode(this.settingsStore.get().useNativePlaywrightLocators);

    this.disposables.push(
      this.browserManager.onStatusChange((status) => {
        this.postStatus(status);
        // Object Spy / Generate Code can't survive a disconnect — reflect that.
        if (status.state !== 'connected') {
          this.postSpyState(false);
          this.generating = false;
          this.pendingAmbiguous = undefined;
          this.postGeneratingState(false);
        }
      }),
      this.browserManager.onLog((message) => this.outputChannel.appendLine(message)),
      this.browserManager.onCapture((info) => this.addElement(info)),
      this.browserManager.onAction((action) => void this.handleAction(action)),
      this.codegenManager.onStatusChange((status) => this.postStatus(mapCodegenStatus(status))),
      this.codegenManager.onLog((message) => this.outputChannel.appendLine(message)),
      this.codegenManager.onCodeUpdate((code) => {
        this.nativeGeneratedCode = code;
        this.postCode(true);
      }),
      this.settingsStore.onChange((settings) => {
        void this.browserManager.setLocatorType(settings.locatorType);
        this.browserManager.setBrowserChannel(settings.browserChannel);
        void this.browserManager.setNativeLocatorMode(settings.useNativePlaywrightLocators);
        this.postNativeModeActive(settings.useNativePlaywrightLocators);
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
    this.postStatus(this.currentStatus());
    this.postSpyState(this.browserManager.isSpyEnabled());
    this.postGeneratingState(this.generating);
    this.postNativeModeActive(this.settingsStore.get().useNativePlaywrightLocators);
    this.postLinkedScenario();
    this.postFeatureFileAvailable(this.featureFilePanel.hasLinkedFile());
    this.postCode();
    this.postCopilotEnabledState(this.settingsStore.get().copilotEnabled);
    for (const info of this.capturedElements.values()) {
      this.postCapture(info);
    }
    if (this.pendingAmbiguous) {
      this.postAmbiguous(this.pendingAmbiguous);
    }
  }

  /** `url` is only meaningful in native mode (Playwright `codegen`'s own
   * positional CLI argument, needed at spawn time) — the Command Palette's
   * "softPlay: Start Browser" command has no URL to offer, so it's optional;
   * codegen simply opens blank and the user types into its own address bar,
   * same as running it by hand with no URL. */
  async startBrowser(url?: string): Promise<void> {
    if (this.settingsStore.get().useNativePlaywrightLocators) {
      const settings = this.settingsStore.get();
      await this.codegenManager.start(url?.trim() ?? '', settings.language, settings.browserChannel);
      return;
    }
    try {
      await this.browserManager.start();
    } catch (err) {
      vscode.window.showErrorMessage(`softPlay: failed to start Chrome — ${describeError(err)}`);
    }
  }

  async stopBrowser(): Promise<void> {
    if (this.settingsStore.get().useNativePlaywrightLocators) {
      await this.codegenManager.stop();
      return;
    }
    await this.browserManager.stop();
  }

  /** Whichever of the two managers is relevant right now, translated to the
   * one BrowserStatus shape the panel/webview already understand — see
   * mapCodegenStatus(). */
  private currentStatus(): BrowserStatus {
    return this.settingsStore.get().useNativePlaywrightLocators
      ? mapCodegenStatus(this.codegenManager.getStatus())
      : this.browserManager.getStatus();
  }

  openSettings(): void {
    this.settingsPanel.show();
  }

  async navigate(url: string): Promise<void> {
    try {
      await this.browserManager.navigate(url);
    } catch (err) {
      vscode.window.showErrorMessage(`softPlay: failed to navigate — ${describeError(err)}`);
    }
  }

  dispose(): void {
    if (this.autoRefineTimer) {
      clearTimeout(this.autoRefineTimer);
    }
    this.llmCancellation?.cancel();
    this.llmCancellation?.dispose();
    this.browserManager.dispose();
    this.codegenManager.dispose();
    this.settingsPanel.dispose();
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
      case 'navigate':
        if (message.payload && message.payload.trim()) {
          await this.navigate(message.payload.trim());
        }
        break;
      case 'toggleSpy':
        await this.toggleSpy();
        break;
      case 'openSettings':
        this.settingsPanel.show();
        break;
      case 'startGenerateCode':
        await this.startGenerateCode();
        break;
      case 'stopGenerateCode':
        await this.stopGenerateCode();
        break;
      case 'resolveAmbiguous':
        await this.resolveAmbiguous(message.payload);
        break;
      case 'deleteElements':
        this.deleteElements(message.payload);
        break;
      case 'saveCode':
        await this.saveCode(message.payload);
        break;
      case 'saveLocators':
        await this.saveLocators(message.payload.format);
        break;
      case 'killAllBrowsers':
        await this.killAllBrowsers();
        break;
      case 'refreshPromptFiles':
        await this.refreshPromptFiles();
        break;
      case 'sendToLlm':
        await this.sendToLlm(message.payload.selectedFiles, message.payload.code, message.payload.customInstructions);
        break;
      case 'saveLlmCode':
        await this.saveLlmCode(message.payload);
        break;
      case 'highlightElement':
        await this.highlightElement(message.payload);
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
        // immediate feedback rather than waiting for the next recorded
        // action to happen to trigger a refinement.
        this.scheduleAutoRefine();
        break;
    }
  }

  /** Adds a captured/recorded element to the table, deduped by locator (#3). */
  private addElement(info: CapturedElement): void {
    const key = elementKey(info);
    if (this.capturedElements.has(key)) {
      return;
    }
    this.capturedElements.set(key, info);
    this.postCapture(info);
  }

  private deleteElements(keys: string[]): void {
    for (const key of keys) {
      this.capturedElements.delete(key);
    }
    this.webview?.postMessage({ type: 'removeElements', payload: keys });
  }

  /** "Highlight On Page" (#1) — brings the real Chrome tab forward and
   * flashes the selected row's element, if it's still on the current page. */
  private async highlightElement(key: string): Promise<void> {
    const info = this.capturedElements.get(key);
    if (!info) {
      void vscode.window.showWarningMessage('softPlay: that element is no longer in the table.');
      return;
    }
    const found = await this.browserManager.highlightElement(info.locatorType, info.locator);
    if (!found) {
      void vscode.window.showWarningMessage(
        `softPlay: "${info.elementName}" wasn't found on the current page — did you navigate away?`
      );
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

  private async saveLocators(format: 'json' | 'properties'): Promise<void> {
    if (this.capturedElements.size === 0) {
      void vscode.window.showInformationMessage('softPlay: no locators captured yet.');
      return;
    }
    const folders = await vscode.window.showOpenDialog({
      canSelectFolders: true,
      canSelectFiles: false,
      canSelectMany: false,
      openLabel: 'Save locators here'
    });
    if (!folders || folders.length === 0) {
      return;
    }
    const baseName = await vscode.window.showInputBox({
      prompt: 'File name (without extension)',
      value: 'softplay-locators'
    });
    if (!baseName) {
      return;
    }
    const ext = format === 'json' ? 'json' : 'properties';
    const uri = vscode.Uri.joinPath(folders[0], `${baseName}.${ext}`);
    const content = format === 'json' ? this.buildLocatorsJson() : this.buildLocatorsProperties();
    await vscode.workspace.fs.writeFile(uri, Buffer.from(content, 'utf8'));
    void vscode.window.showInformationMessage(`softPlay: saved ${path.basename(uri.fsPath)}`);
  }

  /** elementName -> locator only — see item #4. Names are disambiguated
   * with a numeric suffix when two different elements share one. */
  private buildElementNameMap(): Record<string, string> {
    const usedKeys = new Set<string>();
    const map: Record<string, string> = {};
    for (const info of this.capturedElements.values()) {
      const base = info.elementName || 'element';
      let key = base;
      let suffix = 2;
      while (usedKeys.has(key)) {
        key = `${base}${suffix}`;
        suffix++;
      }
      usedKeys.add(key);
      map[key] = info.locator;
    }
    return map;
  }

  private buildLocatorsJson(): string {
    return JSON.stringify(this.buildElementNameMap(), null, 2);
  }

  private buildLocatorsProperties(): string {
    const map = this.buildElementNameMap();
    const lines = Object.entries(map).map(([key, locator]) => `${key}=${escapePropertiesValue(locator)}`);
    return lines.join('\n') + '\n';
  }

  private async killAllBrowsers(): Promise<void> {
    // Both, unconditionally, regardless of which mode is current — clears
    // an orphaned session left over from before the Settings toggle was
    // last flipped, not just whichever manager the current setting implies.
    await this.browserManager.killAllAndClear();
    await this.codegenManager.stop();
    this.nativeGeneratedCode = '';
    this.capturedElements.clear();
    this.codeGenerator.reset();
    this.generating = false;
    this.pendingAmbiguous = undefined;
    // 'clearAll' resets the webview's code editor/table itself — no need to
    // also postCode() here, that would just be an empty-code message the
    // client immediately overwrites again anyway.
    this.webview?.postMessage({ type: 'clearAll' });
    this.outputChannel.appendLine('Killed all softPlay-launched browser instances and cleared stored locators.');
  }

  // -----------------------------------------------------------------------
  // "Custom md files" (GitHub Copilot AI Assist) — item 16, revised: there
  // is no more "Send to Copilot"/"Send Anyway" button. Checking a
  // .github/*.md file's checkbox is itself the action (sendToLlm() and
  // autoRefineWithLlm() both read this.selectedInstructionFiles, kept in
  // sync via the 'selectedInstructionFiles' message on every checkbox
  // change) — it's folded automatically into the next refinement, either
  // the chat composer's manual send (free-text instructions + whatever's
  // checked) or the automatic pipeline debounced after each new action
  // Generate Code records (scheduleAutoRefine() -> autoRefineWithLlm()).
  // Either way it only ever fires while "Link with GitHub Copilot LLM" is
  // on and a model is picked in Settings, which is itself an explicit,
  // one-time opt-in; VS Code's Language Model API separately shows its own
  // one-time consent dialog the first time this extension calls
  // sendRequest, regardless of which path triggers it.
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
   * Fires automatically whenever Generate Code records a new action, with no
   * button click required — the try/catch + logger + explicit-wait +
   * zero-hardcoded-values refinement (prompts/senior-qe-instructions.md) is
   * meant to keep the AI Generated Code panel current as the recording
   * grows, not require the user to remember to re-click Send. Debounced
   * (see AUTO_REFINE_DEBOUNCE_MS) so a burst of clicks fires one Copilot
   * request once things settle, not one per click. Silently does nothing if
   * Copilot isn't linked — this is a convenience on top of the manual "Send
   * to Copilot" flow, not a requirement to use it.
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
    const playwrightCode = this.getCurrentGeneratedCode();
    if (!playwrightCode.trim()) {
      return; // nothing recorded yet in either mode -- nothing to refine
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

    try {
      const prompt = buildLlmPrompt(
        settings.language,
        readSeniorQeInstructions(),
        instructions,
        this.buildLocatorsJson(),
        playwrightCode,
        customInstructions,
        this.linkedScenario
      );

      let accumulated = '';
      await sendPrompt(
        settings.copilotModelId,
        prompt,
        (chunk) => {
          accumulated += chunk;
          this.postLlmChunk(chunk);
        },
        cts.token
      );

      this.postLlmDone(extractCodeBlock(accumulated));
    } catch (err) {
      if (!cts.token.isCancellationRequested) {
        const message = err instanceof CopilotUnavailableError ? err.message : describeError(err);
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

  private async saveLlmCode(code: string): Promise<void> {
    const settings = this.settingsStore.get();
    const isJava = settings.language === 'java';
    const defaultName = isJava ? 'GeneratedTestAI.java' : 'test_recorded_flow_ai.py';
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

  private postCopilotEnabledState(enabled: boolean): void {
    this.webview?.postMessage({ type: 'copilotEnabledState', payload: enabled });
  }

  private postNativeModeActive(active: boolean): void {
    this.webview?.postMessage({ type: 'nativeModeActive', payload: active });
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

  private postLlmStart(): void {
    this.webview?.postMessage({ type: 'llmStart' });
  }

  private postLlmChunk(chunk: string): void {
    this.webview?.postMessage({ type: 'llmChunk', payload: chunk });
  }

  private postLlmDone(finalCode: string): void {
    this.webview?.postMessage({ type: 'llmDone', payload: finalCode });
  }

  private postLlmError(message: string): void {
    this.webview?.postMessage({ type: 'llmError', payload: message });
  }

  private async toggleSpy(): Promise<void> {
    if (this.browserManager.getStatus().state !== 'connected') {
      return;
    }
    const next = !this.browserManager.isSpyEnabled();
    await this.browserManager.setSpyEnabled(next);
    this.postSpyState(next);
  }

  private async startGenerateCode(): Promise<void> {
    if (this.browserManager.getStatus().state !== 'connected') {
      return;
    }
    this.generating = true;
    // Auto-enables Object Spy (BrowserManager.setRecording does this) —
    // reflect that in the toggle button too.
    await this.browserManager.setRecording(true);
    this.postSpyState(this.browserManager.isSpyEnabled());
    this.postGeneratingState(true);
  }

  private async stopGenerateCode(): Promise<void> {
    this.generating = false;
    await this.browserManager.setRecording(false);
    if (this.pendingAmbiguous) {
      this.pendingAmbiguous = undefined;
      this.postAmbiguousResolved();
    }
    this.postGeneratingState(false);
  }

  /** A recorded action arrived from the page agent — either add it to the
   * generated code (unique locator) or pause and ask the user to resolve it
   * (count > 1 — never guess an nth() index silently). */
  private async handleAction(action: RecordedActionEvent): Promise<void> {
    if (!this.generating) {
      return; // stale event racing a Stop Code Generation click
    }
    // A navigation isn't tied to any element — no locator to be ambiguous
    // about, and nothing meaningful to show in the Elements table — so it
    // skips straight to the generated code (see codeGenerator.ts's
    // buildFlowSegments()).
    if (action.actionType === 'navigate') {
      this.codeGenerator.addAction(toRecordedAction(action));
      this.outputChannel.appendLine(`Recorded: navigate → ${action.value}`);
      this.postCode(true);
      return;
    }
    // "Use native Playwright feature" (Settings, default ON) skips this
    // pause entirely — real Playwright Codegen doesn't verify uniqueness
    // either, and will happily hand you a locator that needs `.first()`/
    // manual disambiguation later; this mode intentionally matches that,
    // accepting whatever was captured as-is instead of blocking the
    // recording to ask for a fix.
    if (action.matches !== 1 && !this.settingsStore.get().useNativePlaywrightLocators) {
      this.pendingAmbiguous = action;
      // Pause reporting only — NOT the whole recording session (setRecording
      // would also disable click pass-through, since Object Spy's own
      // `spyEnabled` never gets cleared just because recording paused; that
      // used to silently start blocking every click, including ones that
      // should navigate, until the ambiguous banner was resolved).
      await this.browserManager.setRecordingPaused(true);
      this.postAmbiguous(action);
      return;
    }
    this.codeGenerator.addAction(toRecordedAction(action));
    this.addElement(action); // also tracked in the Elements table, not just the generated code (#15)
    this.outputChannel.appendLine(`Recorded: ${action.actionType} → ${action.locator}`);
    this.postCode(true);
  }

  private async resolveAmbiguous(payload: { locator: string } | null): Promise<void> {
    const pending = this.pendingAmbiguous;
    if (!pending) {
      return;
    }

    if (payload && payload.locator.trim()) {
      const locator = payload.locator.trim();
      const count = await this.browserManager.verifyLocatorCount(pending.locatorType, locator);
      if (count !== 1) {
        // Still not unique (or invalid) — keep it paused and re-prompt with
        // the fresh count so the user can keep refining.
        this.pendingAmbiguous = { ...pending, locator, matches: count };
        this.postAmbiguous(this.pendingAmbiguous, count < 0 ? 'Invalid locator.' : `Still ${count} matches.`);
        return;
      }
      const resolved = { ...pending, locator, matches: count };
      this.codeGenerator.addAction(toRecordedAction(resolved));
      this.addElement(resolved);
      this.outputChannel.appendLine(`Recorded (resolved): ${pending.actionType} → ${locator}`);
      this.postCode(true);
    } else {
      this.outputChannel.appendLine(`Skipped ambiguous ${pending.actionType} on <${pending.tag}> (${pending.matches} matches).`);
    }

    this.pendingAmbiguous = undefined;
    this.postAmbiguousResolved();
    if (this.generating) {
      await this.browserManager.setRecordingPaused(false);
    }
  }

  private postStatus(status: BrowserStatus): void {
    this.webview?.postMessage({ type: 'status', payload: status });
  }

  private postSpyState(enabled: boolean): void {
    this.webview?.postMessage({ type: 'spyState', payload: enabled });
  }

  private postCapture(info: CapturedElement): void {
    this.webview?.postMessage({ type: 'capture', payload: info });
  }

  private postGeneratingState(generating: boolean): void {
    this.webview?.postMessage({ type: 'generatingState', payload: generating });
  }

  /** Whichever the current mode actually is: the raw text `codegen` wrote
   * verbatim (native mode — no CodeGenerator involvement at all, per the
   * feature's whole point), or this extension's own template-generated
   * Page Object code (legacy CDP-attach mode). Shared by postCode() and the
   * AI refinement pipeline so both always agree on what "the current
   * generated code" means. */
  private getCurrentGeneratedCode(): string {
    const settings = this.settingsStore.get();
    if (settings.useNativePlaywrightLocators) {
      return this.nativeGeneratedCode;
    }
    return this.codeGenerator.generate(
      settings.language,
      settings.languageVersion,
      this.browserManager.getPageTitle(),
      settings.browserChannel
    );
  }

  /** `isNewRecording` flags a genuinely new action just landed (vs. a
   * refresh triggered by, say, a Settings change) — the panel uses it to
   * flash the "New code recorded." indicator (#2). */
  private postCode(isNewRecording = false): void {
    const settings = this.settingsStore.get();
    const code = this.getCurrentGeneratedCode();
    this.webview?.postMessage({
      type: 'code',
      payload: { code, language: settings.language, languageVersion: settings.languageVersion, isNewRecording }
    });
    if (isNewRecording) {
      this.scheduleAutoRefine();
    }
  }

  private postAmbiguous(action: RecordedActionEvent, note?: string): void {
    this.webview?.postMessage({ type: 'ambiguousAction', payload: action, note });
  }

  private postAmbiguousResolved(): void {
    this.webview?.postMessage({ type: 'ambiguousResolved' });
  }

  private getVersion(): string {
    // context.extension carries this build's own package.json — always the
    // version actually running, no separate copy to fall out of sync with.
    return (this.context as any).extension?.packageJSON?.version ?? '0.0.0';
  }

  private getHtml(webview: vscode.Webview): string {
    const scriptUri = webview.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, 'media', 'main.js'));
    const highlightUri = webview.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, 'media', 'highlight.js'));
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
    <span class="title">SOFT-PLAY AI POWERED TEST AUTOMATION PLUGIN</span>
    <span id="versionBadge" class="version-badge">v${this.getVersion()}</span>
  </div>

  <details class="section" id="controlPanelSection" open>
    <summary>Control Panel</summary>
    <div class="section-body">
      <div class="toolbar-row">
        <button id="startBtn" class="btn btn-primary">Start</button>
        <button id="stopBtn" class="btn" disabled>Stop</button>
        <span id="statusPill" class="status-pill status-idle">Idle</span>
      </div>
      <div id="nativeModeNote" class="native-mode-note" hidden>
        <strong>Use native Playwright feature</strong> is on (Settings) — Start launches
        Playwright's own <code>codegen</code> tool in its own browser window. Object Spy,
        the Locator Output table, and Generate Code aren't available while it's running;
        the URL below is only used as the page it opens to.
      </div>
      <div class="toolbar-row">
        <input id="urlInput" type="text" placeholder="https://example.com" />
        <button id="navigateBtn" class="btn legacy-only" disabled>Navigate</button>
      </div>
      <div class="toolbar-row">
        <button id="spyBtn" class="btn legacy-only" disabled title="Hover the real Chrome window to highlight elements; click to capture a locator">Object Spy: Off</button>
        <button id="genCodeBtn" class="btn legacy-only" disabled title="Record real browser actions and generate Playwright code">Generate Code</button>
        <button id="stopCodeBtn" class="btn legacy-only" disabled title="Pause recording — Generate Code resumes without losing what's generated">Stop Code Generation</button>
        <button id="settingsBtn" class="btn btn-icon" title="Settings (locator type, language)">⚙</button>
      </div>
      <div class="toolbar-row">
        <button id="killAllBtn" class="btn btn-danger" title="Close every browser this extension launched and clear all captured locators + generated code">Kill All Browsers</button>
      </div>
      <div class="toolbar-row">
        <button id="linkFeatureBtn" class="btn" title="Browse to a Cucumber .feature file and pick a Scenario/Scenario Outline to link to the generated code">Link Feature File</button>
        <span id="linkedScenarioBadge" class="linked-scenario-badge" hidden>
          <span id="linkedScenarioText"></span>
          <button id="unlinkScenarioBtn" class="btn-icon-small" title="Unlink this scenario">✕</button>
        </span>
      </div>

      <div id="ambiguousBanner" class="ambiguous-banner legacy-only" hidden>
        <div class="ambiguous-text">
          <strong>Ambiguous locator</strong> — <span id="ambiguousDetail"></span>
        </div>
        <input id="ambiguousLocatorInput" type="text" />
        <button id="ambiguousResumeBtn" class="btn btn-primary">Resume</button>
        <button id="ambiguousSkipBtn" class="btn">Skip</button>
      </div>
    </div>
  </details>

  <details class="section legacy-only" id="locatorOutputSection" open>
    <summary>Locator Output</summary>
    <div class="section-body">
      <table id="resultsTable">
        <thead>
          <tr>
            <th class="col-check"><input type="checkbox" id="selectAllCheckbox" title="Select all" /></th>
            <th>Element Name</th>
            <th>Element Locator</th>
            <th>Locator Quality</th>
            <th>Locator Uniqueness</th>
          </tr>
        </thead>
        <tbody>
          <tr class="empty-row">
            <td colspan="5">No elements captured yet. Turn on Object Spy and click an element in the real Chrome window.</td>
          </tr>
        </tbody>
      </table>
      <div class="table-actions">
        <button id="highlightOnPageBtn" class="btn" disabled title="Select exactly one row, then click to flash it on the real page">Highlight On Page</button>
        <button id="deleteSelectedBtn" class="btn" disabled>Delete Selected</button>
        <button id="saveLocatorsJsonBtn" class="btn">Save Locators (JSON)</button>
        <button id="saveLocatorsPropsBtn" class="btn">Save Locators (.properties)</button>
      </div>
    </div>
  </details>

  <details class="section" id="generatedCodeSection" open>
    <summary>Generated Code</summary>
    <div class="section-body">
      <div id="aiAssistSection" class="ai-assist" hidden>
        <details>
          <summary>Custom md files</summary>
          <div class="ai-assist-body">
            <div class="ai-files-header">Instruction / skill / prompt files (<code>.github/*.md</code>) — check any to include them automatically</div>
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
      </div>

      <div class="code-panels">
        <div class="code-panel" id="playwrightCodePanel">
          <div class="code-header">
            <button id="collapseCodeBtn" class="btn-icon-small code-collapse-btn" title="Collapse this panel">▾</button>
            <h3 class="section-title">Playwright Code <span id="codeLanguageLabel"></span> <span id="nativeModeBadge" class="native-mode-badge" hidden>Native Playwright Codegen</span></h3>
            <span id="newCodeFlash" class="new-code-flash" hidden>New code recorded.</span>
            <button id="copyCodeBtn" class="btn btn-small">Copy Code</button>
            <button id="saveCodeBtn" class="btn">Save Code</button>
          </div>
          <div id="codeRefreshBanner" class="code-refresh-banner" hidden>
            New code recorded. <button id="codeRefreshBtn" class="btn btn-small">Refresh (discards manual edits)</button>
          </div>
          <div class="code-editor-wrap">
            <pre id="codeHighlight" class="code-highlight" aria-hidden="true"><code></code></pre>
            <textarea id="codeEditArea" class="code-edit-area" spellcheck="false">// Click "Generate Code" and interact with the real Chrome window.</textarea>
          </div>
        </div>

        <div class="code-panel" id="llmCodePanel" hidden>
          <div class="code-header">
            <button id="collapseLlmCodeBtn" class="btn-icon-small code-collapse-btn" title="Collapse this panel">▾</button>
            <h3 class="section-title">AI Generated Code <span id="llmStatusLabel" class="llm-status"></span></h3>
            <button id="copyLlmCodeBtn" class="btn btn-small">Copy Code</button>
            <button id="saveLlmCodeBtn" class="btn">Save Code</button>
          </div>
          <div class="code-editor-wrap">
            <pre id="llmCodeHighlight" class="code-highlight" aria-hidden="true"><code></code></pre>
            <textarea id="llmCodeEditArea" class="code-edit-area" spellcheck="false">// Enable "Link with GitHub Copilot LLM" in Settings and pick a model, then check a .md file below or type instructions in the chat — the AI Generated Code view fills in automatically as code is recorded.</textarea>
          </div>
        </div>
      </div>
    </div>
  </details>

  <script nonce="${nonce}" src="${highlightUri}"></script>
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
// every refinement, manual or automatic. Lives outside src/ deliberately,
// same as agent/pageAgent.js: .vscodeignore excludes src/**/*.ts from the
// packaged extension, but this file must ship as plain markdown, not be
// compiled. Missing/unreadable is a benign "run without the extra standard"
// fallback, never a hard failure — the reference code and any .github/
// project instructions still make it into the prompt either way.
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

/** Translates CodegenStatus into the one BrowserStatus shape the webview
 * already knows how to render (status pill, Start/Stop enablement) — so
 * native mode needs no separate status-handling code client-side at all. */
function mapCodegenStatus(status: CodegenStatus): BrowserStatus {
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

function escapePropertiesValue(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/\r?\n/g, '\\n');
}

/**
 * Builds the single user message sent to the Copilot model — per item
 * #16.3, explicitly asks for the same Page-Object style/structure/language
 * CodeGenerator itself produces (§codeGenerator.ts), so the two views read
 * as variations on one convention rather than unrelated code. LLM output
 * can't be forced into an exact shape the way a template can, hence the
 * explicit, detailed ask plus extractCodeBlock() cleaning up the response
 * afterward — and why both code views stay editable.
 */
function buildLlmPrompt(
  language: 'java' | 'python',
  builtInInstructions: string,
  instructions: { path: string; content: string }[],
  locatorsJson: string,
  playwrightCode: string,
  customInstructions: string,
  linkedScenario?: LinkedScenario
): string {
  const languageName = language === 'java' ? 'Java (JUnit 5, Playwright for Java)' : 'Python (pytest, Playwright for Python)';

  const parts: string[] = [
    `You are an expert Playwright test automation engineer working on an enterprise QA codebase.`,
    `Generate ${languageName} automation code that follows the SAME enterprise Page-Object style as the ` +
      `reference "Playwright-generated code" below: a page object class exposing one fluent method per ` +
      `element interaction (each method returns the page object itself for chaining), and a separate ` +
      `test class/function that composes those methods in order. Reuse the exact locators given in the ` +
      `"Captured element locators" JSON below — do not invent new ones or guess at different ones. ` +
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
  // was selected (or in addition to one), see item #2's no-instructions warning.
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
    `\n## Captured element locators (JSON)\n\`\`\`json\n${locatorsJson}\n\`\`\``,
    `\n## Reference Playwright-generated code — match this structure and style\n\`\`\`${language}\n${playwrightCode}\n\`\`\``
  );

  return parts.join('\n');
}

function toRecordedAction(action: RecordedActionEvent): RecordedAction {
  return {
    actionType: action.actionType,
    tag: action.tag,
    text: action.text,
    elementName: action.elementName,
    locatorType: action.locatorType,
    locator: action.locator,
    tier: action.tier,
    qualityLabel: action.qualityLabel,
    matches: action.matches,
    value: action.value,
    submitLike: action.submitLike
  };
}
