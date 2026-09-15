import * as vscode from 'vscode';
import { encryptSecret, SECRET_FIELD_PATTERN, TOKEN_MARKER } from './secretVault';

/**
 * "Instant instructions to LLM" free-text half of Auto Password Encryption
 * — closes a real gap uiPasswordRedactor.ts never covered: that module
 * only ever scans RECORDED PLAYWRIGHT CODE (`.fill()`/`.type()` calls) or
 * the API Automation request builder's own dedicated fields. Nothing
 * previously scanned the chat box's own free-text content, so a user
 * typing a real-looking connection string or credential directly into
 * "Instant instructions to LLM" (e.g.
 * `cassandra://user:realpassword@host:9042/keyspace`) sent it to Copilot
 * completely in plaintext — silently contradicting this extension's own
 * "every credential is encrypted by default" guarantee, and (per real
 * evidence from a bank's enterprise Copilot deployment) plausibly enough
 * to trip that deployment's own content-safety/DLP filtering on its own,
 * independent of prompt size.
 *
 * Two independent passes, both aggressive by design (a false positive
 * just means a harmless value gets encrypted too — no real cost; a false
 * negative would defeat the entire feature, matching the exact same
 * philosophy secretVault.ts's `looksLikeSecretField()` already documents):
 *
 * 1. Connection-string embedded credentials — `scheme://user:PASSWORD@host`
 *    (JDBC/ODBC/driver-URI style, covering Postgres, Cassandra, MongoDB,
 *    Redis, AMQP, and any other `scheme://user:pass@host` shape) — only the
 *    password segment is encrypted; a bare username isn't a secret on its
 *    own.
 * 2. Generic `label: value` / `label = value` / `label "value"` pairs
 *    where the label matches the SAME secret-field vocabulary
 *    (secretVault.ts's `SECRET_FIELD_PATTERN`) already used for recorded
 *    UI fields and the API Authorization tab — e.g. "password: xoxo",
 *    "API key = abc123".
 *
 * The result is safe to embed directly in an LLM prompt: replacing a
 * plaintext value with an `ENC[v1:...]` token means
 * `password-encryption-standard.md`'s own mandatory rules (never invent/
 * hardcode a plaintext credential, decrypt only via the generated helper
 * at the exact point of use) apply to it exactly the same as a token that
 * came from a recorded `.fill()` call — the model has no way to tell a
 * chat-derived token from a code-derived one, nor does it need to.
 */

const CONNECTION_STRING_CREDENTIAL_PATTERN = /(\b[a-zA-Z][a-zA-Z0-9+.-]*:\/\/)([^\s:@/]+):([^\s@/]+)@/g;

const LABEL_VALUE_PATTERN = new RegExp(`(${SECRET_FIELD_PATTERN.source})(\\s*[:=]\\s*)(?:"([^"]+)"|'([^']+)'|(\\S+))`, 'gi');

export interface RedactionResult {
  text: string;
  /** How many literals were found and encrypted — surfaced to the Output
   * channel purely for transparency, never blocks or alters the flow. */
  count: number;
}

/** Runs every match of `pattern` against `text` through `encryptOne`
 * (async) and rebuilds the string with each match's result substituted in
 * — a small helper since `String.replace()` has no async-callback form. */
async function replaceAllAsync(
  text: string,
  pattern: RegExp,
  encryptOne: (match: RegExpExecArray) => Promise<string | undefined>
): Promise<{ text: string; count: number }> {
  const matches = Array.from(text.matchAll(pattern));
  if (matches.length === 0) {
    return { text, count: 0 };
  }

  let count = 0;
  let result = '';
  let lastIndex = 0;
  for (const match of matches) {
    const replacement = await encryptOne(match);
    if (replacement === undefined) {
      continue; // this particular match wasn't actually worth encrypting (see callers)
    }
    result += text.slice(lastIndex, match.index) + replacement;
    lastIndex = match.index! + match[0].length;
    count++;
  }
  result += text.slice(lastIndex);
  return { text: result, count };
}

export async function encryptCredentialsInFreeText(context: vscode.ExtensionContext, text: string): Promise<RedactionResult> {
  if (!text.trim()) {
    return { text, count: 0 };
  }

  let count = 0;

  const connectionStringPass = await replaceAllAsync(text, CONNECTION_STRING_CREDENTIAL_PATTERN, async (match) => {
    const [fullMatch, scheme, username, password] = match;
    if (!password || password.startsWith(TOKEN_MARKER)) {
      return undefined; // already encrypted (e.g. this ran once already) — never double-encrypt
    }
    const token = await encryptSecret(context, password);
    return `${scheme}${username}:${token}@`;
  });
  count += connectionStringPass.count;

  const labelValuePass = await replaceAllAsync(connectionStringPass.text, LABEL_VALUE_PATTERN, async (match) => {
    const [fullMatch, label, separator, doubleQuoted, singleQuoted, bare] = match;
    const value = doubleQuoted ?? singleQuoted ?? bare;
    if (!value || value.startsWith(TOKEN_MARKER)) {
      return undefined; // already encrypted, or nothing captured — leave untouched
    }
    const token = await encryptSecret(context, value);
    const quote = doubleQuoted !== undefined ? '"' : singleQuoted !== undefined ? "'" : '';
    return `${label}${separator}${quote}${token}${quote}`;
  });
  count += labelValuePass.count;

  return { text: labelValuePass.text, count };
}

/** F04: a purely SYNCHRONOUS sibling of `encryptCredentialsInFreeText()`
 * for LOGGING, not prompt content — a log line has no need for a
 * reversible `ENC[...]` token (nothing ever decrypts a log line back into
 * a working credential), so this just masks a match to a fixed
 * `[REDACTED]` placeholder using the SAME two detection patterns, with no
 * vault/async round-trip. Used by Total Agentic Mode's Verify & Fix Code
 * (`agenticModeController.ts`) to sanitize tool call/result text before it
 * reaches the Output channel — the exact same residual-risk scope as
 * `encryptCredentialsInFreeText()` itself (password-shaped `.fill()`/
 * `.type()` calls are uiPasswordRedactor.ts's job, not this function's;
 * a free-text secret in neither of these two shapes is not detected). */
export function maskCredentialsForLogging(text: string): string {
  if (!text) {
    return text;
  }
  return text
    .replace(CONNECTION_STRING_CREDENTIAL_PATTERN, (_full, scheme: string, username: string) => `${scheme}${username}:[REDACTED]@`)
    .replace(LABEL_VALUE_PATTERN, (_full, label: string, separator: string, dq?: string, sq?: string, bare?: string) => {
      const quote = dq !== undefined ? '"' : sq !== undefined ? "'" : '';
      return `${label}${separator}${quote}[REDACTED]${quote}`;
    });
}
