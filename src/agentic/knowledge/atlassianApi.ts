import { isUnderBasePath } from './connectionConfig';
import { fieldValueToText, storageToText } from './atlassianText';
import { KnowledgeTransport, TransportError, TransportResponse } from './knowledgeTransport';
import { AttachmentStatus, ConnectionAuthMode, ConnectionLimits, Credentials, KnowledgeApiError, KnowledgeConnection } from './knowledgeTypes';

/**
 * Read-only adapters for Jira and Confluence DATA CENTER / SERVER REST APIs.
 * Endpoints are derived here from the configured connection — nothing a model
 * or a web page says can choose a URL.
 *
 * References (official Atlassian documentation):
 *  - Jira Data Center REST API, "issue" group — GET /rest/api/2/issue/{issueIdOrKey}:
 *    https://developer.atlassian.com/server/jira/platform/rest/v10002/api-group-issue/
 *  - Confluence Data Center REST API — GET /rest/api/content/{id} and
 *    GET /rest/api/content/{id}/child/attachment (start/limit paging),
 *    whose results carry `_links.download` (relative to the deployment root):
 *    https://developer.atlassian.com/server/confluence/rest/v900/api-group-attachments/
 *    https://developer.atlassian.com/server/confluence/confluence-rest-api-examples/
 *  - Personal access tokens (`Authorization: Bearer <token>`; Jira 8.14+, Confluence 7.9+):
 *    https://confluence.atlassian.com/enterprise/using-personal-access-tokens-1026032365.html
 *
 * Response field shapes are parsed defensively (a missing optional field never
 * fails the read) because they have NOT been checked against any live TD
 * deployment; see the README's pre-packaging checklist.
 */

// ---------------------------------------------------------------------------
// Links a user can paste
// ---------------------------------------------------------------------------

const ISSUE_KEY = /^[A-Za-z][A-Za-z0-9_]*-\d+$/;

const safeDecode = (s: string): string => {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
};

export type RefResult<T> = { ok: true; value: T } | { ok: false; reason: string };

/** `…/browse/ABC-123`, `…/projects/ABC/issues/ABC-123`, or a board/backlog link with `?selectedIssue=ABC-123`. */
export function parseJiraIssueUrl(url: URL, basePath: string): RefResult<string> {
  const segments = url.pathname.slice(basePath.length).split('/').filter(Boolean).map(safeDecode);
  const candidates: (string | undefined | null)[] = [
    segments[0] === 'browse' ? segments[1] : undefined,
    segments[0] === 'projects' && segments[2] === 'issues' ? segments[3] : undefined,
    url.searchParams.get('selectedIssue')
  ];
  const key = candidates.find((c) => c && ISSUE_KEY.test(c));
  if (key) {
    return { ok: true, value: key.toUpperCase() };
  }
  return { ok: false, reason: "That Jira link isn't a ticket address I can read. Paste the ticket's own link, for example …/browse/ABC-123." };
}

/** `…/pages/viewpage.action?pageId=123` or `…/spaces/KEY/pages/123/Title`. Title-only links are refused with guidance. */
export function parseConfluencePageUrl(url: URL, basePath: string): RefResult<string> {
  const segments = url.pathname.slice(basePath.length).split('/').filter(Boolean).map(safeDecode);
  const queryId = url.searchParams.get('pageId');
  if (segments[0] === 'pages' && segments[1] === 'viewpage.action' && queryId && /^\d+$/.test(queryId)) {
    return { ok: true, value: queryId };
  }
  if (segments[0] === 'spaces' && segments[2] === 'pages' && /^\d+$/.test(segments[3] ?? '')) {
    return { ok: true, value: segments[3] };
  }
  return {
    ok: false,
    reason:
      "That Confluence link doesn't contain a page number (title-based /display/… and short /x/… links aren't supported). " +
      "Open the page, choose ••• → Page Information (or copy the link from the page's Share dialog), and paste the address containing pageId=… or /pages/<number>/."
  };
}

// ---------------------------------------------------------------------------
// Auth + HTTP
// ---------------------------------------------------------------------------

export function buildAuthorization(mode: ConnectionAuthMode, credentials: Credentials): string {
  if (mode === 'pat') {
    return `Bearer ${credentials.secret}`;
  }
  return `Basic ${Buffer.from(`${credentials.username ?? ''}:${credentials.secret}`, 'utf8').toString('base64')}`;
}

