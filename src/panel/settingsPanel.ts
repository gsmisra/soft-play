import * as vscode from 'vscode';
import * as path from 'path';
import { LANGUAGE_VERSIONS, Language, ObjectSpySettings, SettingsStore } from '../settings/settingsStore';
import { listCopilotModels } from '../llm/copilotClient';
import { generateRagCorpus, GenerationProgress, UploadedFile } from '../rag/ragCorpusGenerator';
import { readZipDirectory, extractZipEntryContent } from '../rag/zipReader';
import { isNoiseDirectoryPath, isSupportedRagSourceFile } from '../rag/ragUploadFilters';
import { getOrBuildFreshnessReport } from '../rag/ragFreshnessService';
import { getSemanticApiKey, setSemanticApiKey, testEmbeddingProvider } from '../rag/ragHybridConfig';
import { getSecretEnv, SECRET_ENV_VAR } from '../security/secretVault';

/** Same per-file cap the drop zone enforces for a directly-dropped file
 * (settingsPanel.ts webview script's RAG_MAX_FILE_BYTES) — applied again
 * here to every individual entry extracted from an uploaded zip, since a
 * whole project archive can easily contain a file far larger than anyone
 * would drop by hand. Checked TWICE against a zip entry: once against its
 * declared (central-directory) uncompressed size, before any decompression
 * is attempted at all, and again as the hard `maxOutputBytes` ceiling zlib
 * itself enforces DURING decompression — so a "small compressed, huge
 * declared/actual decompressed size" entry (a zip bomb) is rejected either
 * way, never fully inflated first and only checked afterward. */
const RAG_MAX_ZIP_ENTRY_BYTES = 200 * 1024;

/** Mirrors the webview drop zone's own `RAG_MAX_ZIP_BYTES` — re-checked here
 * against the actual decoded buffer because the extension host must never
 * trust a size claim made by the webview side of a postMessage; nothing
 * stops a future bug (or a malicious message from something other than
 * this extension's own webview) from sending an oversized payload directly. */
const RAG_MAX_ZIP_UPLOAD_BYTES = 25 * 1024 * 1024;

/** A real project zip realistically has, at most, a few thousand files —
 * this bounds the central-directory parse itself against a crafted archive
 * that declares an absurd entry count purely to waste CPU walking it (each
 * entry read is cheap, but not free, and this is synchronous on the
 * extension host). */
const RAG_MAX_ZIP_ENTRIES = 20_000;

/** Total decompressed bytes allowed across every entry actually extracted
 * from ONE zip — the aggregate half of the "small archive, huge inflated
 * total" zip-bomb shape that a per-entry cap alone doesn't cover (many
 * entries each just under the per-entry cap, still adding up to a lot).
 * Generous relative to the 25MB compressed upload cap above (a real
 * project's text/config files rarely exceed a few-to-one compression
 * ratio in aggregate) while still bounding the worst case. Extraction stops
 * — rather than erroring the whole batch — the moment adding another entry
 * would exceed this; every entry already extracted is kept. */
const RAG_MAX_ZIP_AGGREGATE_BYTES = 75 * 1024 * 1024;

type InboundMessage =
  | { type: 'update'; payload: Partial<ObjectSpySettings> }
  | { type: 'listModels' }
  | { type: 'openArchitectureDoc' }
  | { type: 'generateRagCorpus'; payload: { files: UploadedFile[] } }
  | { type: 'cancelRagGeneration' }
  | { type: 'expandRagZip'; payload: { fileName: string; base64: string } }
  | { type: 'checkRagFreshness' }
  | { type: 'saveSemanticApiKey'; payload: { apiKey: string } }
  | { type: 'testSemanticProvider'; payload: { endpoint: string; model: string } }
  | { type: 'copySecretKey' };

/**
 * The Settings menu — deliberately a separate webview panel from the main
 * UI, not a section bolted onto it. Controls the browser channel, the
 * generated code's language/runtime version, and which GitHub Copilot chat
 * model to use, all persisted via SettingsStore (context.globalState). The
 * "Link with GitHub Copilot LLM" on/off switch itself lives in the Control
 * Panel (objectSpyPanel.ts) instead — this panel's model picker/status
 * still reacts to that setting via the same shared SettingsStore, it just
 * doesn't own the switch anymore.
 */
