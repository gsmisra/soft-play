/**
 * Shared types for Total Agentic Mode's read-only Jira/Confluence knowledge
 * connections. Zero `vscode` import anywhere under `agentic/knowledge/` so all
 * of it — configuration, transport, adapters, session — is unit-tested against
 * injected fakes.
 */

export type KnowledgeErrorCode =
  | 'config_error'
  | 'no_match'
  | 'disabled'
  | 'invalid_config'
  | 'ambiguous'
  | 'unsupported_url'
  | 'auth_failed'
  | 'not_found'
  | 'login_required'
  | 'rate_limited'
  | 'timeout'
  | 'too_large'
  | 'network'
  | 'invalid_response'
  | 'redirect_blocked'
  | 'server_error'
  | 'redaction_failed'
  | 'unknown_action'
  | 'unknown_source'
  | 'unknown_attachment'
  | 'limit_exceeded';

/** A failure with a message that is SAFE to show directly in the chat: it
 * never contains credentials, request headers or response bodies. */
export class KnowledgeApiError extends Error {
  constructor(
    readonly code: KnowledgeErrorCode,
    message: string
  ) {
    super(message);
    this.name = 'KnowledgeApiError';
  }
}

export type ConnectionProduct = 'jira' | 'confluence';
export type ConnectionDeployment = 'datacenter';
export type ConnectionAuthMode = 'pat' | 'basic';

export interface ConnectionLimits {
  requestTimeoutMs: number;
  maxResponseBytes: number;
  maxAttachmentBytes: number;
  maxAttachmentBatchBytes: number;
  maxAttachmentCount: number;
  maxListingPages: number;
}

/** One entry of `config/agentic-connections.json`, validated. Enabled entries
 * that failed validation keep `configError`; they never match silently. */
export interface KnowledgeConnection {
  id: string;
  label: string;
  product: ConnectionProduct;
  enabled: boolean;
  /** `https://host[:port]` — present whenever `baseUrl` parsed as a usable https URL. */
  origin?: string;
  /** Deployment context path without a trailing slash: '' or e.g. '/jira'. */
  basePath?: string;
  deployment?: ConnectionDeployment;
  authMode?: ConnectionAuthMode;
  /** Jira only: custom-field IDs (e.g. `customfield_10200`) holding acceptance criteria. */
  acceptanceCriteriaFieldIds: string[];
  configError?: string;
}

/** What the chat/webview may know about a connection — never anything secret. */
export interface PublicConnection {
  id: string;
  label: string;
  product: ConnectionProduct;
  origin: string;
  authMode: ConnectionAuthMode;
}

export interface Credentials {
  username?: string;
  /** Password (basic) or personal access token (pat). Never logged, never placed in a prompt. */
  secret: string;
}

export type AttachmentStatus = 'importable' | 'imported' | 'unsupported_type' | 'too_large' | 'unsafe_url';

/** An attachment as the chat/webview/LLM see it. The download URL is
 * deliberately absent: only the host ever knows where a file is fetched from. */
export interface AttachmentView {
  id: string;
  filename: string;
  mimeType?: string;
  sizeBytes?: number;
  status: AttachmentStatus;
  reason?: string;
}

export interface KnowledgeSourceView {
  id: string;
  connectionId: string;
  connectionLabel: string;
  product: ConnectionProduct;
  kind: 'issue' | 'page';
  /** Issue key or page ID. */
  key: string;
  title: string;
  url: string;
  retrievedAt: string;
  summaryLines: string[];
  conversionNotes: string[];
  attachments: AttachmentView[];
  /** False when the listing hit `maxListingPages` — never labelled "all attachments". */
  attachmentListingComplete: boolean;
  textChars: number;
  truncated: boolean;
}

export interface AttachmentProvenance {
  service: string;
  connectionId: string;
  product: ConnectionProduct;
  resourceKey: string;
  resourceUrl: string;
  attachmentId: string;
  providerAttachmentId: string;
  retrievedAt: string;
}
