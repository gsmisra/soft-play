import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { CodegenManager, CodegenStatus } from '../browser/codegenManager';
import { ObjectSpySettings, SettingsStore } from '../settings/settingsStore';
import { SettingsPanel } from './settingsPanel';
import { FeatureFilePanel, LinkedScenario } from './featureFilePanel';
import { AiCodePanel } from './aiCodePanel';
import { GeneratedFeaturePanel } from './generatedFeaturePanel';
import { CopilotUnavailableError, countModelTokens, extractCodeBlock, findModel, PromptTooLargeError, sendPrompt, sendPromptWithModel } from '../llm/copilotClient';
import { checkEnvironment } from '../execution/environmentCheck';
import { executeGeneratedCode } from '../execution/testExecutor';
import { ApiRequestDetails, SecretEncryptor, buildApiRequestSummary, extractApiBodyFieldNames, hasApiRequest } from '../api/apiRequestDetails';
import { readFileCachedSync, readWorkspaceFileCached } from '../cache/fileCache';
import * as secretVault from '../security/secretVault';
import { encryptPasswordLiteralsInCode } from '../security/uiPasswordRedactor';
import { encryptCredentialsInFreeText } from '../security/chatInstructionRedactor';
import { runVerifyFixAgent } from '../agent/verifyFixOrchestrator';
import { truncateForDialog, truncateForStatusLine } from '../agent/verifyFixTextTruncation';
import { appendPasswordEncryptionSection } from '../security/passwordEncryptionSection';
import { withDatabaseTestingInstructions } from '../llm/databaseTestingInstructions';
import { getOrBuildFreshnessReport, FreshnessReport } from '../rag/ragFreshnessService';
import { RAG_DRAFTS_FOLDER_SEGMENTS } from '../rag/ragCorpusGenerator';
import { parseRagFile } from '../rag/ragFrontmatter';
import { RagMatch } from '../rag/ragRetriever';
import {
  planOperationsFromGherkinSteps,
  planOperationFromApiRequest,
  planUnstructuredOperation,
  withSharedContext,
  OperationPlan
} from '../rag/ragOperationPlanner';
import { packRagSection } from '../rag/ragPackingPipeline';
import { prependRagTraceabilityBanner } from './ragTraceabilityBanner';
import { findUncoveredSteps } from './stepCoverageChecker';
import { AgenticModeController } from '../agentic/agenticModeController';
import { AgenticIngestionPanel } from './agenticIngestionPanel';
import { getAgenticModeSidebarHtml } from './agenticModeSidebarView';

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
  | { type: 'browseApiFormFile'; payload: { rowId: number } }
  | { type: 'clearApiData' }
  | { type: 'updateDraftContext'; payload: { code: string; customInstructions: string; selectedFiles: string[]; apiDetails?: ApiRequestDetails } }
  // Total Agentic Mode — routed straight to AgenticModeController/
  // AgenticIngestionPanel (agentic/agenticModeController.ts,
  // panel/agenticIngestionPanel.ts); ObjectSpyPanel itself never inspects
  // their payloads beyond this dispatch, per this feature's "proper
  // segregation" requirement.
  | { type: 'agentic:ready' }
  | { type: 'agentic:ingestFiles'; payload: { files: { fileName: string; base64: string }[] } }
  | { type: 'agentic:openIngestionPanel' }
  | { type: 'agentic:updateDraftInstructions'; payload: string }
  | { type: 'agentic:refreshInstructionFiles' }
  | { type: 'agentic:selectedInstructionFiles'; payload: string[] }
  | { type: 'agentic:generateFeatureFile' }
  | { type: 'agentic:generateCode' }
  | { type: 'agentic:generateCsv' }
  | { type: 'agentic:clearData' };

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
 * Owns SoftPlay's main UI and bridges it to CodegenManager.
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
 * scenario to it (see featureFilePanel.ts); "Start AI Feature File Generation"
 * is the reverse direction for when no .feature file exists yet — it turns
 * a Playwright Codegen recording alone into a brand-new BDD feature file
 * (see generateFeatureFile()/prompts/generate-feature-file.md). AI
 * processing (Copilot) never starts on its own — recording code, checking a
 * "Custom md files" box, or typing in the chat composer only ever stages
 * context; nothing is sent to the LLM until the user explicitly clicks
 * "Start AI Code Generation" or "Start AI Feature File Generation", each of which
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
  // "Start AI Feature File Generation" — the OPPOSITE direction of the above:
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
  // S02: which scenario (by scenarioIdentityKey()), if any, was linked the
  // LAST time `nativeGeneratedCode` actually changed — i.e. the scenario the
  // CURRENT recording content can genuinely be said to correspond to.
  // Stamped only from the `onCodeUpdate` callback below (never from the
  // "Link Feature file" callback itself), so switching the linked scenario
  // alone — with no fresh recording captured afterward — leaves this
  // pointing at whichever scenario the existing recording actually was made
  // for. `undefined` means either nothing has been recorded yet, or
  // whatever was recorded happened before any scenario was ever linked
  // (the common, intentional "record first, link after" flow — not a
  // mismatch). See recordingMayNotCoverScenario().
  private recordingAssociatedScenarioKey: string | undefined;
  // API Automation mode's Control Panel request builder, as last sent by
  // "Start AI Code Generation"/"Start AI Feature File Generation" — kept around
  // purely so "Regenerate" (AI Generated Code / Generated Feature File
  // panels, which don't have their own copy of the API form) can replay
  // the same request without the user re-entering it. Never read in UI
  // mode.
  private lastApiRequestDetails: ApiRequestDetails | undefined;
  // The full accumulated chat-box instructions ("Add any details for the AI
  // to follow…") from the LAST "Start AI Code Generation"/"Start AI Feature
  // File Generation" — kept around for the exact same reason as
  // lastApiRequestDetails just above: "Regenerate AI Code" (AI Generated
  // Code panel) has no chat box of its own, so it replays this instead of
  // silently dropping whatever instructions the user had accumulated. The
  // sidebar itself already accumulates across multiple rounds rather than
  // clearing after each send (see collectInstructionsForGeneration() in
  // main.js) — this is simply the extension host's own copy of that same
  // "current" string. Reset to '' only by clearSharedLlmContext() (Clear
  // Data / Kill All Browsers), matching the chat box's own reset boundary.
  private lastCustomInstructions = '';
  // Workspace-relative paths of whichever "Custom md files" (.github/*.md)
  // checkboxes are currently checked in the webview — kept in sync via the
  // 'selectedInstructionFiles' message every time the user (un)checks one.
  // Purely staged context: checking a box does NOT itself trigger anything
  // — it's folded in the next time "Start AI Code Generation" is clicked.
  private selectedInstructionFiles: string[] = [];
  // "Token Monitoring" segment — the real token count of the LAST completed
  // LLM response (0 until the first one lands this session), always
  // rebroadcast alongside a fresh "sent" estimate so the sidebar shows both
  // together (see updateTokenEstimate()/broadcastTokenEstimate()).
  private lastReceivedTokens = 0;
  // Discards a stale in-flight token count that resolves after a newer one
  // was already requested (countTokens is async and its latency isn't
  // bounded) — only the response matching the CURRENT sequence number is
  // ever applied, so a slow/older estimate can never overwrite a fresher one.
  private tokenEstimateSeq = 0;
  // Resolves a pending requestCurrentPlaywrightCode() call (see
  // "Regenerate AI Code") once the sidebar webview reports its Playwright
  // Code editor's live content back via 'currentCodeReport'.
  private pendingCodeRequestResolve: ((code: string) => void) | undefined;

  // Tracks the in-flight LLM refinement request, if any, so a second one
  // starting (or the view closing) can cancel the previous one cleanly
  // instead of leaving two streams writing into the same AI code view.
  // Shared between TWO different flows — runLlmRefinement() ("Start AI
  // Code Generation") and runVerifyFixAgentPath() ("Verify & Fix Code") —
  // `llmCancellationOwner` below records WHICH one currently owns it, so a
  // consumer (S01: cancelLinkedGenerationOnScenarioChange()) that only
  // cares about ONE of the two never accidentally cancels the other.
  private llmCancellation: vscode.CancellationTokenSource | undefined;
  /** S01: which flow `llmCancellation` currently belongs to — `undefined`
   * when nothing is in flight. Set immediately alongside `llmCancellation`
   * at the start of whichever of the two methods actually starts a request
   * (never inferred after the fact), so `cancelLinkedGenerationOnScenarioChange()`
   * can tell "the in-flight request depends on `linkedScenario` and must
   * be cancelled when it changes" apart from "Verify & Fix Code is
   * running and has nothing to do with the scenario selection" — cancelling
   * THAT one just because the user browsed to a different Gherkin scenario
   * would be an unrelated, unwanted side effect. */
  private llmCancellationOwner: 'linkedGeneration' | 'verifyFix' | undefined;
  // Same, but for an in-flight "Start AI Feature File Generation" request —
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
  private readonly outputChannel = vscode.window.createOutputChannel('SoftPlay');

  // Total Agentic Mode — a fully separate subsystem (own state, own
  // panels, own LangChain chains; see agentic/agenticModeController.ts's
  // doc comment). `agenticModeEnabledAtLastRender` lets the settings
  // change handler below tell "the mode itself was just toggled" (which
  // needs the sidebar's ENTIRE html swapped) apart from every other
  // settings change (which doesn't).
  private readonly agenticController: AgenticModeController;
  private readonly agenticIngestionPanel: AgenticIngestionPanel;
  private agenticModeEnabledAtLastRender = false;

  constructor(private readonly context: vscode.ExtensionContext, private readonly settingsStore: SettingsStore) {
    this.settingsPanel = new SettingsPanel(context, settingsStore);
    this.aiCodePanel = new AiCodePanel(context, () => void this.regenerateAiCode(), () => void this.verifyAndFixCode());
    this.generatedFeaturePanel = new GeneratedFeaturePanel(context, () => void this.regenerateFeatureFile());
    this.agenticController = new AgenticModeController(context, settingsStore, () => this.webview, this.outputChannel);
    this.agenticIngestionPanel = new AgenticIngestionPanel(context, this.agenticController);
    this.featureFilePanel = new FeatureFilePanel(
      (scenario) => {
        // S01: a Standard-mode "Start AI Code Generation" request already
        // in flight was built from whatever scenario was linked BEFORE
        // this — see cancelInFlightLinkedGeneration()'s own doc comment
        // for why letting it complete and land under this NEW scenario's
        // badge/filename is exactly the reproduced bug this closes.
        this.cancelInFlightLinkedGeneration();
        // S02: computed BEFORE `linkedScenario` is reassigned — this is
        // deliberately a comparison against whatever the EXISTING recording
        // actually corresponds to, not the new scenario itself.
        const recordingMismatch = this.recordingMayNotCoverScenario(scenario);
        this.linkedScenario = scenario;
        this.postLinkedScenario();
        this.outputChannel.appendLine(
          `Linked ${scenario.scenarioKind} "${scenario.scenarioName}" from ${scenario.featureFilePath} — ` +
            `${scenario.selectedStepCount}/${scenario.totalStepCount} step(s) selected for AI analysis.`
        );
        if (recordingMismatch) {
          // S02: the recording currently sitting in the Playwright Code
          // editor was last known to correspond to a DIFFERENT scenario (or
          // none re-verified since) — surfaced immediately, at the moment
          // the mismatch is introduced, rather than silently letting the
          // next "Start AI Code Generation" reuse it as if it were valid
          // grounding for this scenario's own steps.
          this.outputChannel.appendLine(
            `Warning: the current Playwright recording was captured for a different linked scenario and has not ` +
              `been updated since — it may not cover "${scenario.scenarioName}"'s steps. Consider recording again, ` +
              `or carefully review the generated code for missing/incorrect coverage.`
          );
          void vscode.window.showWarningMessage(
            `SoftPlay: the current recording may not cover "${scenario.scenarioName}"'s steps — it was captured ` +
              `for a different linked scenario. Consider re-recording before generating code for this scenario.`
          );
        }
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
        // S02: stamp whichever scenario is linked RIGHT NOW as the one this
        // fresh recording content corresponds to — see the field's own doc
        // comment for why this (not the scenario-link callback) is the only
        // place this gets updated.
        this.recordingAssociatedScenarioKey = scenarioIdentityKey(this.linkedScenario);
        this.postCode(true);
      }),
      this.settingsStore.onChange((settings) => {
        // "Total Agentic Mode" flipping on/off swaps the sidebar's ENTIRE
        // html (getHtml() below) — a fundamentally different template/
        // script, not something the normal per-field UI sync below can
        // handle. Every other settings change re-renders in place, exactly
        // as before this feature existed.
        if (settings.agenticModeEnabled !== this.agenticModeEnabledAtLastRender) {
          if (this.view) {
            this.view.webview.html = this.getHtml(this.view.webview);
            if (settings.agenticModeEnabled) {
              this.agenticController.postFileList();
              this.agenticController.postGenerationState();
              void this.agenticController.estimateTokens();
            } else {
              // The fresh copy of Standard mode's own html/main.js just
              // replaced Agentic Mode's — it needs the exact same state
              // sync a brand-new resolveWebviewView() would give it (see
              // syncStandardModeState()'s own doc comment for why this is
              // required, not optional).
              this.syncStandardModeState();
            }
          }
          if (!settings.agenticModeEnabled) {
            this.agenticController.reset();
          }
          return;
        }

        this.postCode();
        this.postCopilotEnabledState(settings.copilotEnabled);
        if (settings.agenticModeEnabled) {
          void this.agenticController.estimateTokens();
          return;
        }
        // Token Monitoring must react the moment the model (or language,
        // or automation mode) changes — each model reports its own real
        // context window, so switching models can turn a red bar green or
        // vice versa with the exact same draft. The sidebar owns the
        // current draft's content, so it's asked to resend it rather than
        // this trying to reconstruct it from settings alone.
        this.webview?.postMessage({ type: 'requestDraftContext' });
      })
    );
  }

  /** Brings the sidebar view into focus — e.g. from the "SoftPlay: Open Panel" command. */
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

    this.syncStandardModeState();
  }

  /** Pushes every piece of state Standard mode's own webview (main.js)
   * needs to render correctly into a FRESH copy of itself — required both
   * when the view is (re-)resolved from scratch (VS Code recreating the
   * webview's content after it was hidden) AND when switching back from
   * Total Agentic Mode (whose own re-render branch in the settingsStore
   * onChange handler below swaps `webview.html` back to this template).
   * Skipping this after either kind of fresh render leaves main.js's
   * client-side state at its hard-coded initial defaults — in particular
   * "Custom Instructions & RAG Data" starts `hidden` in the raw HTML and
   * ONLY main.js's `applyCopilotEnabledState()` (driven by the
   * `copilotEnabledState` message this method sends) ever reveals it — so
   * omitting this call was exactly the bug where that section stayed
   * missing after switching back from Total Agentic Mode. */
  private syncStandardModeState(): void {
    this.postStatus(mapCodegenStatus(this.codegenManager.getStatus()));
    this.postLinkedScenario();
    this.postFeatureFileAvailable(this.featureFilePanel.hasLinkedFile());
    this.postAiCodeAvailable(this.aiCodePanel.hasCode());
    this.postCode();
    this.postCopilotEnabledState(this.settingsStore.get().copilotEnabled);
  }

  /** `url` is Playwright `codegen`'s own positional CLI argument, needed at
   * spawn time — the Command Palette's "SoftPlay: Start Browser" command
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
    this.agenticIngestionPanel.dispose();
    this.agenticController.dispose();
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
        this.cancelInFlightLinkedGeneration(); // S01 — see the FeatureFilePanel selection callback's own comment
        this.linkedScenario = undefined;
        this.postLinkedScenario();
        break;
      case 'selectedInstructionFiles':
        // Purely staged context — checking a box does not itself trigger
        // anything; it's read fresh the next time "Start AI Code Generation" is
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
      case 'clearApiData':
        this.clearApiData();
        break;
      case 'updateDraftContext':
        void this.updateTokenEstimate(
          message.payload.code,
          message.payload.customInstructions,
          message.payload.selectedFiles,
          message.payload.apiDetails
        );
        break;
      case 'agentic:ready':
        this.agenticController.postFileList();
        this.agenticController.postGenerationState();
        void this.agenticController.estimateTokens();
        break;
      case 'agentic:ingestFiles': {
        const result = await this.agenticController.ingestFiles(message.payload.files);
        this.webview?.postMessage({ type: 'agentic:ingestResult', payload: result });
        // Requirement: successfully ingesting files automatically opens the
        // Ingestion Configuration panel showing what was just loaded — but
        // only when at least one file actually made it in (a drop that was
        // entirely rejected, e.g. a legacy .xls/.doc, has nothing to
        // configure yet).
        if (result.accepted.length > 0) {
          this.agenticIngestionPanel.showAndRefresh();
        }
        break;
      }
      case 'agentic:openIngestionPanel':
        this.agenticIngestionPanel.showAndRefresh();
        break;
      case 'agentic:updateDraftInstructions':
        this.agenticController.updateDraftUserRequest(message.payload);
        break;
      case 'agentic:refreshInstructionFiles':
        await this.agenticController.refreshInstructionFiles();
        break;
      case 'agentic:selectedInstructionFiles':
        this.agenticController.setSelectedInstructionFiles(message.payload);
        break;
      case 'agentic:generateFeatureFile':
        await this.agenticController.generateFeatureFile();
        break;
      case 'agentic:generateCode':
        await this.agenticController.generateAutomationCode();
        break;
      case 'agentic:generateCsv':
        await this.agenticController.generateTestCaseCsv();
        break;
      case 'agentic:clearData':
        this.agenticController.reset();
        this.agenticIngestionPanel.refresh();
        this.outputChannel.appendLine('Total Agentic Mode — Clear Data: every ingested file, cached parsed content, custom-instruction selection, chat text, and generated output has been reset.');
        break;
    }
  }

  /** "Clear Data" (API Automation Control Panel) — the Control Panel's own
   * fields are already reset client-side (see the click handler in
   * main.js); this is everything the extension host was ADDITIONALLY
   * holding on top of that: the linked scenario, the linked/cached feature
   * file (a genuine "forget it", not just an unlink — "Link Feature File"
   * browses fresh again next time), the last-sent API request details
   * (what "Regenerate" in either result panel would otherwise replay), any
   * in-flight LLM request, and both result panels' content — i.e. every
   * piece of "LLM context memory" this session was keeping around for this
   * request, freed for a genuine clean slate. */
  private clearApiData(): void {
    this.clearSharedLlmContext();
    this.outputChannel.appendLine('Clear Data — API Automation context (linked scenario/file, last request, generated results) has been reset.');
  }

  /**
   * Everything "start completely over" has in common between "Clear Data"
   * (API Automation) and "Kill All Browsers" (UI Automation) — every piece
   * of LLM context memory this session was holding on top of whatever
   * lives in the Playwright Code / API request fields themselves: the
   * linked scenario, the linked/cached feature file (forgotten outright,
   * not just unlinked — "Link Feature File" browses fresh again next
   * time), checked "Custom md files", the accumulated chat-box instructions
   * (lastCustomInstructions — the sidebar's own chat composer is reset the
   * same way, in resetAiAssistUi() in main.js), any in-flight LLM request, both
   * result panels' content (AI Generated Code and Generated Feature File —
   * "generated code" per the explicit ask covers both), the green
   * correctness banner, and the Token Monitoring estimate. Callers add
   * whatever's specific to them on top (killAllBrowsers() also stops the
   * browser and clears the raw Playwright Codegen output; clearApiData()
   * has nothing further to add — there's no browser in API mode).
   */
  /** S01: cancels an in-flight `runLlmRefinement()` request — NEVER an
   * in-flight "Verify & Fix Code" one, even though both share
   * `llmCancellation` — see `llmCancellationOwner`'s own doc comment for
   * why cancelling the wrong one would be an unrelated, unwanted side
   * effect of a plain scenario-selection change. Cancellation (rather than
   * letting the request finish and merely discarding its result) is
   * deliberate: `runLlmRefinement()`'s own request-identity check (now
   * ALSO testing `cts.token.isCancellationRequested`, not just
   * `this.llmCancellation !== cts` — see its own doc comment) will
   * silently drop that request's result the moment it settles either way,
   * but actually cancelling stops the underlying Copilot stream/RAG work
   * promptly instead of letting it run to completion for nothing. A no-op
   * when nothing linked-scenario-dependent is actually in flight. */
  private cancelInFlightLinkedGeneration(): void {
    if (this.llmCancellationOwner === 'linkedGeneration') {
      this.llmCancellation?.cancel();
      this.llmCancellation?.dispose();
      this.llmCancellation = undefined;
      this.llmCancellationOwner = undefined;
    }
  }

  /** S02: true when the Playwright recording currently sitting in the
   * editor was last known to correspond to a DIFFERENT scenario than
   * `scenario` (or the recording is stale relative to a scenario switch
   * that happened since it was captured) — i.e. nothing has re-verified
   * that this recording actually covers `scenario`'s steps. `false` when
   * there's no recording yet, or the recording was never associated with
   * any OTHER scenario (the normal "record first, link after" flow) — see
   * `recordingAssociatedScenarioKey`'s own doc comment for the full
   * reasoning. Used both to warn the user the moment a mismatch is
   * introduced (the "Link Feature file" callback) and to keep the LLM
   * prompt itself honest about the recording's unverified relevance (see
   * buildLlmPrompt()). */
  private recordingMayNotCoverScenario(scenario: LinkedScenario | undefined): boolean {
    if (!scenario || !this.nativeGeneratedCode.trim()) {
      return false;
    }
    const key = this.recordingAssociatedScenarioKey;
    return key !== undefined && key !== scenarioIdentityKey(scenario);
  }

  /** S03: a real response is still ALWAYS published even when this finds
   * gaps (see both call sites, right after this) — this only reports, it
   * never blocks or discards a response, since a purely textual heuristic
   * can't be trusted as a hard gate and the model may well have done a
   * genuinely good job the check simply couldn't confirm. Surfaced via the
   * Output channel (a full list, for a permanent record) plus a
   * non-blocking `showWarningMessage` with a "Show Output" affordance —
   * same pattern as this file's other post-hoc advisory warnings (e.g. the
   * RAG freshness check) — rather than a new webview UI surface, keeping
   * this change confined to objectSpyPanel.ts/stepCoverageChecker.ts. */
  private reportStepCoverageGaps(linkedScenario: LinkedScenario | undefined, generatedCode: string, language: 'java' | 'python'): void {
    const uncovered = findUncoveredSteps(linkedScenario, generatedCode, language);
    if (uncovered.length === 0) {
      return;
    }
    this.outputChannel.appendLine(
      `Warning: ${uncovered.length} checked step(s) may have NO matching step definition in the generated code ` +
        `(S03 coverage check — textual heuristic, not a real compile/run check):\n` +
        uncovered.map((s) => `  - ${s}`).join('\n')
    );
    void vscode.window
      .showWarningMessage(
        `SoftPlay: the generated code may be missing step definition(s) for ${uncovered.length} of the linked ` +
          `scenario's step(s) — see the Output channel for which ones.`,
        'Show Output'
      )
      .then((choice) => {
        if (choice === 'Show Output') {
          this.outputChannel.show();
        }
      });
  }

  private clearSharedLlmContext(): void {
    this.llmCancellation?.cancel();
    this.llmCancellation?.dispose();
    this.llmCancellation = undefined;
    this.llmCancellationOwner = undefined;
    this.featureGenCancellation?.cancel();
    this.featureGenCancellation?.dispose();
    this.featureGenCancellation = undefined;

    this.linkedScenario = undefined;
    this.postLinkedScenario();
    this.featureFilePanel.forgetFile();
    this.postFeatureFileAvailable(false);

    this.lastApiRequestDetails = undefined;
    this.lastCustomInstructions = '';
    this.selectedInstructionFiles = [];

    this.aiCodePanel.clear();
    this.generatedFeaturePanel.clear();
    this.postCodeCorrectness(false);
    this.postAiCodeAvailable(false);

    this.lastReceivedTokens = 0;
    this.tokenEstimateSeq++; // discard any in-flight estimate for the context just wiped
    this.webview?.postMessage({ type: 'tokenEstimate', payload: { available: false, reason: 'Cleared — nothing to estimate yet.' } });
  }

  /**
   * "Token Monitoring" — recomputes, using the REAL selected model's own
   * tokenizer (`vscode.LanguageModelChat.countTokens`, via
   * copilotClient.ts's countModelTokens()) rather than a character-count
   * guess, exactly how many tokens the prompt this draft would build
   * actually comes to, and against exactly that model's own real context
   * window (`maxInputTokens`) — both change correctly the instant the user
   * picks a different model in Settings, since each model reports its own.
   * Builds the SAME prompt sendToLlm()/generateFeatureFile() would (same
   * builder functions, same mandatory-standard file, same linked
   * scenario/settings) purely to measure it — nothing is sent to the LLM
   * here. Debounced on the client side (main.js), not here, so this only
   * ever runs once activity settles for a moment, not on every keystroke.
   */
  private async updateTokenEstimate(
    playwrightCode: string,
    customInstructions: string,
    selectedFiles: string[],
    apiDetails: ApiRequestDetails | undefined
  ): Promise<void> {
    const settings = this.settingsStore.get();
    const seq = ++this.tokenEstimateSeq;
    if (!settings.copilotEnabled || !settings.copilotModelId) {
      this.webview?.postMessage({
        type: 'tokenEstimate',
        payload: { available: false, reason: 'Enable "Link with GitHub Copilot LLM" and pick a model in Settings to see token usage.' }
      });
      return;
    }

    const isApiMode = settings.automationMode === 'api';
    if (isApiMode ? !hasApiRequest(apiDetails) : !playwrightCode.trim()) {
      this.webview?.postMessage({
        type: 'tokenEstimate',
        payload: {
          available: false,
          reason: isApiMode ? 'Enter an API request to see token usage.' : 'Record some user action to see token usage.'
        }
      });
      return;
    }

    // S01: snapshotted ONCE here too, for the exact same reason
    // runLlmRefinement() does — this is a live estimate spanning several
    // await boundaries of its own, and a scenario switch mid-estimate
    // should never mix one scenario's mandatory-token measurement with
    // another's final prompt any more than a real generation should.
    const linkedScenarioSnapshot = this.linkedScenario;
    const suggestedBaseName = currentSuggestedBaseName(linkedScenarioSnapshot, settings.language);
    // S02: same snapshot-time computation runLlmRefinement() does — see
    // recordingMayNotCoverScenario()'s own doc comment.
    const recordingMismatch = isApiMode ? false : this.recordingMayNotCoverScenario(linkedScenarioSnapshot);

    let instructions = await this.readInstructionFiles(selectedFiles);
    const builtIn = isApiMode ? readApiAutomationInstructions() : readSeniorQeInstructions();
    // Same Auto Password Encryption pass the real send would do (see
    // runLlmRefinement()) — measuring the UN-redacted/un-encrypted prompt
    // would under- or over-count relative to what's actually sent (an
    // ENC[v1:...] token plus its decrypt helper is a different length than
    // the raw plaintext it replaces).
    const measuredCode = isApiMode ? playwrightCode : (await encryptPasswordLiteralsInCode(this.context, playwrightCode, settings.language)).code;
    // Same free-text redaction pass runLlmRefinement() applies for a real
    // send (see chatInstructionRedactor.ts) — measuring the un-redacted
    // chat text would under/over-count relative to what's actually sent.
    const measuredCustomInstructions = (await encryptCredentialsInFreeText(this.context, customInstructions)).text;
    // Same database-testing-intent check runLlmRefinement() applies — see
    // llm/databaseTestingInstructions.ts — so the live token estimate stays
    // consistent with what will actually be sent.
    instructions = withDatabaseTestingInstructions(instructions, measuredCustomInstructions);
    // Same "measure the mandatory prompt first, then pack RAG against what's
    // actually left" flow as runLlmRefinement() — see buildRagSection()'s
    // own doc comment. Built once with an empty RAG section purely to get
    // an accurate mandatory-token count for packing; the FINAL prompt below
    // is what's actually shown as the estimate.
    const mandatoryPromptForEstimate = isApiMode
      ? await buildApiLlmPrompt(
          settings.language,
          settings.languageVersion,
          builtIn,
          instructions,
          apiDetails!,
          measuredCustomInstructions,
          this.getEncryptSecret(),
          '',
          linkedScenarioSnapshot,
          suggestedBaseName
        )
      : buildLlmPrompt(
          settings.language,
          settings.languageVersion,
          settings.browserChannel,
          builtIn,
          instructions,
          measuredCode,
          measuredCustomInstructions,
          '',
          linkedScenarioSnapshot,
          suggestedBaseName,
          recordingMismatch
        );
    // F12: resolve ONE model and reuse it for every measurement below,
    // rather than each of the three token counts independently
    // re-resolving by model id string (countModelTokens's own internal
    // findModel() call, three times over, on every debounced estimate).
    const model = await findModel(settings.copilotModelId);
    const mandatoryTokensForEstimate = model
      ? await (async () => {
          try {
            return await model.countTokens(mandatoryPromptForEstimate);
          } catch {
            return undefined;
          }
        })()
      : undefined;
    const { section: ragSection } = await this.buildRagSection(
      settings,
      isApiMode,
      measuredCode,
      apiDetails,
      measuredCustomInstructions,
      linkedScenarioSnapshot,
      mandatoryTokensForEstimate,
      model
    );
    const prompt = isApiMode
      ? await buildApiLlmPrompt(
          settings.language,
          settings.languageVersion,
          builtIn,
          instructions,
          apiDetails!,
          measuredCustomInstructions,
          this.getEncryptSecret(),
          ragSection,
          linkedScenarioSnapshot,
          suggestedBaseName
        )
      : buildLlmPrompt(
          settings.language,
          settings.languageVersion,
          settings.browserChannel,
          builtIn,
          instructions,
          measuredCode,
          measuredCustomInstructions,
          ragSection,
          linkedScenarioSnapshot,
          suggestedBaseName,
          recordingMismatch
        );

    const sentTokens = model
      ? await (async () => {
          try {
            return await model.countTokens(prompt);
          } catch {
            return undefined;
          }
        })()
      : undefined;
    if (seq !== this.tokenEstimateSeq) {
      return; // superseded by a newer draft/model change while this was in flight
    }
    if (sentTokens === undefined || !model) {
      this.webview?.postMessage({
        type: 'tokenEstimate',
        payload: { available: false, reason: 'Could not reach the selected Copilot model to estimate tokens.' }
      });
      return;
    }
    this.webview?.postMessage({
      type: 'tokenEstimate',
      payload: {
        available: true,
        sentTokens,
        receivedTokens: this.lastReceivedTokens,
        maxInputTokens: model.maxInputTokens,
        modelId: settings.copilotModelId
      }
    });
  }

  /** Updates `lastReceivedTokens` from a just-completed LLM response and
   * re-broadcasts — a completed response changes what the sidebar should
   * show even though nothing in the DRAFT itself changed, so this can't
   * just wait for the next natural updateTokenEstimate() call. Silently
   * gives up on a counting failure — an inability to count the response
   * after the fact is not worth surfacing as an error to the user. */
  private async recordReceivedTokens(responseText: string, modelId: string): Promise<void> {
    const result = await countModelTokens(modelId, responseText);
    if (!result) {
      return;
    }
    this.lastReceivedTokens = result.count;
    this.webview?.postMessage({
      type: 'tokenEstimate',
      payload: {
        available: true,
        sentTokens: null,
        receivedTokens: this.lastReceivedTokens,
        maxInputTokens: result.maxInputTokens,
        modelId
      }
    });
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
    void vscode.window.showInformationMessage(`SoftPlay: saved ${path.basename(uri.fsPath)}`);
  }

  /** "Kill All Browsers" (UI Automation) — stops every Playwright browser
   * instance this extension launched (via codegenManager.stop(), which
   * also tears down the OS process the browser runs in — see its own doc
   * comment), then resets everything else the same way "Clear Data" does
   * in API Automation mode: both the raw Playwright Codegen output AND the
   * AI Generated Code are removed, any linked/cached feature file and
   * checked Custom md files are forgotten, and the LLM context memory
   * built from any of that (linked scenario, in-flight requests, the
   * Generated Feature File panel, the correctness banner, the token
   * estimate) is freed — a genuine "start this recording completely
   * over", not just a browser restart. */
  private async killAllBrowsers(): Promise<void> {
    await this.codegenManager.stop();
    this.nativeGeneratedCode = '';
    // S02: a genuine "start this recording completely over" also clears
    // whatever scenario the (now-gone) recording was associated with — a
    // brand new recording hasn't been captured under ANY scenario yet.
    this.recordingAssociatedScenarioKey = undefined;
    this.clearSharedLlmContext();
    // 'clearAll' resets the webview's Playwright Code editor and its own
    // local state (Custom md checkboxes, chat composer) — no need to also
    // postCode() here, that would just be an empty-code message the client
    // immediately overwrites again anyway.
    this.webview?.postMessage({ type: 'clearAll' });
    this.outputChannel.appendLine(
      'Kill All Browsers — stopped the codegen browser and cleared all generated code, the linked feature file, and LLM context memory.'
    );
  }

  // -----------------------------------------------------------------------
  // "Custom md files" (GitHub Copilot AI Assist). Checking a .github/*.md
  // file's checkbox is purely staged context — this.selectedInstructionFiles
  // is kept in sync via the 'selectedInstructionFiles' message on every
  // checkbox change, but nothing is sent to the LLM until the user
  // explicitly clicks "Start AI Code Generation" (sendToLlm(), below), same as
  // the chat composer's free-text box. This only ever fires while "Link
  // with GitHub Copilot LLM" is on and a model is picked in Settings, which
  // is itself an explicit, one-time opt-in; VS Code's Language Model API
  // separately shows its own one-time consent dialog the first time this
  // extension calls sendRequest.
  // -----------------------------------------------------------------------

  /** Refreshes BOTH file lists in the "Custom Instructions & RAG Data"
   * segment from one button — Custom Instructions (`.github/*.md`,
   * explicitly EXCLUDING `.github/rag/**` now that that subfolder has its
   * own distinct meaning — see rag/ragIndexer.ts — AND `.github/rag-drafts/**`,
   * where a REJECTED "Generate RAG Corpus format" candidate is quarantined
   * — see ragCorpusGenerator.ts's own doc comment. Without this second
   * exclusion, a rejected draft (which can still contain a credential-
   * shaped value the deterministic scrubber only guarantees to catch, not
   * a model's own prompt-only "don't do this" instruction — see F06)
   * could be explicitly selected here and re-sent into a future prompt,
   * defeating the whole point of quarantining it outside the indexed
   * corpus in the first place) and RAG Data (`.github/rag/*.md`,
   * read-only: which components are relevant to a given request is
   * decided automatically by retrieval scoring, not by checking a box
   * here — see rag/ragRetriever.ts). */
  private async refreshPromptFiles(): Promise<void> {
    const excludedRagFolders = `{.github/rag/**,${RAG_DRAFTS_FOLDER_SEGMENTS.join('/')}/**}`;
    const [instructionFiles, ragFiles] = await Promise.all([
      vscode.workspace.findFiles('.github/**/*.md', excludedRagFolders),
      vscode.workspace.findFiles('.github/rag/**/*.md')
    ]);
    const relPaths = instructionFiles.map((f) => vscode.workspace.asRelativePath(f)).sort();
    const { indexed, skipped } = await this.partitionRagFilesByValidity(ragFiles);
    this.webview?.postMessage({ type: 'promptFiles', payload: relPaths });
    this.webview?.postMessage({ type: 'ragFiles', payload: indexed });
    // F16 — the "RAG Data" list previously showed every *.md file found
    // under .github/rag/ regardless of whether it would actually be
    // indexed (a file with no/invalid YAML frontmatter — e.g. a plain
    // documentation/blueprint doc someone dropped in there — silently
    // never participates in retrieval at all), a visible-library/
    // empty-index mismatch a user had no way to notice from the file list
    // alone. Now surfaced explicitly, with the reason, per skipped file.
    for (const { relPath, reason } of skipped) {
      this.outputChannel.appendLine(`Reusable components (RAG): "${relPath}" was found under .github/rag/ but is NOT indexed (${reason}) — it will never be retrieved.`);
    }
  }

  /** Splits `ragFiles` into ones that will actually be indexed (valid
   * frontmatter) and ones that won't, with a reason — see
   * `refreshPromptFiles()`'s own doc comment. A read/parse failure other
   * than "invalid frontmatter" is reported the same way, under the same
   * "not indexed" umbrella — from a user's perspective the practical fact
   * (this file will never be retrieved) is identical either way. */
  private async partitionRagFilesByValidity(ragFiles: vscode.Uri[]): Promise<{ indexed: string[]; skipped: { relPath: string; reason: string }[] }> {
    const indexed: string[] = [];
    const skipped: { relPath: string; reason: string }[] = [];
    for (const uri of ragFiles) {
      const relPath = vscode.workspace.asRelativePath(uri);
      try {
        const bytes = await vscode.workspace.fs.readFile(uri);
        const parsed = parseRagFile(new TextDecoder('utf-8').decode(bytes));
        if (parsed.ok) {
          indexed.push(relPath);
        } else {
          skipped.push({ relPath, reason: parsed.error });
        }
      } catch (err) {
        skipped.push({ relPath, reason: err instanceof Error ? err.message : String(err) });
      }
    }
    return { indexed: indexed.sort(), skipped };
  }

  /** "Start AI Code Generation" (Control Panel) — the ONLY way AI processing
   * starts. Bundles everything currently staged: the Playwright Code
   * editor's live content (`code`, including manual edits), whichever
   * Custom md files are checked (`selectedFiles`), anything typed into the
   * chat box (`customInstructions`), the linked scenario/selected steps
   * (this.linkedScenario, SNAPSHOTTED once at the very start of
   * runLlmRefinement() — see its own doc comment, S01), and the current
   * Settings (browser channel, language, language version — captured the
   * same way). Recording code, checking a box, or typing in chat never
   * triggers this on their own. */
  private async sendToLlm(
    selectedFiles: string[],
    playwrightCode: string,
    customInstructions: string,
    apiDetails?: ApiRequestDetails
  ): Promise<void> {
    if (apiDetails) {
      this.lastApiRequestDetails = apiDetails;
    }
    this.lastCustomInstructions = customInstructions.trim();
    const instructions = await this.readInstructionFiles(selectedFiles);
    await this.runLlmRefinement(instructions, playwrightCode, this.lastCustomInstructions, apiDetails);
  }

  /** "Regenerate AI Code" (AI Generated Code panel) — re-runs the same
   * refinement with everything read fresh at click time: the Playwright
   * Code editor's live content (including manual edits — see
   * requestCurrentPlaywrightCode()), Settings (language/version/browser),
   * the linked Gherkin scenario, the checked Custom md files, and whatever
   * chat-box instructions have accumulated since the last "Start AI Code
   * Generation"/"Start AI Feature File Generation" (`lastCustomInstructions`
   * — the AI Generated Code panel has no chat box of its own, so this is
   * how it stays in sync with the sidebar's, per the explicit ask that
   * newly typed instructions carry into a regeneration, in both UI and API
   * Automation mode). An explicit, on-demand click, same as "Start AI Code
   * Generation" — just from the AI Generated Code panel instead of the
   * Control Panel. */
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
    await this.runLlmRefinement(instructions, playwrightCode, this.lastCustomInstructions, this.lastApiRequestDetails);
  }

  /** "Start AI Feature File Generation" (Control Panel) — the counterpart to
   * "Start AI Code Generation" for when the user has NOT linked a .feature file:
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
    this.lastCustomInstructions = customInstructions.trim();
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
    // Auto Password Encryption — same pass as runLlmRefinement(); a feature
    // file built from a recorded login flow must never quote the real
    // password either.
    if (!isApiMode) {
      playwrightCode = (await encryptPasswordLiteralsInCode(this.context, playwrightCode, settings.language)).code;
    }
    // Same free-text chat-box redaction as runLlmRefinement() — see
    // security/chatInstructionRedactor.ts.
    customInstructions = (await encryptCredentialsInFreeText(this.context, customInstructions.trim())).text;
    const prompt = isApiMode
      ? await buildApiFeatureFilePrompt(
          builtIn,
          (apiDetails ?? this.lastApiRequestDetails)!,
          customInstructions,
          settings.language,
          this.getEncryptSecret(),
          this.linkedScenario
        )
      : buildFeatureFilePrompt(builtIn, playwrightCode, customInstructions);
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
      void this.recordReceivedTokens(accumulated, settings.copilotModelId);
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
   * the Control Panel's "Start AI Feature File Generation" button — same
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
      const env = await checkEnvironment(
        settings.language,
        settings.automationMode,
        this.context.extensionUri.fsPath,
        this.context.globalStorageUri.fsPath
      );
      this.outputChannel.appendLine(
        `Verify & Fix Code — environment check (${settings.language}, ${isApiMode ? 'API' : 'UI'} mode): ${env.ok ? 'OK' : 'FAILED'} — ${env.message}`
      );
      if (!env.ok) {
        this.aiCodePanel.setVerifyStatus(env.message, 'error');
        void vscode.window.showErrorMessage(`SoftPlay: ${env.message}`);
        return;
      }
      // `env` already ran the Python check above (env & package
      // provisioning included, for API mode) — reuse its pythonCommand
      // rather than checking a second time.
      const pythonCommand = settings.language === 'python' ? env.pythonCommand ?? 'python' : '';

      // Kept fresh on every attempt (re-read, not snapshotted once) so a
      // recording made WHILE the fix loop is running still counts — but in
      // practice this is whatever was last recorded/entered, exactly the
      // "keep the original context in LLM memory" ask.
      const scratchDir = path.join(this.context.globalStorageUri.fsPath, 'test-runner', settings.automationMode, settings.language);
      await fs.promises.mkdir(scratchDir, { recursive: true });

      try {
        await this.runVerifyFixAgentPath(settings, isApiMode, scratchDir, pythonCommand, initialCode);
      } catch (err) {
        // The tool-calling agent hit something beyond "the generated code
        // has a bug" — Copilot itself unavailable, a malformed tool-calling
        // response, etc. Never leave the user stuck: fall back to the
        // original, proven fixed-attempt-count loop this feature replaced
        // (kept verbatim as runLegacyVerifyFixLoop() below) rather than
        // surface a raw agent-framework error.
        const message = describeError(err);
        this.outputChannel.appendLine(
          `Verify & Fix Code — the tool-calling agent failed unexpectedly (${message}); falling back to the classic single-shot fix loop.`
        );
        await this.runLegacyVerifyFixLoop(settings, isApiMode, scratchDir, pythonCommand, initialCode);
      }
    } finally {
      this.aiCodePanel.setVerifyButtonEnabled(true);
    }
  }

  /**
   * The primary "Verify & Fix Code" path since the tool-calling agent
   * rewrite — a small, bounded LangChain agent (see agent/verifyFixAgent.ts)
   * given three tools (run_code, read_file, read_feature_file — see
   * agent/verifyFixTools.ts) drives its own run → inspect → fix → re-run
   * cycle instead of this method hardcoding exactly one fix-prompt per
   * failed attempt. The human-in-the-loop confirmation before every single
   * execution is enforced INSIDE the run_code tool itself (see
   * `confirmRun` below), so it holds regardless of how many turns the
   * agent takes internally.
   */
  private async runVerifyFixAgentPath(
    settings: ObjectSpySettings,
    isApiMode: boolean,
    scratchDir: string,
    pythonCommand: string,
    initialCode: string
  ): Promise<void> {
    const originalContext = await this.buildOriginalContextForFix(settings, isApiMode);
    const builtInStandard = isApiMode ? readApiAutomationInstructions() : readSeniorQeInstructions();

    const systemPrompt =
      `You are an expert ${isApiMode ? 'API' : 'UI/Playwright'} test automation engineer working on an enterprise ` +
      `QA codebase, operating as an autonomous fixing agent with tools. Your job: make the given ${settings.language} ` +
      `file actually compile/run correctly, using the tools you're given rather than guessing blind.\n\n` +
      `Rules:\n` +
      `1. Call run_code FIRST with the file exactly as given, before changing anything — this captures the real, ` +
      `current error.\n` +
      `2. If it fails, use read_file and/or read_feature_file if you need more context, then call run_code again ` +
      `with your corrected version of the COMPLETE file (never a diff or snippet).\n` +
      `3. Fix ONLY what's necessary to resolve the reported error. Do not restructure or rewrite parts of the code ` +
      `that aren't implicated by it. Keep the same class/file name, the same target language/runtime version` +
      `${isApiMode ? '' : ', the same browser-executable launch override (never remove or weaken it)'}, and the ` +
      `overall structure — this is a targeted fix, not a rewrite.\n` +
      `4. Every fixed version you submit via run_code must still follow the mandatory refinement standard below, ` +
      `in full.\n` +
      `5. If run_code reports the user declined to run it, stop immediately — do not call any other tool.\n` +
      (builtInStandard ? `\n## Mandatory refinement standard — every version you submit must follow every part of this\n${builtInStandard}` : '');

    const userPrompt =
      `## ${originalContext.label}\n${originalContext.content}\n\n` +
      `## Current file to verify and, if necessary, fix\n\`\`\`${settings.language}\n${initialCode}\n\`\`\``;

    this.outputChannel.appendLine(
      `Verify & Fix Code (agent) — starting with Copilot model "${settings.copilotModelId}": system prompt is ` +
        `${systemPrompt.length} chars, user prompt is ${userPrompt.length} chars.`
    );

    this.llmCancellation?.cancel();
    this.llmCancellation?.dispose();
    const cts = new vscode.CancellationTokenSource();
    this.llmCancellation = cts;
    this.llmCancellationOwner = 'verifyFix';

    let lastShownCode = initialCode;
    // Tracked from every run_code tool result so the final status — for a
    // 'max_steps'/'no_further_action' stop, which has no dedicated error
    // field of its own — can still tell the user what actually went wrong
    // on the last real attempt, not just that the agent gave up.
    let lastKnownError: string | undefined;
    const result = await runVerifyFixAgent({
      modelId: settings.copilotModelId,
      systemPrompt,
      userPrompt,
      maxAttempts: ObjectSpyPanel.MAX_VERIFY_ATTEMPTS,
      // Comfortably above maxAttempts so the agent can call read_file/
      // read_feature_file between executions without instantly exhausting
      // its turn budget, while still bounded (see verifyFixAgent.ts).
      maxSteps: ObjectSpyPanel.MAX_VERIFY_ATTEMPTS * 3 + 2,
      cancellationToken: cts.token,
      runCodeDeps: {
        language: settings.language,
        scratchDir,
        linkedFeatureFilePath: this.linkedScenario?.featureFilePath,
        pythonCommand,
        automationMode: settings.automationMode,
        resourcesRoot: this.context.extensionUri.fsPath,
        secretEnv: await secretVault.getSecretEnv(this.context),
        // F03: closes the same shared-tool race Agentic Mode's own verify
        // path fixes — see verifyFixTools.ts's own doc comment on this field.
        cancellationToken: cts.token
      },
      confirmRun: async (attempt, maxAttempts, lastErrorOutput) => {
        const choice = await vscode.window.showWarningMessage(
          attempt === 1
            ? `Run the AI-generated code now to verify it ${isApiMode ? 'compiles/parses' : 'executes headless'} without errors?`
            : `Attempt ${attempt} of ${maxAttempts}: re-run the agent-fixed code to verify it now ${isApiMode ? 'compiles/parses' : 'executes headless'} without errors?`,
          // `detail` shows the PREVIOUS attempt's actual error — so the
          // user can judge whether this is something Copilot should keep
          // trying to fix, or something they'd rather fix themselves,
          // instead of approving another run blind. Absent on attempt 1
          // (nothing has failed yet).
          lastErrorOutput ? { modal: true, detail: truncateForDialog(lastErrorOutput) } : { modal: true },
          'Yes',
          'No'
        );
        return choice === 'Yes';
      },
      onOutput: (line) => this.outputChannel.appendLine(line),
      onStep: (log) => {
        // Full audit trail — every tool call and result the agent made,
        // exactly what a bank's QA/security review would ask to see for
        // "what did the AI actually do" (see architecture.html).
        this.outputChannel.appendLine(`Verify & Fix Code (agent) — [${log.kind}${log.toolName ? `:${log.toolName}` : ''}] ${log.detail}`);
        // Mirrors the pre-agent UX where each fix attempt's code streamed
        // into the AI Generated Code panel as it was produced — here, the
        // moment the agent commits to trying a new candidate (a run_code
        // call), that candidate is shown immediately rather than only
        // after the whole agent session ends.
        if (log.kind === 'tool_call' && log.toolName === 'run_code') {
          try {
            const args = JSON.parse(log.detail) as { code?: string };
            if (typeof args.code === 'string' && args.code !== lastShownCode) {
              lastShownCode = args.code;
              this.aiCodePanel.finish(args.code);
              this.postAiCodeAvailable(true);
            }
          } catch {
            // Malformed tool-call args JSON — cosmetic only (the actual
            // run still proceeds); nothing to react to here.
          }
        }
        if (log.kind === 'tool_result' && log.toolName === 'run_code') {
          try {
            const parsed = JSON.parse(log.detail) as { signal?: string; output?: string };
            // A failure result has `output`; a success result doesn't
            // (see verifyFixTools.ts) — only overwrite on an actual
            // failure, so a later successful attempt doesn't need to
            // clear this (the 'success' branch below never reads it).
            if (parsed.signal !== 'success' && typeof parsed.output === 'string') {
              lastKnownError = parsed.output;
            }
          } catch {
            // Malformed/unexpected tool-result JSON — nothing to react to.
          }
        }
      }
    });

    if (cts.token.isCancellationRequested) {
      return;
    }

    switch (result.stopReason) {
      case 'success': {
        const compileOnly = Boolean(result.raw?.compileOnly);
        const apiCallOutcome = result.raw?.apiCallOutcome as 'passed' | 'failed' | 'not-run' | undefined;
        if (result.finalCode) {
          this.aiCodePanel.finish(result.finalCode);
          this.postAiCodeAvailable(true);
        }
        if (compileOnly) {
          this.aiCodePanel.setVerifyStatus(
            'Compiled successfully — BDD step definitions have no generated runner to fully execute yet, so this is a compile check, not a confirmed run.',
            'success'
          );
        } else if (isApiMode) {
          if (apiCallOutcome === 'failed') {
            this.aiCodePanel.setVerifyStatus(
              'Code Correctness Confirmed — no syntax errors. The live API call itself returned an error response ' +
                '(see the SoftPlay Output channel) — recheck the endpoint URL/credentials and try again in your own IDE/test package.',
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
      case 'declined':
        this.aiCodePanel.setVerifyStatus(
          `${result.summary}${lastKnownError ? ` Last error: ${truncateForStatusLine(lastKnownError)}` : ''} Current code's errors are shown in the SoftPlay Output channel for manual fixing.`,
          'error'
        );
        return;
      case 'max_steps':
        this.aiCodePanel.setVerifyStatus(
          `${result.summary}${lastKnownError ? ` Last error: ${truncateForStatusLine(lastKnownError)}` : ''}`,
          'error'
        );
        return;
      case 'no_further_action':
        this.aiCodePanel.setVerifyStatus(
          `Copilot stopped without a confirmed fix: ${result.summary}${lastKnownError ? ` Last error: ${truncateForStatusLine(lastKnownError)}` : ''}`,
          'error'
        );
        return;
      case 'cancelled':
        return;
      case 'error':
        // Re-thrown so verifyAndFixCode()'s caller falls back to
        // runLegacyVerifyFixLoop() — see that method's own doc comment.
        throw result.error ?? new Error(result.summary);
    }
  }

  /** Auto Password Encryption applies here too — this "original context" is
   * resent to Copilot on every single fix attempt (agent tool call or
   * legacy loop iteration alike), so the real recorded/API credential must
   * never appear in it any more than in the original request. Shared by
   * both runVerifyFixAgentPath() and runLegacyVerifyFixLoop() so the two
   * paths can never drift apart on this. */
  private async buildOriginalContextForFix(
    settings: ObjectSpySettings,
    isApiMode: boolean
  ): Promise<{ label: string; content: string }> {
    return isApiMode
      ? {
          label: 'Original API Request Details (the ground truth for this request — refer back to this if the error suggests one was used incorrectly)',
          content: this.lastApiRequestDetails ? await buildApiRequestSummary(this.lastApiRequestDetails, this.getEncryptSecret()) : '(not available)'
        }
      : {
          label:
            'Original Playwright Codegen output (real recording, see note above about credentials — the ground truth for which locators and actions are actually correct; refer back to this if the error suggests one was used incorrectly)',
          content: `\`\`\`${settings.language}\n${(await encryptPasswordLiteralsInCode(this.context, this.nativeGeneratedCode, settings.language)).code}\n\`\`\``
        };
  }

  /**
   * The ORIGINAL "Verify & Fix Code" implementation, unchanged, kept as an
   * automatic fallback for when the new tool-calling agent path
   * (runVerifyFixAgentPath()) fails outright — see verifyAndFixCode()'s
   * try/catch. Never invoked when the agent path itself works, success or
   * failure; only when it throws (Copilot unavailable, an unexpected
   * agent-framework error, ...). Keeping this exact, previously-shipped
   * code path intact — not deleted, not refactored — is the safety net
   * behind "the new implementation must not break existing stable
   * behavior."
   */
  private async runLegacyVerifyFixLoop(
    settings: ObjectSpySettings,
    isApiMode: boolean,
    scratchDir: string,
    pythonCommand: string,
    initialCode: string
  ): Promise<void> {
    let code = initialCode;
    // Set after every failed attempt (below) and shown in the NEXT
    // attempt's confirmation dialog, so "re-run?" is an informed decision
    // rather than a blind one — same reasoning as runVerifyFixAgentPath()'s
    // confirmRun().
    let lastErrorOutput: string | undefined;
    for (let attempt = 1; attempt <= ObjectSpyPanel.MAX_VERIFY_ATTEMPTS; attempt++) {
      const choice = await vscode.window.showWarningMessage(
        attempt === 1
          ? `Run the AI-generated code now to verify it ${isApiMode ? 'compiles/parses' : 'executes headless'} without errors?`
          : `Attempt ${attempt} of ${ObjectSpyPanel.MAX_VERIFY_ATTEMPTS}: re-run the LLM-fixed code to verify it now ${isApiMode ? 'compiles/parses' : 'executes headless'} without errors?`,
        lastErrorOutput ? { modal: true, detail: truncateForDialog(lastErrorOutput) } : { modal: true },
        'Yes',
        'No'
      );
      if (choice !== 'Yes') {
        this.aiCodePanel.setVerifyStatus(
          `Stopped before attempt ${attempt} — current code's errors are shown in the SoftPlay Output channel for manual fixing.`,
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
        settings.automationMode,
        this.context.extensionUri.fsPath,
        // SoftPlay_SECRET_KEY — lets the generated code's own
        // SecretVault.decrypt()/decrypt_secret() call actually resolve a
        // credential Auto Password Encryption encrypted (see
        // security/secretVault.ts). Harmless to always pass: unused by
        // code with no encrypted values in it.
        await secretVault.getSecretEnv(this.context)
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
                '(see the SoftPlay Output channel) — recheck the endpoint URL/credentials and try again in your own IDE/test package.',
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

      lastErrorOutput = result.output;

      if (attempt === ObjectSpyPanel.MAX_VERIFY_ATTEMPTS) {
        this.aiCodePanel.setVerifyStatus(
          `Still failing after ${ObjectSpyPanel.MAX_VERIFY_ATTEMPTS} attempts: ${truncateForStatusLine(result.output)} ` +
            `(full output in the SoftPlay Output channel — fix manually, or click Verify & Fix Code again).`,
          'error'
        );
        return;
      }

      this.aiCodePanel.setVerifyStatus(`Attempt ${attempt} failed: ${truncateForStatusLine(result.output)} — asking the LLM to fix it…`, 'info');
      const originalContext = await this.buildOriginalContextForFix(settings, isApiMode);
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
      this.postAiCodeAvailable(false);
      const cts = new vscode.CancellationTokenSource();
      try {
        const fixed = await this.streamCopilotResponse(fixPrompt, settings.copilotModelId, cts, (chunk) =>
          this.aiCodePanel.appendChunk(chunk)
        );
        code = extractCodeBlock(fixed);
        this.aiCodePanel.finish(code);
        this.postAiCodeAvailable(true);
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
  }

  /** Big green "Code Correctness Confirmed" banner on the sidebar's main UI
   * — shown only after a genuine headless run passed (never for a
   * compile-only BDD check). Cleared (`false`) the moment the AI-generated
   * code changes again — a fresh generation, a fix-loop attempt, or a
   * verification failure — since a stale "confirmed" would be misleading. */
  private postCodeCorrectness(confirmed: boolean): void {
    this.webview?.postMessage({ type: 'codeCorrectness', payload: confirmed });
  }

  /** "Open AI Generated Code" button on the sidebar — shown only once
   * there's actual AI-generated code in memory to open, in both UI
   * Automation and API Automation mode; hidden the instant that stops
   * being true (a fresh generation just started, a fix attempt is
   * running, or everything's been cleared). */
  private postAiCodeAvailable(available: boolean): void {
    this.webview?.postMessage({ type: 'aiCodeAvailable', payload: available });
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
    this.llmCancellationOwner = 'linkedGeneration';

    // S01: snapshotted ONCE, right here, and used for EVERY use below —
    // never `this.linkedScenario` directly again inside this method. The
    // reproduced bug this closes: `this.linkedScenario` is a plain mutable
    // field the Gherkin-scenario picker's own selection callback can
    // reassign at any moment, including WHILE this method's own async prep
    // (encryption, RAG retrieval, token counting) is still in flight —
    // reading it fresh at each of several DIFFERENT points (the suggested
    // output filename, computed once up front via postLlmStart(); the
    // mandatory-token-measurement prompt; the final real prompt; the
    // retry-without-RAG fallback prompt) meant a single request could end
    // up built from an inconsistent MIX of two different scenarios' own
    // data, depending on exactly when the selection changed relative to
    // where execution happened to be. A snapshot guarantees this ONE
    // request is internally consistent from start to finish, no matter
    // what the user does to the LIVE selection while it's running.
    const linkedScenarioSnapshot = this.linkedScenario;
    const suggestedBaseName = currentSuggestedBaseName(linkedScenarioSnapshot, settings.language);
    // S02: same snapshot-time computation — see
    // recordingMayNotCoverScenario()'s own doc comment. Snapshotted here,
    // alongside the scenario itself, so this one request's prompt stays
    // internally consistent about whether the recording it embeds was ever
    // actually verified against this scenario.
    const recordingMismatch = isApiMode ? false : this.recordingMayNotCoverScenario(linkedScenarioSnapshot);

    this.postLlmStart(suggestedBaseName);

    // Everything from here through the actual Copilot call used to be split
    // across an UNGUARDED prep section (encryption, RAG index building,
    // prompt construction) followed by a try/catch around ONLY the
    // streaming call itself — so a failure during prep (a recipe file
    // deleted between the RAG index's own file scan and reading it, a
    // secret-storage error from Auto Password Encryption, ...) propagated
    // straight out of this method uncaught (onDidReceiveMessage's handler
    // is fire-and-forget — see its own doc comment), leaving `postLlmStart()`
    // as the last thing the webview ever heard: a "(generating…)" state
    // with no way out short of reloading the panel. ONE try/catch spanning
    // ALL of prep + the request now guarantees this method always reaches a
    // terminal `postLlmDone`/`postLlmError`, whatever fails and whenever.
    //
    // `this.llmCancellation !== cts` (checked both on the success path and
    // in the catch) is this request's identity check — cheaper than a
    // separate counter, since a NEWER call to this method already
    // overwrites `this.llmCancellation` with its own fresh
    // CancellationTokenSource before doing any async work (see just above).
    // If THIS request's own prep/streaming was still in flight when that
    // happened, its eventual result — success or failure — must never
    // clobber the newer request's already-in-progress UI state.
    //
    // S01: BOTH checks now ALSO test `cts.token.isCancellationRequested`
    // directly, not just `this.llmCancellation !== cts` — the identity
    // check alone only ever catches "a NEWER generation request started."
    // It says nothing about "the Gherkin scenario selection changed WHILE
    // this exact request was still the active one" (no new request; same
    // `cts` throughout) — see `cancelLinkedGenerationOnScenarioChange()`,
    // which cancels `cts` for exactly that case. Relying on cancellation
    // status directly (rather than only inferring it from identity) means
    // this is never accidentally accepted just because nothing NEWER
    // happened to start.
    let ragSection = '';
    let ragMatches: RagMatch[] = [];
    let builtIn = '';
    // F12 — resolved once inside the try block below and reused for the
    // retry-without-RAG fallback in the catch block too, rather than each
    // independently re-resolving by model id string.
    let resolvedModel: vscode.LanguageModelChat | undefined;
    // The exact prompt actually handed to streamCopilotResponse() below —
    // kept in this outer scope (rather than the try block's own `const
    // prompt`) so the catch block can, ONLY on a genuine failure, measure
    // its REAL token count for `buildEmptyResponseGuidance()` — see that
    // function's own doc comment on why a request that already measured
    // comfortably under budget must not still be blamed on size.
    let lastSentPrompt = '';
    try {
      builtIn = isApiMode ? readApiAutomationInstructions() : readSeniorQeInstructions();
      // Auto Password Encryption — never send a recorded password/credential
      // literal to Copilot in plaintext (see security/uiPasswordRedactor.ts).
      // Applied here, once, right before the prompt is built — the sidebar's
      // own "Generated Code" view keeps showing Codegen's real, unmodified
      // output regardless (see ObjectSpyPanel's class doc comment).
      let encryptedCount = 0;
      if (!isApiMode) {
        const redacted = await encryptPasswordLiteralsInCode(this.context, playwrightCode, settings.language);
        playwrightCode = redacted.code;
        encryptedCount = redacted.count;
      }
      // Same guarantee, extended to the free-text "Instant instructions to
      // LLM" chat box — see security/chatInstructionRedactor.ts's own doc
      // comment for why this was a real gap (a connection string or
      // "password: ..." typed directly into chat previously reached Copilot
      // completely in plaintext, in BOTH automation modes).
      const chatRedaction = await encryptCredentialsInFreeText(this.context, customInstructions);
      customInstructions = chatRedaction.text;
      encryptedCount += chatRedaction.count;
      // Database testing intent: only ever driven by the "Instant
      // instructions to LLM" chat box text, per the explicit ask — a
      // deterministic keyword/regex check (llm/databaseTestingInstructions.ts),
      // never an extra LLM call. A false positive just adds one harmless
      // extra section to the prompt.
      instructions = withDatabaseTestingInstructions(instructions, customInstructions);
      // Built once with an empty RAG section purely to measure the
      // MANDATORY (non-RAG) token cost — packing (buildRagSection below)
      // needs this to compute how much of the model's own real context
      // window is actually left for RAG content, per Phase 3's "consume
      // the actual resolved model/tokenizer and the assembled non-RAG
      // input" packing requirement. `undefined` (counting unavailable)
      // flows straight through to buildRagSection()'s own documented
      // unmeasured fallback, never silently treated as "zero mandatory
      // cost, unlimited RAG budget."
      const mandatoryPrompt = isApiMode
        ? await buildApiLlmPrompt(
            settings.language,
            settings.languageVersion,
            builtIn,
            instructions,
            apiDetails!,
            customInstructions,
            this.getEncryptSecret(),
            '',
            linkedScenarioSnapshot,
            suggestedBaseName
          )
        : buildLlmPrompt(
            settings.language,
            settings.languageVersion,
            settings.browserChannel,
            builtIn,
            instructions,
            playwrightCode,
            customInstructions,
            '',
            linkedScenarioSnapshot,
            suggestedBaseName,
            recordingMismatch
          );
      // F12: resolve ONE model here and reuse this SAME handle for the
      // mandatory-token measurement, RAG packing (buildRagSection), AND
      // the actual send below (streamCopilotResponse) — previously each
      // of those independently re-resolved by model id string
      // (countModelTokens/findModel each call vscode.lm.selectChatModels()
      // on their own), so packing's own `maxInputTokens`/tokenizer could,
      // in principle, come from a DIFFERENT resolution than what
      // ultimately enforces the real admission check and sends the
      // request. `undefined` when the model can't be resolved at all
      // flows through exactly like an unmeasurable count already did —
      // buildRagSection()'s own documented character-based fallback.
      resolvedModel = await findModel(settings.copilotModelId);
      const mandatoryTokens = resolvedModel
        ? await (async () => {
            try {
              return await resolvedModel.countTokens(mandatoryPrompt);
            } catch {
              return undefined;
            }
          })()
        : undefined;
      const built = await this.buildRagSection(settings, isApiMode, playwrightCode, apiDetails, customInstructions, linkedScenarioSnapshot, mandatoryTokens, resolvedModel, cts.token);
      ragSection = built.section;
      ragMatches = built.matches;
      const prompt = isApiMode
        ? await buildApiLlmPrompt(
            settings.language,
            settings.languageVersion,
            builtIn,
            instructions,
            apiDetails!,
            customInstructions,
            this.getEncryptSecret(),
            ragSection,
            linkedScenarioSnapshot,
            suggestedBaseName
          )
        : buildLlmPrompt(
            settings.language,
            settings.languageVersion,
            settings.browserChannel,
            builtIn,
            instructions,
            playwrightCode,
            customInstructions,
            ragSection,
            linkedScenarioSnapshot,
            suggestedBaseName,
            recordingMismatch
          );
      lastSentPrompt = prompt;
      // Diagnostic trail for exactly the question "was X actually sent, and
      // did a response come back?" — check the SoftPlay Output channel
      // (View -> Output -> SoftPlay) rather than needing to guess from a
      // stuck "(generating…)" label with no other visible signal.
      if (encryptedCount > 0) {
        this.outputChannel.appendLine(`Auto Password Encryption: encrypted ${encryptedCount} credential value(s) before sending to Copilot.`);
      }
      const instructionFileChars = instructions.reduce((sum, f) => sum + f.content.length, 0);
      this.outputChannel.appendLine(
        `Sending to Copilot model "${settings.copilotModelId}" (${isApiMode ? 'API' : 'UI'} mode): target ` +
          `${settings.language} ${settings.languageVersion}, mandatory standard ` +
          `${builtIn ? `(${builtIn.length} chars)` : '(MISSING — instructions .md failed to load)'}, ` +
          `${instructions.length} project .md file(s) (${instructionFileChars.toLocaleString()} chars), ` +
          `RAG section (${ragSection.length.toLocaleString()} chars${ragMatches.length ? `, ${ragMatches.length} match(es): ${ragMatches.map((m) => m.id).join(', ')}` : ', no matches'}), ` +
          `${linkedScenarioSnapshot ? `linked scenario "${linkedScenarioSnapshot.scenarioName}"` : 'no linked scenario'}${recordingMismatch ? ' (S02: recording UNVERIFIED against this scenario)' : ''}, ` +
          `${isApiMode ? `API request to ${apiDetails?.url}` : `${playwrightCode.length} chars of reference code`} — ` +
          `prompt is ${prompt.length.toLocaleString()} chars total.`
      );

      const accumulated = await this.streamCopilotResponse(prompt, settings.copilotModelId, cts, (chunk) => this.postLlmChunk(chunk), resolvedModel);
      if (this.llmCancellation !== cts || cts.token.isCancellationRequested) {
        return; // superseded by a newer request, OR cancelled without necessarily being replaced (S01: e.g. the linked scenario changed) — its own UI update wins either way.
      }
      this.outputChannel.appendLine(`Copilot response received: ${accumulated.length} chars.`);
      const { code: finalCode, observedMatches } = prependRagTraceabilityBanner(extractCodeBlock(accumulated), ragMatches, settings.language, (p) =>
        vscode.workspace.asRelativePath(p)
      );
      if (ragMatches.length > 0) {
        // The full retrieved -> included in prompt -> call evidence
        // OBSERVED breakdown, in one place — buildRagSection() above
        // already logged "matched N of M indexed" (retrieved) and, when
        // applicable, "N match(es) omitted from the prompt" (retrieved but
        // NOT included); this closes the loop with the last step. "Observed"
        // deliberately, not "used"/"verified" — see
        // ragTraceabilityBanner.ts's own doc comment on why this is a
        // heuristic textual signal, never a real call-graph verification.
        this.outputChannel.appendLine(
          `Reusable components (RAG): ${ragMatches.length} included in the prompt, ${observedMatches.length} with call evidence OBSERVED (heuristic) in the generated code` +
            (observedMatches.length > 0 ? ` (${observedMatches.map((m) => m.id).join(', ')}).` : '.')
        );
      }
      this.reportStepCoverageGaps(linkedScenarioSnapshot, finalCode, settings.language);
      this.postLlmDone(finalCode);
      void this.recordReceivedTokens(accumulated, settings.copilotModelId);
    } catch (err) {
      if (cts.token.isCancellationRequested || this.llmCancellation !== cts) {
        return; // cancelled, or superseded by a newer request — never surface a stale result/error for it either.
      }
      const message = err instanceof CopilotUnavailableError ? err.message : describeError(err);
      this.outputChannel.appendLine(`Code generation request failed: ${message}`);

      // A response with genuinely zero completions from the model backend
      // (seen in practice — see isEmptyModelResponseError()'s own doc
      // comment), OR a request llm/copilotClient.ts's own token-budget
      // preflight refused to even send (PromptTooLargeError) — either way
      // is exactly the failure mode an oversized "Reusable components" RAG
      // section combined with an already-large prompt (built-in
      // instructions + every checked custom .md file + the full recorded/
      // API reference code) can trigger — "Start AI Feature File
      // Generation" never includes RAG at all, so it keeps working fine
      // regardless, misleadingly looking like "RAG itself" is what's
      // broken. A single recipe's own body is now size-capped too (see
      // ragRetriever.ts's formatRagPromptSection()), but this retry is a
      // safety net for whatever combination still tips a request over —
      // one automatic attempt WITHOUT the RAG section, so this specific,
      // recoverable failure doesn't just dead-end on a cryptic raw
      // provider error the user has no way to act on.
      if (ragSection && (err instanceof PromptTooLargeError || isEmptyModelResponseError(message))) {
        this.outputChannel.appendLine(
          err instanceof PromptTooLargeError
            ? 'Request was too large for the model with RAG components included — retrying once without them...'
            : 'Copilot returned an empty response with RAG components included — retrying once without them...'
        );
        const fallbackPrompt = isApiMode
          ? await buildApiLlmPrompt(
              settings.language,
              settings.languageVersion,
              builtIn,
              instructions,
              apiDetails!,
              customInstructions,
              this.getEncryptSecret(),
              '',
              linkedScenarioSnapshot,
              suggestedBaseName
            )
          : buildLlmPrompt(
              settings.language,
              settings.languageVersion,
              settings.browserChannel,
              builtIn,
              instructions,
              playwrightCode,
              customInstructions,
              '',
              linkedScenarioSnapshot,
              suggestedBaseName,
              recordingMismatch
            );
        lastSentPrompt = fallbackPrompt;
        this.postLlmStart(suggestedBaseName);
        try {
          const accumulated = await this.streamCopilotResponse(fallbackPrompt, settings.copilotModelId, cts, (chunk) => this.postLlmChunk(chunk), resolvedModel);
          if (this.llmCancellation !== cts || cts.token.isCancellationRequested) {
            return; // superseded by a newer request, OR cancelled (S01), while this retry was still in flight.
          }
          this.outputChannel.appendLine(`Copilot response received on retry (without RAG): ${accumulated.length} chars.`);
          const fallbackCode = extractCodeBlock(accumulated);
          this.reportStepCoverageGaps(linkedScenarioSnapshot, fallbackCode, settings.language);
          this.postLlmDone(fallbackCode);
          void this.recordReceivedTokens(accumulated, settings.copilotModelId);
          return;
        } catch (retryErr) {
          if (cts.token.isCancellationRequested || this.llmCancellation !== cts) {
            return;
          }
          const retryMessage = retryErr instanceof CopilotUnavailableError ? retryErr.message : describeError(retryErr);
          this.outputChannel.appendLine(`Retry without RAG also failed: ${retryMessage}`);
          // Failed even WITHOUT RAG — the RAG section was never the actual
          // bottleneck, so say so plainly rather than leaving the user
          // thinking dropping RAG should have fixed it.
          const retryMeasured = await measureFailedPromptTokens(resolvedModel, lastSentPrompt);
          this.postLlmError(describeCopilotFailure(retryErr, retryMessage, instructions.length, '', retryMeasured));
          return;
        }
      }

      const measured = await measureFailedPromptTokens(resolvedModel, lastSentPrompt);
      this.postLlmError(describeCopilotFailure(err, message, instructions.length, ragSection, measured));
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
    onChunk: (chunk: string) => void,
    model?: vscode.LanguageModelChat
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
      // F12: reuse an already-resolved model handle when given (see this
      // method's own new `model` parameter and sendPromptWithModel()'s own
      // doc comment) rather than sendPrompt()'s internal by-id resolution
      // — every OTHER call site (feature-file generation, the fix-loop)
      // omits it and gets the exact same behavior as before this
      // parameter existed.
      const send = (onFragment: (chunk: string) => void) =>
        model ? sendPromptWithModel(model, prompt, onFragment, cts.token) : sendPrompt(copilotModelId, prompt, onFragment, cts.token);
      send((chunk) => {
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
      })
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


  /** Bound `SecretEncryptor` (see api/apiRequestDetails.ts) for this panel's
   * own `context` — API Automation mode's every prompt-building call site
   * passes this in so credential-shaped auth fields get encrypted
   * (SoftPlay's "Auto Password Encryption") rather than sent in plaintext. */
  private getEncryptSecret(): SecretEncryptor {
    return (plaintext: string) => secretVault.encryptSecret(this.context, plaintext);
  }

  /** Decomposes the current request into independently-retrievable
   * operations (rag/ragOperationPlanner.ts, Phase 3) — one operation per
   * SELECTED Gherkin step when a scenario is linked (never a deselected
   * one — see LinkedScenario.stepTexts's own doc comment), one operation
   * for an API request's method/URL + sanitized body field names, or one
   * fallback operation wrapping the recorded Playwright code when neither
   * applies. The chat box's free text is folded into every resulting
   * operation as shared context (`withSharedContext()`), same treatment a
   * scenario's own Background gets — real retrieval-relevant vocabulary,
   * not itself a distinct capability request. */
  /** `linkedScenario` (S01) is passed in explicitly by the caller's own
   * already-snapshotted value — NEVER read from `this.linkedScenario`
   * live — so this plan (and everything `buildRagSection()` retrieves
   * against it) always matches the SAME scenario the rest of that one
   * request was built from, regardless of what the live selection does
   * while this request is still in flight. */
  private buildOperationPlan(
    isApiMode: boolean,
    playwrightCode: string,
    apiDetails: ApiRequestDetails | undefined,
    customInstructions: string,
    linkedScenario: LinkedScenario | undefined
  ): OperationPlan {
    const basePlan = linkedScenario
      ? planOperationsFromGherkinSteps(linkedScenario.stepTexts, linkedScenario.backgroundRawText, linkedScenario.exampleTexts)
      : isApiMode && apiDetails
        ? planOperationFromApiRequest(`${apiDetails.method} ${apiDetails.url}`.trim(), extractApiBodyFieldNames(apiDetails))
        : planUnstructuredOperation(isApiMode ? '' : playwrightCode);
    return withSharedContext(basePlan, customInstructions);
  }

  /**
   * Builds the "Reusable components available" prompt section (see
   * rag/ragRetriever.ts) for the CURRENT request — or `''` when RAG is
   * turned off in Settings, no workspace folder is open, or
   * `.github/rag` has nothing indexed yet. Every one of those is a silent,
   * normal no-op, never surfaced as an error: a team that hasn't adopted
   * this yet sees zero behavior change. Shared by runLlmRefinement() (the
   * real send) and updateTokenEstimate() (so the token estimate reflects
   * exactly what a real send would include, same reasoning as Auto
   * Password Encryption's own redaction pass being shared between the two).
   *
   * Item 2 (dedupe): this method now just builds ITS OWN operation plan
   * (Gherkin steps/API details/Playwright code — the one genuinely
   * different piece between Standard and Agentic mode) and hands off to
   * rag/ragPackingPipeline.ts's `packRagSection()` for everything after
   * that (retrieve per operation, exclude known-stale recipes, pack
   * against the real token budget, format) — the exact same pipeline
   * agenticModeController.ts's own `buildRagSection()` now also calls,
   * instead of each maintaining an independent copy of this logic.
   */
  private async buildRagSection(
    settings: ObjectSpySettings,
    isApiMode: boolean,
    playwrightCode: string,
    apiDetails: ApiRequestDetails | undefined,
    customInstructions: string,
    // S01: the CALLER's own already-snapshotted value — never read live —
    // so per-operation RAG retrieval always matches the same scenario the
    // rest of this one request was built from. See buildOperationPlan()'s
    // own doc comment.
    linkedScenario: LinkedScenario | undefined,
    mandatoryTokens: number | undefined,
    model?: vscode.LanguageModelChat,
    cancellationToken?: vscode.CancellationToken
  ): Promise<{ section: string; matches: RagMatch[] }> {
    if (!settings.ragEnabled) {
      return { section: '', matches: [] };
    }
    const plan = this.buildOperationPlan(isApiMode, playwrightCode, apiDetails, customInstructions, linkedScenario);
    return packRagSection(plan, {
      extensionContext: this.context,
      settings,
      mandatoryTokens,
      model,
      cancellationToken,
      logPrefix: 'Reusable components (RAG)',
      onLog: (message) => this.outputChannel.appendLine(message)
    });
  }

  /**
   * "SoftPlay: Check RAG Source Freshness" (Command Palette command
   * `objectSpy.checkRagFreshness`, and the Settings panel's own "Check
   * Freshness" button — see settingsPanel.ts) — Phase 5's active
   * source-staleness check. Always forces a fresh check
   * (`forceRefresh: true`): this is an explicit, manually-triggered
   * diagnostic, not a background poll, so a user clicking it always wants
   * to know the CURRENT state, not whatever was cached from a previous
   * run. All real decision logic lives in, and is unit tested from,
   * rag/ragFreshnessChecker.ts and rag/ragSourceIdentity.ts — this method
   * is purely the vscode-side "run it and report the result" glue.
   */
  async checkRagSourceFreshness(): Promise<FreshnessReport | undefined> {
    const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri;
    if (!workspaceRoot) {
      void vscode.window.showWarningMessage('SoftPlay: Open a workspace folder first — recipes are read from its .github/rag folder.');
      return undefined;
    }

    const report = await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: 'SoftPlay: Checking RAG source freshness…' },
      () =>
        getOrBuildFreshnessReport(workspaceRoot, {
          forceRefresh: true,
          onWarn: (message) => this.outputChannel.appendLine(`RAG Source Freshness: ${message}`)
        })
    );

    this.logFreshnessReport(report);

    const { fresh, stale, missing, unverifiable, error } = report.counts;
    if (report.entries.length === 0) {
      void vscode.window.showInformationMessage('SoftPlay: No RAG recipes found under .github/rag — nothing to check.');
    } else {
      const summary = `RAG Source Freshness: ${fresh} fresh, ${stale} stale, ${missing} missing, ${unverifiable} unverifiable, ${error} error(s) — see the SoftPlay output channel for details.`;
      if (stale > 0 || missing > 0 || error > 0) {
        const choice = await vscode.window.showWarningMessage(summary, 'Show Output');
        if (choice === 'Show Output') {
          this.outputChannel.show(true);
        }
      } else {
        void vscode.window.showInformationMessage(summary);
      }
    }
    return report;
  }

  private logFreshnessReport(report: FreshnessReport): void {
    this.outputChannel.appendLine(`\n── RAG Source Freshness check (${report.generatedAt}) ──`);
    if (report.entries.length === 0) {
      this.outputChannel.appendLine('No RAG recipes found under .github/rag.');
      return;
    }
    for (const entry of report.entries) {
      this.outputChannel.appendLine(`[${entry.state.toUpperCase()}] ${entry.relativePath} (${entry.recipeId}) — ${entry.detail}`);
    }
    const { fresh, stale, missing, unverifiable, error } = report.counts;
    this.outputChannel.appendLine(
      `Summary: ${report.entries.length} recipe(s) — ${fresh} fresh, ${stale} stale, ${missing} missing, ${unverifiable} unverifiable, ${error} error(s).`
    );
  }

  private async readInstructionFiles(relPaths: string[]): Promise<{ path: string; content: string }[]> {
    if (!vscode.workspace.workspaceFolders?.length) {
      return [];
    }
    const results: { path: string; content: string }[] = [];
    for (const relPath of relPaths) {
      try {
        const uri = vscode.Uri.joinPath(vscode.workspace.workspaceFolders[0].uri, relPath);
        // mtime-checked cache (cache/fileCache.ts) — these files are called
        // on every debounced token-estimate tick as well as every real send,
        // so an unedited file skips the read+decode entirely, while an edit
        // made mid-session (these are user-owned workspace files, unlike the
        // bundled prompts above) is still picked up on the very next read.
        const content = await readWorkspaceFileCached(uri);
        results.push({ path: relPath, content });
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
  private postLlmStart(suggestedBaseName: string | undefined): void {
    this.aiCodePanel.setLanguage(this.settingsStore.get().language);
    this.aiCodePanel.setSuggestedFileName(suggestedBaseName);
    this.aiCodePanel.startGenerating();
    this.webview?.postMessage({ type: 'aiStatus', payload: { state: 'generating' } });
    // Fresh generation incoming — any prior "Code Correctness Confirmed"
    // was about a now-superseded version of the code, and there's no
    // complete AI-generated code in memory again until it finishes.
    this.postCodeCorrectness(false);
    this.postAiCodeAvailable(false);
  }

  private postLlmChunk(chunk: string): void {
    this.aiCodePanel.appendChunk(chunk);
  }

  private postLlmDone(finalCode: string): void {
    this.aiCodePanel.finish(finalCode);
    this.webview?.postMessage({ type: 'aiStatus', payload: { state: 'idle' } });
    this.postAiCodeAvailable(true);
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
   * own — only "Start AI Code Generation" does. */
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
    const settings = this.settingsStore.get();
    this.agenticModeEnabledAtLastRender = settings.agenticModeEnabled;
    if (settings.agenticModeEnabled) {
      return getAgenticModeSidebarHtml({
        webview,
        styleUri: webview.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, 'media', 'main.css')),
        scriptUri: webview.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, 'media', 'agenticMode.js')),
        nonce: getNonce(),
        version: this.getVersion()
      });
    }

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
      <span class="title-line">
        <span class="title">TD Securities Agentic Test Automation</span>
        <span id="versionBadge" class="version-badge">v${this.getVersion()}</span>
      </span>
      <span class="title-subtitle">LangChain-powered Agent</span>
    </span>
    <button id="settingsBtn" class="btn-icon-top" title="Settings (language, browser, GitHub Copilot)">⚙</button>
  </div>

  <div id="codeCorrectnessBanner" class="code-correctness-banner" hidden>✓ Code Correctness Confirmed</div>

  <details class="section" id="controlPanelSection" open>
    <summary>Control Panel</summary>
    <div class="section-body">
      <div class="toolbar-row">
        <button id="linkFeatureBtn" class="btn btn-silver" title="Browse to a Cucumber .feature file and pick a Scenario/Scenario Outline to link to the generated code">Link Feature File</button>
        <span id="linkedScenarioBadge" class="linked-scenario-badge" hidden>
          <span id="linkedScenarioText"></span>
          <button id="unlinkScenarioBtn" class="btn-icon-small" title="Unlink this scenario">✕</button>
        </span>
        <button id="clearApiDataBtn" class="btn btn-danger clear-data-btn" hidden title="Clear every Control Panel field, the linked/generated feature file, the AI Generated Code, and the LLM context built from them">Clear Data</button>
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

  <details class="section" id="customInstructionsRagSection" open hidden>
    <summary>Custom Instructions &amp; RAG Data</summary>
    <div class="section-body">
      <details class="ai-assist" id="customInstructionsSubsection">
        <summary>Custom Instructions</summary>
        <div class="ai-assist-body">
          <div class="ai-files-header">Instruction / skill / prompt files (<code>.github/*.md</code>)</div>
          <div id="promptFilesList" class="prompt-files-list">
            <div class="prompt-files-empty">No .md files found yet — click Refresh.</div>
          </div>
        </div>
      </details>

      <details class="ai-assist" id="ragDataSubsection">
        <summary>RAG Data</summary>
        <div class="ai-assist-body">
          <div class="ai-files-header">Reusable component recipes (<code>.github/rag/*.md</code>) — matched automatically, nothing to select here</div>
          <div id="ragFilesList" class="prompt-files-list">
            <div class="prompt-files-empty">No recipes found yet — click Refresh.</div>
          </div>
        </div>
      </details>

      <div class="toolbar-row">
        <button id="refreshPromptFilesBtn" class="btn btn-small btn-silver" title="Re-scan .github/*.md (Custom Instructions) and .github/rag/*.md (RAG Data)">Refresh file list</button>
      </div>

      <div id="chatComposer" class="chat-composer">
        <div id="chatMessages" class="chat-messages"></div>
        <div class="chat-input-label">Instant instructions to LLM</div>
        <div class="chat-input-row">
          <textarea id="chatInput" class="chat-input" rows="3" placeholder="Add any details for the AI to follow…"></textarea>
          <button id="chatSendBtn" class="chat-send-btn" title="Add to the request — click 'Start AI Code Generation' below to actually send" aria-label="Add">➤</button>
        </div>
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
      <div class="toolbar-row ai-open-row">
        <button id="generateFeatureFileBtn" class="btn btn-silver" title="No feature file to link yet? Record a flow with Start above, then send the recorded Playwright Code (plus anything in the chat box) to the LLM to generate a brand-new BDD Gherkin feature file">Start AI Feature File Generation</button>
        <button id="startAiProcessingBtn" class="btn btn-silver" title="Send the current Playwright Code, Settings (browser/language/version), linked scenario or selected steps, checked Custom Instructions files, and anything in the chat box below to the LLM for AI code generation">Start AI Code Generation</button>
        <button id="openAiCodeBtn" class="btn btn-silver" hidden>Open AI Generated Code</button>
        <span id="aiStatusLabel" class="llm-status"></span>
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
          <button type="button" id="apiCurlBtn" class="api-curl-btn" title="Paste a curl command to auto-fill this request">CURL</button>
        </div>
        <div id="apiCurlPanel" class="api-curl-panel" hidden>
          <textarea id="apiCurlInput" class="api-curl-textarea" rows="6" spellcheck="false" placeholder="Paste a curl command here — e.g. curl -X POST https://api.example.com/users -H 'Content-Type: application/json' -d '{&quot;name&quot;:&quot;John&quot;}'"></textarea>
          <div class="api-curl-actions">
            <span id="apiCurlStatus" class="api-curl-status"></span>
            <button type="button" id="apiCurlCancelBtn" class="api-curl-cancel-btn">Cancel</button>
            <button type="button" id="apiCurlImportBtn" class="api-curl-import-btn">Import</button>
          </div>
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
              <option value="digest">Digest Auth</option>
              <option value="oauth1">OAuth 1.0</option>
              <option value="oauth2">OAuth 2.0</option>
              <option value="hawk">Hawk Authentication</option>
              <option value="awsv4">AWS Signature</option>
              <option value="ntlm">NTLM Authentication</option>
              <option value="edgegrid">Akamai EdgeGrid</option>
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
          <div class="api-auth-fields" data-auth="digest" hidden>
            <div class="api-field-row"><label>Username</label><input id="apiAuthDigestUser" type="text" placeholder="Username" /></div>
            <div class="api-field-row"><label>Password</label><input id="apiAuthDigestPass" type="password" placeholder="Password" /></div>
          </div>
          <div class="api-auth-fields" data-auth="oauth1" hidden>
            <div class="api-field-row"><label>Consumer Key</label><input id="apiAuthOauth1ConsumerKey" type="password" placeholder="Consumer Key" /></div>
            <div class="api-field-row"><label>Consumer Secret</label><input id="apiAuthOauth1ConsumerSecret" type="password" placeholder="Consumer Secret" /></div>
            <div class="api-field-row"><label>Access Token</label><input id="apiAuthOauth1AccessToken" type="password" placeholder="Access Token" /></div>
            <div class="api-field-row"><label>Token Secret</label><input id="apiAuthOauth1TokenSecret" type="password" placeholder="Token Secret" /></div>
            <div class="api-field-row">
              <label>Signature Method</label>
              <select id="apiAuthOauth1SignatureMethod">
                <option value="HMAC-SHA1">HMAC-SHA1</option>
                <option value="HMAC-SHA256">HMAC-SHA256</option>
                <option value="PLAINTEXT">PLAINTEXT</option>
              </select>
            </div>
          </div>
          <div class="api-auth-fields" data-auth="oauth2" hidden>
            <div class="api-field-row"><label>Access Token</label><input id="apiAuthOauth2AccessToken" type="password" placeholder="Access Token" /></div>
            <div class="api-field-row"><label>Header Prefix</label><input id="apiAuthOauth2HeaderPrefix" type="text" placeholder="Bearer" value="Bearer" /></div>
          </div>
          <div class="api-auth-fields" data-auth="hawk" hidden>
            <div class="api-field-row"><label>Hawk Auth ID</label><input id="apiAuthHawkId" type="text" placeholder="Hawk Auth ID" /></div>
            <div class="api-field-row"><label>Hawk Auth Key</label><input id="apiAuthHawkKey" type="password" placeholder="Hawk Auth Key" /></div>
            <div class="api-field-row">
              <label>Algorithm</label>
              <select id="apiAuthHawkAlgorithm">
                <option value="sha256">sha256</option>
                <option value="sha1">sha1</option>
              </select>
            </div>
          </div>
          <div class="api-auth-fields" data-auth="awsv4" hidden>
            <div class="api-field-row"><label>Access Key</label><input id="apiAuthAwsAccessKey" type="password" placeholder="Access Key" /></div>
            <div class="api-field-row"><label>Secret Key</label><input id="apiAuthAwsSecretKey" type="password" placeholder="Secret Key" /></div>
            <div class="api-field-row"><label>Session Token</label><input id="apiAuthAwsSessionToken" type="password" placeholder="Session Token (optional)" /></div>
            <div class="api-field-row"><label>AWS Region</label><input id="apiAuthAwsRegion" type="text" placeholder="e.g. us-east-1" /></div>
            <div class="api-field-row"><label>Service Name</label><input id="apiAuthAwsServiceName" type="text" placeholder="e.g. execute-api" /></div>
          </div>
          <div class="api-auth-fields" data-auth="ntlm" hidden>
            <div class="api-field-row"><label>Username</label><input id="apiAuthNtlmUser" type="text" placeholder="Username" /></div>
            <div class="api-field-row"><label>Password</label><input id="apiAuthNtlmPass" type="password" placeholder="Password" /></div>
            <div class="api-field-row"><label>Domain</label><input id="apiAuthNtlmDomain" type="text" placeholder="Domain (optional)" /></div>
            <div class="api-field-row"><label>Workstation</label><input id="apiAuthNtlmWorkstation" type="text" placeholder="Workstation (optional)" /></div>
          </div>
          <div class="api-auth-fields" data-auth="edgegrid" hidden>
            <div class="api-field-row"><label>Access Token</label><input id="apiAuthEdgeGridAccessToken" type="password" placeholder="Access Token" /></div>
            <div class="api-field-row"><label>Client Token</label><input id="apiAuthEdgeGridClientToken" type="password" placeholder="Client Token" /></div>
            <div class="api-field-row"><label>Client Secret</label><input id="apiAuthEdgeGridClientSecret" type="password" placeholder="Client Secret" /></div>
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

// This is the built-in "think like a senior UI test automation engineer"
// refinement standard (try/catch, logger.info/warn/error, explicit
// visible+enabled waits, zero hardcoded values) sent to the LLM on every
// refinement, manual or automatic. Lives outside src/ deliberately:
// .vscodeignore excludes src/**/*.ts from the packaged extension, but this
// file must ship as plain markdown, not be compiled. Missing/unreadable is a
// benign "run without the extra standard" fallback, never a hard failure —
// the reference code and any .github/ project instructions still make it
// into the prompt either way. Cached (mtime-checked, see cache/fileCache.ts)
// rather than re-read from disk on every prompt build.
function readSeniorQeInstructions(): string {
  return readFileCachedSync(path.join(__dirname, '..', '..', 'prompts', 'senior-qe-instructions.md'));
}

// Same pattern as readSeniorQeInstructions() above, for the "Generate
// Gherkin Feature File" prompt (prompts/generate-feature-file.md) instead.
function readFeatureFileGenInstructions(): string {
  return readFileCachedSync(path.join(__dirname, '..', '..', 'prompts', 'generate-feature-file.md'));
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

  // `playwrightCode` has already had any password/credential literal
  // replaced with an `ENC[v1:...]` token by Auto Password Encryption (see
  // security/uiPasswordRedactor.ts) — a feature file describes BEHAVIOR,
  // not code, so no decrypt helper is needed here; just make sure the
  // model never treats the token itself as something to reproduce.
  parts.push(
    `\n## Playwright Codegen output to analyze\n\`\`\`\n${playwrightCode}\n\`\`\``
  );
  if (playwrightCode.includes(secretVault.TOKEN_MARKER)) {
    parts.push(
      `\n## Note on \`ENC[v1:...]\` tokens above\nThese are SoftPlay Auto Password Encryption tokens — encrypted ` +
        `credentials, not real values. Describe the underlying action in plain business terms only (e.g. "the user ` +
        `enters their password") — never reproduce, quote, or attempt to decode the token itself in the feature file.`
    );
  }

  // Deliberately LAST — see buildLlmPrompt()'s identical block for why:
  // placed earlier, this reads as a suggestion easily outweighed by
  // whatever large block follows it; last, it's what the model reads
  // right before generating.
  if (customInstructions) {
    parts.push(
      `\n## ⚠ Additional instructions from the user — read this last and apply it\nThe user typed the following ` +
        `into SoftPlay's chat box specifically for this request. Treat it as a real, binding requirement, not a ` +
        `suggestion — if it conflicts with something more generic stated earlier in this prompt, this wins:\n${customInstructions}`
    );
  }

  return parts.join('\n');
}

// Same pattern as readSeniorQeInstructions()/readFeatureFileGenInstructions()
// above, for API Automation mode's prompts/api-automation-instructions.md.
function readApiAutomationInstructions(): string {
  return readFileCachedSync(path.join(__dirname, '..', '..', 'prompts', 'api-automation-instructions.md'));
}

/** S04: pytest-bdd needs an explicit `@scenario(<path>, '<name>')` binding
 * per test function — the model has no reliable way to invent the real
 * relative path to a feature file it never actually receives, and
 * previously wasn't given one anywhere in the prompt at all (confirmed by
 * the review: only the feature/scenario NAMES and raw Gherkin text ever
 * reached the prompt). `''` for Java (Cucumber-JVM discovers step
 * definitions by classpath scanning — no per-scenario file-path binding
 * exists to get wrong) or when there's no linked scenario to bind.
 *
 * Gives the WORKSPACE-relative path (`vscode.workspace.asRelativePath()` —
 * the same "identify a file without leaking the machine's own absolute
 * filesystem layout" convention already used for the RAG traceability
 * banner) rather than a path relative to wherever the generated test file
 * will eventually be saved — that location isn't knowable at prompt-build
 * time, since the user can save the "AI Generated Code" editor's contents
 * anywhere. The model is told explicitly to adapt the `../` traversal to
 * wherever it structures the output, but must always resolve to this exact
 * file, never a placeholder or invented name.
 *
 * Also explicitly forbids pytest-bdd's `scenarios(...)` helper (binds
 * EVERY scenario in a feature file at once) — this generation is scoped to
 * ONE selected scenario; auto-binding the rest would require step
 * definitions for scenarios this request was never asked to cover. */
function buildPythonScenarioBindingSection(language: 'java' | 'python', linkedScenario: LinkedScenario): string {
  if (language !== 'python') {
    return '';
  }
  const workspaceRelativePath = vscode.workspace.asRelativePath(linkedScenario.featureFilePath);
  return (
    `\n## Required pytest-bdd scenario binding (non-negotiable)\n` +
    `The linked feature file's path, relative to the workspace root, is \`${workspaceRelativePath}\`. Bind this test ` +
    `function to it with \`@scenario('${workspaceRelativePath}', '${linkedScenario.scenarioName}')\` — pytest-bdd ` +
    `resolves that path relative to the TEST FILE'S OWN location by default, so adjust the number of \`../\` ` +
    `segments to wherever you structure the output, but it must always resolve to this exact feature file, never a ` +
    `placeholder or invented name. Use the scenario name exactly as given above, character for character. Do NOT ` +
    `use \`scenarios('${workspaceRelativePath}')\` (pytest-bdd's bind-every-scenario-in-the-file helper) — this ` +
    `request is scoped to ONLY the "${linkedScenario.scenarioName}" scenario; auto-binding every other scenario in ` +
    `that feature file would require step definitions for scenarios this request was never asked to cover.`
  );
}

/** API Automation mode's counterpart to buildFeatureFilePrompt() — same
 * "code/request in, feature file out" shape, just fed the Control Panel's
 * API request details (buildApiRequestSummary()) instead of Playwright
 * Codegen output. A linked scenario (if any) is folded in as additional
 * business context per the explicit ask that a linked feature file be
 * handled "the same way" in API mode as in UI mode. */
async function buildApiFeatureFilePrompt(
  builtInInstructions: string,
  apiDetails: ApiRequestDetails,
  customInstructions: string,
  language: 'java' | 'python',
  encryptSecret: SecretEncryptor,
  linkedScenario?: LinkedScenario
): Promise<string> {
  const parts: string[] = [];

  if (builtInInstructions) {
    parts.push(builtInInstructions);
  } else {
    parts.push(
      'Analyze the following API request details and produce a complete, business-focused BDD Gherkin feature ' +
        'file. Output ONLY the feature file in a single fenced `gherkin` code block, no other commentary.'
    );
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

  const apiSummary = await buildApiRequestSummary(apiDetails, encryptSecret);
  parts.push(`\n## API Request Details to analyze\n${apiSummary}`);
  appendPasswordEncryptionSection(parts, apiSummary, language);

  // Deliberately LAST — see buildLlmPrompt()'s identical block for why.
  if (customInstructions) {
    parts.push(
      `\n## ⚠ Additional instructions from the user — read this last and apply it\nThe user typed the following ` +
        `into SoftPlay's chat box specifically for this request. Treat it as a real, binding requirement, not a ` +
        `suggestion — if it conflicts with something more generic stated earlier in this prompt, this wins:\n${customInstructions}`
    );
  }

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
async function buildApiLlmPrompt(
  language: 'java' | 'python',
  languageVersion: string,
  builtInInstructions: string,
  instructions: { path: string; content: string }[],
  apiDetails: ApiRequestDetails,
  customInstructions: string,
  encryptSecret: SecretEncryptor,
  /** Pre-formatted "Reusable components available" section (see
   * rag/ragRetriever.ts's formatRagPromptSection()) — already `''` when
   * retrieval is disabled/has nothing relevant, so callers never need a
   * separate on/off branch here. */
  ragSection: string,
  linkedScenario?: LinkedScenario,
  suggestedClassName?: string
): Promise<string> {
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

  const apiSummary = await buildApiRequestSummary(apiDetails, encryptSecret);
  parts.push(`\n## API Request Details — the request to build test automation around\n${apiSummary}`);
  appendPasswordEncryptionSection(parts, apiSummary, language);
  if (ragSection) {
    parts.push(ragSection);
  }

  if (linkedScenario) {
    parts.push(
      `\n## Linked Gherkin ${linkedScenario.scenarioKind} — "${linkedScenario.scenarioName}" (from ${linkedScenario.featureName})`,
      `The user has linked this Cucumber ${linkedScenario.scenarioKind} to the API request above via "Link Feature ` +
        `file". Every Given/When/Then/And/But/* line below must get its own properly linked BDD step definition ` +
        `per section 7 of the mandatory refinement standard — do not just append the Gherkin as a comment. Produce ` +
        `exactly ONE file, in exactly ONE fenced code block: the API client AND its BDD step definitions together.`,
      `\`\`\`gherkin\n${[linkedScenario.backgroundRawText, linkedScenario.rawText].filter(Boolean).join('\n\n')}\n\`\`\``
    );
    if (!isPartialSelection) {
      if (suggestedClassName) {
        parts.push(
          `\n## Required ${language === 'java' ? 'class' : 'module/file'} name (non-negotiable)\n` +
            (language === 'java'
              ? `Name the primary public class exactly \`${suggestedClassName}\` (and its file \`${suggestedClassName}.java\`) — ` +
                `derived from this scenario's own name, so it stays recognizable as the test for THIS scenario.`
              : `Name the module (test file, without the \`.py\` extension) exactly \`${suggestedClassName}\` — derived ` +
                `from this scenario's own name, so it stays recognizable as the test for THIS scenario.`)
        );
      }
      const pythonBinding = buildPythonScenarioBindingSection(language, linkedScenario);
      if (pythonBinding) {
        parts.push(pythonBinding);
      }
    }
  }

  // Free-text instructions from the chat composer ("Add any details for
  // the AI to follow…") — deliberately LAST, same reasoning as
  // buildLlmPrompt()'s identical block: a model weighs what it reads most
  // recently more heavily, and this document alone runs well over a
  // thousand lines, easily burying/outweighing anything placed earlier.
  if (customInstructions) {
    parts.push(
      `\n## ⚠ Additional instructions from the user — read this last and apply it\nThe user typed the following ` +
        `into SoftPlay's chat box specifically for this request. Treat it as a real, binding requirement, not a ` +
        `suggestion — if it conflicts with something more generic stated earlier in this prompt, this wins:\n${customInstructions}`
    );
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

  // Defense in depth: the broken code SHOULD already carry ENC[v1:...]
  // tokens plus its decrypt helper (both `originalContext.content` and
  // `brokenCode` are checked, not just one) rather than any plaintext
  // credential, per the standard given on the original request — restating
  // it here means a fix attempt can never accidentally drop the decrypt
  // helper or "simplify" a token back toward plaintext.
  appendPasswordEncryptionSection(parts, `${originalContext.content}\n${brokenCode}`, language);

  parts.push(
    `\n## Task\nFix ONLY what's necessary to resolve this specific error. Do not restructure or rewrite parts of ` +
      `the code that aren't implicated by it. Keep the same class/file name, the same target language/runtime ` +
      `version${automationMode === 'ui' ? ', the same browser-executable launch override (never remove or weaken it)' : ''}, ` +
      `and the overall structure — this is a targeted fix, not a rewrite.`
  );

  return parts.join('\n');
}

/** The class name (Java) / module base name (Python) `linkedScenario`'s own
 * name derives into (see testNaming.ts) for `language` — `undefined` when
 * no scenario is linked, in which case callers fall back to their own
 * generic default.
 *
 * S01: a plain, pure free function taking BOTH inputs explicitly, rather
 * than a method reading `this.linkedScenario`/`this.settingsStore.get().language`
 * live — every caller (runLlmRefinement(), updateTokenEstimate()) now
 * passes its own already-SNAPSHOTTED scenario/language, computed once at
 * the top of that request, so the suggested filename this produces can
 * never end up describing a different scenario than the prompt/result
 * built alongside it in that same request. */
function currentSuggestedBaseName(linkedScenario: LinkedScenario | undefined, language: 'java' | 'python'): string | undefined {
  if (!linkedScenario) {
    return undefined;
  }
  return language === 'java' ? linkedScenario.javaClassName : linkedScenario.pythonModuleName;
}

/** S02: a stable identity key for a linked scenario — same shape/kind/name
 * combination from the same feature file always yields the same key, so it
 * can be compared across scenario switches without holding onto the whole
 * (possibly large) `LinkedScenario` object. `undefined` in, `undefined`
 * out — "no scenario" has no identity to compare. */
function scenarioIdentityKey(linkedScenario: LinkedScenario | undefined): string | undefined {
  if (!linkedScenario) {
    return undefined;
  }
  return `${linkedScenario.featureFilePath}::${linkedScenario.scenarioKind}::${linkedScenario.scenarioName}`;
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

/** Matches the specific "the model backend returned zero completions"
 * failure shape (observed verbatim as "Response contained no choices.")
 * — this is the underlying GitHub Copilot Chat extension/provider's own
 * error text, not one this codebase produces, so it's matched loosely
 * (case-insensitive substring) rather than exactly, in case the wording
 * varies slightly across Copilot Chat versions. Reported in practice when
 * an already-large "Start AI Code Generation" prompt (built-in
 * instructions + custom .md files + full recorded/API code) grows further
 * with an oversized RAG "Reusable components" section — see
 * runLlmRefinement()'s retry-without-RAG fallback right where this is used. */
function isEmptyModelResponseError(message: string): boolean {
  const normalized = message.toLowerCase();
  return normalized.includes('no choices') || normalized.includes('empty response') || normalized.includes('no completion');
}

/** A failed request's own actual token usage, measured REACTIVELY (only
 * once a request has already failed) so `buildEmptyResponseGuidance()` can
 * ground its explanation in real numbers instead of always defaulting to
 * "the prompt was too large" — see that function's own doc comment for why
 * this matters. `undefined` when there's no resolved model to count
 * against, `prompt` is empty (nothing was actually sent yet), or the count
 * itself throws — degrades to the old, size-agnostic wording, never a
 * crash. Deliberately reactive (never measured on the success path) so
 * this adds zero extra cost/latency to the overwhelming common case where
 * nothing fails at all. */
async function measureFailedPromptTokens(model: vscode.LanguageModelChat | undefined, prompt: string): Promise<{ sentTokens: number; maxInputTokens: number } | undefined> {
  if (!model || !prompt) {
    return undefined;
  }
  try {
    return { sentTokens: await model.countTokens(prompt), maxInputTokens: model.maxInputTokens };
  } catch {
    return undefined;
  }
}

/** Fraction of a model's own `maxInputTokens` below which the request's
 * OWN measured size is treated as "comfortably fits" — i.e. clear enough
 * to actively rule out "the prompt was too large" as this failure's cause,
 * not merely "didn't hit the hard PromptTooLargeError preflight." A generous
 * threshold (half the model's real limit) deliberately errs toward NOT
 * blaming size only when the evidence against it is strong. */
const EMPTY_RESPONSE_SIZE_UNLIKELY_THRESHOLD = 0.5;

/** Turns the raw, cryptic "Response contained no choices."-style provider
 * error into something the user can actually ACT on. This failure has no
 * single fixed cause — it's the model backend's own generic way of saying
 * "this request couldn't be completed" — and an oversized prompt is only
 * ONE possible reason, not the only one. Unconditionally leading with "the
 * prompt was probably too large" is actively misleading whenever
 * `measuredTokens` shows the request measured well under the model's own
 * limit: this extension's OWN preflight budget check (llm/copilotClient.ts's
 * `PromptTooLargeError`) already runs BEFORE every request and would have
 * refused to even send a genuinely oversized one, so reaching this "no
 * choices" branch at all already means that check passed. When the
 * measured evidence clearly rules size out, this instead points at the
 * other realistic causes: a transient Copilot backend hiccup, a Copilot
 * Chat sign-in/connectivity problem, or — notably common on a locked-down
 * corporate/enterprise GitHub Copilot deployment — an organization-level
 * content-exclusion or policy filter silently rejecting this specific
 * request's content. `ragWasStillIncluded` distinguishes "this failed WITH
 * RAG content included, an automatic retry without it is about to run/
 * already ran" from "this failed even withOUT RAG — RAG was never the
 * actual bottleneck" so the size-related guidance (when still shown)
 * doesn't misdirect blame. */
function buildEmptyResponseGuidance(
  rawMessage: string,
  customInstructionFileCount: number,
  ragWasStillIncluded: boolean,
  measuredTokens?: { sentTokens: number; maxInputTokens: number }
): string {
  const usageFraction = measuredTokens ? measuredTokens.sentTokens / measuredTokens.maxInputTokens : undefined;
  const sizeUnlikely = usageFraction !== undefined && usageFraction < EMPTY_RESPONSE_SIZE_UNLIKELY_THRESHOLD;

  const measurementNote = measuredTokens
    ? `This request measured ${measuredTokens.sentTokens.toLocaleString()} of the selected model's ${measuredTokens.maxInputTokens.toLocaleString()}-token limit ` +
      `(${Math.round((measuredTokens.sentTokens / measuredTokens.maxInputTokens) * 100)}%)${sizeUnlikely ? ' — well within budget, so an oversized prompt is unlikely to be the actual cause here' : ''}. `
    : '';

  if (sizeUnlikely) {
    return (
      `Copilot returned an empty response (no choices). ${measurementNote}` +
      `Since size doesn't appear to be the cause, this is more likely a transient Copilot backend issue, a Copilot Chat ` +
      `sign-in/connectivity problem, or — common on a locked-down corporate/enterprise GitHub Copilot deployment — an ` +
      `organization-level content-exclusion or policy filter rejecting this specific request. Try again; confirm Copilot ` +
      `Chat itself is signed in and responds normally outside SoftPlay; or check with whoever administers your ` +
      `organization's GitHub Copilot policy about content-exclusion rules that might apply to this workspace. Check the ` +
      `SoftPlay Output channel for the exact prompt size breakdown. Raw provider error: ${rawMessage}`
    );
  }

  const levers = [
    customInstructionFileCount > 0 ? `uncheck some of the ${customInstructionFileCount} checked Custom Instructions file(s)` : undefined,
    'select fewer Gherkin steps in the linked scenario (partial-selection mode sends a smaller prompt)',
    'pick a Copilot model with a larger context window in Settings',
    ragWasStillIncluded ? 'turning off "Use reusable components" (RAG) in Settings, if the components matched aren\'t actually relevant here' : undefined
  ].filter((lever): lever is string => !!lever);
  return (
    `Copilot returned an empty response (no choices) — this usually means the combined prompt was too large or ` +
    `otherwise rejected by the model backend, not a bug in the code you recorded. ${measurementNote}Things that actually ` +
    `shrink the request: ${levers.join('; ')}. Check the SoftPlay Output channel for the exact prompt size breakdown. ` +
    `Raw provider error: ${rawMessage}`
  );
}

/** Picks the right user-facing message for a failed Copilot request.
 * `PromptTooLargeError` (llm/copilotClient.ts) already names the exact
 * token count/budget and concrete levers — passed through as-is rather
 * than wrapped in `buildEmptyResponseGuidance()`'s "empty response (no
 * choices)" wording, which would misdescribe a request this extension
 * itself declined to send. An "empty response" style error still gets
 * that guidance (now evidence-aware — see `measuredTokens`); anything else
 * is shown as-is. */
function describeCopilotFailure(
  err: unknown,
  message: string,
  customInstructionFileCount: number,
  ragSection: string,
  measuredTokens?: { sentTokens: number; maxInputTokens: number }
): string {
  if (err instanceof PromptTooLargeError) {
    return message;
  }
  return isEmptyModelResponseError(message) ? buildEmptyResponseGuidance(message, customInstructionFileCount, !!ragSection, measuredTokens) : message;
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
  /** See buildApiLlmPrompt()'s identical parameter. */
  ragSection: string,
  linkedScenario?: LinkedScenario,
  suggestedClassName?: string,
  /** S02: true when the recording above was last known to correspond to a
   * DIFFERENT (or no re-verified) linked scenario than `linkedScenario` —
   * i.e. its relevance to the steps below has never actually been
   * confirmed. Softens the "reuse its locators as-is"/"match this
   * structure" language into an explicit, honest caveat instead, so the
   * model doesn't confidently treat unrelated recorded actions as
   * sufficient grounding for steps they may not cover. Always `false` for
   * API Automation mode (buildApiLlmPrompt() has no recording at all). */
  recordingMayNotCoverScenario?: boolean
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
        `The user selected **${browserChannel === 'edge' ? 'Microsoft Edge' : 'Google Chrome'}** in SoftPlay ` +
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

  // Placed BEFORE the "Linked Gherkin" section on purpose: the Gherkin
  // section (and its exclusion instruction, when only some steps are
  // checked) is deliberately the LAST thing the model reads before it has
  // to start generating — a model weighs what it read most recently more
  // heavily, and this reference block is large enough that ending on it
  // instead would drown out the exclusion instruction (observed in
  // practice: unchecked steps' click/navigation actions got folded back in
  // as "setup" even when no step definition was generated for them).
  //
  // `playwrightCode` here is real, unmodified `codegen` output EXCEPT for
  // one thing: any password/credential-shaped `.fill(...)`/`.type(...)`
  // literal has already been replaced with an `ENC[v1:...]` token by
  // "Auto Password Encryption" (see security/uiPasswordRedactor.ts, applied
  // by the caller before this function ever sees the code) — so the real
  // plaintext value never reaches this prompt in the first place.
  // S02: when the recording wasn't captured/re-verified for the currently
  // linked scenario, the confident "match this structure and style, reuse
  // its locators as-is" framing would tell the model this recording is
  // known-good grounding for the steps below — it isn't. Replaced with an
  // explicit caveat instead, so the model treats it only as an unverified
  // style/locator reference and calls out — rather than silently
  // fabricates or drops — any linked step it finds no corresponding action
  // for.
  parts.push(
    recordingMayNotCoverScenario
      ? `\n## Reference Playwright-generated code (real \`codegen\` output — see note above about credentials) — ` +
          `⚠ UNVERIFIED against the scenario linked below: this recording was captured for a different (or no ` +
          `re-confirmed) linked scenario and may not contain any actions relevant to the steps below. Use it only ` +
          `as a locator/style reference where an action genuinely corresponds to a step below — do NOT assume it ` +
          `demonstrates every step, do NOT invent actions to make it appear to, and explicitly call out (as a code ` +
          `comment on that step definition) any linked step below this recording provides no real evidence for.\n` +
          `\`\`\`${language}\n${playwrightCode}\n\`\`\``
      : `\n## Reference Playwright-generated code (real \`codegen\` output — see note above about credentials) — match this structure and style, reuse its locators as-is\n\`\`\`${language}\n${playwrightCode}\n\`\`\``
  );
  appendPasswordEncryptionSection(parts, playwrightCode, language);
  if (ragSection) {
    parts.push(ragSection);
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
            `files or code blocks.`) +
        // S02: restated here too, right next to the actual step list, not
        // just up in the reference-code section above — this is the LAST
        // thing the model reads before generating (see the comment on why
        // this section is placed last), so the caveat needs to survive to
        // this point rather than being drowned out by everything in between.
        (recordingMayNotCoverScenario
          ? ` ⚠ The reference recording above is UNVERIFIED against these specific steps (see its own warning) — for ` +
            `any step below it provides no real corresponding action for, still produce a correct step definition ` +
            `using your own best-effort locators/actions for that step, and add a comment on it noting the ` +
            `recording didn't demonstrate it; never claim or imply the recording covers a step it doesn't.`
          : ''),
      `\`\`\`gherkin\n${gherkinBlock}\n\`\`\``
    );
    // A snippet has no class of its own to name — this requirement only
    // makes sense for the full-file case.
    if (!isPartialSelection) {
      if (suggestedClassName) {
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
      const pythonBinding = buildPythonScenarioBindingSection(language, linkedScenario);
      if (pythonBinding) {
        parts.push(pythonBinding);
      }
    }
  }

  // Free-text instructions from the chat composer ("Add any details for
  // the AI to follow…") — deliberately the LAST thing in the prompt, after
  // the reference code and linked scenario, not earlier: a model weighs
  // what it reads most recently more heavily, and burying this behind the
  // large reference-code/Gherkin blocks that used to follow it caused it
  // to be effectively ignored in practice. This is the user's own most
  // specific, most current ask — apply it on top of everything above,
  // adjusting whatever part of the output it's actually about, even where
  // that means deviating from a general rule stated earlier.
  if (customInstructions) {
    parts.push(
      `\n## ⚠ Additional instructions from the user — read this last and apply it\nThe user typed the following ` +
        `into SoftPlay's chat box specifically for this request. Treat it as a real, binding requirement, not a ` +
        `suggestion — if it conflicts with something more generic stated earlier in this prompt, this wins:\n${customInstructions}`
    );
  }

  return parts.join('\n');
}
