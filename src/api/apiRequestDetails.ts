/**
 * The API Automation Control Panel's request builder, as a structured
 * shape — mirrors exactly what main.js's `collectApiRequestDetails()`
 * sends over (see objectSpyPanel.ts's 'sendToLlm'/'generateFeatureFile'
 * handlers). Kept separate from settingsStore.ts's `ObjectSpySettings`
 * deliberately: this is per-request data typed into the Control Panel each
 * time, not a persisted setting.
 */

export interface ApiKeyValueRow {
  key: string;
  value: string;
  description: string;
}

/** form-data's own row shape — the only body encoding that can carry a
 * file upload (matches Postman: each row's Value can be switched between
 * plain Text and a File picked via a native OS dialog). `value` holds the
 * absolute path on disk when `valueType` is 'file' (never file *contents*
 * — this extension doesn't send the HTTP request itself, only describes
 * its shape to the LLM, so a path is all the generated code needs to know
 * which file to stream). */
export interface ApiFormDataRow extends ApiKeyValueRow {
  valueType: 'text' | 'file';
}

/** Every auth type softPlay's Control Panel offers — the same set Postman
 * itself offers minus "Inherit auth from parent" (no collection/folder
 * hierarchy exists here for anything to inherit from). */
export type ApiAuthType = 'noauth' | 'apikey' | 'bearer' | 'basic' | 'digest' | 'oauth1' | 'oauth2' | 'hawk' | 'awsv4' | 'ntlm' | 'edgegrid';
export type ApiBodyMode = 'none' | 'form-data' | 'x-www-form-urlencoded' | 'raw';

/** All auth types' fields flattened into one object (mirrors the Control
 * Panel's own markup — one field block per type, shown/hidden by
 * `authType`) rather than a discriminated union: simpler to read/write
 * from main.js, and only the fields matching the current `authType` are
 * ever populated or rendered into the LLM prompt (see
 * buildApiRequestSummary()) — the rest just sit empty. */
export interface ApiAuthFields {
  apiKeyName: string;
  apiKeyValue: string;
  apiKeyAddTo: 'header' | 'query';
  bearerToken: string;
  basicUsername: string;
  basicPassword: string;
  digestUsername: string;
  digestPassword: string;
  oauth1ConsumerKey: string;
  oauth1ConsumerSecret: string;
  oauth1AccessToken: string;
  oauth1TokenSecret: string;
  oauth1SignatureMethod: string;
  oauth2AccessToken: string;
  oauth2HeaderPrefix: string;
  hawkAuthId: string;
  hawkAuthKey: string;
  hawkAlgorithm: string;
  awsAccessKey: string;
  awsSecretKey: string;
  awsSessionToken: string;
  awsRegion: string;
  awsServiceName: string;
  ntlmUsername: string;
  ntlmPassword: string;
  ntlmDomain: string;
  ntlmWorkstation: string;
  edgeGridAccessToken: string;
  edgeGridClientToken: string;
  edgeGridClientSecret: string;
}

export interface ApiRequestDetails {
  method: string;
  url: string;
  params: ApiKeyValueRow[];
  headers: ApiKeyValueRow[];
  authType: ApiAuthType;
  auth: ApiAuthFields;
  bodyMode: ApiBodyMode;
  bodyFormFields: ApiFormDataRow[];
  bodyUrlencodedFields: ApiKeyValueRow[];
  bodyRawLanguage: string;
  bodyRaw: string;
}

/** True once the user has typed at least a URL — the minimum needed for
 * "there's actually a request here" (mirrors the Playwright-code-empty
 * guard elsewhere: never send an empty/no-op context to the LLM). */
export function hasApiRequest(details: ApiRequestDetails | undefined): boolean {
  return !!details && details.url.trim().length > 0;
}

const REDACTED = '(value provided — redacted; reference it via config/env var in the generated code, never hardcode it)';

function formatRows(rows: ApiKeyValueRow[]): string {
  if (!rows.length) {
    return '  (none)';
  }
  return rows
    .map((r) => `  - ${r.key}: ${r.value}${r.description ? ` (${r.description})` : ''}`)
    .join('\n');
}