export interface ApiContext {
  connection: KnowledgeConnection;
  limits: ConnectionLimits;
  transport: KnowledgeTransport;
  /** The full `Authorization` header value. Lives only in this object's lifetime; never logged. */
  authorization: string;
  signal?: AbortSignal;
}

const rootOf = (c: KnowledgeConnection): string => `${c.origin}${c.basePath ?? ''}`;

/** A URL is inside the approved connection when it is https, credential-free, same origin and under the context path. */
export function isWithinConnection(connection: KnowledgeConnection, candidate: URL): boolean {
  return candidate.protocol === 'https:' && !candidate.username && !candidate.password && candidate.origin === connection.origin && isUnderBasePath(candidate.pathname, connection.basePath ?? '');
}

function mapTransportError(err: unknown): never {
  if (err instanceof TransportError) {
    switch (err.code) {
      case 'aborted':
        throw err;
      case 'timeout':
        throw new KnowledgeApiError('timeout', err.message);
      case 'too_large':
        throw new KnowledgeApiError('too_large', err.message);
      case 'rate_limited':
        throw new KnowledgeApiError('rate_limited', err.message);
      case 'redirect_blocked':
      case 'too_many_redirects':
        throw new KnowledgeApiError('redirect_blocked', err.message);
      case 'unsupported_scheme':
        throw new KnowledgeApiError('config_error', err.message);
      default:
        throw new KnowledgeApiError('network', `${err.message} Check the address, your network/VPN and proxy settings.`);
    }
  }
  throw err;
}

async function apiGet(ctx: ApiContext, url: string, accept: string, maxBytes: number): Promise<TransportResponse> {
  try {
    return await ctx.transport.get({
      url,
      authorization: ctx.authorization,
      accept,
      maxBytes,
      signal: ctx.signal,
      isRedirectAllowed: (_from, to) => isWithinConnection(ctx.connection, to)
    });
  } catch (err) {
    return mapTransportError(err);
  }
}

function checkStatus(res: TransportResponse, authMode: ConnectionAuthMode): void {
  if (res.status >= 200 && res.status < 300) {
    return;
  }
  const credential = authMode === 'pat' ? 'personal access token' : 'username and password';
  if (res.status === 401) {
    throw new KnowledgeApiError('auth_failed', `The server rejected the ${credential} (HTTP 401). Check it and reconnect.`);
  }
  if (res.status === 403) {
    throw new KnowledgeApiError(
      'auth_failed',
      'Access was denied (HTTP 403). The account may lack permission for this item, or the server may have locked the login (for example after repeated failures, or a CAPTCHA requirement).'
    );
  }
  if (res.status === 404) {
    throw new KnowledgeApiError('not_found', 'Not found (HTTP 404). The item may not exist, or this account may not be allowed to see it.');
  }
  if (res.status >= 500) {
    throw new KnowledgeApiError('server_error', `The server reported an error (HTTP ${res.status}). Try again later.`);
  }
  throw new KnowledgeApiError('invalid_response', `The server answered with an unexpected status (HTTP ${res.status}).`);
}

const LOGIN_PAGE_MESSAGE =
  'The server returned a web page instead of data — it probably wants an interactive (SSO / browser) login, which is not supported here. Ask your administrator for a personal access token.';

function looksLikeHtml(res: TransportResponse): boolean {
  return /text\/html/i.test(res.headers['content-type'] ?? '') || res.body.subarray(0, 64).toString('utf8').trimStart().startsWith('<');
}

function parseJson(res: TransportResponse): unknown {
  if (looksLikeHtml(res)) {
    throw new KnowledgeApiError('login_required', LOGIN_PAGE_MESSAGE);
  }
  try {
    return JSON.parse(res.body.toString('utf8'));
  } catch {
    throw new KnowledgeApiError('invalid_response', "The server's answer was not valid JSON.");
  }
}

async function getJson(ctx: ApiContext, path: string): Promise<Record<string, unknown>> {
  const res = await apiGet(ctx, `${rootOf(ctx.connection)}${path}`, 'application/json', ctx.limits.maxResponseBytes);
  checkStatus(res, ctx.connection.authMode ?? 'pat');
  const json = parseJson(res);
  if (!json || typeof json !== 'object' || Array.isArray(json)) {
    throw new KnowledgeApiError('invalid_response', 'The server answered with an unexpected JSON shape.');
  }
  return json as Record<string, unknown>;
}

const rec = (v: unknown): Record<string, unknown> => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {});
const str = (v: unknown): string | undefined => (typeof v === 'string' && v.trim() ? v : typeof v === 'number' ? String(v) : undefined);
const num = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : undefined);

