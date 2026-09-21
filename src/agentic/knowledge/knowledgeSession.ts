import {
  ApiContext,
  buildAuthorization,
  classifyAttachment,
  downloadAttachment,
  fetchConfluencePage,
  fetchJiraIssue,
  FetchedResource,
  parseConfluencePageUrl,
  parseJiraIssueUrl,
  RawAttachment
} from './atlassianApi';
import { ConfigLoadResult, resolveKnowledgeUrl, toPublicConnection } from './connectionConfig';
import { KnowledgeTransport, TransportError } from './knowledgeTransport';
import {
  AttachmentProvenance,
  AttachmentView,
  ConnectionLimits,
  Credentials,
  KnowledgeApiError,
  KnowledgeConnection,
  KnowledgeErrorCode,
  KnowledgeSourceView,
  PublicConnection
} from './knowledgeTypes';

/**
 * One Total Agentic session's view of its Jira/Confluence connections:
 * session-only credentials, the registry of retrieved resources (host-owned
 * IDs), pending "connect securely" actions, and the consent-gated attachment
 * import. Zero `vscode` import — every UI/IO boundary is injected as a
 * `KnowledgeHost`, so the real orchestration is exercised by tests with fakes.
 *
 * Enforcement lives HERE, outside the model: no network request happens
 * before credentials exist; an attachment is only downloaded after the host's
 * own selection UI returns its ID; a model can never supply a URL. Every
 * `await` is followed by a stale check against `generation`, which
 * `reset()` bumps — a result that completes after Clear Data commits nothing.
 *
 * Credentials are held in this object's memory only (never persisted) and are
 * dropped by `reset()`. No claim is made that the runtime zeroes the memory.
 */

export interface KnowledgeHost {
  /** Masked VS Code input. Resolve `undefined` when the user cancels. Must honour `signal`. */
  promptCredentials(request: { connection: PublicConnection }, signal: AbortSignal): Promise<Credentials | undefined>;
  /** Host-owned selection UI. Resolve the chosen attachment IDs, or `undefined` if cancelled. */
  selectAttachments(request: { source: KnowledgeSourceView; choices: AttachmentView[]; preselected: string[] }, signal: AbortSignal): Promise<string[] | undefined>;
  /** Puts a downloaded file into Input Files (real ingestion). Must not commit when `isCurrent()` is false. */
  ingestAttachment(
    request: { fileName: string; buffer: Buffer; provenance: AttachmentProvenance },
    isCurrent: () => boolean
  ): Promise<{ ok: true; fileName: string } | { ok: false; reason: string }>;
  /** Existing credential protection for model-bound text. Throw when the text cannot be safely protected. */
  redact(text: string): Promise<string>;
}

export interface KnowledgeSessionDeps {
  getConfig: () => Promise<ConfigLoadResult>;
  createTransport: (limits: ConnectionLimits) => KnowledgeTransport;
  host: KnowledgeHost;
  now?: () => Date;
  /** Cap on the text kept per resource (disclosed as `truncated`). */
  maxSourceChars?: number;
}

export interface PendingConnectAction {
  actionId: string;
  kind: 'connect' | 'reconnect';
  connection: PublicConnection;
  /** The link the user pasted — retried automatically once they connect. */
  url: string;
}

export type OpenResult =
  | { status: 'ok'; source: KnowledgeSourceView; fromCache: boolean }
  | { status: 'needs_authentication'; action: PendingConnectAction }
  | { status: 'error'; code: KnowledgeErrorCode; message: string; action?: PendingConnectAction }
  | { status: 'cancelled' }
  | { status: 'stale' };

export type ImportResult =
  | { status: 'done'; imported: { attachmentId: string; filename: string; fileName: string }[]; failed: { attachmentId: string; filename: string; reason: string }[] }
  | { status: 'declined' }
  | { status: 'needs_authentication'; action: PendingConnectAction }
  | { status: 'error'; code: KnowledgeErrorCode; message: string }
  | { status: 'cancelled' }
  | { status: 'stale' };

interface InternalAttachment extends AttachmentView {
  sourceId: string;
  providerId: string;
  downloadUrl?: string;
  importedFileName?: string;
}

interface InternalSource extends Omit<KnowledgeSourceView, 'attachments' | 'textChars'> {
  text: string;
  attachments: InternalAttachment[];
}

export interface SourceSegment {
  sourceId: string;
  label: string;
  url: string;
  retrievedAt: string;
  text: string;
  truncated: boolean;
  notes: string[];
}