/** form-data rows need their own formatting: a 'file' row must read as an
 * unambiguous instruction to perform a real multipart file upload (Java
 * REST Assured `.multiPart(key, new File(path))`; Python `requests`
 * `files={key: open(path, 'rb')}`) — never as if the file's path string
 * were itself the field's text value. */
function formatFormDataRows(rows: ApiFormDataRow[]): string {
  if (!rows.length) {
    return '  (none)';
  }
  return rows
    .map((r) => {
      const value = r.valueType === 'file' ? `[FILE UPLOAD] ${r.value || '(no file selected)'}` : r.value;
      return `  - ${r.key} (${r.valueType}): ${value}${r.description ? ` (${r.description})` : ''}`;
    })
    .join('\n');
}

/**
 * Renders the API request as a plain-language summary for the LLM prompt —
 * never the literal secret VALUE of an API key/bearer token/basic-auth
 * password (see REDACTED above): the LLM still needs to know an auth
 * scheme and header/field NAME to generate correct code, but not the real
 * credential, both because it doesn't need it to write correct code (per
 * api-automation-instructions.md's "zero hardcoded secrets" rule, the
 * generated code should reference it via config/env var, not embed it) and
 * because sending real credentials into an LLM request is simply avoided
 * wherever it isn't actually necessary.
 */
export function buildApiRequestSummary(details: ApiRequestDetails): string {
  const lines: string[] = [];
  lines.push(`Method: ${details.method}`);
  lines.push(`URL: ${details.url}`);

  lines.push('Query Params:');
  lines.push(formatRows(details.params));

  lines.push('Headers:');
  lines.push(formatRows(details.headers));

  lines.push(`Authorization: ${authTypeLabel(details.authType)}`);
  lines.push(...formatAuthFields(details.authType, details.auth));

  lines.push(`Body mode: ${details.bodyMode}`);
  if (details.bodyMode === 'form-data') {
    lines.push('Form-data fields:');
    lines.push(formatFormDataRows(details.bodyFormFields));
  } else if (details.bodyMode === 'x-www-form-urlencoded') {
    lines.push('x-www-form-urlencoded fields:');
    lines.push(formatRows(details.bodyUrlencodedFields));
  } else if (details.bodyMode === 'raw') {
    const format = rawBodyFormatInfo(details.bodyRawLanguage);
    lines.push(
      `Raw body — data format: **${format.label}** (the user explicitly selected this in the Control Panel's Body ` +
        `tab; treat the body below as ${format.label}, not any other format, regardless of how it happens to look) ` +
        `— set \`Content-Type: ${format.contentType}\` on the request${format.parseNote ? `; ${format.parseNote}` : ''}.`
    );
    lines.push(`\`\`\`${format.fence}`);
    lines.push(details.bodyRaw || '(empty)');
    lines.push('```');
  }

  return lines.join('\n');
}

/** Maps the raw body's language picker (`bodyRawLanguage` — 'JSON' / 'XML'
 * / 'Text', exactly as the Control Panel's select option values read) to
 * everything the LLM needs to generate code that actually treats the body
 * as that format: the real Content-Type to set, the fenced-code-block
 * language tag (so the body itself is visually/structurally unambiguous
 * in the prompt too, not just labeled in prose), and — for JSON/XML — a
 * reminder to parse/serialize accordingly rather than pass it as an
 * opaque string. Unrecognized values fall back to Text, never silently to
 * JSON — the user's actual selection must never be guessed at. */
function rawBodyFormatInfo(bodyRawLanguage: string): { label: string; contentType: string; fence: string; parseNote: string } {
  switch (bodyRawLanguage) {
    case 'JSON':
      return {
        label: 'JSON',
        contentType: 'application/json',
        fence: 'json',
        parseNote: 'build/send it as real structured JSON (a serialized object/POJO, or a JSON library), never as a hand-typed string'
      };
    case 'XML':
      return {
        label: 'XML',
        contentType: 'application/xml',
        fence: 'xml',
        parseNote: 'build/send it as real XML (an XML library/builder or a properly escaped template), never as a hand-typed string with no escaping'
      };
    default:
      return { label: 'plain text', contentType: 'text/plain', fence: '', parseNote: '' };
  }
}