// ---------------------------------------------------------------------------
// Attachments
// ---------------------------------------------------------------------------

export interface RawAttachment {
  providerId: string;
  filename: string;
  mimeType?: string;
  sizeBytes?: number;
  /** Absolute, validated download URL — undefined when the provider's link lies outside the approved connection. */
  downloadUrl?: string;
}

export interface FetchedResource {
  kind: 'issue' | 'page';
  key: string;
  title: string;
  summaryLines: string[];
  text: string;
  conversionNotes: string[];
  attachments: RawAttachment[];
  attachmentListingComplete: boolean;
}

/** Resolves a provider download link and keeps it ONLY if it lies inside the approved connection. */
export function resolveDownloadUrl(connection: KnowledgeConnection, link: unknown): string | undefined {
  const raw = str(link);
  if (!raw) {
    return undefined;
  }
  const base = connection.basePath ?? '';
  let candidate: URL;
  try {
    // A root-relative link is relative to the deployment ROOT (which includes any context path).
    const relative = raw.startsWith('/') && !(base && (raw === base || raw.startsWith(`${base}/`))) ? `${base}${raw}` : raw;
    candidate = new URL(relative, `${connection.origin}/`);
  } catch {
    return undefined;
  }
  return isWithinConnection(connection, candidate) ? candidate.href : undefined;
}

const SUPPORTED_EXTENSIONS = new Set(['csv', 'json', 'xml', 'yml', 'yaml', 'txt', 'md', 'log', 'xlsx', 'docx', 'pdf']);
const LEGACY_REASONS: Record<string, string> = {
  xls: 'Legacy .xls is not supported — save it as .xlsx first.',
  doc: 'Legacy .doc is not supported — save it as .docx first.'
};

export function extensionOf(filename: string): string {
  const dot = filename.lastIndexOf('.');
  return dot > 0 ? filename.slice(dot + 1).toLowerCase() : '';
}

export function classifyAttachment(raw: RawAttachment, limits: ConnectionLimits): { status: AttachmentStatus; reason?: string } {
  if (!raw.downloadUrl) {
    return { status: 'unsafe_url', reason: "This attachment's address is outside the approved connection, so it will not be downloaded." };
  }
  const ext = extensionOf(raw.filename);
  if (!SUPPORTED_EXTENSIONS.has(ext)) {
    return { status: 'unsupported_type', reason: LEGACY_REASONS[ext] ?? `Files of type ".${ext || 'unknown'}" cannot be read (supported: ${[...SUPPORTED_EXTENSIONS].join(', ')}).` };
  }
  if (raw.sizeBytes !== undefined && raw.sizeBytes > limits.maxAttachmentBytes) {
    return { status: 'too_large', reason: `Larger than the ${(limits.maxAttachmentBytes / (1024 * 1024)).toLocaleString()} MB limit.` };
  }
  return { status: 'importable' };
}

/** Downloads ONE attachment from a URL the host already validated. */
export async function downloadAttachment(ctx: ApiContext, downloadUrl: string, maxBytes: number): Promise<Buffer> {
  const res = await apiGet(ctx, downloadUrl, '*/*', maxBytes);
  checkStatus(res, ctx.connection.authMode ?? 'pat');
  if (looksLikeHtml(res)) {
    throw new KnowledgeApiError('login_required', LOGIN_PAGE_MESSAGE);
  }
  return res.body;
}

// ---------------------------------------------------------------------------
// Jira
// ---------------------------------------------------------------------------

const JIRA_FIELDS = ['summary', 'description', 'status', 'issuetype', 'priority', 'labels', 'attachment', 'updated'];