export type SourceReadResult =
  | { status: 'ok'; sourceId: string; title: string; retrievedAt: string; totalChars: number; offset: number; returnedChars: number; hasMore: boolean; content: string }
  | { status: 'error'; code: KnowledgeErrorCode; message: string };

const DEFAULT_MAX_SOURCE_CHARS = 60_000;
const HARD_MAX_READ_CHARS = 20_000;
const DEFAULT_READ_CHARS = 8_000;
const SETUP_GUIDANCE = 'An administrator sets each connection\'s address in config/agentic-connections.json ("enabled", "baseUrl", "deployment", "authMode") before packaging.';

export class KnowledgeSession {
  private sources = new Map<string, InternalSource>();
  private keyIndex = new Map<string, string>();
  private credentials = new Map<string, Credentials>();
  private pending = new Map<string, PendingConnectAction>();
  private ops = new Set<AbortController>();
  private nextSource = 1;
  private nextAttachment = 1;
  private nextAction = 1;
  private gen = 0;

  constructor(private readonly deps: KnowledgeSessionDeps) {}

  get generation(): number {
    return this.gen;
  }

  hasCredentials(connectionId: string): boolean {
    return this.credentials.has(connectionId);
  }

  /** Clear Data / dispose: cancels every operation and forgets credentials, sources and pending actions. */
  reset(): void {
    this.gen++;
    for (const op of this.ops) {
      op.abort();
    }
    this.ops.clear();
    this.sources.clear();
    this.keyIndex.clear();
    this.credentials.clear();
    this.pending.clear();
    this.nextSource = 1;
    this.nextAttachment = 1;
    this.nextAction = 1;
  }

  // ------------------------------------------------------------------ views

  getSources(): KnowledgeSourceView[] {
    return [...this.sources.values()].map((s) => this.toView(s));
  }

  getSource(sourceId: string): KnowledgeSourceView | undefined {
    const source = this.sources.get(sourceId);
    return source ? this.toView(source) : undefined;
  }

  /** A file that came from an attachment was removed from Input Files: offer that attachment for import again. */
  unmarkImported(attachmentId: string): KnowledgeSourceView | undefined {
    for (const source of this.sources.values()) {
      const attachment = source.attachments.find((a) => a.id === attachmentId);
      if (attachment && attachment.status === 'imported') {
        attachment.status = 'importable';
        attachment.importedFileName = undefined;
        return this.toView(source);
      }
    }
    return undefined;
  }

  /** The text of every retrieved resource, for the per-turn context. */
  segments(): SourceSegment[] {
    return [...this.sources.values()].map((s) => ({
      sourceId: s.id,
      label: `${s.connectionLabel} ${s.key}`,
      url: s.url,
      retrievedAt: s.retrievedAt,
      text: s.text,
      truncated: s.truncated,
      notes: s.conversionNotes
    }));
  }

  readSourceText(sourceId: string, offset = 0, maxChars = DEFAULT_READ_CHARS): SourceReadResult {
    const source = this.sources.get(sourceId);
    if (!source) {
      return { status: 'error', code: 'unknown_source', message: `There is no retrieved resource "${sourceId}". Known: ${[...this.sources.keys()].join(', ') || '(none)'}.` };
    }
    const start = Math.max(0, Math.min(offset, source.text.length));
    const content = source.text.slice(start, start + Math.max(1, Math.min(maxChars, HARD_MAX_READ_CHARS)));
    return {
      status: 'ok',
      sourceId,
      title: source.title,
      retrievedAt: source.retrievedAt,
      totalChars: source.text.length,
      offset: start,
      returnedChars: content.length,
      hasMore: start + content.length < source.text.length,
      content
    };
  }

  private toView(s: InternalSource): KnowledgeSourceView {
    const { text, attachments, ...rest } = s;
    return {
      ...rest,
      textChars: text.length,
      attachments: attachments.map(({ sourceId: _s, providerId: _p, downloadUrl: _d, importedFileName: _f, ...view }) => ({ ...view }))
    };
  }

  // ------------------------------------------------------------- operations

  private beginOp(external?: AbortSignal): AbortController {
    const op = new AbortController();
    this.ops.add(op);
    if (external) {
      if (external.aborted) {
        op.abort();
      } else {
        external.addEventListener('abort', () => op.abort(), { once: true });
      }
    }
    return op;
  }