export class SettingsPanel implements vscode.Disposable {
  private panel: vscode.WebviewPanel | undefined;
  private readonly disposables: vscode.Disposable[] = [];
  /** Cancelled if the panel is disposed mid-generation, so a closed
   * Settings panel doesn't leave a "Generate RAG Corpus format" batch
   * quietly running in the background. */
  private ragGenerationCts: vscode.CancellationTokenSource | undefined;

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
      'SoftPlay: Settings',
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
    void this.postSemanticKeyStatus();
  }

  dispose(): void {
    this.ragGenerationCts?.cancel();
    this.ragGenerationCts?.dispose();
    this.panel?.dispose();
    this.disposables.forEach((d) => d.dispose());
  }

  private async handleMessage(message: InboundMessage): Promise<void> {
    if (message.type === 'update') {
      await this.settingsStore.update(message.payload);
    } else if (message.type === 'listModels') {
      const models = await listCopilotModels();
      this.panel?.webview.postMessage({ type: 'models', payload: models });
    } else if (message.type === 'openArchitectureDoc') {
      await this.openArchitectureDoc();
    } else if (message.type === 'generateRagCorpus') {
      await this.handleGenerateRagCorpus(message.payload.files);
    } else if (message.type === 'cancelRagGeneration') {
      this.handleCancelRagGeneration();
    } else if (message.type === 'expandRagZip') {
      await this.handleExpandRagZip(message.payload.fileName, message.payload.base64);
    } else if (message.type === 'checkRagFreshness') {
      await this.handleCheckRagFreshness();
    } else if (message.type === 'saveSemanticApiKey') {
      await this.handleSaveSemanticApiKey(message.payload.apiKey);
    } else if (message.type === 'testSemanticProvider') {
      await this.handleTestSemanticProvider(message.payload.endpoint, message.payload.model);
    } else if (message.type === 'copySecretKey') {
      await this.copySecretKeyToClipboard();
    }
  }

  /**
   * "Copy CI/CD Secret Key" — the ONLY place this extension ever exposes
   * the raw Auto Password Encryption master key to a human. SoftPlay never
   * needs this itself: "Verify & Fix Code" gets it injected automatically
   * into its own child process's environment (see
   * execution/testExecutor.ts). This exists purely for the scenario
   * security/secretVault.ts's own doc comment already anticipates — a
   * SAVED generated file later run OUTSIDE the extension (a standalone
   * terminal, a real CI/CD pipeline) needs `SoftPlay_SECRET_KEY` set to
   * decrypt its `ENC[v1:...]` tokens, and until now there was literally no
   * way for a user to learn what value that actually is (it's held in
   * VS Code's OS-keychain-backed SecretStorage, not a plain file).
   *
   * Deliberately copies to the clipboard rather than displaying it in the
   * webview — never rendered into the DOM, never left sitting visible in
   * a screen-shared window.
   */
  private async copySecretKeyToClipboard(): Promise<void> {
    const env = await getSecretEnv(this.context);
    const value = env[SECRET_ENV_VAR];
    await vscode.env.clipboard.writeText(`${SECRET_ENV_VAR}=${value}`);
    void vscode.window.showInformationMessage(
      `Copied ${SECRET_ENV_VAR} to the clipboard. This is your own local Auto Password Encryption key — set it as an ` +
        `environment variable wherever you run a saved generated test OUTSIDE this extension (a terminal, your CI/CD ` +
        `pipeline's own secrets manager). Never commit it to source control or paste it into a generated file — ` +
        'store it the same way you would any other secret.'
    );
  }

  /**
   * Front-end companion to the "Generate RAG Corpus format" drop zone
   * accepting a whole project/framework as a single `.zip` (settingsPanel.ts
   * webview script) — a webview has no Node `zlib`, so the actual unzip has
   * to happen here in the extension host (zipReader.ts, dependency-free —
   * same posture as tfidfEmbeddings.ts). Filters out noise directories
   * (node_modules, target, .git, ...) and unsupported file types so a real
   * project zip doesn't queue up hundreds of useless recipe generations,
   * and caps individual entries at the same size the UI enforces for a
   * directly dropped file — then hands the surviving files back to the
   * webview to merge into its normal pending-file list, exactly as if each
   * had been dropped individually (folder structure preserved via
   * `relativePath`, see ragRecipeNormalizer.ts's `ragTargetRelPath()`).
   */
  private async handleExpandRagZip(fileName: string, base64: string): Promise<void> {
    try {
      const buffer = Buffer.from(base64, 'base64');
      if (buffer.length > RAG_MAX_ZIP_UPLOAD_BYTES) {
        throw new Error(`Zip is larger than ${(RAG_MAX_ZIP_UPLOAD_BYTES / (1024 * 1024)).toFixed(0)} MB — not processing it.`);
      }

      // Phase 1: read ONLY the central directory's metadata — no entry is
      // decompressed yet. This is what lets every allowed-path/type/
      // declared-size check below run BEFORE any decompression is
      // attempted, rather than after (the bug this fixes: `unzip()` used to
      // fully inflate every entry unconditionally, so a small compressed
      // archive containing one hostile entry — or simply a large irrelevant
      // generated file well within the noise-directory/extension filters
      // below — could exhaust memory before those filters ever got a
      // chance to help).
      const directory = readZipDirectory(buffer);
      if (directory.length > RAG_MAX_ZIP_ENTRIES) {
        throw new Error(`Zip contains too many entries (${directory.length.toLocaleString()}, over the ${RAG_MAX_ZIP_ENTRIES.toLocaleString()} limit) — not processing it.`);
      }

      const files: { fileName: string; relativePath: string; content: string }[] = [];
      let skipped = 0;
      let aggregateBytes = 0;
      for (const entry of directory) {
        if (entry.isDirectory) {
          continue;
        }
        const normalized = entry.path.replace(/^\/+/, '');
        const baseName = path.posix.basename(normalized);
        const dirPath = path.posix.dirname(normalized);
        const relativePath = dirPath === '.' ? '' : dirPath;

        // Path/type/declared-size policy — checked entirely from directory
        // metadata, before extractZipEntryContent() below ever runs.
        if (isNoiseDirectoryPath(relativePath) || !isSupportedRagSourceFile(baseName) || entry.uncompressedSize > RAG_MAX_ZIP_ENTRY_BYTES) {
          skipped += 1;
          continue;
        }
        if (aggregateBytes + entry.uncompressedSize > RAG_MAX_ZIP_AGGREGATE_BYTES) {
          // Aggregate cap reached — stop extracting further entries rather
          // than erroring the whole batch; everything extracted so far is
          // still handed back.
          skipped += directory.length - directory.indexOf(entry);
          break;
        }

        try {
          // Phase 2: decompress THIS ONE entry, bounded by zlib's own
          // maxOutputLength — never fully materializes more than
          // RAG_MAX_ZIP_ENTRY_BYTES even if this entry's declared size (or
          // its real compression ratio) lies about how large it really is.
          const content = extractZipEntryContent(buffer, entry, { maxOutputBytes: RAG_MAX_ZIP_ENTRY_BYTES });
          aggregateBytes += content.byteLength;
          files.push({ fileName: baseName, relativePath, content: content.toString('utf-8') });
        } catch {
          // A single bad/oversized/corrupt entry (ZipEntryTooLargeError or
          // otherwise) never aborts the whole zip — skip just this one,
          // reflected in `skippedCount`, and keep going.
          skipped += 1;
        }
      }
      this.panel?.webview.postMessage({ type: 'ragZipExpanded', payload: { fileName, files, skippedCount: skipped } });
    } catch (err) {
      this.panel?.webview.postMessage({
        type: 'ragZipExpanded',
        payload: { fileName, files: [], skippedCount: 0, error: err instanceof Error ? err.message : String(err) }
      });
    }
  }

  /**
   * "Generate RAG Corpus format" — turns each uploaded file into a
   * `.github/rag/<name>.md` reusable-component recipe via Copilot (see
   * rag/ragCorpusGenerator.ts). Requires the same "Link with GitHub
   * Copilot LLM" + model selection every other AI feature does — this is
   * a real LLM call (analyzing arbitrary code to infer a title/tags/
   * imports isn't something a template can do), not a local operation.
   */
  private async handleGenerateRagCorpus(files: UploadedFile[]): Promise<void> {
    const settings = this.settingsStore.get();
    if (!settings.copilotEnabled || !settings.copilotModelId) {
      this.panel?.webview.postMessage({
        type: 'ragGenerationDone',
        payload: { succeeded: 0, skipped: 0, failed: files.length, error: 'Enable "Link with GitHub Copilot LLM" (Control Panel) and pick a model in Settings first.' }
      });
      return;
    }
    const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri;
    if (!workspaceRoot) {
      this.panel?.webview.postMessage({
        type: 'ragGenerationDone',
        payload: { succeeded: 0, skipped: 0, failed: files.length, error: 'Open a workspace folder first — recipes are saved under its .github/rag folder.' }
      });
      return;
    }
    if (files.length === 0) {
      return;
    }

    this.ragGenerationCts?.cancel();
    this.ragGenerationCts?.dispose();
    const cts = new vscode.CancellationTokenSource();
    this.ragGenerationCts = cts;

    let result: { succeeded: number; skipped: number; failed: number };
    try {
      result = await generateRagCorpus({
        modelId: settings.copilotModelId,
        files,
        workspaceRoot,
        cancellationToken: cts.token,
        onProgress: (progress: GenerationProgress) => {
          // F14 fix: `this.ragGenerationCts` is REPLACED (not just its
          // token flagged cancelled) the moment a NEWER batch starts —
          // comparing identity against the `cts` THIS call closed over is
          // the same "is this still the current request" pattern already
          // used elsewhere in this codebase (e.g. objectSpyPanel.ts's
          // `this.llmCancellation !== cts`). Without this, a batch that
          // was superseded (its own `cancel()` already called above, but
          // whose `generateRagCorpus()` promise is still running in the
          // background) could keep posting progress lines into a NEWER
          // batch's already-fresh, in-progress log — messages need to be
          // scoped to the request that produced them, not just to
          // whichever panel instance happens to still be open.
          if (this.ragGenerationCts !== cts) {
            return;
          }
          this.panel?.webview.postMessage({ type: 'ragGenerationProgress', payload: progress });
        },
        confirmOverwrite: async (existingFileNames) => {
          const choice = await vscode.window.showWarningMessage(
            `${existingFileNames.length} recipe file(s) already exist in .github/rag and would be overwritten: ${existingFileNames.join(', ')}. Overwrite them?`,
            { modal: true },
            'Overwrite',
            'Skip Existing'
          );
          return choice === 'Overwrite';
        }
      });
    } catch (err) {
      if (this.ragGenerationCts !== cts) {
        return; // superseded by a newer batch — its own eventual outcome is what the UI cares about now
      }
      // Belt-and-suspenders: generateRagCorpus() is designed to always
      // resolve, never reject (see its own doc comment) — but this call is
      // awaited from a fire-and-forget message handler
      // (webview.onDidReceiveMessage -> handleMessage), so if some future
      // change (or an unexpected throw from the confirmOverwrite dialog
      // itself) ever DOES let an exception through here, the webview must
      // still get a terminal message regardless — otherwise "Generate"
      // stays disabled forever with no way to recover short of reloading
      // the whole Settings panel.
      this.panel?.webview.postMessage({
        type: 'ragGenerationDone',
        payload: { succeeded: 0, skipped: 0, failed: files.length, error: err instanceof Error ? err.message : String(err) }
      });
      return;
    }

    if (this.ragGenerationCts !== cts) {
      return; // superseded — never post a stale batch's final summary over a newer batch's in-progress UI
    }
    this.panel?.webview.postMessage({ type: 'ragGenerationDone', payload: result });
  }

  /**
   * "End Process" — user-initiated hard stop for an in-flight "Generate RAG
   * Corpus format" batch. Just fires the SAME `CancellationTokenSource`
   * `handleGenerateRagCorpus()` already threads through every await point
   * inside `generateRagCorpus()` — including straight into `vscode.lm`'s
   * `model.sendRequest()` (llm/copilotClient.ts's `sendPrompt()`), so an
   * ACTUAL in-flight Copilot request is aborted immediately by VS Code's
   * own Language Model API, not merely ignored once it eventually resolves
   * on its own. There's no separate "kill" to build here — the cancellation
   * plumbing already existed (previously only reachable by closing the
   * whole Settings panel, see `dispose()`); this is just the missing UI
   * trigger for it.
   *
   * Deliberately does NOT dispose/clear `this.ragGenerationCts` here — the
   * in-flight `generateRagCorpus()` call is still running (every remaining
   * unit's own cancellation check now sees `isCancellationRequested`,
   * reports itself 'skipped', and the loop finishes almost immediately) and
   * still needs its own `cts` to keep matching `this.ragGenerationCts` so
   * its final `ragGenerationDone` summary isn't mistaken for a stale/
   * superseded batch and dropped (see the `this.ragGenerationCts !== cts`
   * guards above) — that summary is what resets the webview's "End
   * Process" button back to "Generate".
   *
   * Never touches disk: every recipe already written to `.github/rag`
   * earlier in this SAME batch (or any prior run) is untouched — cancelling
   * only ever skips whichever unit(s) hadn't been written yet. Nothing
   * "stored in memory" outlives this call either — `generateRagCorpus()`'s
   * only per-batch state (`sourceMappedCache`, the existing-targets map) is
   * local to that one function call and is freed the moment it returns,
   * which happens right after this cancellation propagates.
   */
  private handleCancelRagGeneration(): void {
    this.ragGenerationCts?.cancel();
  }

  /**
   * "Check Freshness" (Reusable Components section) — the Settings panel's
   * own front-end for Phase 5's active source-staleness check (see
   * rag/ragFreshnessService.ts, rag/ragFreshnessChecker.ts), so a user can
   * see per-recipe fresh/stale/missing/unverifiable/error state without
   * leaving Settings; the exact same check also runs from the Command
   * Palette ("SoftPlay: Check RAG Source Freshness" — see
   * objectSpyPanel.ts's `checkRagSourceFreshness()`, which additionally
   * logs to the SoftPlay output channel). Always forces a fresh check
   * (`forceRefresh: true`) — a manually-clicked button should never show a
   * stale cached answer about staleness itself.
   */
  private async handleCheckRagFreshness(): Promise<void> {
    const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri;
    if (!workspaceRoot) {
      this.panel?.webview.postMessage({
        type: 'ragFreshnessResult',
        payload: { error: 'Open a workspace folder first — recipes are read from its .github/rag folder.' }
      });
      return;
    }
    try {
      const report = await getOrBuildFreshnessReport(workspaceRoot, { forceRefresh: true });
      this.panel?.webview.postMessage({ type: 'ragFreshnessResult', payload: { report } });
    } catch (err) {
      this.panel?.webview.postMessage({
        type: 'ragFreshnessResult',
        payload: { error: err instanceof Error ? err.message : String(err) }
      });
    }
  }

  /**
   * "Save Key" (Hybrid Retrieval section) — the ONE write path for the
   * semantic-embedding provider's API key (Phase 6). Stored via VS Code's
   * own `SecretStorage` (OS-keychain-backed), same posture as
   * security/secretVault.ts's own master key — NEVER in `globalState`/
   * settings.json, NEVER echoed back to the webview. An empty string
   * CLEARS any previously saved key (see ragHybridConfig.ts's
   * `setSemanticApiKey()`).
   */
  private async handleSaveSemanticApiKey(apiKey: string): Promise<void> {
    await setSemanticApiKey(this.context, apiKey);
    await this.postSemanticKeyStatus();
  }

  private async postSemanticKeyStatus(): Promise<void> {
    const hasKey = !!(await getSemanticApiKey(this.context));
    this.panel?.webview.postMessage({ type: 'semanticKeyStatus', payload: { hasKey } });
  }

  /**
   * "Test Connection" (Hybrid Retrieval section) — the only place this
   * extension calls a configured semantic endpoint OUTSIDE of a real
   * retrieval request, so a user can confirm their configuration works
   * before relying on it. Uses whatever endpoint/model the user currently
   * has typed in the form (not yet necessarily saved) plus the
   * ALREADY-SAVED API key, if any — embeds one generic test string, never
   * real recipe/query content.
   */
  private async handleTestSemanticProvider(endpoint: string, model: string): Promise<void> {
    const apiKey = await getSemanticApiKey(this.context);
    const result = await testEmbeddingProvider({ endpoint, model, apiKey });
    this.panel?.webview.postMessage({ type: 'semanticTestResult', payload: result });
  }

  /**
   * "Architecture & Technical Information" — a standalone, self-contained
   * HTML file (media/architecture.html: inline CSS/SVG only, no external
   * script/stylesheet/CDN references) opened in the user's own default
   * browser via `vscode.env.openExternal`, not a second webview panel.
   * Deliberately NOT a webview: the page is long, image-free but
   * diagram-heavy, and meant to be read/printed/shared like a normal
   * document — a real browser tab (with its own zoom, find-in-page, print)
   * suits that far better than a CSP-constrained VS Code webview, and this
   * still satisfies "opens a html page locally" since nothing ever leaves
   * the machine to render it.
   */
  private async openArchitectureDoc(): Promise<void> {
    const docPath = vscode.Uri.joinPath(this.context.extensionUri, 'media', 'architecture.html');
    try {
      await vscode.env.openExternal(docPath);
    } catch (err) {
      void vscode.window.showErrorMessage(
        `SoftPlay: Could not open the Architecture & Technical Information page (${docPath.fsPath}): ${
          err instanceof Error ? err.message : String(err)
        }`
      );
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
  <title>SoftPlay Settings</title>
  <style>
    :root {
      /* TD Bank's own brand green — same fixed (non-theme-derived) color
         used for the app title bar in the Control Panel (media/main.css's
         --td-green), reused here so this link reads as the same brand
         element wherever it appears. */
      --td-green: #54b948;
      --td-green-dark: #3f9636;
    }
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
    #copilotModelRow, #copilotStatus { display: none; }
    #copilotModelRow.visible, #copilotStatus.visible { display: flex; }
    .status-text {
      font-size: 0.82em;
      color: var(--vscode-descriptionForeground);
    }
    .field.disabled { opacity: 0.5; }
    .architecture-link-row {
      margin-top: 32px;
      padding-top: 14px;
      border-top: 1px solid var(--vscode-panel-border);
      text-align: center;
    }
    .architecture-link {
      /* -apple-system stack + weight/letter-spacing to match the Control
         Panel's own TD-green title text (media/main.css's .title), so this
         reads as the same brand-styled element rather than a generic link. */
      font-family: -apple-system, BlinkMacSystemFont, var(--vscode-font-family), 'Segoe UI', sans-serif;
      font-weight: 600;
      font-size: 0.92em;
      letter-spacing: 0.01em;
      color: var(--td-green);
      background: none;
      border: none;
      padding: 4px 2px;
      cursor: pointer;
      text-decoration: none;
      display: inline-flex;
      align-items: center;
      gap: 5px;
    }
    .architecture-link:hover,
    .architecture-link:focus-visible {
      color: var(--td-green-dark);
      text-decoration: underline;
    }
    .btn {
      padding: 6px 14px;
      border: none;
      border-radius: 4px;
      background: var(--vscode-button-background);
      color: var(--vscode-button-foreground);
      cursor: pointer;
      font-size: 0.9em;
    }
    .btn:hover:not(:disabled) { background: var(--vscode-button-hoverBackground); }
    .btn:disabled { opacity: 0.5; cursor: not-allowed; }
    .btn-secondary {
      background: var(--vscode-button-secondaryBackground, transparent);
      color: var(--vscode-button-secondaryForeground, var(--vscode-foreground));
      border: 1px solid var(--vscode-panel-border);
    }
    /* "End Process" (Generate RAG Corpus Format) — solid red, deliberately
       distinct from every other button here so a destructive/stop action
       reads as one at a glance, not tied to a VS Code theme variable (same
       posture as media/main.css's own .btn-danger-confirm for "Kill All
       Browsers"/"Clear Data"). */
    .btn-danger {
      background: #a1260d;
      color: #fff;
    }
    .btn-danger:hover:not(:disabled) { background: #c42b0f; }
    .rag-dropzone {
      display: flex;
      align-items: center;
      justify-content: center;
      flex-direction: column;
      gap: 10px;
      padding: 22px 16px;
      border: 2px dashed var(--vscode-panel-border);
      border-radius: 6px;
      text-align: center;
      color: var(--vscode-descriptionForeground);
      font-size: 0.88em;
      transition: border-color 0.15s ease, background 0.15s ease;
    }
    /* TD Bank green highlight while a drag is actually over the zone —
       fixed brand color like --td-green elsewhere, not theme-derived, so
       the "you're about to drop here" cue reads the same in every theme. */
    .rag-dropzone.dragover {
      border-color: var(--td-green);
      background: rgba(84, 185, 72, 0.08);
    }
    .rag-file-list {
      display: flex;
      flex-direction: column;
      gap: 4px;
      margin-top: 10px;
    }
    .rag-file-item {
      display: flex;
      align-items: center;
      gap: 8px;
      padding: 4px 10px;
      border-radius: 4px;
      background: var(--vscode-input-background);
      font-size: 0.85em;
    }
    .rag-file-item .rag-file-name { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .rag-file-item .rag-file-size { flex: none; color: var(--vscode-descriptionForeground); }
    .rag-file-remove {
      flex: none;
      background: none;
      border: none;
      color: var(--vscode-descriptionForeground);
      cursor: pointer;
      font-size: 0.9em;
      padding: 0 4px;
    }
    .rag-file-remove:hover { color: var(--vscode-errorForeground, #f14c4c); }
    /* Live running Copilot token total for the current "Generate RAG Corpus
       Format" batch — same informational tone as the Control Panel's own
       "Token Monitoring" breakdown values, scoped here since this batch's
       token usage is independent of that section's own current-draft
       estimate (a separate webview, a separate LLM usage stream). */
    .rag-token-usage {
      margin-top: 8px;
      font-size: 0.85em;
      color: var(--vscode-descriptionForeground);
    }
    .rag-token-usage b { color: var(--vscode-foreground); font-weight: 600; }
    .rag-progress {
      margin-top: 12px;
      max-height: 160px;
      overflow-y: auto;
      font-size: 0.8em;
      font-family: var(--vscode-editor-font-family, monospace);
      background: var(--vscode-editor-background);
      border: 1px solid var(--vscode-panel-border);
      border-radius: 4px;
      padding: 8px 10px;
    }
    .rag-progress-line { padding: 2px 0; white-space: pre-wrap; }
    .rag-progress-line.success { color: #3fb950; }
    .rag-progress-line.error { color: var(--vscode-errorForeground, #f14c4c); }
    .rag-progress-line.skipped, .rag-progress-line.started { color: var(--vscode-descriptionForeground); }
    .rag-progress-line.done { font-weight: 600; color: var(--vscode-foreground); }
    /* Freshness-check states (Phase 5) — reuses the same .rag-progress
       container styling as generation progress, with its own color per
       state (the class name is the state string itself, e.g. class="rag-
       progress-line stale"): fresh=green (matches .success), stale=amber
       (needs attention but not an error), missing/error=red (.error above
       already covers "error"; "missing" gets the same treatment —
       something's actually wrong either way), unverifiable=muted (nothing
       to check, not a problem). */
    .rag-progress-line.fresh { color: #3fb950; }
    .rag-progress-line.stale { color: #d29922; }
    .rag-progress-line.missing { color: var(--vscode-errorForeground, #f14c4c); }
    .rag-progress-line.unverifiable { color: var(--vscode-descriptionForeground); }
    .rag-text-input {
      flex: 1;
      min-width: 0;
      padding: 4px 6px;
      background: var(--vscode-input-background);
      color: var(--vscode-input-foreground);
      border: 1px solid var(--vscode-input-border, transparent);
      border-radius: 2px;
      font-family: var(--vscode-font-family);
      font-size: 0.9em;
    }
    /* Collapsed-by-default "RAG and Agentic Settings" group (native
       <details>/<summary> — no extra JS needed for the open/close behavior
       itself) wrapping Total Agentic Mode plus every RAG-related section
       (Reusable Components, Hybrid Retrieval, Generate RAG Corpus Format)
       so a user who hasn't opted into either never has to scroll past
       them. The <summary> is styled to match the page's own h2 section
       headers, plus a small disclosure arrow. */
    details.settings-group {
      margin: 20px 0 8px;
    }
    details.settings-group summary {
      cursor: pointer;
      font-size: 1em;
      text-transform: uppercase;
      letter-spacing: 0.04em;
      color: var(--vscode-descriptionForeground);
      border-bottom: 1px solid var(--vscode-panel-border);
      padding-bottom: 4px;
      display: flex;
      align-items: center;
      gap: 6px;
      user-select: none;
    }
    details.settings-group summary::-webkit-details-marker { display: none; }
    details.settings-group summary::before {
      content: '▶';
      display: inline-block;
      font-size: 0.7em;
      transition: transform 0.15s ease;
    }
    details.settings-group[open] summary::before {
      transform: rotate(90deg);
    }
    details.settings-group .settings-group-body {
      padding-left: 2px;
    }
    details.settings-group .settings-group-body h2:first-of-type {
      margin-top: 20px;
    }
  </style>
</head>
<body>
  <h2>Automation Type</h2>
  <div class="field">
    <label>
      Automation type
      <span class="hint">UI Automation records/refines Playwright browser tests. API Automation builds REST Assured (Java) / requests (Python) API tests from a request you describe below instead — no browser involved.</span>
    </label>
    <div class="radio-group">
      <label><input type="radio" name="automationMode" value="ui" /> UI Automation</label>
      <label><input type="radio" name="automationMode" value="api" /> API Automation</label>
    </div>
  </div>

  <h2>Browser</h2>
  <div class="field" id="browserField">
    <label>
      Browser
      <span class="hint">Chrome or Edge only — this extension never downloads a browser of its own. Not used in API Automation mode (no browser is launched).</span>
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
  <p class="note" style="margin-top: 0;">
    The "Link with GitHub Copilot LLM" switch now lives in the Control Panel (SoftPlay's main sidebar view) — turn it
    on there first. Once it's on, pick which model to use below.
  </p>
  <div class="field" id="copilotModelRow">
    <label>Model</label>
    <select id="copilotModel"></select>
  </div>
  <div class="field" id="copilotStatus">
    <span class="status-text" id="copilotStatusText"></span>
  </div>

  <h2>Auto Password Encryption</h2>
  <p class="note" style="margin-top: 0;">
    Every credential SoftPlay detects (recorded UI fields, API Authorization tab values, and now the "Instant
    instructions to LLM" chat box) is encrypted locally before it ever reaches Copilot, and saved into generated code
    only as an <code>ENC[v1:...]</code> token — never the real value. SoftPlay itself supplies the decryption key
    automatically whenever it runs your code ("Verify &amp; Fix Code"). If you run a SAVED generated test file
    yourself — a terminal, your own CI/CD pipeline — it needs the same key, set as the
    <code>SoftPlay_SECRET_KEY</code> environment variable, to decrypt those tokens.
  </p>
  <div style="display: flex; justify-content: flex-end; margin-bottom: 8px;">
    <button type="button" id="copySecretKeyBtn" class="btn btn-secondary">Copy CI/CD Secret Key</button>
  </div>
  <p class="note" style="margin-top: 0;">
    Copies <code>SoftPlay_SECRET_KEY=&lt;value&gt;</code> to your clipboard — this is YOUR OWN key, generated once and
    stored in VS Code's own OS-keychain-backed secret storage, never written to a plain file. Store it the same way
    you'd store any other secret (your CI/CD system's own secrets manager). <b>Never</b> paste it into a generated
    code file or commit it to source control — doing so would let anyone who can read that file decrypt every
    credential this extension has ever encrypted for you.
  </p>

  <details id="ragSettingsGroup" class="settings-group">
  <summary>RAG and Agentic Settings</summary>
  <div class="settings-group-body">

  <h2>Mode</h2>
  <div class="field">
    <label>
      Total Agentic Mode
      <span class="hint">
        Swaps the Control Panel sidebar for a file-drop-driven workflow: ingest requirement/data files, then generate
        a feature file, automation code, and/or a Jira-importable manual test-case CSV — all built from the same
        ingested files plus your custom instructions and RAG data. Standard mode's own recording workflow is
        untouched and always available by switching back.
      </span>
    </label>
    <div class="radio-group">
      <label><input type="radio" name="agenticModeEnabled" value="false" /> Standard</label>
      <label><input type="radio" name="agenticModeEnabled" value="true" /> Total Agentic Mode</label>
    </div>
  </div>

  <h2>Reusable Components (RAG)</h2>
  <div class="field">
    <label>
      Use reusable components
      <span class="hint">Augments code-generation prompts with the best-matching entries from <code>.github/rag/</code>, if any exist. Safe to leave on — retrieval simply finds nothing when that folder is empty or missing.</span>
    </label>
    <input type="checkbox" id="ragEnabledToggle" />
  </div>
  <div class="field">
    <label>
      Source freshness
      <span class="hint">Checks each recipe's recorded source file (if any) against its CURRENT content — flags one as stale, missing, or unverifiable so you know which recipes might need regenerating. Recipes with no recorded source (hand-authored, or generated before this existed) are reported as "unverifiable", not a problem.</span>
    </label>
    <button type="button" id="ragCheckFreshnessBtn" class="btn btn-secondary">Check Freshness</button>
  </div>
  <div id="ragFreshnessResult" class="rag-progress" hidden></div>

  <h2>Hybrid Retrieval (Experimental)</h2>
  <p class="note" style="margin-top: 0;">
    Off by default. When enabled AND fully configured below, retrieval combines ordinary lexical (TF-IDF) matching
    with SEMANTIC similarity from an external embedding endpoint you provide, via Reciprocal Rank Fusion — lexical
    retrieval keeps working completely unaffected either way. <b>When active, your <code>.github/rag/</code> recipe
    text and generation queries are sent to the endpoint below for embedding</b> — only configure one you trust.
  </p>
  <div class="field">
    <label>
      Enable hybrid retrieval
      <span class="hint">Has no effect until an endpoint and model are also set below.</span>
    </label>
    <input type="checkbox" id="ragHybridEnabledToggle" />
  </div>
  <div class="field">
    <label>Embedding endpoint URL</label>
    <input type="text" id="ragSemanticEndpoint" class="rag-text-input" placeholder="https://api.example.com/v1/embeddings" />
  </div>
  <div class="field">
    <label>Model</label>
    <input type="text" id="ragSemanticModel" class="rag-text-input" placeholder="text-embedding-3-small" />
  </div>
  <div class="field">
    <label>
      API key
      <span class="hint" id="ragSemanticKeyStatus">No key saved.</span>
    </label>
    <div style="display: flex; gap: 6px;">
      <input type="password" id="ragSemanticApiKey" class="rag-text-input" placeholder="Leave blank to keep / clear" />
      <button type="button" id="ragSaveKeyBtn" class="btn btn-secondary">Save Key</button>
    </div>
  </div>
  <div style="display: flex; justify-content: flex-end; gap: 8px; margin-top: 4px;">
    <button type="button" id="ragTestConnectionBtn" class="btn btn-secondary">Test Connection</button>
  </div>
  <div id="ragSemanticTestResult" class="rag-progress" hidden></div>

  <h2>Generate RAG Corpus Format</h2>
  <p class="note" style="margin-top: 0;">
    Drop existing helper/config files below — or drop a single <code>.zip</code> of an entire project/framework (Java,
    Python, Scala, ...) and SoftPlay will unzip it, keep only supported source/config files (skipping
    <code>node_modules</code>, <code>.git</code>, build output, etc.), and generate a recipe for each — preserving the
    original folder structure under <code>.github/rag/</code>. SoftPlay asks Copilot to turn each file into a
    well-structured reusable-component recipe (creating <code>.github/rag/</code> if it doesn't exist yet). Requires
    "Link with GitHub Copilot LLM" (Control Panel) and a model picked above.
  </p>
  <div id="ragDropZone" class="rag-dropzone">
    <span>Drop files or a project <code>.zip</code> here, or</span>
    <button type="button" id="ragBrowseBtn" class="btn btn-secondary">Choose Files…</button>
    <input
      type="file"
      id="ragFileInput"
      multiple
      hidden
      accept=".java,.py,.js,.ts,.jsx,.tsx,.sh,.bash,.zsh,.bat,.cmd,.ps1,.json,.xml,.yml,.yaml,.properties,.ini,.toml,.sql,.scala,.kt,.kts,.rb,.go,.cs,.gradle,.groovy,.conf,.cfg,.env.example,.md,.txt,.zip"
    />
  </div>
  <div id="ragFileList" class="rag-file-list"></div>
  <div id="ragTokenUsage" class="rag-token-usage" hidden>
    Tokens used so far (this GitHub Copilot model) — Sent: <b id="ragTokensSent">0</b> · Received: <b id="ragTokensReceived">0</b> · Total: <b id="ragTokensTotal">0</b>
  </div>
  <div style="display: flex; justify-content: flex-end; margin-top: 10px;">
    <button type="button" id="ragGenerateBtn" class="btn" disabled>Generate</button>
    <button type="button" id="ragEndProcessBtn" class="btn btn-danger" hidden>End Process</button>
  </div>
  <div id="ragProgress" class="rag-progress" hidden></div>

  </div>
  </details>

  <p class="note">Changes apply immediately and persist across VS Code restarts.</p>

  <div class="architecture-link-row">
    <button type="button" id="architectureLink" class="architecture-link" title="Opens a local HTML page with the full architecture, caching, and LLM integration reference, plus a step-by-step usage guide">
      📐 Architecture &amp; Technical Information
    </button>
  </div>

  <script nonce="${nonce}">
    (function () {
      const vscode = acquireVsCodeApi();
      const languageSelect = document.getElementById('language');
      const versionSelect = document.getElementById('languageVersion');
      const copilotModelRow = document.getElementById('copilotModelRow');
      const copilotModelSelect = document.getElementById('copilotModel');
      const copilotStatus = document.getElementById('copilotStatus');
      const copilotStatusText = document.getElementById('copilotStatusText');
      let languageVersions = {};
      let pendingModelId = '';

      const browserField = document.getElementById('browserField');

      document.getElementById('architectureLink').addEventListener('click', () => {
        vscode.postMessage({ type: 'openArchitectureDoc' });
      });

      document.getElementById('copySecretKeyBtn').addEventListener('click', () => {
        vscode.postMessage({ type: 'copySecretKey' });
      });

      document.querySelectorAll('input[name="agenticModeEnabled"]').forEach((radio) => {
        radio.addEventListener('change', () => {
          if (radio.checked) {
            vscode.postMessage({ type: 'update', payload: { agenticModeEnabled: radio.value === 'true' } });
          }
        });
      });

      const ragEnabledToggle = document.getElementById('ragEnabledToggle');
      ragEnabledToggle.addEventListener('change', () => {
        vscode.postMessage({ type: 'update', payload: { ragEnabled: ragEnabledToggle.checked } });
      });

      // --- "Check Freshness" (Phase 5: active source-staleness check) ---
      const ragCheckFreshnessBtn = document.getElementById('ragCheckFreshnessBtn');
      const ragFreshnessResultEl = document.getElementById('ragFreshnessResult');
      ragCheckFreshnessBtn.addEventListener('click', () => {
        ragCheckFreshnessBtn.disabled = true;
        ragFreshnessResultEl.hidden = false;
        ragFreshnessResultEl.innerHTML = '';
        const line = document.createElement('div');
        line.className = 'rag-progress-line started';
        line.textContent = 'Checking…';
        ragFreshnessResultEl.appendChild(line);
        vscode.postMessage({ type: 'checkRagFreshness' });
      });

      function renderFreshnessResult(payload) {
        ragCheckFreshnessBtn.disabled = false;
        ragFreshnessResultEl.innerHTML = '';
        if (payload.error) {
          const line = document.createElement('div');
          line.className = 'rag-progress-line error';
          line.textContent = payload.error;
          ragFreshnessResultEl.appendChild(line);
          return;
        }
        const report = payload.report;
        if (report.entries.length === 0) {
          const line = document.createElement('div');
          line.className = 'rag-progress-line skipped';
          line.textContent = 'No RAG recipes found under .github/rag.';
          ragFreshnessResultEl.appendChild(line);
          return;
        }
        report.entries.forEach((entry) => {
          const line = document.createElement('div');
          line.className = 'rag-progress-line ' + entry.state;
          line.textContent = '[' + entry.state.toUpperCase() + '] ' + entry.relativePath + ' — ' + entry.detail;
          ragFreshnessResultEl.appendChild(line);
        });
        const c = report.counts;
        const summary = document.createElement('div');
        summary.className = 'rag-progress-line done';
        summary.textContent =
          'Summary: ' + report.entries.length + ' recipe(s) — ' + c.fresh + ' fresh, ' + c.stale + ' stale, ' +
          c.missing + ' missing, ' + c.unverifiable + ' unverifiable, ' + c.error + ' error(s).';
        ragFreshnessResultEl.appendChild(summary);
      }

      // --- Hybrid Retrieval (Experimental) — Phase 6 ---
      const ragHybridEnabledToggle = document.getElementById('ragHybridEnabledToggle');
      const ragSemanticEndpointInput = document.getElementById('ragSemanticEndpoint');
      const ragSemanticModelInput = document.getElementById('ragSemanticModel');
      const ragSemanticApiKeyInput = document.getElementById('ragSemanticApiKey');
      const ragSemanticKeyStatusEl = document.getElementById('ragSemanticKeyStatus');
      const ragSaveKeyBtn = document.getElementById('ragSaveKeyBtn');
      const ragTestConnectionBtn = document.getElementById('ragTestConnectionBtn');
      const ragSemanticTestResultEl = document.getElementById('ragSemanticTestResult');

      ragHybridEnabledToggle.addEventListener('change', () => {
        vscode.postMessage({ type: 'update', payload: { ragHybridEnabled: ragHybridEnabledToggle.checked } });
      });
      ragSemanticEndpointInput.addEventListener('change', () => {
        vscode.postMessage({ type: 'update', payload: { ragSemanticEndpoint: ragSemanticEndpointInput.value.trim() } });
      });
      ragSemanticModelInput.addEventListener('change', () => {
        vscode.postMessage({ type: 'update', payload: { ragSemanticModel: ragSemanticModelInput.value.trim() } });
      });
      ragSaveKeyBtn.addEventListener('click', () => {
        vscode.postMessage({ type: 'saveSemanticApiKey', payload: { apiKey: ragSemanticApiKeyInput.value } });
        ragSemanticApiKeyInput.value = '';
      });
      ragTestConnectionBtn.addEventListener('click', () => {
        ragSemanticTestResultEl.hidden = false;
        ragSemanticTestResultEl.innerHTML = '';
        const line = document.createElement('div');
        line.className = 'rag-progress-line started';
        line.textContent = 'Testing…';
        ragSemanticTestResultEl.appendChild(line);
        vscode.postMessage({
          type: 'testSemanticProvider',
          payload: { endpoint: ragSemanticEndpointInput.value.trim(), model: ragSemanticModelInput.value.trim() }
        });
      });

      // --- "Generate RAG Corpus format" — drop zone / file picker / Generate ---
      const ragDropZone = document.getElementById('ragDropZone');
      const ragFileInput = document.getElementById('ragFileInput');
      const ragBrowseBtn = document.getElementById('ragBrowseBtn');
      const ragFileListEl = document.getElementById('ragFileList');
      const ragGenerateBtn = document.getElementById('ragGenerateBtn');
      const ragEndProcessBtn = document.getElementById('ragEndProcessBtn');
      const ragProgressEl = document.getElementById('ragProgress');
      const ragTokenUsageEl = document.getElementById('ragTokenUsage');
      const ragTokensSentEl = document.getElementById('ragTokensSent');
      const ragTokensReceivedEl = document.getElementById('ragTokensReceived');
      const ragTokensTotalEl = document.getElementById('ragTokensTotal');

      function ragUpdateTokenUsage(tokensSoFar) {
        if (!tokensSoFar) return;
        ragTokenUsageEl.hidden = false;
        ragTokensSentEl.textContent = tokensSoFar.sent.toLocaleString();
        ragTokensReceivedEl.textContent = tokensSoFar.received.toLocaleString();
        ragTokensTotalEl.textContent = (tokensSoFar.sent + tokensSoFar.received).toLocaleString();
      }
      // Generous enough for a real source/config file, small enough to
      // guard against a pathological paste bloating the Copilot prompt —
      // this content is read entirely into memory and sent as-is.
      const RAG_MAX_FILE_BYTES = 200 * 1024;
      // A whole project/framework zip is a different scale of upload than
      // a hand-picked file — generous enough for a real small-to-medium
      // repo, small enough that reading it into memory + base64-encoding
      // it for the postMessage to the extension host stays snappy.
      const RAG_MAX_ZIP_BYTES = 25 * 1024 * 1024;
      let ragPendingFiles = []; // { fileName, relativePath, content }

      function arrayBufferToBase64(buffer) {
        let binary = '';
        const bytes = new Uint8Array(buffer);
        const chunkSize = 0x8000;
        for (let i = 0; i < bytes.length; i += chunkSize) {
          binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunkSize));
        }
        return btoa(binary);
      }

      function ragAppendProgressLine(fileName, status, message) {
        ragProgressEl.hidden = false;
        const line = document.createElement('div');
        line.className = 'rag-progress-line ' + status;
        line.textContent = fileName ? fileName + ' — ' + (message || status) : message || status;
        ragProgressEl.appendChild(line);
        ragProgressEl.scrollTop = ragProgressEl.scrollHeight;
      }

      function ragUpdateFileListUI() {
        ragFileListEl.innerHTML = '';
        ragPendingFiles.forEach((file, index) => {
          const item = document.createElement('div');
          item.className = 'rag-file-item';

          const name = document.createElement('span');
          name.className = 'rag-file-name';
          const displayName = (file.relativePath ? file.relativePath + '/' : '') + file.fileName;
          name.textContent = displayName;
          name.title = displayName;

          const size = document.createElement('span');
          size.className = 'rag-file-size';
          size.textContent = (file.content.length / 1024).toFixed(1) + ' KB';

          const removeBtn = document.createElement('button');
          removeBtn.type = 'button';
          removeBtn.className = 'rag-file-remove';
          removeBtn.title = 'Remove';
          removeBtn.textContent = '✕';
          removeBtn.addEventListener('click', () => {
            ragPendingFiles.splice(index, 1);
            ragUpdateFileListUI();
          });

          item.appendChild(name);
          item.appendChild(size);
          item.appendChild(removeBtn);
          ragFileListEl.appendChild(item);
        });
        ragGenerateBtn.disabled = ragPendingFiles.length === 0;
      }

      function ragAddFiles(fileList) {
        Array.from(fileList).forEach((file) => {
          const isZip =
            /\.zip$/i.test(file.name) || file.type === 'application/zip' || file.type === 'application/x-zip-compressed';
          if (isZip) {
            if (file.size > RAG_MAX_ZIP_BYTES) {
              ragAppendProgressLine(file.name, 'error', 'Skipped — zip larger than 25 MB.');
              return;
            }
            ragAppendProgressLine(file.name, 'started', 'Reading zip and extracting supported files…');
            const reader = new FileReader();
            reader.onload = () => {
              vscode.postMessage({
                type: 'expandRagZip',
                payload: { fileName: file.name, base64: arrayBufferToBase64(reader.result) }
              });
            };
            reader.onerror = () => ragAppendProgressLine(file.name, 'error', 'Could not read this zip file.');
            reader.readAsArrayBuffer(file);
            return;
          }

          if (file.size > RAG_MAX_FILE_BYTES) {
            ragAppendProgressLine(file.name, 'error', 'Skipped — larger than 200 KB.');
            return;
          }
          const reader = new FileReader();
          reader.onload = () => {
            ragPendingFiles.push({ fileName: file.name, relativePath: '', content: String(reader.result || '') });
            ragUpdateFileListUI();
          };
          reader.onerror = () => ragAppendProgressLine(file.name, 'error', 'Could not read this file.');
          reader.readAsText(file);
        });
      }

      ragBrowseBtn.addEventListener('click', () => ragFileInput.click());
      ragFileInput.addEventListener('change', () => {
        ragAddFiles(ragFileInput.files);
        ragFileInput.value = '';
      });

      ['dragenter', 'dragover'].forEach((evt) => {
        ragDropZone.addEventListener(evt, (e) => {
          e.preventDefault();
          ragDropZone.classList.add('dragover');
        });
      });
      ['dragleave', 'drop'].forEach((evt) => {
        ragDropZone.addEventListener(evt, (e) => {
          e.preventDefault();
          ragDropZone.classList.remove('dragover');
        });
      });
      ragDropZone.addEventListener('drop', (e) => {
        if (e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files.length) {
          ragAddFiles(e.dataTransfer.files);
        }
      });

      ragGenerateBtn.addEventListener('click', () => {
        if (ragPendingFiles.length === 0) return;
        ragGenerateBtn.hidden = true;
        ragEndProcessBtn.hidden = false;
        ragEndProcessBtn.disabled = false;
        ragEndProcessBtn.textContent = 'End Process';
        ragProgressEl.hidden = false;
        ragProgressEl.innerHTML = '';
        ragTokenUsageEl.hidden = true; // a fresh batch's own totals start over, not from the last batch's tail
        vscode.postMessage({
          type: 'generateRagCorpus',
          payload: { files: ragPendingFiles.map((f) => ({ fileName: f.fileName, relativePath: f.relativePath || '', content: f.content })) }
        });
      });

      ragEndProcessBtn.addEventListener('click', () => {
        // Disabled immediately (not hidden) — stays in place as feedback
        // that the click registered, until the in-flight batch's own
        // 'ragGenerationDone' (always sent, win or cancel) swaps it back to
        // "Generate". Recipes already saved earlier in this batch, and
        // anything already in .github/rag from a prior run, are never
        // touched by this — only whichever unit(s) haven't been written
        // yet are skipped.
        ragEndProcessBtn.disabled = true;
        ragEndProcessBtn.textContent = 'Ending…';
        ragAppendProgressLine('', 'started', 'Ending process — cancelling the in-flight Copilot request and skipping any remaining files…');
        vscode.postMessage({ type: 'cancelRagGeneration' });
      });

      document.querySelectorAll('input[name="browserChannel"]').forEach((radio) => {
        radio.addEventListener('change', () => {
          if (radio.checked) {
            vscode.postMessage({ type: 'update', payload: { browserChannel: radio.value } });
          }
        });
      });

      document.querySelectorAll('input[name="automationMode"]').forEach((radio) => {
        radio.addEventListener('change', () => {
          if (radio.checked) {
            vscode.postMessage({ type: 'update', payload: { automationMode: radio.value } });
          }
        });
      });

      function applyAutomationMode(mode) {
        const isApi = mode === 'api';
        document.querySelectorAll('input[name="browserChannel"]').forEach((radio) => {
          radio.disabled = isApi;
        });
        browserField.classList.toggle('disabled', isApi);
      }

      languageSelect.addEventListener('change', () => {
        vscode.postMessage({ type: 'update', payload: { language: languageSelect.value } });
      });

      versionSelect.addEventListener('change', () => {
        vscode.postMessage({ type: 'update', payload: { languageVersion: versionSelect.value } });
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
        if (message.type === 'ragZipExpanded') {
          const p = message.payload;
          if (p.error) {
            ragAppendProgressLine(p.fileName, 'error', 'Could not read as a zip — ' + p.error);
          } else {
            p.files.forEach((f) => ragPendingFiles.push(f));
            ragUpdateFileListUI();
            const skippedNote = p.skippedCount ? ', skipped ' + p.skippedCount + ' (unsupported type or excluded folder)' : '';
            ragAppendProgressLine(p.fileName, 'success', 'Extracted ' + p.files.length + ' supported file(s)' + skippedNote + '.');
          }
          return;
        }
        if (message.type === 'ragFreshnessResult') {
          renderFreshnessResult(message.payload);
          return;
        }
        if (message.type === 'semanticKeyStatus') {
          ragSemanticKeyStatusEl.textContent = message.payload.hasKey ? 'A key is saved.' : 'No key saved.';
          return;
        }
        if (message.type === 'semanticTestResult') {
          const r = message.payload;
          ragSemanticTestResultEl.hidden = false;
          ragSemanticTestResultEl.innerHTML = '';
          const line = document.createElement('div');
          line.className = 'rag-progress-line ' + (r.ok ? 'success' : 'error');
          line.textContent = r.message;
          ragSemanticTestResultEl.appendChild(line);
          return;
        }
        if (message.type === 'ragGenerationProgress') {
          const p = message.payload;
          ragAppendProgressLine(p.fileName, p.status, p.message);
          ragUpdateTokenUsage(p.tokensSoFar);
          return;
        }
        if (message.type === 'ragGenerationDone') {
          const r = message.payload;
          if (r.error) {
            ragAppendProgressLine('', 'error', r.error);
          } else {
            ragAppendProgressLine('', 'done', 'Done — ' + r.succeeded + ' generated, ' + r.skipped + ' skipped, ' + r.failed + ' failed.');
            // Only clear the queue on a real attempt (not the early-exit
            // "Copilot isn't set up" error above) — a genuine failure per
            // file already stays visible in the progress log for review,
            // but the pending list itself is done with regardless. This
            // also covers "End Process": a cancelled batch still lands here
            // (skipped units just count toward the skipped total), so the
            // queue clears the exact same way a completed one does.
            ragPendingFiles = [];
            ragUpdateFileListUI();
          }
          // Always restore "Generate" in place of "End Process" here —
          // this is the ONE terminal message every batch ends with, whether
          // it ran to completion, failed outright, or was cancelled via
          // "End Process" above.
          ragEndProcessBtn.hidden = true;
          ragEndProcessBtn.disabled = false;
          ragEndProcessBtn.textContent = 'End Process';
          ragGenerateBtn.hidden = false;
          ragGenerateBtn.disabled = ragPendingFiles.length === 0;
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
        document.querySelectorAll('input[name="automationMode"]').forEach((radio) => {
          radio.checked = radio.value === settings.automationMode;
        });
        applyAutomationMode(settings.automationMode);
        languageSelect.value = settings.language;
        renderVersions(settings.language, settings.languageVersion);
        ragEnabledToggle.checked = settings.ragEnabled;
        ragHybridEnabledToggle.checked = settings.ragHybridEnabled;
        if (document.activeElement !== ragSemanticEndpointInput) {
          ragSemanticEndpointInput.value = settings.ragSemanticEndpoint;
        }
        if (document.activeElement !== ragSemanticModelInput) {
          ragSemanticModelInput.value = settings.ragSemanticModel;
        }
        document.querySelectorAll('input[name="agenticModeEnabled"]').forEach((radio) => {
          radio.checked = radio.value === String(settings.agenticModeEnabled);
        });

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
