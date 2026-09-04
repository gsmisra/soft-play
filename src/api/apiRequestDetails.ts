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

export type ApiAuthType = 'noauth' | 'apikey' | 'bearer' | 'basic';
export type ApiBodyMode = 'none' | 'form-data' | 'x-www-form-urlencoded' | 'raw';

export interface ApiRequestDetails {
  method: string;
  url: string;
  params: ApiKeyValueRow[];
  headers: ApiKeyValueRow[];
  authType: ApiAuthType;
  auth: {
    apiKeyName: string;
    apiKeyValue: string;
    apiKeyAddTo: 'header' | 'query';
    bearerToken: string;
    basicUsername: string;
    basicPassword: string;
  };
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
  if (details.authType === 'apikey') {
    lines.push(`  - Key name: ${details.auth.apiKeyName || '(not set)'}`);
    lines.push(`  - Value: ${details.auth.apiKeyValue ? REDACTED : '(not set)'}`);
    lines.push(`  - Added to: ${details.auth.apiKeyAddTo === 'query' ? 'Query Params' : 'Header'}`);
  } else if (details.authType === 'bearer') {
    lines.push(`  - Token: ${details.auth.bearerToken ? REDACTED : '(not set)'}`);
  } else if (details.authType === 'basic') {
    lines.push(`  - Username: ${details.auth.basicUsername || '(not set)'}`);
    lines.push(`  - Password: ${details.auth.basicPassword ? REDACTED : '(not set)'}`);
  }

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
    default:
      return 'No Auth';
  }
}