  /** Called before EVERY state mutation and after every await that precedes one. After Clear Data the answer is
   * `stale`; after Stop it is `cancelled`. Either way nothing is stored, registered or ingested. */
  private interrupted(op: AbortController, stale: () => boolean): { status: 'stale' } | { status: 'cancelled' } | undefined {
    if (stale()) {
      return { status: 'stale' };
    }
    return op.signal.aborted ? { status: 'cancelled' } : undefined;
  }

  private createAction(kind: PendingConnectAction['kind'], connection: KnowledgeConnection, url: string): PendingConnectAction {
    const action: PendingConnectAction = { actionId: `act-${this.nextAction++}`, kind, connection: toPublicConnection(connection), url };
    this.pending.set(action.actionId, action);
    return action;
  }

  /** Reads the link the user pasted: resolves it to a configured connection, asks to connect first when needed, then retrieves it. */
  async openLink(url: string, options: { refresh?: boolean; signal?: AbortSignal } = {}): Promise<OpenResult> {
    const gen = this.gen;
    const op = this.beginOp(options.signal);
    try {
      return await this.openWith(url, options.refresh === true, op, () => gen !== this.gen);
    } finally {
      this.ops.delete(op);
    }
  }

  /** The user clicked "Connect securely": collect credentials through the host's masked input, then retrieve the pending link. */
  async connect(actionId: string, options: { signal?: AbortSignal } = {}): Promise<OpenResult> {
    const pending = this.pending.get(actionId);
    if (!pending) {
      return { status: 'error', code: 'unknown_action', message: 'That connect request is no longer available. Paste the link again.' };
    }
    const gen = this.gen;
    const stale = (): boolean => gen !== this.gen;
    const op = this.beginOp(options.signal);
    try {
      const config = await this.deps.getConfig();
      const halted1 = this.interrupted(op, stale);
      if (halted1) {
        return halted1;
      }
      const connection = config.ok ? config.value.connections.find((c) => c.id === pending.connection.id) : undefined;
      if (!connection || !connection.enabled || connection.configError) {
        return { status: 'error', code: 'invalid_config', message: `The connection "${pending.connection.label}" is not available (it may have been disabled or changed).` };
      }
      const credentials = await this.deps.host.promptCredentials({ connection: toPublicConnection(connection) }, op.signal);
      // Cleared or cancelled while the prompt was open: store NOTHING.
      const halted2 = this.interrupted(op, stale);
      if (halted2) {
        return halted2;
      }
      if (!credentials || !credentials.secret) {
        return { status: 'cancelled' };
      }
      this.credentials.set(connection.id, credentials);
      this.pending.delete(actionId);
      return await this.openWith(pending.url, true, op, stale);
    } finally {
      this.ops.delete(op);
    }
  }

  private async openWith(url: string, refresh: boolean, op: AbortController, stale: () => boolean): Promise<OpenResult> {
    const config = await this.deps.getConfig();
    const halted3 = this.interrupted(op, stale);
    if (halted3) {
      return halted3;
    }
    if (!config.ok) {
      return { status: 'error', code: 'config_error', message: `${config.error} ${SETUP_GUIDANCE}` };
    }
    const resolution = resolveKnowledgeUrl(config.value, url);
    switch (resolution.kind) {
      case 'rejected':
        return { status: 'error', code: 'unsupported_url', message: resolution.reason };
      case 'no_match':
        return {
          status: 'error',
          code: 'no_match',
          message:
            `That link doesn't match any configured connection${resolution.configured.length ? ` (configured: ${resolution.configured.join(', ')})` : ' (none is configured yet)'}. ` +
            `Nothing was contacted. ${SETUP_GUIDANCE}`
        };
      case 'disabled':
        return { status: 'error', code: 'disabled', message: `"${resolution.connection.label}" is configured but disabled. Set "enabled": true for it in config/agentic-connections.json.` };
      case 'invalid_config':
        return { status: 'error', code: 'invalid_config', message: `"${resolution.connection.label}" is enabled but its configuration is invalid: ${resolution.connection.configError}.` };
      case 'ambiguous':
        return {
          status: 'error',
          code: 'ambiguous',
          message: `Several connections share this address (${resolution.connections.map((c) => c.label).join(', ')}). Give each its own baseUrl or context path in config/agentic-connections.json.`
        };
    }
    const connection = resolution.connection;
    const basePath = connection.basePath ?? '';
    const ref = connection.product === 'jira' ? parseJiraIssueUrl(resolution.url, basePath) : parseConfluencePageUrl(resolution.url, basePath);
    if (!ref.ok) {
      return { status: 'error', code: 'unsupported_url', message: ref.reason };
    }
    const cacheKey = `${connection.id}|${ref.value}`;
    const cachedId = this.keyIndex.get(cacheKey);
    if (cachedId && !refresh) {
      return { status: 'ok', source: this.toView(this.sources.get(cachedId)!), fromCache: true };
    }
    const credentials = this.credentials.get(connection.id);
    if (!credentials) {
      // No credentials, no request: connecting is a deliberate user action.
      return { status: 'needs_authentication', action: this.createAction('connect', connection, url) };
    }
    return this.retrieve(connection, config.value.limits, ref.value, url, credentials, op, stale);
  }