export async function fetchJiraIssue(ctx: ApiContext, key: string): Promise<FetchedResource> {
  const criteriaFields = ctx.connection.acceptanceCriteriaFieldIds;
  const fields = [...JIRA_FIELDS, ...criteriaFields].join(',');
  const issue = await getJson(ctx, `/rest/api/2/issue/${encodeURIComponent(key)}?fields=${encodeURIComponent(fields)}`);
  const f = rec(issue.fields);
  const issueKey = str(issue.key) ?? key;
  const title = str(f.summary) ?? '(no summary)';
  const type = str(rec(f.issuetype).name);
  const status = str(rec(f.status).name);
  const priority = str(rec(f.priority).name);
  const labels = Array.isArray(f.labels) ? f.labels.filter((l): l is string => typeof l === 'string') : [];
  const description = fieldValueToText(f.description);

  const notes: string[] = [];
  const sections = [`Jira issue ${issueKey}: ${title}`];
  const facts = [type && `Type: ${type}`, status && `Status: ${status}`, priority && `Priority: ${priority}`, labels.length ? `Labels: ${labels.join(', ')}` : undefined].filter(Boolean) as string[];
  if (facts.length) {
    sections.push(facts.join(' | '));
  }
  sections.push(`Description:\n${description || '(empty)'}`);
  if (typeof f.description === 'string' && description) {
    notes.push('The description is Jira wiki markup and is shown as written.');
  }
  for (const id of criteriaFields) {
    const criteria = fieldValueToText(f[id]);
    if (criteria) {
      sections.push(`Acceptance criteria (${id}):\n${criteria}`);
    }
  }
  if (criteriaFields.length === 0) {
    notes.push('No acceptance-criteria field is configured for this connection, so only the description is shown.');
  }

  const attachments: RawAttachment[] = (Array.isArray(f.attachment) ? f.attachment : []).map((a) => {
    const item = rec(a);
    return {
      providerId: str(item.id) ?? '',
      filename: str(item.filename) ?? 'attachment',
      mimeType: str(item.mimeType),
      sizeBytes: num(item.size),
      downloadUrl: resolveDownloadUrl(ctx.connection, item.content)
    };
  });
  return {
    kind: 'issue',
    key: issueKey,
    title,
    summaryLines: [`${issueKey} — ${title}`, ...facts],
    text: sections.join('\n\n'),
    conversionNotes: notes,
    // Jira returns every attachment inside the issue payload itself.
    attachments: attachments.filter((a) => a.providerId),
    attachmentListingComplete: true
  };
}

// ---------------------------------------------------------------------------
// Confluence
// ---------------------------------------------------------------------------

const CONFLUENCE_PAGE_SIZE = 50;

export async function fetchConfluencePage(ctx: ApiContext, pageId: string): Promise<FetchedResource> {
  const page = await getJson(ctx, `/rest/api/content/${encodeURIComponent(pageId)}?expand=${encodeURIComponent('body.storage,version,space')}`);
  const type = str(page.type);
  if (type !== 'page' && type !== 'blogpost') {
    throw new KnowledgeApiError('unsupported_url', `That link points to a Confluence "${type ?? 'unknown'}", not a page, so it cannot be read here.`);
  }
  const title = str(page.title) ?? '(untitled)';
  const space = rec(page.space);
  const version = rec(page.version);
  const converted = storageToText(str(rec(rec(page.body).storage).value) ?? '');
  const facts = [
    str(space.name) ? `Space: ${str(space.name)}${str(space.key) ? ` (${str(space.key)})` : ''}` : undefined,
    num(version.number) !== undefined ? `Version: ${num(version.number)}` : undefined,
    str(version.when) ? `Last updated: ${str(version.when)}` : undefined
  ].filter(Boolean) as string[];

  const attachments: RawAttachment[] = [];
  let complete = false;
  for (let pageIndex = 0, start = 0; pageIndex < ctx.limits.maxListingPages; pageIndex++) {
    const listing = await getJson(ctx, `/rest/api/content/${encodeURIComponent(pageId)}/child/attachment?start=${start}&limit=${CONFLUENCE_PAGE_SIZE}`);
    const results = Array.isArray(listing.results) ? listing.results : [];
    for (const r of results) {
      const item = rec(r);
      const ext = rec(item.extensions);
      const meta = rec(item.metadata);
      attachments.push({
        providerId: str(item.id) ?? '',
        filename: str(item.title) ?? 'attachment',
        mimeType: str(ext.mediaType) ?? str(meta.mediaType),
        sizeBytes: num(ext.fileSize),
        downloadUrl: resolveDownloadUrl(ctx.connection, rec(item._links).download)
      });
    }
    const hasMore = Boolean(rec(listing._links).next) || results.length >= CONFLUENCE_PAGE_SIZE;
    if (!hasMore || results.length === 0) {
      complete = true;
      break;
    }
    start += results.length;
  }
  return {
    kind: 'page',
    key: pageId,
    title,
    summaryLines: [title, ...facts],
    text: [`Confluence page: ${title}`, facts.join(' | '), converted.text || '(the page has no readable content)'].filter(Boolean).join('\n\n'),
    conversionNotes: converted.notes,
    attachments: attachments.filter((a) => a.providerId),
    attachmentListingComplete: complete
  };
}
