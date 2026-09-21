import * as fs from 'fs';
import { z } from 'zod';
import { ConnectionLimits, KnowledgeConnection, PublicConnection } from './knowledgeTypes';

/**
 * `config/agentic-connections.json` — which Jira / Confluence deployments
 * Total Agentic Mode may talk to. Installation-controlled (resolved from the
 * extension's own install path by the caller), NEVER from the workspace: a
 * repository must not be able to redirect a credential-bearing request.
 *
 * The file holds addresses and modes only. Any key that looks like a
 * credential is rejected outright, so a secret can never be committed here by
 * accident.
 */

export const DEFAULT_LIMITS: ConnectionLimits = {
  requestTimeoutMs: 30000,
  maxResponseBytes: 5 * 1024 * 1024,
  maxAttachmentBytes: 10 * 1024 * 1024,
  maxAttachmentBatchBytes: 30 * 1024 * 1024,
  maxAttachmentCount: 20,
  maxListingPages: 10
};

/** Hard ceilings: a config typo (an extra zero) cannot turn a bounded read into an unbounded one. */
const LIMIT_RANGES: Record<keyof ConnectionLimits, [number, number]> = {
  requestTimeoutMs: [1000, 120000],
  maxResponseBytes: [1024, 50 * 1024 * 1024],
  maxAttachmentBytes: [1024, 50 * 1024 * 1024],
  maxAttachmentBatchBytes: [1024, 200 * 1024 * 1024],
  maxAttachmentCount: [1, 100],
  maxListingPages: [1, 50]
};

const SECRET_KEY = /pass(word)?|secret|token|credential|api[-_]?key|username|user$|authorization/i;

const entrySchema = z
  .object({
    id: z.string().regex(/^[a-z0-9][a-z0-9-]{0,62}$/, 'must be lowercase letters, digits and dashes'),
    label: z.string().min(1),
    product: z.enum(['jira', 'confluence']),
    enabled: z.boolean(),
    baseUrl: z.string().default(''),
    deployment: z.string().default('unconfigured'),
    authMode: z.string().default('unconfigured'),
    acceptanceCriteriaFieldIds: z.array(z.string().regex(/^customfield_\d+$/, 'must look like customfield_12345')).optional()
  })
  .strict();

const configSchema = z
  .object({
    schemaVersion: z.literal(1),
    connections: z.array(entrySchema),
    limits: z.object({}).catchall(z.number()).optional()
  })
  .strict();

export interface LoadedConnections {
  connections: KnowledgeConnection[];
  limits: ConnectionLimits;
}

export type ConfigLoadResult = { ok: true; value: LoadedConnections } | { ok: false; error: string };