  private apiContext(connection: KnowledgeConnection, limits: ConnectionLimits, credentials: Credentials, op: AbortController): ApiContext {
    return {
      connection,
      limits,
      transport: this.deps.createTransport(limits),
      authorization: buildAuthorization(connection.authMode ?? 'pat', credentials),
      signal: op.signal
    };
  }

  /** Maps a failure into a result. A 401/403 drops the credentials and offers a DELIBERATE reconnect — never an automatic re-prompt. */
  private failure(err: unknown, connection: KnowledgeConnection, url: string, stale: () => boolean): OpenResult {
    if (err instanceof TransportError && err.code === 'aborted') {
      return stale() ? { status: 'stale' } : { status: 'cancelled' };
    }
    if (stale()) {
      return { status: 'stale' };
    }
    if (err instanceof KnowledgeApiError) {
      if (err.code === 'auth_failed') {
        this.credentials.delete(connection.id);
        return { status: 'error', code: err.code, message: `${err.message} Nothing was retrieved.`, action: this.createAction('reconnect', connection, url) };
      }
      return { status: 'error', code: err.code, message: err.message };
    }
    return { status: 'error', code: 'invalid_response', message: 'Something unexpected went wrong while reading the resource.' };
  }

  private async retrieve(
    connection: KnowledgeConnection,
    limits: ConnectionLimits,
    key: string,
    url: string,
    credentials: Credentials,
    op: AbortController,
    stale: () => boolean
  ): Promise<OpenResult> {
    let fetched: FetchedResource;
    try {
      const api = this.apiContext(connection, limits, credentials, op);
      fetched = connection.product === 'jira' ? await fetchJiraIssue(api, key) : await fetchConfluencePage(api, key);
    } catch (err) {
      return this.failure(err, connection, url, stale);
    }
    const halted4 = this.interrupted(op, stale);
    if (halted4) {
      return halted4;
    }
    let text: string;
    let summaryLines: string[];
    let title: string;
    try {
      text = await this.deps.host.redact(fetched.text);
      summaryLines = await Promise.all(fetched.summaryLines.map((l) => this.deps.host.redact(l)));
      title = await this.deps.host.redact(fetched.title);
    } catch {
      // A redaction that failed BECAUSE the session was cleared or stopped is not a redaction error to report.
      const interruptedByUser = this.interrupted(op, stale);
      if (interruptedByUser) {
        return interruptedByUser;
      }
      return { status: 'error', code: 'redaction_failed', message: 'The retrieved content could not be checked for credentials, so it was not used. Nothing was added to the conversation.' };
    }
    const halted5 = this.interrupted(op, stale);
    if (halted5) {
      return halted5;
    }
    return { status: 'ok', source: this.register(connection, limits, fetched, { text, summaryLines, title }, url), fromCache: false };
  }

