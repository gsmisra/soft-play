import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { ObjectSpySettings, SettingsStore } from '../settings/settingsStore';
import { readFileCachedSync, readWorkspaceFileCached } from '../cache/fileCache';
import { CopilotUnavailableError, countModelTokens, extractCodeBlock, findModel } from '../llm/copilotClient';
import { VSCodeCopilotToolCallingModel } from '../agent/vscodeCopilotToolCallingModel';
import { checkEnvironment } from '../execution/environmentCheck';
import { runVerifyFixAgent } from '../agent/verifyFixOrchestrator';
import { truncateForDialog, truncateForStatusLine } from '../agent/verifyFixTextTruncation';
import * as secretVault from '../security/secretVault';
import { validateFeatureFileStructure } from '../bdd/gherkinStructuralValidator';
import { encryptPasswordLiteralsInCode } from '../security/uiPasswordRedactor';
import { encryptCredentialsInFreeText, maskCredentialsForLogging } from '../security/chatInstructionRedactor';
import { appendPasswordEncryptionSection } from '../security/passwordEncryptionSection';
import { planOperationsFromAgenticSegments, chunkTextForOperations } from '../rag/ragOperationPlanner';
import { packRagSection } from '../rag/ragPackingPipeline';
import { RAG_DRAFTS_FOLDER_SEGMENTS } from '../rag/ragCorpusGenerator';
import { parseRagFile } from '../rag/ragFrontmatter';
import { AiCodePanel } from '../panel/aiCodePanel';
import { GeneratedFeaturePanel } from '../panel/generatedFeaturePanel';
import { buildAgenticAutomationCodeChain, buildAgenticFeatureFileChain, buildAgenticTestCaseCsvChain, buildAgenticHumanTurnText, AgenticGenerationInput } from './agenticChains';
import type { Runnable } from '@langchain/core/runnables';
import { buildCsvPreview, detectAgenticFileKind, extractSegmentForFile } from './textIngestion';
import { parseXlsxBuffer, buildXlsxPreview } from './xlsxIngestion';
import { parseDocxBuffer, buildDocxPreview } from './docxIngestion';
import { parsePdfBuffer, buildPdfPreview } from './pdfIngestion';
import { InvalidTestCaseCsvError, normalizeTestCaseCsvResponse } from './csvTestCaseGenerator';
import { parseCsvStrict, stringifyCsv, MalformedCsvError } from './csvUtils';
import { buildAgenticActionShape, AgenticActionKind } from './agenticActionShape';
import { withDatabaseTestingInstructions } from '../llm/databaseTestingInstructions';
import {
  AGENTIC_LEGACY_UNSUPPORTED_EXTENSIONS,
  AGENTIC_MAX_SEGMENT_CHARS,
  AgenticFileKind,
  AgenticFileMeta,
  AgenticIngestedFile,
  AgenticIngestionConfig
} from './agenticTypes';

/**
 * Total Agentic Mode — a deliberately SEPARATE module from every existing
 * generation path (objectSpyPanel.ts's `runLlmRefinement()`/
 * `generateFeatureFile()`) rather than a third branch bolted onto them, per
 * the explicit "proper segregation" requirement: this class owns its own
 * ingested-file state, its own LangChain chains (agenticChains.ts), and its
 * own pair of output panels (fresh `AiCodePanel`/`GeneratedFeaturePanel`
 * instances, never the ones Standard mode already owns) — nothing here can
 * reach into, or be reached by, Standard mode's fields, so turning Agentic
 * Mode on/off can never change Standard mode's own behavior.
 *
 * File formats: text-shaped input (`.csv`, `.json`, `.xml`, `.yml`/`.yaml`,
 * `.txt`/`.md`/`.log`, and best-effort raw text for anything else) is
 * handled directly here as UTF-8 text (textIngestion.ts). `.xlsx`
 * (xlsxIngestion.ts, via `exceljs`), `.docx` (docxIngestion.ts, via
 * `mammoth`), and `.pdf` (pdfIngestion.ts, via `pdfjs-dist`) are each
 * parsed by their own dedicated module into a structured, already-parsed
 * shape (sheets/heading-sections/pages) — see `buildIngestedFile()` below
 * for the dispatch. Legacy pre-2007 Office binary formats (`.xls`, `.doc`)
 * are a completely different, unrelated binary format from `.xlsx`/`.docx`
 * (which are OOXML zip packages) and are rejected with a specific
 * "save as .xlsx/.docx" message rather than mis-parsed as garbage.
 *
 * In-memory only: every ingested file's raw/parsed content lives in the
 * `files` Map for this VS Code session and is NEVER written to disk —
 * closing the workspace or reloading the window clears it, exactly like
 * the rest of this extension's "staged context" (the chat box, checked
 * instruction files) never persisting across a restart.
 */

/** Per-file cap on the RAW upload — separate from (and larger than) the
 * post-ingestion `AGENTIC_MAX_SEGMENT_CHARS` cap on what's actually sent to
 * the LLM (textIngestion.ts) — a user may legitimately drop a large source
 * file and then configure a small slice of it. */
const AGENTIC_MAX_RAW_FILE_BYTES = 10 * 1024 * 1024;

const JIRA_TEMPLATE_RELATIVE_PATH = ['.github', 'Jira_test_case_template.md'];
/** Item 7: an OPTIONAL real example CSV a team may drop next to the MD
 * instructions file above — same base name, `.csv` instead of `.md`.
 * Unlike the MD file, this is NEVER auto-scaffolded (see
 * `readCsvTemplateExample()`'s own doc comment for why) — purely "if it's
 * there, use it; if not, behavior is 100% unchanged." */
const CSV_TEMPLATE_RELATIVE_PATH = ['.github', 'Jira_test_case_template.csv'];

/** F07: see `readCsvTemplateExample()`'s own doc comment for the exact
 * distinction this makes possible. */
type CsvTemplateReadResult = { status: 'absent' } | { status: 'invalid'; reason: string } | { status: 'ok'; header: string[]; exampleRows: string[][] };

export interface AgenticIngestResult {
  accepted: AgenticFileMeta[];
  rejected: { fileName: string; reason: string }[];
}

export class AgenticModeController implements vscode.Disposable {
  private readonly files = new Map<string, AgenticIngestedFile>();
  private nextFileId = 1;
  private lastUserRequest = '';
  // A15: bumped by reset()/Clear Data (and dispose()) so any `ingestFiles()`
  // call already IN FLIGHT when the session was reset can tell, once its own
  // async parsing finally finishes, that it's no longer the current session
  // — and discard its own results instead of unconditionally re-inserting a
  // stale upload into a `files` Map the user just explicitly emptied. See
  // `ingestFiles()`'s own doc comment for the exact reproduced gap this
  // closes.
  private sessionEpoch = 0;
  // Workspace-relative paths of whichever "Custom Instructions" checkboxes
  // are currently checked in Agentic Mode's OWN "Custom Instructions & RAG
  // Data" segment (agenticModeSidebarView.ts/media/agenticMode.js) — its
  // own independent selection, never shared with Standard mode's
  // ObjectSpyPanel.selectedInstructionFiles. Starts empty (nothing
  // checked), matching Standard mode's own default.
  private selectedInstructionFiles: string[] = [];
  private lastReceivedTokens = 0;
  private tokenEstimateSeq = 0;
  // The last CSV file this session actually wrote — "View Manual Test
  // Cases in CSV" reopens exactly this file rather than regenerating (see
  // generateTestCaseCsv()). undefined until the first successful CSV
  // generation, and reset to undefined by reset()/Clear Data.
  private lastCsvUri: vscode.Uri | undefined;

  // Fresh, independent panel instances — see class doc comment. Regenerate
  // simply re-runs the same action; Agentic Mode's own generation actions
  // are idempotent given the same ingested files/config/request, so both
  // panels' "Regenerate" reruns the matching generate*() method below.
  private readonly aiCodePanel: AiCodePanel;
  private readonly generatedFeaturePanel: GeneratedFeaturePanel;

  private codeCancellation: vscode.CancellationTokenSource | undefined;
  private featureCancellation: vscode.CancellationTokenSource | undefined;
  private csvCancellation: vscode.CancellationTokenSource | undefined;
  // Item 4: deliberately its OWN field, never shared with codeCancellation —
  // see verifyAndFixAgenticCode()'s own doc comment for why.
  private verifyCancellation: vscode.CancellationTokenSource | undefined;

  /** F02: `generateAutomationCode()` and `verifyAndFixAgenticCode()` have
   * independent CANCELLATION (correctly — cancelling one must never cancel
   * the other's own in-flight work), but they write the SAME `aiCodePanel`.
   * This tracks which operation currently has the right to actually commit
   * to it (`finish()`/a final `setVerifyStatus()`/re-enabling the Verify
   * button) — set the moment EITHER operation starts, so starting one
   * immediately supersedes the other's own eventual commit, without
   * touching the other's unrelated cancellation token. See
   * `isCurrentOperation()`'s own doc comment for the full ownership
   * contract this and the per-kind cancellation fields together form. */
  private aiCodePanelOwner: vscode.CancellationTokenSource | undefined;

  /** F02: a simple monotonic counter giving every `verifyAndFixAgenticCode()`
   * invocation its OWN scratch subdirectory — so two overlapping verify
   * runs (e.g. a fast double-click, or a stale run still finishing after a
   * new one started) can never share/corrupt each other's build
   * artifacts, unlike sharing one fixed `.../agentic/<mode>/<language>`
   * path across every invocation. */
  private verifyOperationSeq = 0;