function formatZodIssues(err: z.ZodError): string {
  return err.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`).join('; ');
}

/** Finds a key that looks like a credential anywhere in the parsed JSON, so the message can be specific. */
function findSecretKey(value: unknown, trail = ''): string | undefined {
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i++) {
      const hit = findSecretKey(value[i], `${trail}[${i}]`);
      if (hit) {
        return hit;
      }
    }
  } else if (value && typeof value === 'object') {
    for (const [key, child] of Object.entries(value)) {
      if (SECRET_KEY.test(key)) {
        return `${trail}.${key}`.replace(/^\./, '');
      }
      const hit = findSecretKey(child, `${trail}.${key}`);
      if (hit) {
        return hit;
      }
    }
  }
  return undefined;
}

interface ParsedBase {
  origin: string;
  basePath: string;
}

/** `https://host[:port][/context]` → origin + context path, or a reason it is unusable. */
export function parseBaseUrl(baseUrl: string): { ok: true; value: ParsedBase } | { ok: false; reason: string } {
  if (!baseUrl.trim()) {
    return { ok: false, reason: 'baseUrl is empty' };
  }
  let url: URL;
  try {
    url = new URL(baseUrl.trim());
  } catch {
    return { ok: false, reason: 'baseUrl is not a valid URL' };
  }
  if (url.protocol !== 'https:') {
    return { ok: false, reason: 'baseUrl must use https' };
  }
  if (url.username || url.password) {
    return { ok: false, reason: 'baseUrl must not contain a username or password' };
  }
  if (url.search || url.hash) {
    return { ok: false, reason: 'baseUrl must not contain a query string or fragment' };
  }
  const basePath = url.pathname.replace(/\/+$/, '');
  if (/\/\//.test(basePath)) {
    return { ok: false, reason: 'baseUrl path must not contain empty segments' };
  }
  return { ok: true, value: { origin: url.origin, basePath } };
}

function validateEntry(raw: z.infer<typeof entrySchema>): KnowledgeConnection {
  const connection: KnowledgeConnection = {
    id: raw.id,
    label: raw.label,
    product: raw.product,
    enabled: raw.enabled,
    acceptanceCriteriaFieldIds: raw.acceptanceCriteriaFieldIds ?? []
  };
  const base = parseBaseUrl(raw.baseUrl);
  if (base.ok) {
    connection.origin = base.value.origin;
    connection.basePath = base.value.basePath;
  }
  if (raw.deployment === 'datacenter') {
    connection.deployment = 'datacenter';
  }
  if (raw.authMode === 'pat' || raw.authMode === 'basic') {
    connection.authMode = raw.authMode;
  }
  if (raw.enabled) {
    if (!base.ok) {
      connection.configError = base.reason;
    } else if (raw.deployment !== 'datacenter') {
      connection.configError = `deployment "${raw.deployment}" is not supported — only "datacenter" (Jira/Confluence Data Center or Server REST) is implemented`;
    } else if (raw.authMode !== 'pat' && raw.authMode !== 'basic') {
      connection.configError = `authMode "${raw.authMode}" is not supported — use "pat" (personal access token) or "basic" (username + password, only if your deployment allows it)`;
    } else if (raw.product !== 'jira' && raw.acceptanceCriteriaFieldIds?.length) {
      connection.configError = 'acceptanceCriteriaFieldIds only applies to Jira connections';
    }
  }
  return connection;
}

export function parseConnectionsConfig(text: string): ConfigLoadResult {
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch (err) {
    return { ok: false, error: `agentic-connections.json is not valid JSON: ${err instanceof Error ? err.message : String(err)}` };
  }
  const secretPath = findSecretKey(json);
  if (secretPath) {
    return {
      ok: false,
      error: `agentic-connections.json must not contain credentials (found "${secretPath}"). Credentials are entered securely in the chat and are never stored in this file.`
    };
  }
  const parsed = configSchema.safeParse(json);
  if (!parsed.success) {
    return { ok: false, error: `agentic-connections.json is invalid: ${formatZodIssues(parsed.error)}` };
  }
  const ids = new Set<string>();
  for (const entry of parsed.data.connections) {
    if (ids.has(entry.id)) {
      return { ok: false, error: `agentic-connections.json is invalid: connection id "${entry.id}" is used more than once` };
    }
    ids.add(entry.id);
  }
  const limits: ConnectionLimits = { ...DEFAULT_LIMITS };
  for (const [key, value] of Object.entries(parsed.data.limits ?? {})) {
    const range = LIMIT_RANGES[key as keyof ConnectionLimits];
    if (!range) {
      return { ok: false, error: `agentic-connections.json is invalid: unknown limit "${key}"` };
    }
    if (!Number.isInteger(value) || value < range[0] || value > range[1]) {
      return { ok: false, error: `agentic-connections.json is invalid: limits.${key} must be a whole number between ${range[0]} and ${range[1]}` };
    }
    limits[key as keyof ConnectionLimits] = value;
  }
  return { ok: true, value: { connections: parsed.data.connections.map(validateEntry), limits } };
}

export async function loadConnectionsConfigFile(filePath: string): Promise<ConfigLoadResult> {
  let text: string;
  try {
    text = await fs.promises.readFile(filePath, 'utf8');
  } catch (err) {
    return { ok: false, error: `Could not read the connections file (${err instanceof Error ? err.message : String(err)}).` };
  }
  return parseConnectionsConfig(text);
}

export function toPublicConnection(connection: KnowledgeConnection): PublicConnection {
  return {
    id: connection.id,
    label: connection.label,
    product: connection.product,
    origin: connection.origin ?? '',
    authMode: connection.authMode ?? 'pat'
  };
}

// ---------------------------------------------------------------------------
// URL → connection
// ---------------------------------------------------------------------------

export type UrlResolution =
  | { kind: 'match'; connection: KnowledgeConnection; url: URL }
  | { kind: 'disabled'; connection: KnowledgeConnection }
  | { kind: 'invalid_config'; connection: KnowledgeConnection }
  | { kind: 'ambiguous'; connections: KnowledgeConnection[] }
  | { kind: 'rejected'; reason: string }
  | { kind: 'no_match'; configured: string[] };

/** True when `pathname` is `basePath` itself or lies beneath it on a path
 * boundary — `/jira` matches `/jira` and `/jira/browse/X`, never `/jiraX`. */
export function isUnderBasePath(pathname: string, basePath: string): boolean {
  return basePath === '' || pathname === basePath || pathname.startsWith(`${basePath}/`);
}

/**
 * Decides which configured connection (if any) a user-pasted URL belongs to,
 * using PARSED origins and path boundaries — never substring matching on the
 * host. Among connections sharing an origin, the most specific (longest)
 * context path wins; two entries at the identical location are reported as
 * ambiguous rather than picking one silently.
 */
export function resolveKnowledgeUrl(loaded: LoadedConnections, rawUrl: string): UrlResolution {
  let url: URL;
  try {
    url = new URL(rawUrl.trim());
  } catch {
    return { kind: 'rejected', reason: 'That is not a valid URL.' };
  }
  if (url.protocol !== 'https:') {
    return { kind: 'rejected', reason: 'Only https links are supported.' };
  }
  if (url.username || url.password) {
    return { kind: 'rejected', reason: 'The link contains a username or password. Remove it — credentials are entered securely instead.' };
  }
  const candidates = loaded.connections.filter((c) => c.origin !== undefined && c.origin === url.origin && isUnderBasePath(url.pathname, c.basePath ?? ''));
  if (candidates.length === 0) {
    return { kind: 'no_match', configured: loaded.connections.filter((c) => c.enabled && !c.configError).map((c) => c.label) };
  }
  const longest = Math.max(...candidates.map((c) => (c.basePath ?? '').length));
  const best = candidates.filter((c) => (c.basePath ?? '').length === longest);
  if (best.length > 1) {
    return { kind: 'ambiguous', connections: best };
  }
  const connection = best[0];
  if (!connection.enabled) {
    return { kind: 'disabled', connection };
  }
  if (connection.configError) {
    return { kind: 'invalid_config', connection };
  }
  return { kind: 'match', connection, url };
}