  private register(connection: KnowledgeConnection, limits: ConnectionLimits, fetched: FetchedResource, safe: { text: string; summaryLines: string[]; title: string }, url: string): KnowledgeSourceView {
    const cacheKey = `${connection.id}|${fetched.key}`;
    const existingId = this.keyIndex.get(cacheKey);
    const previous = existingId ? this.sources.get(existingId) : undefined;
    const id = existingId ?? `src-${this.nextSource++}`;
    const maxChars = this.deps.maxSourceChars ?? DEFAULT_MAX_SOURCE_CHARS;
    const truncated = safe.text.length > maxChars;

    const attachments: InternalAttachment[] = fetched.attachments.map((raw: RawAttachment) => {
      const before = previous?.attachments.find((a) => a.providerId === raw.providerId);
      const classified = classifyAttachment(raw, limits);
      const imported = before?.status === 'imported';
      return {
        id: before?.id ?? `att-${this.nextAttachment++}`,
        sourceId: id,
        providerId: raw.providerId,
        filename: raw.filename,
        mimeType: raw.mimeType,
        sizeBytes: raw.sizeBytes,
        status: imported ? 'imported' : classified.status,
        reason: imported ? undefined : classified.reason,
        downloadUrl: raw.downloadUrl,
        importedFileName: imported ? before?.importedFileName : undefined
      };
    });
    const parsed = new URL(url.trim());
    const source: InternalSource = {
      id,
      connectionId: connection.id,
      connectionLabel: connection.label,
      product: connection.product,
      kind: fetched.kind,
      key: fetched.key,
      title: safe.title,
      url: `${parsed.origin}${parsed.pathname}${parsed.search}`,
      retrievedAt: (this.deps.now?.() ?? new Date()).toISOString(),
      summaryLines: safe.summaryLines,
      conversionNotes: fetched.conversionNotes,
      attachmentListingComplete: fetched.attachmentListingComplete,
      truncated,
      text: truncated ? safe.text.slice(0, maxChars) : safe.text,
      attachments
    };
    this.sources.set(id, source);
    this.keyIndex.set(cacheKey, id);
    return this.toView(source);
  }

  // ----------------------------------------------------------- attachments