  /** Same role as ObjectSpyPanel.MAX_VERIFY_ATTEMPTS — a hard cap on how
   * many times Agentic Mode's own "Verify & Fix Code" actually EXECUTES
   * the candidate code. */
  private static readonly MAX_VERIFY_ATTEMPTS = 5;

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly settingsStore: SettingsStore,
    private readonly getSidebarWebview: () => vscode.Webview | undefined,
    private readonly outputChannel: vscode.OutputChannel
  ) {
    // The panel's OWN "Regenerate" button must always force a fresh
    // generation — `true` bypasses the "already have content, just show
    // it" short-circuit generateAutomationCode()/generateFeatureFile()
    // apply for the SIDEBAR's own Start/View button (see their own doc
    // comments below). Without this, clicking Regenerate on already-open
    // content would silently do nothing, since content already exists.
    this.aiCodePanel = new AiCodePanel(context, () => void this.generateAutomationCode(true), () => void this.verifyAndFixAgenticCode(), 'Agentic Mode — AI Generated Code');
    this.generatedFeaturePanel = new GeneratedFeaturePanel(context, () => void this.generateFeatureFile(true), 'Agentic Mode — Generated Feature File');
  }

  dispose(): void {
    this.sessionEpoch++; // A15 — see ingestFiles()'s own doc comment
    this.codeCancellation?.cancel();
    this.codeCancellation?.dispose();
    this.featureCancellation?.cancel();
    this.featureCancellation?.dispose();
    this.csvCancellation?.cancel();
    this.csvCancellation?.dispose();
    this.verifyCancellation?.cancel();
    this.verifyCancellation?.dispose();
    this.aiCodePanelOwner = undefined;
    this.aiCodePanel.dispose();
    this.generatedFeaturePanel.dispose();
  }

  /**
   * "Clear Data" (Agentic Mode's own sidebar button) AND the reset that
   * runs automatically when Total Agentic Mode is turned off — the exact
   * same "start completely over" guarantee Standard mode's own Clear Data/
   * Kill All Browsers give: every ingested file's raw AND parsed content,
   * every per-file ingestion config, the checked custom-instruction
   * selection, the accumulated chat-box request, any in-flight generation,
   * both owned result panels' content, and the Token Monitoring estimate
   * are all wiped — nothing from this batch of files can leak into the
   * next one. Mirrors ObjectSpyPanel.clearSharedLlmContext() scope-for-scope.
   */
  reset(): void {
    this.sessionEpoch++; // A15 — see ingestFiles()'s own doc comment
    this.codeCancellation?.cancel();
    this.codeCancellation?.dispose();
    this.codeCancellation = undefined;
    this.featureCancellation?.cancel();
    this.featureCancellation?.dispose();
    this.featureCancellation = undefined;
    this.csvCancellation?.cancel();
    this.csvCancellation?.dispose();
    this.csvCancellation = undefined;
    this.verifyCancellation?.cancel();
    this.verifyCancellation?.dispose();
    this.verifyCancellation = undefined;
    this.aiCodePanelOwner = undefined;

    // Dropping every reference to the Map's own AgenticIngestedFile entries
    // (raw text AND any parsedXlsx/parsedDocx/parsedPdf structure) is what
    // actually frees the in-memory content — clear() removes the only
    // handles this controller was holding, so it becomes eligible for
    // garbage collection immediately, not just logically "forgotten".
    this.files.clear();
    this.lastUserRequest = '';
    this.selectedInstructionFiles = [];

    this.aiCodePanel.clear();
    this.generatedFeaturePanel.clear();
    this.lastCsvUri = undefined;
    // Flips "View Manual Test Cases in CSV"/"View AI Feature File
    // Generation"/"View AI Code Generation" back to their original
    // Generate/Start labels now that there's nothing left to view.
    this.postGenerationState();

    this.lastReceivedTokens = 0;
    this.tokenEstimateSeq++; // discard any in-flight estimate for the context just wiped
    this.getSidebarWebview()?.postMessage({ type: 'tokenEstimate', payload: { available: false, reason: 'Cleared — nothing to estimate yet.' } });

    this.postFileList();
    // Re-scanning also re-renders the sidebar's Custom Instructions
    // checkboxes from scratch (unchecked by default) — the only way to
    // clear THEIR visual state too, since the sidebar only re-renders that
    // list from a fresh 'agentic:promptFiles' message, never on its own.
    void this.refreshInstructionFiles();
  }

  // A13: "is this request still current?" (isStaleRequest()) now lives in
  // its own pure, directly-unit-tested module — see agenticRequestEpoch.ts
  // for the full reasoning on why this must be checked explicitly, every
  // time, immediately before any output/file/UI side effect, rather than
  // assumed from whether `chain.invoke()` itself threw.

  /** F01/F08: the generalized "is THIS specific operation still the one
   * that owns `field`?" check — used everywhere a `generate*()`/
   * `verifyAndFixAgenticCode()` method needs to decide, after an `await`,
   * whether it's still safe to commit a side effect (UI update, file
   * write, token count). Three independent signals, ALL required:
   * (1) `this[field] === cts` — a NEWER operation of the SAME kind hasn't
   * superseded this one (the existing `isStaleRequest()`-style identity
   * check every `generate*()` method already used); (2) `this.sessionEpoch
   * === epoch` — `reset()`/`dispose()` hasn't run since this operation's
   * own epoch was captured, even if (as `verifyAndFixAgenticCode()` used
   * to allow, F01) that happened BEFORE this operation ever got around to
   * assigning `this[field]` in the first place — a stale operation from a
   * cleared session must never be mistaken for current just because
   * nothing else has started since; (3) the token itself isn't already
   * cancelled — matches every existing A13 check's own belt-and-suspenders
   * reasoning (a provider can resolve successfully even after
   * cancellation was requested). Callers MUST capture `epoch =
   * this.sessionEpoch` and create+assign `cts` to `field` SYNCHRONOUSLY,
   * before their first `await` — capturing either one late reopens
   * exactly the gap this exists to close. */
  private isCurrentOperation(
    field: 'featureCancellation' | 'codeCancellation' | 'csvCancellation' | 'verifyCancellation',
    cts: vscode.CancellationTokenSource,
    epoch: number
  ): boolean {
    return this[field] === cts && this.sessionEpoch === epoch && !cts.token.isCancellationRequested;
  }

  /** F02: whether `cts` currently owns the SHARED `aiCodePanel` — see
   * `aiCodePanelOwner`'s own doc comment. Checked in addition to (never
   * instead of) `isCurrentOperation()` for that operation's OWN
   * cancellation field, immediately before any `aiCodePanel` mutation. */
  private ownsAiCodePanel(cts: vscode.CancellationTokenSource): boolean {
    return this.aiCodePanelOwner === cts;
  }

  // ------------------------------------------------------------------
  // Ingestion
  // ------------------------------------------------------------------

  /** `uploads` are base64-encoded exactly as read by the webview's
   * `FileReader.readAsArrayBuffer` + base64 encoder (same mechanism the RAG
   * zip drop zone already uses — see settingsPanel.ts) — the sidebar
   * webview has no Node `Buffer`/text-decoding of its own, so decoding
   * happens here in the extension host. Async because xlsx/docx/pdf
   * parsing (exceljs/mammoth/pdfjs-dist) genuinely is — every file in the
   * batch is parsed in parallel via `Promise.all`, so one large PDF
   * doesn't serialize behind the others.
   *
   * A15: `sessionEpoch` is captured BEFORE any of that async parsing
   * starts, and re-checked immediately after `Promise.all()` resolves,
   * before this batch's results are inserted into `this.files` or any
   * side effect (`postFileList()`/`estimateTokens()`) runs. The reproduced
   * gap this closes: start an upload, call `reset()`/Clear Data WHILE
   * parsing is still in flight (a real xlsx/docx/pdf parse genuinely takes
   * time), then let the parse finish — the OLD code unconditionally
   * inserted the (now stale) parsed files into `this.files` regardless,
   * silently repopulating state the user had JUST explicitly emptied, and
   * broadcast a file-list/token update for a batch that no longer belongs
   * to the current session. `reset()`/`dispose()` both bump `sessionEpoch`
   * — a mismatch here means EXACTLY that happened, and the whole batch
   * (not just some of it) is discarded silently: no `files.set()`, no
   * `postFileList()`/`estimateTokens()`, and an honestly empty result
   * (never a stale "accepted"/"rejected" list a caller might act on, e.g.
   * objectSpyPanel.ts's own "open the Ingestion Configuration panel when
   * something was accepted" — nothing here should still be considered
   * accepted). A LEGITIMATE, still-current upload is completely
   * unaffected — this only ever discards a batch whose OWN session has
   * already ended. */
  async ingestFiles(uploads: { fileName: string; base64: string }[]): Promise<AgenticIngestResult> {
    const epoch = this.sessionEpoch;
    const accepted: AgenticFileMeta[] = [];
    const rejected: { fileName: string; reason: string }[] = [];

    const results = await Promise.all(
      uploads.map(async (upload) => {
        const ext = path.extname(upload.fileName).toLowerCase();
        const legacyReason = AGENTIC_LEGACY_UNSUPPORTED_EXTENSIONS[ext];
        if (legacyReason) {
          return { ok: false as const, fileName: upload.fileName, reason: legacyReason };
        }

        let buffer: Buffer;
        try {
          buffer = Buffer.from(upload.base64, 'base64');
        } catch {
          return { ok: false as const, fileName: upload.fileName, reason: 'Could not decode the uploaded file.' };
        }
        if (buffer.byteLength > AGENTIC_MAX_RAW_FILE_BYTES) {
          return { ok: false as const, fileName: upload.fileName, reason: `Larger than ${AGENTIC_MAX_RAW_FILE_BYTES / (1024 * 1024)} MB.` };
        }

        const kind = detectAgenticFileKind(upload.fileName);
        try {
          const file = await this.buildIngestedFile(upload.fileName, kind, buffer);
          return { ok: true as const, file };
        } catch (err) {
          // A real parse failure (corrupt/password-protected file, an
          // .xlsx/.docx/.pdf that isn't actually valid despite its
          // extension, ...) — rejected with the library's own message
          // rather than silently producing an empty/garbled file.
          return {
            ok: false as const,
            fileName: upload.fileName,
            reason: `Could not read this ${kind.toUpperCase()} file: ${err instanceof Error ? err.message : String(err)}`
          };
        }
      })
    );

    // A15: checked HERE — after every file finished parsing, before ANY of
    // it is inserted or reported. See this method's own doc comment.
    if (epoch !== this.sessionEpoch) {
      return { accepted: [], rejected: [] };
    }

    for (const result of results) {
      if (result.ok) {
        this.files.set(result.file.id, result.file);
        accepted.push(this.toMeta(result.file));
      } else {
        rejected.push({ fileName: result.fileName, reason: result.reason });
      }
    }

    this.postFileList();
    void this.estimateTokens();
    return { accepted, rejected };
  }

  /** Builds the full `AgenticIngestedFile` for one successfully-decoded
   * upload — the one place that dispatches to the right parser
   * (xlsxIngestion.ts/docxIngestion.ts/pdfIngestion.ts, or a plain UTF-8
   * decode for the text-like kinds) and builds that kind's preview. Throws
   * on a genuine parse failure — the caller (ingestFiles()) turns that into
   * a rejection with the library's own error message. */
  private async buildIngestedFile(fileName: string, kind: AgenticFileKind, buffer: Buffer): Promise<AgenticIngestedFile> {
    const id = String(this.nextFileId++);
    const base = { id, fileName, kind, sizeBytes: buffer.byteLength, rawText: '', config: {} };

    if (kind === 'xlsx') {
      const parsedXlsx = await parseXlsxBuffer(buffer);
      return { ...base, parsedXlsx, xlsxPreview: buildXlsxPreview(parsedXlsx) };
    }
    if (kind === 'docx') {
      const parsedDocx = await parseDocxBuffer(buffer);
      return { ...base, parsedDocx, docxPreview: buildDocxPreview(parsedDocx) };
    }
    if (kind === 'pdf') {
      const parsedPdf = await parsePdfBuffer(buffer);
      return { ...base, parsedPdf, pdfPreview: buildPdfPreview(parsedPdf) };
    }

    const rawText = buffer.toString('utf-8');
    return { ...base, rawText, csvPreview: kind === 'csv' ? buildCsvPreview(rawText) : undefined };
  }

  removeFile(id: string): void {
    this.files.delete(id);
    this.postFileList();
    void this.estimateTokens();
  }

  updateConfig(id: string, config: AgenticIngestionConfig): void {
    const file = this.files.get(id);
    if (!file) {
      return;
    }
    file.config = config;
    void this.estimateTokens();
  }

  updateDraftUserRequest(text: string): void {
    this.lastUserRequest = text;
    void this.estimateTokens();
  }

  private toMeta(file: AgenticIngestedFile): AgenticFileMeta {
    return {
      id: file.id,
      fileName: file.fileName,
      kind: file.kind,
      sizeBytes: file.sizeBytes,
      csvPreview: file.csvPreview
    };
  }

  /** Public so ObjectSpyPanel can re-sync the sidebar's file-count display
   * after a fresh `resolveWebviewView()` (VS Code recreates the webview's
   * content when the sidebar is hidden/shown again, same as every other
   * piece of state Standard mode already re-syncs on resolve) — the
   * controller's own in-memory file map survives that; only the webview
   * handle needs telling about it again. */
  postFileList(): void {
    this.getSidebarWebview()?.postMessage({
      type: 'agentic:fileList',
      payload: Array.from(this.files.values()).map((f) => this.toMeta(f))
    });
  }

  /** Exposed for agenticIngestionPanel.ts, which needs the full ingested
   * file (raw text included) to render an accurate preview alongside its
   * config controls — never sent to the sidebar's own webview, which only
   * ever needs the lightweight metadata (`postFileList()` above). */
  getFiles(): AgenticIngestedFile[] {
    return Array.from(this.files.values());
  }

  /** Tells the sidebar whether each of the three "Generate"/"Start" buttons
   * should read as "View ..." instead — i.e. whether that output already
   * exists in memory (or, for CSV, was already written to disk this
   * session) and a click should just SHOW it rather than run a fresh
   * generation. Called after every successful generation, after
   * `reset()`/Clear Data (flips every button back to its original label),
   * and once on the sidebar's own 'agentic:ready' so a freshly (re-)loaded
   * webview immediately shows the correct labels rather than defaulting to
   * "Generate"/"Start" for output that's actually still sitting in memory. */
  postGenerationState(): void {
    this.getSidebarWebview()?.postMessage({
      type: 'agentic:generationState',
      payload: {
        hasFeatureFile: this.generatedFeaturePanel.hasContent(),
        hasCode: this.aiCodePanel.hasCode(),
        hasCsv: this.lastCsvUri !== undefined
      }
    });
  }

  // ------------------------------------------------------------------
  // Shared context assembly
  // ------------------------------------------------------------------

  /**
   * Every currently ingested file contributes — this loop never skips a
   * file, filters by kind, or caps how MANY files go in; the only per-file
   * limit is `AGENTIC_MAX_SEGMENT_CHARS` (60,000 chars — see
   * agenticTypes.ts) as a last-resort safety net against one pathological
   * file (an unconfigured multi-thousand-row spreadsheet, a huge PDF)
   * blowing out the whole request on its own.
   *
   * `audit`, when true, logs a line PER FILE to the Output channel — real
   * character counts, not a claim: how large the file's selected segment
   * is, whether the safety cap actually cut it, and the running total — so
   * "did my file's content actually make it into the prompt, in full or
   * truncated" is something you can verify directly in the SoftPlay Output
   * channel, not something you have to take on trust. Deliberately opt-in
   * (only the three generate*() methods below pass `true`) — this method
   * is ALSO called by `estimateTokens()` on essentially every keystroke/
   * config change (Token Monitoring), where logging unconditionally would
   * flood the Output channel with noise for zero benefit.
   */
  private buildIngestedContext(audit = false): string {
    if (this.files.size === 0) {
      if (audit) {
        this.outputChannel.appendLine('Agentic Mode — context audit: no files ingested; sending custom instructions/RAG/chat-box content only.');
      }
      return '(No input files have been ingested yet.)';
    }
    const parts: string[] = [];
    let totalChars = 0;
    if (audit) {
      this.outputChannel.appendLine(`Agentic Mode — context audit: assembling ${this.files.size} file(s) for this generation.`);
    }
    for (const file of this.files.values()) {
      const segment = extractSegmentForFile(file);
      totalChars += segment.text.length;
      if (audit) {
        this.outputChannel.appendLine(
          `  - ${file.fileName} (${file.kind}): ${segment.text.length.toLocaleString()} char(s) included` +
            (segment.truncated
              ? ` — TRUNCATED at the ${AGENTIC_MAX_SEGMENT_CHARS.toLocaleString()}-char safety cap; narrow this file's range in Ingestion Configuration to fit more of it.`
              : ' (full selection, not truncated).')
        );
      }
      parts.push(`### File: ${file.fileName}${segment.truncated ? ' (truncated to the size cap)' : ''}\n${segment.text}`);
    }
    if (audit) {
      this.outputChannel.appendLine(`Agentic Mode — context audit: ${totalChars.toLocaleString()} total char(s) of file content included in this request.`);
    }
    return parts.join('\n\n');
  }

  setSelectedInstructionFiles(files: string[]): void {
    this.selectedInstructionFiles = files;
    void this.estimateTokens();
  }

  /** Re-scans `.github/*.md` (Custom Instructions — checkbox list) and
   * `.github/rag/*.md` (RAG Data — read-only list) and pushes both to the
   * sidebar, exactly mirroring ObjectSpyPanel.refreshPromptFiles()'s own
   * two queries/exclusion glob (including the `.github/rag-drafts/**`
   * exclusion — see that method's own doc comment on why a rejected,
   * quarantined draft must never be selectable here) for Standard mode.
   * Called on Agentic Mode's own "Refresh file list" click and once
   * automatically when the sidebar (re-)loads, so the lists are populated
   * without an extra manual step. */
  async refreshInstructionFiles(): Promise<void> {
    const excludedRagFolders = `{.github/rag/**,${RAG_DRAFTS_FOLDER_SEGMENTS.join('/')}/**}`;
    const [instructionFiles, ragFiles] = await Promise.all([
      vscode.workspace.findFiles('.github/**/*.md', excludedRagFolders),
      vscode.workspace.findFiles('.github/rag/**/*.md')
    ]);
    const relPaths = instructionFiles.map((f) => vscode.workspace.asRelativePath(f)).sort();
    // F16 — see ObjectSpyPanel.refreshPromptFiles()'s own doc comment: only
    // list a RAG file here if it will actually be indexed, never a
    // visible-library/empty-index mismatch a user has no way to notice.
    const indexed: string[] = [];
    for (const uri of ragFiles) {
      const relPath = vscode.workspace.asRelativePath(uri);
      try {
        const bytes = await vscode.workspace.fs.readFile(uri);
        const parsed = parseRagFile(new TextDecoder('utf-8').decode(bytes));
        if (parsed.ok) {
          indexed.push(relPath);
        } else {
          this.outputChannel.appendLine(`Agentic Mode RAG: "${relPath}" was found under .github/rag/ but is NOT indexed (${parsed.error}) — it will never be retrieved.`);
        }
      } catch (err) {
        this.outputChannel.appendLine(`Agentic Mode RAG: "${relPath}" could not be read (${err instanceof Error ? err.message : String(err)}) — it will never be retrieved.`);
      }
    }
    this.getSidebarWebview()?.postMessage({ type: 'agentic:promptFiles', payload: relPaths });
    this.getSidebarWebview()?.postMessage({ type: 'agentic:ragFiles', payload: indexed.sort() });
  }

  /** Only the CHECKED `.github/*.md` files (`selectedInstructionFiles`,
   * set via `setSelectedInstructionFiles()`) — Agentic Mode's own "Custom
   * Instructions" checkbox list works exactly like Standard mode's
   * (nothing selected by default; the user opts specific files in),
   * rather than silently including every instruction file that exists.
   * Reviewed rather than unit tested (pure vscode.workspace.fs glue,
   * mirroring objectSpyPanel.ts's own readInstructionFiles()). */
  private async readSelectedCustomInstructionFiles(): Promise<string> {
    if (!vscode.workspace.workspaceFolders?.length || this.selectedInstructionFiles.length === 0) {
      return '';
    }
    const workspaceRoot = vscode.workspace.workspaceFolders[0].uri;
    const contents = await Promise.all(
      this.selectedInstructionFiles.map(async (relPath) => {
        try {
          const uri = vscode.Uri.joinPath(workspaceRoot, relPath);
          const content = await readWorkspaceFileCached(uri);
          return `### ${relPath}\n${content}`;
        } catch {
          // Skip a file that vanished/moved between listing and sending.
          return '';
        }
      })
    );
    return contents.filter(Boolean).join('\n\n');
  }

  /** Per-file character budget when building the RAG retrieval QUERY
   * specifically — distinct from `buildIngestedContext()` above, which
   * always includes every file's FULL selected segment in the actual
   * generation prompt regardless. Blindly slicing the fully-concatenated
   * `lastUserRequest + ingestedContext` string to a flat total (this used
   * to be `.slice(0, 4000)`) means whichever files happened to be
   * ingested/iterated FIRST consumed the entire budget, and any file after
   * that point contributed ZERO retrieval signal at all — a helper only
   * relevant to a LATER file's own requirements could never be found by
   * RAG, even though that file's full content still reaches the real
   * generation prompt untouched. A fixed, modest budget PER CHUNK instead
   * guarantees every ingested file contributes SOME query signal regardless
   * of how many files there are or what order they were added in. Modest
   * on purpose — this is retrieval signal, not the actual content sent to
   * the model, so a bounded excerpt is enough; the local, zero-cost TF-IDF
   * embedding (see rag/tfidfEmbeddings.ts) has no reason to need more per
   * individual chunk. */
  private static readonly RAG_QUERY_CHARS_PER_FILE = 600;

  /** Caps how many operations ONE file's segment can contribute (F13) —
   * `chunkTextForOperations()` adaptively grows chunk size to stay within
   * this, so a single very large ingested file (up to
   * `AGENTIC_MAX_SEGMENT_CHARS` = 60,000 chars) still produces FULL
   * coverage of its own content, in a bounded number of retrieval
   * operations, rather than either (a) the pre-F13 bug — one operation
   * covering only the first `RAG_QUERY_CHARS_PER_FILE` characters, losing
   * everything after that entirely — or (b) an unbounded number of
   * operations (a naive one-chunk-per-600-chars split of a 60,000-char
   * file would be 100 operations on its own) that would dominate coverage-
   * ordering and packing with one file's worth of chunks. */
  private static readonly MAX_RAG_CHUNKS_PER_FILE = 12;

  /** Decomposes the CURRENT ingested files + free-text request into
   * independently-retrievable operations (rag/ragOperationPlanner.ts,
   * Phase 3) — one operation for the user's own explicit request, plus one
   * or more operations PER ingested file, covering that file's ENTIRE
   * selected segment (F13 fix) via `chunkTextForOperations()` rather than
   * only its first `RAG_QUERY_CHARS_PER_FILE` characters (the bug this
   * replaces: a distinctive requirement mentioned only near the end of a
   * long ingested document previously never influenced RAG retrieval at
   * all, even though the model itself received that file's FULL content
   * for actual generation — see `buildIngestedContext()`). Per-operation
   * retrieval on top of that removes the further "only 2 matches total, no
   * matter how many distinct files/needs" ceiling a single whole-query
   * retrieval call used to impose. */
  private buildOperationPlan() {
    const fileSegments = Array.from(this.files.values()).flatMap((file) => {
      const fullText = extractSegmentForFile(file).text;
      const chunks = chunkTextForOperations(fullText, AgenticModeController.RAG_QUERY_CHARS_PER_FILE, AgenticModeController.MAX_RAG_CHUNKS_PER_FILE);
      return chunks.map((text, i) => ({ fileName: chunks.length > 1 ? `${file.fileName} (part ${i + 1}/${chunks.length})` : file.fileName, text }));
    });
    return planOperationsFromAgenticSegments(this.lastUserRequest, fileSegments);
  }

  /** Item 2 (dedupe): builds ITS OWN operation plan (from ingested-file
   * segments — the one genuinely different piece between Standard and
   * Agentic mode) and hands off to rag/ragPackingPipeline.ts's
   * `packRagSection()` for everything after that (retrieve per operation,
   * exclude known-stale recipes, pack against the real token budget,
   * format) — the exact same pipeline `objectSpyPanel.ts`'s own
   * `buildRagSection()` now also calls, instead of each maintaining an
   * independent copy of this logic (previously duplicated here almost
   * verbatim, per this method's own since-removed doc comment). */
  private async buildRagSection(
    settings: ObjectSpySettings,
    mandatoryTokens: number | undefined,
    model?: vscode.LanguageModelChat,
    cancellationToken?: vscode.CancellationToken
  ): Promise<string> {
    if (!settings.ragEnabled) {
      return '';
    }
    const plan = this.buildOperationPlan();
    const { section } = await packRagSection(plan, {
      extensionContext: this.context,
      settings,
      mandatoryTokens,
      model,
      cancellationToken,
      logPrefix: 'Agentic Mode RAG',
      onLog: (message) => this.outputChannel.appendLine(message)
    });
    return section;
  }

  private readSeniorQeInstructions(): string {
    return readFileCachedSync(path.join(__dirname, '..', '..', 'prompts', 'senior-qe-instructions.md'));
  }

  private readApiAutomationInstructions(): string {
    return readFileCachedSync(path.join(__dirname, '..', '..', 'prompts', 'api-automation-instructions.md'));
  }

  /** `.github/Jira_test_case_template.md` — copied from this extension's
   * own shipped default (prompts/Jira_test_case_template.md) into the
   * workspace the first time it's needed, exactly like `.github/rag/`
   * being auto-created for RAG (ragCorpusGenerator.ts) — so it's a real,
   * git-trackable, user-editable file from the very first generation
   * rather than something only this extension's binary knows about. */
  private async readOrScaffoldJiraTemplate(workspaceRoot: vscode.Uri): Promise<string> {
    const templateUri = vscode.Uri.joinPath(workspaceRoot, ...JIRA_TEMPLATE_RELATIVE_PATH);
    try {
      const bytes = await vscode.workspace.fs.readFile(templateUri);
      return new TextDecoder('utf-8').decode(bytes);
    } catch {
      const defaultContent = readFileCachedSync(path.join(__dirname, '..', '..', 'prompts', 'Jira_test_case_template.md'));
      try {
        await vscode.workspace.fs.writeFile(templateUri, new TextEncoder().encode(defaultContent));
        this.outputChannel.appendLine(`Agentic Mode: created ${templateUri.fsPath} from the built-in default template.`);
      } catch (err) {
        this.outputChannel.appendLine(`Agentic Mode: could not create ${templateUri.fsPath}: ${err instanceof Error ? err.message : String(err)}`);
      }
      return defaultContent;
    }
  }

  /** F07/F06: the team's own REAL example CSV, if they dropped one at
   * `.github/Jira_test_case_template.csv` — grounds both the prompt
   * (see `buildCsvTemplateExampleSection()`) and the response validation
   * (`generateTestCaseCsv()`'s call to `normalizeTestCaseCsvResponse()`)
   * in the team's actual Jira import shape, rather than only the free-text
   * column spec in the MD instructions file. Deliberately NEVER
   * auto-scaffolded like the MD file is — a fabricated example CSV with
   * made-up data would actively mislead the model, so this is either
   * genuinely present (a real file the team maintains) or absent.
   *
   * F07: a THREE-way result — `'absent'` (no workspace, or the file
   * genuinely doesn't exist — the common, unconfigured case, zero
   * behavior change) is now distinguished from `'invalid'` (the file
   * EXISTS but fails to parse, or its header is empty/has duplicate
   * column names) — previously both collapsed into the same `undefined`,
   * so a team with a genuinely broken template silently got treated as if
   * they had none at all, with no indication anything was wrong. */
  private async readCsvTemplateExample(): Promise<CsvTemplateReadResult> {
    const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri;
    if (!workspaceRoot) {
      return { status: 'absent' };
    }
    const uri = vscode.Uri.joinPath(workspaceRoot, ...CSV_TEMPLATE_RELATIVE_PATH);
    let bytes: Uint8Array;
    try {
      bytes = await vscode.workspace.fs.readFile(uri);
    } catch {
      return { status: 'absent' }; // doesn't exist — the normal, unconfigured case
    }
    let rows: string[][];
    try {
      rows = parseCsvStrict(new TextDecoder('utf-8').decode(bytes)).filter((row) => row.some((cell) => cell.trim().length > 0));
    } catch (err) {
      return { status: 'invalid', reason: err instanceof MalformedCsvError ? err.message : String(err) };
    }
    if (rows.length === 0) {
      return { status: 'invalid', reason: 'The file has no parseable rows at all.' };
    }
    const [header, ...exampleRows] = rows;
    if (header.every((cell) => cell.trim().length === 0)) {
      return { status: 'invalid', reason: 'The file\'s header row is empty.' };
    }
    const seen = new Set<string>();
    for (const cell of header) {
      const trimmed = cell.trim();
      if (!trimmed) {
        return { status: 'invalid', reason: 'The header row has one or more empty column names.' };
      }
      if (seen.has(trimmed)) {
        return { status: 'invalid', reason: `The header row has a duplicate column name: "${trimmed}".` };
      }
      seen.add(trimmed);
    }
    return { status: 'ok', header, exampleRows };
  }

  /** At most 2 example rows verbatim — a concrete few-shot pattern for
   * realistic value density/formatting is the point, not reproducing the
   * whole file; capped by ROW COUNT rather than `agenticExtractionUtils.ts`'s
   * `capSegment()` (that helper's 60,000-char budget is sized for a whole
   * ingested source FILE, a completely different scale than a couple of
   * short template rows). */
  private buildCsvTemplateExampleSection(template: { header: string[]; exampleRows: string[][] }): string {
    const sample = stringifyCsv([template.header, ...template.exampleRows.slice(0, 2)]).trimEnd();
    return (
      `\n## Real example CSV template (from .github/Jira_test_case_template.csv) — your output MUST use EXACTLY ` +
      `these ${template.header.length} column(s), in this exact order and with this exact header row. Study the ` +
      `example row(s) below for realistic value density/formatting — every generated data row must be as fully ` +
      `populated as they are; never leave a cell blank unless a column is genuinely inapplicable to that step.\n` +
      `\`\`\`csv\n${sample}\n\`\`\``
    );
  }

  private async buildSystemInstructions(settings: ObjectSpySettings, ragSection: string, includeCsvTemplate: boolean, userRequest: string): Promise<string> {
    const parts: string[] = [];
    if (includeCsvTemplate) {
      const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri;
      parts.push(workspaceRoot ? await this.readOrScaffoldJiraTemplate(workspaceRoot) : readFileCachedSync(path.join(__dirname, '..', '..', 'prompts', 'Jira_test_case_template.md')));
      const csvTemplateExample = await this.readCsvTemplateExample();
      if (csvTemplateExample.status === 'ok') {
        parts.push(this.buildCsvTemplateExampleSection(csvTemplateExample));
      } else if (csvTemplateExample.status === 'invalid') {
        // F07: surfaced here too (not just at validation time) — the
        // model should know its own grounding is missing, and the user
        // sees this in the Output channel even before a response comes
        // back, rather than only learning about it from a later error.
        this.outputChannel.appendLine(`Agentic Mode: .github/Jira_test_case_template.csv exists but could not be used — ${csvTemplateExample.reason}`);
      }
    } else {
      const isApiMode = settings.automationMode === 'api';
      parts.push(isApiMode ? this.readApiAutomationInstructions() : this.readSeniorQeInstructions());
      parts.push(`Target language: ${settings.language} (version ${settings.languageVersion}).`);
    }
    const customInstructions = await this.readSelectedCustomInstructionFiles();
    if (customInstructions) {
      parts.push('## Team custom instructions / skills / prompt files\n' + customInstructions);
    }
    // Database testing intent: only ever driven by the "Instant
    // instructions to LLM" chat box text (userRequest), per the explicit
    // ask — a deterministic keyword/regex check
    // (llm/databaseTestingInstructions.ts), never an extra LLM call.
    // Reuses withDatabaseTestingInstructions()'s own file-read/caching
    // against an empty array purely to get the bundled file's content when
    // it applies, so the file path/caching logic lives in exactly one
    // place shared with Standard mode.
    const databaseTestingSection = withDatabaseTestingInstructions<{ path: string; content: string }>([], userRequest);
    if (databaseTestingSection.length > 0) {
      parts.push('## Database testing instructions\n' + databaseTestingSection[0].content);
    }
    if (ragSection) {
      parts.push(ragSection);
    }
    return parts.join('\n\n');
  }

  // ------------------------------------------------------------------
  // Token Monitoring — reuses the SAME `tokenEstimate` message shape/UI
  // Standard mode's Token Monitoring already renders (media/main.js's
  // applyTokenEstimate()); Agentic Mode's own sidebar script
  // (media/agenticMode.js) renders it with a small dedicated copy of that
  // same rendering logic, kept deliberately separate per this feature's
  // "proper segregation" requirement rather than sharing main.js's DOM
  // wiring across two very different sidebar layouts.
  // ------------------------------------------------------------------

  async estimateTokens(): Promise<void> {
    const settings = this.settingsStore.get();
    const seq = ++this.tokenEstimateSeq;
    if (!settings.copilotEnabled || !settings.copilotModelId) {
      this.getSidebarWebview()?.postMessage({
        type: 'tokenEstimate',
        payload: { available: false, reason: 'Enable "Link with GitHub Copilot LLM" (Control Panel, Standard mode) and pick a model in Settings to see token usage.' }
      });
      return;
    }

    // Resolve ONE model and reuse it for every measurement below (F12) —
    // the old code called countModelTokens() by model id string twice,
    // each independently re-resolving via findModel() internally.
    const model = await findModel(settings.copilotModelId);
    if (!model) {
      this.getSidebarWebview()?.postMessage({
        type: 'tokenEstimate',
        payload: { available: false, reason: 'Could not reach the selected Copilot model to estimate tokens.' }
      });
      return;
    }

    const ingestedContext = this.buildIngestedContext();
    // Measure the MANDATORY (non-RAG) cost first, using the REAL final
    // two-message shape (F12) — see buildRagSection()'s own doc comment on
    // why packing needs this to know how much of the model's real context
    // window is actually left for RAG content.
    const mandatorySystemInstructions = await this.buildSystemInstructions(settings, '', false, this.lastUserRequest);
    const mandatoryTokens = await this.measureAgenticRequestTokens(model, mandatorySystemInstructions, ingestedContext, this.lastUserRequest);
    const ragSection = await this.buildRagSection(settings, mandatoryTokens, model);
    const systemInstructions = await this.buildSystemInstructions(settings, ragSection, false, this.lastUserRequest);

    const sentTokens = await this.measureAgenticRequestTokens(model, systemInstructions, ingestedContext, this.lastUserRequest);
    if (seq !== this.tokenEstimateSeq) {
      return; // a newer estimate has already superseded this one
    }
    if (sentTokens === undefined) {
      this.getSidebarWebview()?.postMessage({
        type: 'tokenEstimate',
        payload: { available: false, reason: 'Could not reach the selected Copilot model to estimate tokens.' }
      });
      return;
    }
    this.getSidebarWebview()?.postMessage({
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

  /** F08: `isCurrent`, when given, is re-checked AFTER `countModelTokens()`'s
   * own await — this method previously updated `this.lastReceivedTokens`/
   * broadcast a token estimate UNCONDITIONALLY once its count resolved, so
   * an old, already-superseded (or Clear-Data-cleared) operation's own
   * late-arriving count could silently overwrite what a NEWER operation
   * (or Clear Data's own "nothing to estimate yet" reset) had just shown.
   * Callers pass their own `isCurrentOperation(...)` result AT THE MOMENT
   * this resolves; omitted only by call sites with no operation identity
   * of their own to check against. */
  private async recordReceivedTokens(settings: ObjectSpySettings, text: string, isCurrent?: () => boolean): Promise<void> {
    const result = await countModelTokens(settings.copilotModelId, text);
    if (isCurrent && !isCurrent()) {
      return;
    }
    this.lastReceivedTokens = result?.count ?? 0;
    this.getSidebarWebview()?.postMessage({
      type: 'tokenEstimate',
      payload: { available: true, receivedTokens: this.lastReceivedTokens, sentTokens: null, maxInputTokens: result?.maxInputTokens, modelId: settings.copilotModelId }
    });
  }

  // ------------------------------------------------------------------
  // Generation actions
  // ------------------------------------------------------------------

  private async resolveModel(settings: ObjectSpySettings): Promise<vscode.LanguageModelChat> {
    if (!settings.copilotEnabled || !settings.copilotModelId) {
      throw new CopilotUnavailableError();
    }
    const model = await findModel(settings.copilotModelId);
    if (!model) {
      throw new CopilotUnavailableError();
    }
    return model;
  }

  // A14: the complete, immutable per-action shape (directive suffix,
  // whether to include the CSV template, the effective/fallback-
  // substituted user request) now lives in its own pure, directly-unit-
  // tested module — see agenticActionShape.ts for the full reasoning on
  // why this must be built ONCE and reused for both the mandatory-only
  // measurement pass and the actual chain.invoke() call.

  /** Measures a would-be agentic request's token cost using the SAME
   * message shape agenticChains.ts's `AGENTIC_PROMPT` actually sends at
   * request time — TWO SEPARATE messages (`systemInstructions`, then the
   * human turn's own literal wrapper text around `ingestedContext`/
   * `userRequest` — see `vscodeCopilotToolCallingModel.ts`'s
   * `toVSCodeMessage()`, which turns BOTH into separate `User`-role
   * `vscode.LanguageModelChatMessage`s), counted and SUMMED exactly like
   * `assertMessagesFitModel()` itself counts a real multi-message request
   * (F12 fix). Used for BOTH the "mandatory-only" pass (an empty/no-RAG
   * `systemInstructions`, to learn how much budget is left for RAG
   * content) and the FINAL pass (the real, RAG-included
   * `systemInstructions`, for the actual token estimate/preflight) — same
   * message shape either way, only `systemInstructions` differs.
   *
   * The OLD estimate concatenated all three pieces into ONE string with
   * plain "\n\n" joins — entirely omitting the human turn's own literal
   * wrapper text ("Ingested input files (already trimmed...)...", "---",
   * "The user's request:") and never reflecting that these are two
   * SEPARATE messages, not one — a real, reproducible undercount of what
   * actually gets sent. Reuses the ALREADY-resolved `model` handle (every
   * call site here resolves one up front) rather than a second,
   * potentially different, resolution by model id string.
   *
   * Returns `undefined` if either count fails, matching
   * `countModelTokens()`'s own "can't measure" convention — an unmeasured
   * mandatory cost is exactly what makes `buildRagSection()` fall back to
   * `formatRagPromptSection()`'s own character-based packing instead of
   * the real-token-budget path. */
  private async measureAgenticRequestTokens(model: vscode.LanguageModelChat, systemInstructions: string, ingestedContext: string, userRequest: string): Promise<number | undefined> {
    try {
      const humanTurnText = buildAgenticHumanTurnText(ingestedContext, userRequest);
      const [systemCount, humanCount] = await Promise.all([model.countTokens(systemInstructions), model.countTokens(humanTurnText)]);
      return systemCount + humanCount;
    } catch {
      return undefined;
    }
  }

  /** Item 1 (dedupe): the identical LLM-call sequence every `generate*()`
   * action below shares — resolve the model, build the ingested context,
   * build this action's own immutable shape (A14), measure the mandatory
   * (non-RAG) token cost, pack the RAG section against that budget, build
   * the final system instructions, and invoke the chain. Returns the
   * SETTINGS object it actually used alongside the result — not a fresh
   * `this.settingsStore.get()` — so a caller's own post-generation step
   * (`recordReceivedTokens()`) measures against the exact same model this
   * request was actually sent to, even if the user changed Settings while
   * this call's own `await`s were in flight.
   *
   * Deliberately stops HERE: committing the result (a panel's `.finish()`
   * vs. CSV's own file-write/webview-status sequence) stays in each
   * `generate*()` method below — those three tails are genuinely different
   * in kind, not just cosmetically, and folding them into this same method
   * would trade real duplication for a harder-to-read hooks/options
   * parameter. */
  private async runAgenticChain(
    kind: AgenticActionKind,
    cts: vscode.CancellationTokenSource,
    chainFactory: (model: VSCodeCopilotToolCallingModel) => Runnable<AgenticGenerationInput, string>
  ): Promise<{ result: string; settings: ObjectSpySettings }> {
    const settings = this.settingsStore.get();
    const chatModel = await this.resolveModel(settings);
    const ingestedContext = this.buildIngestedContext(true);
    // A14: the complete, immutable shape of this ONE action — computed
    // ONCE and reused for BOTH the mandatory-only measurement below AND
    // the actual chain.invoke() call — see buildAgenticActionShape()'s own
    // doc comment for the exact bug this closes (measuring against a
    // SMALLER structure than what's actually sent).
    const shape = buildAgenticActionShape(kind, this.lastUserRequest, settings.language, settings.languageVersion);
    // Measure the MANDATORY (non-RAG) cost first, reusing the model
    // already resolved above — see buildRagSection()'s own doc comment.
    const mandatorySystemInstructions = (await this.buildSystemInstructions(settings, '', shape.includeCsvTemplate, shape.effectiveUserRequest)) + shape.directiveSuffix;
    const mandatoryTokens = await this.measureAgenticRequestTokens(chatModel, mandatorySystemInstructions, ingestedContext, shape.effectiveUserRequest);
    const ragSection = await this.buildRagSection(settings, mandatoryTokens, chatModel, cts.token);
    const systemInstructions = (await this.buildSystemInstructions(settings, ragSection, shape.includeCsvTemplate, shape.effectiveUserRequest)) + shape.directiveSuffix;
    const chainLabel: Record<AgenticActionKind, string> = { feature: 'feature-file', code: 'automation-code', csv: 'manual-test-case-CSV' };
    this.outputChannel.appendLine(`Agentic Mode — invoking the LangChain ${chainLabel[kind]} chain (ChatPromptTemplate -> Copilot -> StringOutputParser)...`);
    const chain = chainFactory(new VSCodeCopilotToolCallingModel(chatModel, cts.token));
    const result = await chain.invoke({ systemInstructions, ingestedContext, userRequest: shape.effectiveUserRequest });
    return { result, settings };
  }

  /** `forceRegenerate` — false (the default, used by the sidebar's own
   * "Start AI Feature File Generation"/"View AI Feature File Generation"
   * button) means: if a feature file is ALREADY sitting in memory from an
   * earlier click this session, just reveal it again (`.show()`, no new
   * LLM call, no re-run of anything) — the exact "reopen what I already
   * generated" behavior AiCodePanel/GeneratedFeaturePanel already support
   * (see GeneratedFeaturePanel.hasContent()'s own doc comment), just never
   * reached before because this method always regenerated unconditionally.
   * `true` (used ONLY by the panel's own internal "Regenerate" button —
   * see the constructor) bypasses that check to force a genuinely fresh
   * generation. */
  async generateFeatureFile(forceRegenerate = false): Promise<void> {
    if (!forceRegenerate && this.generatedFeaturePanel.hasContent()) {
      this.generatedFeaturePanel.show();
      return;
    }

    const epoch = this.sessionEpoch;
    this.featureCancellation?.cancel();
    this.featureCancellation?.dispose();
    const cts = new vscode.CancellationTokenSource();
    this.featureCancellation = cts;

    this.generatedFeaturePanel.show();
    this.generatedFeaturePanel.startGenerating();
    try {
      const { result, settings } = await this.runAgenticChain('feature', cts, buildAgenticFeatureFileChain);
      // A13: checked HERE — immediately before the FIRST output/UI side
      // effect this method commits — never assumed from whether
      // `chain.invoke()` itself threw (it may not have: see
      // agenticRequestEpoch.ts's own doc comment on why cancellation/reset
      // must not rely on the provider rejecting its stream). A stale
      // result is discarded silently — reset()/a newer "Start"/"Regenerate"
      // click already owns whatever the user is now looking at, and this
      // response no longer corresponds to it.
      if (!this.isCurrentOperation('featureCancellation', cts, epoch)) {
        return;
      }
      // Recorded regardless of whether validation below passes — the model
      // genuinely responded and consumed real tokens either way, matching
      // generateTestCaseCsv()'s own "record before validating" order.
      void this.recordReceivedTokens(settings, result, () => this.isCurrentOperation('featureCancellation', cts, epoch));
      // F09: a deterministic structural validation pass — see
      // bdd/gherkinStructuralValidator.ts's own doc comment for its exact,
      // explicitly-scoped checks (an unterminated doc string, a mismatched
      // Examples table, and Item 5's original "at least one real Scenario
      // block" check) and why this is NOT a claim of full Gherkin-spec
      // conformance. Also normalizes exactly one outer Markdown fence, so
      // a fenced-but-otherwise-valid feature is both ACCEPTED and saved
      // WITHOUT the fence, rather than either wrongly rejected or saved
      // with the fence still embedded in it. The raw response is never
      // silently discarded on a failure — logged in full to the Output
      // channel, so nothing is lost even though the panel itself only
      // shows the error.
      const validation = validateFeatureFileStructure(result.trim());
      if (!validation.ok) {
        this.outputChannel.appendLine(`Agentic Mode — feature file generation failed structural validation: ${validation.reason} Raw response:\n${result.trim()}`);
        this.generatedFeaturePanel.showError(
          `The generated content doesn't parse as a valid Gherkin feature file (${validation.reason}) — see the SoftPlay Output channel for the raw response. Try regenerating, or refine your request.`
        );
        return;
      }
      this.generatedFeaturePanel.finish(validation.normalized);
      this.postGenerationState();
      cts.dispose(); // A13: a request that actually completed no longer needs its own token source kept around
    } catch (err) {
      // A13: an old request's own REJECTION must not overwrite a NEWER,
      // still-in-flight (or already-finished) request's panel state either
      // — checked before `showError()` for the exact same reason as the
      // success path above.
      if (!this.isCurrentOperation('featureCancellation', cts, epoch)) {
        return;
      }
      const message = err instanceof CopilotUnavailableError ? err.message : err instanceof Error ? err.message : String(err);
      this.generatedFeaturePanel.showError(message);
      this.outputChannel.appendLine(`Agentic Mode — feature file generation failed: ${message}`);
    }
  }

  /** See generateFeatureFile()'s doc comment — identical `forceRegenerate`
   * contract, just for "Start"/"View AI Code Generation". */
  async generateAutomationCode(forceRegenerate = false): Promise<void> {
    if (!forceRegenerate && this.aiCodePanel.hasCode()) {
      this.aiCodePanel.show();
      return;
    }

    const epoch = this.sessionEpoch;
    this.codeCancellation?.cancel();
    this.codeCancellation?.dispose();
    const cts = new vscode.CancellationTokenSource();
    this.codeCancellation = cts;
    // F02: claimed the moment this operation starts — see the field's own
    // doc comment for why this must happen regardless of whatever
    // `verifyAndFixAgenticCode()` might independently still be doing.
    this.aiCodePanelOwner = cts;

    this.aiCodePanel.setLanguage(this.settingsStore.get().language);
    this.aiCodePanel.show();
    // Item 4: "Verify & Fix Code" is now wired up for Agentic Mode too
    // (see verifyAndFixAgenticCode() below) — disabled only DURING
    // generation, exactly like Standard mode's own AiCodePanel, rather than
    // permanently disabled as a stub.
    this.aiCodePanel.setVerifyButtonEnabled(false);
    this.aiCodePanel.startGenerating();
    try {
      const { result, settings } = await this.runAgenticChain('code', cts, buildAgenticAutomationCodeChain);
      // A13 — see generateFeatureFile()'s identical check and
      // agenticRequestEpoch.ts's own doc comment for the full reasoning.
      // F02: ALSO requires still owning the shared panel — a verify run
      // that started after this one must not have its own eventual result
      // overwritten by this now-superseded generation.
      if (!this.isCurrentOperation('codeCancellation', cts, epoch) || !this.ownsAiCodePanel(cts)) {
        return;
      }
      this.aiCodePanel.finish(extractCodeBlock(result));
      this.aiCodePanel.setVerifyButtonEnabled(true);
      // Item 5: the validation loop for generated code is "Verify & Fix
      // Code" itself (Item 4) — never auto-triggered (that would silently
      // compile/run code the user never asked to execute, crossing the
      // "a human approves every execution" line — see verifyFixAgent.ts's
      // own doc comment), just made visibly available the moment there's
      // something to verify.
      // F09: precise about what's automatic (this generation) vs. manual
      // (the click) — nothing executes without the user's own approval.
      this.aiCodePanel.setVerifyStatus('Generated. Click "Verify & Fix Code" to compile/run it — nothing executes without your approval.', 'info');
      this.postGenerationState();
      void this.recordReceivedTokens(settings, result, () => this.isCurrentOperation('codeCancellation', cts, epoch) && this.ownsAiCodePanel(cts));
      cts.dispose();
    } catch (err) {
      if (!this.isCurrentOperation('codeCancellation', cts, epoch) || !this.ownsAiCodePanel(cts)) {
        return;
      }
      const message = err instanceof CopilotUnavailableError ? err.message : err instanceof Error ? err.message : String(err);
      this.aiCodePanel.showError(message);
      this.outputChannel.appendLine(`Agentic Mode — automation code generation failed: ${message}`);
    }
  }

  /**
   * Item 4: "Verify & Fix Code" for Total Agentic Mode's own generated
   * code — mirrors `objectSpyPanel.ts`'s `verifyAndFixCode()`/
   * `runVerifyFixAgentPath()` almost exactly (same environment check, same
   * scratch-dir-under-globalStorage convention, the SAME `runVerifyFixAgent()`
   * tool-calling agent with the SAME three tools and the SAME human-
   * confirm-per-execution contract — see agent/verifyFixAgent.ts's own doc
   * comment on why every execution needs a human's explicit go-ahead
   * regardless of which mode generated the code). Zero new agent-loop code.
   *
   * The one real adaptation: Standard mode's "original context" is a
   * recorded Playwright/API request; Agentic Mode has no such thing —
   * instead, the fixing agent is given the SAME ingested-file context and
   * user request that produced the code in the first place, so it can
   * re-derive what the code was actually supposed to do. If a feature file
   * was ALSO generated this session, its content is written to a scratch
   * file and handed to `read_feature_file` the same way Standard mode's
   * linked scenario is — otherwise that tool simply reports nothing linked
   * (see verifyFixTools.ts's own `undefined`-handling).
   *
   * Uses its OWN `verifyCancellation` field — deliberately NOT shared with
   * `codeCancellation` (the generation flow). Standard mode originally
   * shared one field between generation and verify/fix and had to retrofit
   * `llmCancellationOwner` after finding a real cross-flow cancellation bug
   * (see objectSpyPanel.ts's own doc comment on that field) — a separate
   * field here avoids ever needing that fix in the first place.
   */
  private async verifyAndFixAgenticCode(): Promise<void> {
    // F01: reserved SYNCHRONOUSLY, before ANY await below — see
    // `isCurrentOperation()`'s own doc comment for exactly why. Previously
    // this only happened much later (after the editor-read/environment-
    // check/mkdir/feature-write awaits), so a reset()/Clear Data during any
    // of those had nothing yet to cancel, and this method could still go on
    // to start the agent for a session the user had just cleared.
    const epoch = this.sessionEpoch;
    this.verifyCancellation?.cancel();
    this.verifyCancellation?.dispose();
    const cts = new vscode.CancellationTokenSource();
    this.verifyCancellation = cts;
    // F02: claims the shared aiCodePanel immediately — a fresh
    // generateAutomationCode() click starting after this point must not
    // let THIS run's own eventual commit land on top of it, and vice versa.
    this.aiCodePanelOwner = cts;
    // F02: this operation's own scratch subdirectory — never shared with
    // any other verify invocation (overlapping runs, or a stale one still
    // finishing after a newer click), so build artifacts can never collide.
    const operationId = ++this.verifyOperationSeq;

    const isCurrent = () => this.isCurrentOperation('verifyCancellation', cts, epoch) && this.ownsAiCodePanel(cts);

    const settings = this.settingsStore.get();
    const isApiMode = settings.automationMode === 'api';
    if (!settings.copilotEnabled || !settings.copilotModelId) {
      if (isCurrent()) {
        this.aiCodePanel.setVerifyStatus('Enable "Link with GitHub Copilot LLM" (Control Panel) and pick a model in Settings first.', 'error');
      }
      return;
    }

    const initialCode = await this.aiCodePanel.requestCurrentCode();
    if (!isCurrent()) {
      return;
    }
    if (!initialCode.trim()) {
      void vscode.window.showWarningMessage('Nothing to verify — generate some AI code first.');
      return;
    }

    this.aiCodePanel.setVerifyButtonEnabled(false);
    try {
      this.aiCodePanel.setVerifyStatus('Checking the local environment…', 'info');
      const env = await checkEnvironment(settings.language, settings.automationMode, this.context.extensionUri.fsPath, this.context.globalStorageUri.fsPath, settings.languageVersion);
      if (!isCurrent()) {
        return;
      }
      this.outputChannel.appendLine(`Agentic Mode Verify & Fix Code — environment check (${settings.language}, ${isApiMode ? 'API' : 'UI'} mode): ${env.ok ? 'OK' : 'FAILED'} — ${env.message}`);
      if (!env.ok) {
        this.aiCodePanel.setVerifyStatus(env.message, 'error');
        void vscode.window.showErrorMessage(`SoftPlay: ${env.message}`);
        return;
      }
      const pythonCommand = settings.language === 'python' ? env.pythonCommand ?? 'python' : '';

      // F02: a separate 'agentic' subtree — never the same directory
      // Standard mode's own verify/fix scratch dir uses — PLUS this one
      // operation's own `verify-<operationId>` leaf, so no two verify runs
      // (Standard vs. Agentic, or two overlapping Agentic ones) ever share
      // build artifacts.
      const scratchDir = path.join(this.context.globalStorageUri.fsPath, 'test-runner', 'agentic', settings.automationMode, settings.language, `verify-${operationId}`);
      await fs.promises.mkdir(scratchDir, { recursive: true });
      if (!isCurrent()) {
        return;
      }

      // If a feature file was ALSO generated this session, give the agent
      // something real to read via read_feature_file — written fresh every
      // run so an edit to the Generated Feature File panel is picked up.
      let linkedFeatureFilePath: string | undefined;
      if (this.generatedFeaturePanel.hasContent()) {
        linkedFeatureFilePath = path.join(scratchDir, 'generated.feature');
        await fs.promises.writeFile(linkedFeatureFilePath, this.generatedFeaturePanel.getContent(), 'utf8');
        if (!isCurrent()) {
          return;
        }
      }

      // F04: redact BEFORE any of this reaches a prompt — see
      // security/passwordEncryptionSection.ts's own doc comment for
      // exactly what these two redactors do and don't catch (password-
      // shaped `.fill()`/`.type()` calls; connection-string/labeled-field
      // credentials in free text — never a claim of universal secret
      // detection). The agent operates on these ENCRYPTED versions
      // throughout — its own run_code calls execute the encrypted
      // candidate, never a plaintext one — so the model only ever
      // sees/produces `ENC[...]` tokens. The runtime master key itself
      // (`secretEnv` below) is unaffected — it already only ever reaches
      // the executed child process's environment, never a prompt string.
      const encryptedCode = (await encryptPasswordLiteralsInCode(this.context, initialCode, settings.language)).code;
      const ingestedContextRaw = this.buildIngestedContext(true);
      const encryptedIngestedContext = (await encryptCredentialsInFreeText(this.context, ingestedContextRaw)).text;
      const encryptedUserRequest = (await encryptCredentialsInFreeText(this.context, this.lastUserRequest)).text;
      if (!isCurrent()) {
        return;
      }

      const builtInStandard = isApiMode ? this.readApiAutomationInstructions() : this.readSeniorQeInstructions();
      // F04: the SAME mandatory standard + decrypt-helper section Standard
      // mode's own fix-prompt builder appends — included whenever an
      // ENC[...] token is actually present above, teaching the fixing
      // agent to PRESERVE the token/helper through a repair rather than
      // "simplifying" it back toward plaintext.
      const encryptionParts: string[] = [];
      appendPasswordEncryptionSection(encryptionParts, `${encryptedIngestedContext}\n${encryptedUserRequest}\n${encryptedCode}`, settings.language);
      const encryptionSection = encryptionParts.join('\n\n');

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
        (builtInStandard ? `\n## Mandatory refinement standard — every version you submit must follow every part of this\n${builtInStandard}` : '') +
        encryptionSection;

      const userPrompt =
        `## Ingested input files and the original request this code was generated from (the ground truth for what ` +
        `this code is supposed to do — refer back to this if the error suggests something was implemented incorrectly)\n` +
        `${encryptedIngestedContext || '(no files were ingested for this generation)'}\n\n---\n\nThe original request:\n${encryptedUserRequest || '(none — the ingested files alone were the ask)'}\n\n` +
        `## Current file to verify and, if necessary, fix\n\`\`\`${settings.language}\n${encryptedCode}\n\`\`\``;

      this.outputChannel.appendLine(
        `Agentic Mode Verify & Fix Code (agent) — starting with Copilot model "${settings.copilotModelId}": system prompt is ${systemPrompt.length} chars, user prompt is ${userPrompt.length} chars.`
      );

      let lastShownCode = encryptedCode;
      let lastKnownError: string | undefined;
      const result = await runVerifyFixAgent({
        modelId: settings.copilotModelId,
        systemPrompt,
        userPrompt,
        maxAttempts: AgenticModeController.MAX_VERIFY_ATTEMPTS,
        maxSteps: AgenticModeController.MAX_VERIFY_ATTEMPTS * 3 + 2,
        cancellationToken: cts.token,
        runCodeDeps: {
          language: settings.language,
          languageVersion: settings.languageVersion,
          scratchDir,
          linkedFeatureFilePath,
          pythonCommand,
          automationMode: settings.automationMode,
          resourcesRoot: this.context.extensionUri.fsPath,
          secretEnv: await secretVault.getSecretEnv(this.context),
          // F03: rechecked by the shared tool itself immediately before
          // executing, AFTER confirmRun() resolves — closes the race where
          // a Clear Data/cancel fires while the confirmation dialog is
          // still open and "Yes" is answered afterward. See
          // verifyFixTools.ts's own doc comment on this field.
          cancellationToken: cts.token
        },
        confirmRun: async (attempt, maxAttempts, lastErrorOutput) => {
          const choice = await vscode.window.showWarningMessage(
            attempt === 1
              ? `Run the AI-generated code now to verify it ${isApiMode ? 'compiles/parses' : 'executes headless'} without errors?`
              : `Attempt ${attempt} of ${maxAttempts}: re-run the agent-fixed code to verify it now ${isApiMode ? 'compiles/parses' : 'executes headless'} without errors?`,
            lastErrorOutput ? { modal: true, detail: truncateForDialog(lastErrorOutput) } : { modal: true },
            'Yes',
            'No'
          );
          return choice === 'Yes';
        },
        onOutput: (line) => this.outputChannel.appendLine(maskCredentialsForLogging(line)),
        onStep: (log) => {
          // F04: masked before it ever reaches the Output channel — a tool
          // call/result can carry the model's own candidate code or the
          // executor's raw stdout/stderr, either of which could still
          // contain a plaintext value despite the encryption pass above
          // (e.g. a fix that reverts a token, or an error message that
          // echoes an input value back).
          this.outputChannel.appendLine(`Agentic Mode Verify & Fix Code (agent) — [${log.kind}${log.toolName ? `:${log.toolName}` : ''}] ${maskCredentialsForLogging(log.detail)}`);
          if (!isCurrent()) {
            return;
          }
          if (log.kind === 'tool_call' && log.toolName === 'run_code') {
            try {
              const args = JSON.parse(log.detail) as { code?: string };
              if (typeof args.code === 'string' && args.code !== lastShownCode) {
                lastShownCode = args.code;
                this.aiCodePanel.finish(args.code);
                this.postGenerationState();
              }
            } catch {
              // Malformed tool-call args JSON — cosmetic only.
            }
          }
          if (log.kind === 'tool_result' && log.toolName === 'run_code') {
            try {
              const parsed = JSON.parse(log.detail) as { signal?: string; output?: string };
              if (parsed.signal !== 'success' && typeof parsed.output === 'string') {
                lastKnownError = parsed.output;
              }
            } catch {
              // Malformed/unexpected tool-result JSON — nothing to react to.
            }
          }
        }
      });

      if (!isCurrent()) {
        return;
      }

      switch (result.stopReason) {
        case 'success': {
          const compileOnly = Boolean(result.raw?.compileOnly);
          const apiCallOutcome = result.raw?.apiCallOutcome as 'passed' | 'failed' | 'not-run' | undefined;
          if (result.finalCode) {
            this.aiCodePanel.finish(result.finalCode);
            this.postGenerationState();
          }
          if (compileOnly) {
            this.aiCodePanel.setVerifyStatus(
              'Compiled successfully — BDD step definitions have no generated runner to fully execute yet, so this is a compile check, not a confirmed run.',
              'success'
            );
          } else if (isApiMode) {
            this.aiCodePanel.setVerifyStatus(
              apiCallOutcome === 'failed'
                ? 'Code Correctness Confirmed — no syntax errors. The live API call itself returned an error response (see the SoftPlay Output channel) — recheck the endpoint URL/credentials and try again in your own IDE/test package.'
                : 'Code Correctness Confirmed — compiled cleanly and the API call succeeded.',
              'success'
            );
          } else {
            this.aiCodePanel.setVerifyStatus('Code Correctness Confirmed — ran headless without errors.', 'success');
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
          this.aiCodePanel.setVerifyStatus(`${result.summary}${lastKnownError ? ` Last error: ${truncateForStatusLine(lastKnownError)}` : ''}`, 'error');
          return;
        case 'no_further_action':
          this.aiCodePanel.setVerifyStatus(
            `Copilot stopped without a confirmed fix: ${result.summary}${lastKnownError ? ` Last error: ${truncateForStatusLine(lastKnownError)}` : ''}`,
            'error'
          );
          return;
        case 'cancelled':
          return;
        case 'error': {
          const message = result.error instanceof Error ? result.error.message : String(result.error ?? result.summary);
          this.aiCodePanel.setVerifyStatus(`Verify & Fix Code failed: ${message}`, 'error');
          this.outputChannel.appendLine(`Agentic Mode Verify & Fix Code — the tool-calling agent failed unexpectedly: ${message}`);
          return;
        }
      }
    } catch (err) {
      // F05: covers the preflight (env check, mkdir, feature-file write,
      // secretVault.getSecretEnv(), model resolution) throwing — the
      // previous `try/finally` had no `catch` at all, so any of these
      // could become an unhandled rejection (the panel callback invokes
      // this method with `void`) and leave the user stuck on the last
      // in-progress status forever. Never falls back to a legacy loop
      // (Agentic Mode has none) and never re-runs an already-approved
      // execution — just reports what happened.
      if (!isCurrent()) {
        return;
      }
      if (cts.token.isCancellationRequested) {
        return; // cancellation is cancellation, not a failure to report
      }
      const message = err instanceof Error ? err.message : String(err);
      this.aiCodePanel.setVerifyStatus(`Verify & Fix Code failed: ${message}`, 'error');
      this.outputChannel.appendLine(`Agentic Mode Verify & Fix Code — failed before/during orchestration: ${message}`);
    } finally {
      // F02: an old, already-superseded operation must never re-enable a
      // button a NEWER operation (generation or a fresher verify) is still
      // using.
      if (this.ownsAiCodePanel(cts)) {
        this.aiCodePanel.setVerifyButtonEnabled(true);
      }
    }
  }

  /** `forceRegenerate` — false (the sidebar's own button, "Generate"/"View
   * Manual Test Cases in CSV") reopens the exact CSV file already written
   * this session (`lastCsvUri`) with no new LLM call at all when one
   * exists; `true` forces a genuinely fresh generation. Unlike the feature
   * file/code chains, there's no separate "Regenerate" affordance for CSV
   * today — the only way to force `true` is via a fresh generation after
   * "Clear Data" resets `lastCsvUri` to undefined. */
  async generateTestCaseCsv(forceRegenerate = false): Promise<void> {
    if (!forceRegenerate && this.lastCsvUri) {
      try {
        const document = await vscode.workspace.openTextDocument(this.lastCsvUri);
        await vscode.window.showTextDocument(document, { viewColumn: vscode.ViewColumn.Beside, preview: false });
        return;
      } catch {
        // The file was moved/deleted outside SoftPlay since it was
        // written — fall through and generate a fresh one rather than
        // leaving the button permanently stuck on "View" with nothing to
        // show.
        this.lastCsvUri = undefined;
        this.postGenerationState();
      }
    }

    const epoch = this.sessionEpoch;
    this.csvCancellation?.cancel();
    this.csvCancellation?.dispose();
    const cts = new vscode.CancellationTokenSource();
    this.csvCancellation = cts;

    const webview = this.getSidebarWebview();
    webview?.postMessage({ type: 'agentic:csvStatus', payload: { state: 'generating' } });
    try {
      const { result, settings } = await this.runAgenticChain('csv', cts, buildAgenticTestCaseCsvChain);
      // A13 — see generateFeatureFile()'s identical check and
      // agenticRequestEpoch.ts's own doc comment for the full reasoning.
      // Checked here BEFORE directory creation/write/status-reporting even
      // starts.
      if (!this.isCurrentOperation('csvCancellation', cts, epoch)) {
        return;
      }
      // Item 7/F07: grounds validation in the team's REAL example CSV when
      // one exists and is valid at .github/Jira_test_case_template.csv —
      // `'absent'` (the common, unconfigured case) behaves exactly as
      // before this feature existed. `'invalid'` is now a real, actionable
      // error (F07) rather than silently falling through as if unconfigured.
      const csvTemplateExample = await this.readCsvTemplateExample();
      if (csvTemplateExample.status === 'invalid') {
        throw new Error(`.github/Jira_test_case_template.csv exists but could not be used: ${csvTemplateExample.reason} Fix or remove it, then try again.`);
      }
      const normalized = normalizeTestCaseCsvResponse(result, csvTemplateExample.status === 'ok' ? csvTemplateExample : undefined);
      void this.recordReceivedTokens(settings, result, () => this.isCurrentOperation('csvCancellation', cts, epoch));

      const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri;
      if (!workspaceRoot) {
        throw new Error('Open a workspace folder first — the CSV is saved into it.');
      }
      const outDir = vscode.Uri.joinPath(workspaceRoot, '.github', 'generated-test-cases');
      await vscode.workspace.fs.createDirectory(outDir);
      // A13: re-checked AFTER `createDirectory()` — a real async boundary a
      // reset()/Clear Data could land in between the check above and the
      // ACTUAL write below (the review's own explicit "reset immediately
      // before write" scenario) — never assume nothing changed just
      // because it didn't a few lines up.
      if (!this.isCurrentOperation('csvCancellation', cts, epoch)) {
        return;
      }
      const fileName = `manual-test-cases-${timestampForFileName()}.csv`;
      const outUri = vscode.Uri.joinPath(outDir, fileName);
      await vscode.workspace.fs.writeFile(outUri, new TextEncoder().encode(normalized.content));
      // F08: re-checked AFTER the write itself resolves — a reset()/newer
      // click landing DURING the write must not let this stale operation
      // still claim `lastCsvUri`, report "done," or open the file. The
      // write already happened and its file is left on disk (timestamped,
      // never colliding with another run's own output) — simply never
      // treated as this session's "current" CSV, and never opened.
      if (!this.isCurrentOperation('csvCancellation', cts, epoch)) {
        return;
      }
      this.lastCsvUri = outUri;
      this.postGenerationState();
      cts.dispose();

      webview?.postMessage({
        type: 'agentic:csvStatus',
        payload: { state: 'done', message: `Saved ${normalized.rowCount} step row(s), ${normalized.columnCount} column(s) to ${vscode.workspace.asRelativePath(outUri)}.${normalized.populationNote}` }
      });
      const document = await vscode.workspace.openTextDocument(outUri);
      // F08: one more boundary — opening the document is itself an await;
      // a reset()/newer click between the message above and the editor
      // actually opening must not surface a stale document either.
      if (!this.isCurrentOperation('csvCancellation', cts, epoch)) {
        return;
      }
      await vscode.window.showTextDocument(document, { viewColumn: vscode.ViewColumn.Beside, preview: false });
    } catch (err) {
      // A13: an old/superseded/cancelled request's own rejection (or an
      // error thrown by this method's own body, e.g. "no workspace open")
      // must not report a stale status over a newer request's own
      // in-progress or already-completed one.
      if (!this.isCurrentOperation('csvCancellation', cts, epoch)) {
        return;
      }
      const message =
        err instanceof InvalidTestCaseCsvError || err instanceof CopilotUnavailableError || err instanceof Error ? err.message : String(err);
      webview?.postMessage({ type: 'agentic:csvStatus', payload: { state: 'error', message } });
      this.outputChannel.appendLine(`Agentic Mode — manual test-case CSV generation failed: ${message}`);
    }
  }
}

function timestampForFileName(): string {
  return new Date().toISOString().replace(/[:.]/g, '-');
}