function authTypeLabel(type: ApiAuthType): string {
  switch (type) {
    case 'apikey':
      return 'API Key';
    case 'bearer':
      return 'Bearer Token';
    case 'basic':
      return 'Basic Auth';
    case 'digest':
      return 'Digest Auth';
    case 'oauth1':
      return 'OAuth 1.0';
    case 'oauth2':
      return 'OAuth 2.0';
    case 'hawk':
      return 'Hawk Authentication';
    case 'awsv4':
      return 'AWS Signature';
    case 'ntlm':
      return 'NTLM Authentication';
    case 'edgegrid':
      return 'Akamai EdgeGrid';
    default:
      return 'No Auth';
  }
}

/** One line per field of whichever auth type is actually selected — every
 * secret-shaped field (keys, secrets, tokens, passwords) goes through
 * REDACTED, exactly like the original API Key/Bearer/Basic handling did;
 * everything else (usernames, key NAMES, regions, algorithms, header
 * prefixes) is plain, non-secret metadata the LLM needs to generate the
 * right shape of code and is sent as-is. */
function formatAuthFields(type: ApiAuthType, auth: ApiAuthFields): string[] {
  const notSet = (v: string) => v || '(not set)';
  const secret = (v: string) => (v ? REDACTED : '(not set)');
  switch (type) {
    case 'apikey':
      return [
        `  - Key name: ${notSet(auth.apiKeyName)}`,
        `  - Value: ${secret(auth.apiKeyValue)}`,
        `  - Added to: ${auth.apiKeyAddTo === 'query' ? 'Query Params' : 'Header'}`
      ];
    case 'bearer':
      return [`  - Token: ${secret(auth.bearerToken)}`];
    case 'basic':
      return [`  - Username: ${notSet(auth.basicUsername)}`, `  - Password: ${secret(auth.basicPassword)}`];
    case 'digest':
      return [`  - Username: ${notSet(auth.digestUsername)}`, `  - Password: ${secret(auth.digestPassword)}`];
    case 'oauth1':
      return [
        `  - Consumer Key: ${secret(auth.oauth1ConsumerKey)}`,
        `  - Consumer Secret: ${secret(auth.oauth1ConsumerSecret)}`,
        `  - Access Token: ${secret(auth.oauth1AccessToken)}`,
        `  - Token Secret: ${secret(auth.oauth1TokenSecret)}`,
        `  - Signature Method: ${notSet(auth.oauth1SignatureMethod)}`
      ];
    case 'oauth2':
      return [`  - Access Token: ${secret(auth.oauth2AccessToken)}`, `  - Header Prefix: ${notSet(auth.oauth2HeaderPrefix)}`];
    case 'hawk':
      return [
        `  - Hawk Auth ID: ${notSet(auth.hawkAuthId)}`,
        `  - Hawk Auth Key: ${secret(auth.hawkAuthKey)}`,
        `  - Algorithm: ${notSet(auth.hawkAlgorithm)}`
      ];
    case 'awsv4':
      return [
        `  - Access Key: ${secret(auth.awsAccessKey)}`,
        `  - Secret Key: ${secret(auth.awsSecretKey)}`,
        `  - Session Token: ${auth.awsSessionToken ? secret(auth.awsSessionToken) : '(not set — not using temporary credentials)'}`,
        `  - AWS Region: ${notSet(auth.awsRegion)}`,
        `  - Service Name: ${notSet(auth.awsServiceName)}`
      ];
    case 'ntlm':
      return [
        `  - Username: ${notSet(auth.ntlmUsername)}`,
        `  - Password: ${secret(auth.ntlmPassword)}`,
        `  - Domain: ${auth.ntlmDomain || '(not set)'}`,
        `  - Workstation: ${auth.ntlmWorkstation || '(not set)'}`
      ];
    case 'edgegrid':
      return [
        `  - Access Token: ${secret(auth.edgeGridAccessToken)}`,
        `  - Client Token: ${secret(auth.edgeGridClientToken)}`,
        `  - Client Secret: ${secret(auth.edgeGridClientSecret)}`
      ];
    default:
      return [];
  }
}