  /**
   * Imports attachments of an already-retrieved resource. ALWAYS goes through
   * the host's selection UI — a conversational "yes" never downloads anything
   * by itself — and only IDs the host returns (and that belong to THIS
   * resource) are fetched, from URLs the host validated at listing time.
   */
  async importAttachments(sourceId: string, requestedIds: string[] | undefined, options: { signal?: AbortSignal } = {}): Promise<ImportResult> {
    const gen = this.gen;
    const stale = (): boolean => gen !== this.gen;
    const op = this.beginOp(options.signal);
    try {
      const source = this.sources.get(sourceId);
      if (!source) {
        return { status: 'error', code: 'unknown_source', message: `There is no retrieved resource "${sourceId}".` };
      }
      const config = await this.deps.getConfig();
      const halted6 = this.interrupted(op, stale);
      if (halted6) {
        return halted6;
      }
      const connection = config.ok ? config.value.connections.find((c) => c.id === source.connectionId) : undefined;
      if (!config.ok || !connection || !connection.enabled || connection.configError) {
        return { status: 'error', code: 'invalid_config', message: `The connection "${source.connectionLabel}" is not available, so its attachments cannot be read.` };
      }
      const limits = config.value.limits;
      const credentials = this.credentials.get(connection.id);
      if (!credentials) {
        return { status: 'needs_authentication', action: this.createAction('connect', connection, source.url) };
      }

      const choices = source.attachments.filter((a) => a.status === 'importable');
      if (requestedIds) {
        for (const id of requestedIds) {
          const found = source.attachments.find((a) => a.id === id);
          if (!found) {
            return { status: 'error', code: 'unknown_attachment', message: `"${id}" is not an attachment of ${source.key}. Its attachments: ${source.attachments.map((a) => a.id).join(', ') || '(none)'}.` };
          }
          if (found.status !== 'importable') {
            return { status: 'error', code: 'unknown_attachment', message: `${found.id} (${found.filename}) cannot be imported: ${found.status === 'imported' ? 'it was already imported' : found.reason}` };
          }
        }
      }
      if (choices.length === 0) {
        return { status: 'error', code: 'unknown_attachment', message: 'None of this resource\'s attachments can be imported (they are unsupported types, too large, or already imported).' };
      }

      const view = (a: InternalAttachment): AttachmentView => ({ id: a.id, filename: a.filename, mimeType: a.mimeType, sizeBytes: a.sizeBytes, status: a.status, reason: a.reason });
      const selected = await this.deps.host.selectAttachments({ source: this.toView(source), choices: choices.map(view), preselected: requestedIds ?? [] }, op.signal);
      const halted7 = this.interrupted(op, stale);
      if (halted7) {
        return halted7;
      }
      if (op.signal.aborted) {
        return { status: 'cancelled' };
      }
      if (!selected || selected.length === 0) {
        return { status: 'declined' };
      }
      const approved = [...new Set(selected)];
      const chosen: InternalAttachment[] = [];
      for (const id of approved) {
        const found = choices.find((a) => a.id === id);
        if (!found) {
          return { status: 'error', code: 'unknown_attachment', message: `"${id}" was not one of the attachments offered, so nothing was downloaded.` };
        }
        chosen.push(found);
      }
      if (chosen.length > limits.maxAttachmentCount) {
        return { status: 'error', code: 'limit_exceeded', message: `${chosen.length} attachments were selected; at most ${limits.maxAttachmentCount} can be imported at once. Nothing was downloaded.` };
      }
      const batchBytes = chosen.reduce((sum, a) => sum + (a.sizeBytes ?? 0), 0);
      if (batchBytes > limits.maxAttachmentBatchBytes) {
        return {
          status: 'error',
          code: 'limit_exceeded',
          message: `The selected attachments total ${(batchBytes / (1024 * 1024)).toFixed(1)} MB, above the ${(limits.maxAttachmentBatchBytes / (1024 * 1024)).toFixed(0)} MB limit for one import. Nothing was downloaded — select fewer.`
        };
      }

      const api = this.apiContext(connection, limits, credentials, op);
      const imported: { attachmentId: string; filename: string; fileName: string }[] = [];
      const failed: { attachmentId: string; filename: string; reason: string }[] = [];
      const batchMb = (limits.maxAttachmentBatchBytes / (1024 * 1024)).toFixed(0);
      // The sizes above are only the provider's CLAIM (and may be missing or understated), so the batch limit
      // is enforced again on the bytes actually received: each download may use at most what is left of it.
      let receivedBytes = 0;
      for (const attachment of chosen) {
        const before = this.interrupted(op, stale);
        if (before) {
          return before;
        }
        const remaining = limits.maxAttachmentBatchBytes - receivedBytes;
        if (remaining <= 0) {
          failed.push({ attachmentId: attachment.id, filename: attachment.filename, reason: `Skipped — the ${batchMb} MB limit for one import was reached. Import it separately.` });
          continue;
        }
        const allowance = Math.min(limits.maxAttachmentBytes, remaining);
        try {
          const buffer = await downloadAttachment(api, attachment.downloadUrl!, allowance);
          const downloaded = this.interrupted(op, stale);
          if (downloaded) {
            return downloaded;
          }
          receivedBytes += buffer.length;
          const result = await this.deps.host.ingestAttachment(
            {
              fileName: `${source.key}/${attachment.filename}`,
              buffer,
              provenance: {
                service: source.connectionLabel,
                connectionId: source.connectionId,
                product: source.product,
                resourceKey: source.key,
                resourceUrl: source.url,
                attachmentId: attachment.id,
                providerAttachmentId: attachment.providerId,
                retrievedAt: (this.deps.now?.() ?? new Date()).toISOString()
              }
            },
            // Parsing can take a while: Stop OR Clear Data during it must stop the file entering Input Files.
            () => !stale() && !op.signal.aborted
          );
          const ingested = this.interrupted(op, stale);
          if (ingested) {
            return ingested;
          }
          if (result.ok) {
            attachment.status = 'imported';
            attachment.reason = undefined;
            attachment.importedFileName = result.fileName;
            imported.push({ attachmentId: attachment.id, filename: attachment.filename, fileName: result.fileName });
          } else {
            failed.push({ attachmentId: attachment.id, filename: attachment.filename, reason: result.reason });
          }
        } catch (err) {
          if (err instanceof TransportError && err.code === 'aborted') {
            return stale() ? { status: 'stale' } : { status: 'cancelled' };
          }
          const failedNow = this.interrupted(op, stale);
          if (failedNow) {
            return failedNow;
          }
          if (err instanceof KnowledgeApiError && err.code === 'too_large' && allowance < limits.maxAttachmentBytes) {
            failed.push({ attachmentId: attachment.id, filename: attachment.filename, reason: `Skipped — it would exceed the ${batchMb} MB limit for one import.` });
            continue;
          }
          const reason = err instanceof KnowledgeApiError ? err.message : 'The file could not be downloaded.';
          failed.push({ attachmentId: attachment.id, filename: attachment.filename, reason });
          if (err instanceof KnowledgeApiError && err.code === 'auth_failed') {
            this.credentials.delete(connection.id);
            for (const rest of chosen.slice(chosen.indexOf(attachment) + 1)) {
              failed.push({ attachmentId: rest.id, filename: rest.filename, reason: 'Skipped — authentication failed. Reconnect and try again.' });
            }
            break;
          }
        }
      }
      return { status: 'done', imported, failed };
    } finally {
      this.ops.delete(op);
    }
  }
}
