import * as vscode from 'vscode';
import { encryptSecret, looksLikeSecretField, SECRET_FIELD_PATTERN } from './secretVault';

/**
 * UI Automation mode's half of "Auto Password Encryption". Playwright
 * Codegen's raw output embeds whatever was literally typed into the
 * recording browser as a plain string argument — e.g.
 * `page.getByLabel("Password").fill("Secret123!")` (Python) or
 * `page.getByLabel("Password").fill("Secret123!");` (Java, since codegen's
 * own `--target` flag controls which language is emitted directly — see
 * browser/codegenManager.ts). That literal would otherwise flow straight
 * into the LLM prompt AND into the final saved test file in plaintext.
 *
 * This scans the recorded code line-by-line and replaces exactly the
 * string literal of a `.fill(...)` / `.type(...)` / `.pressSequentially(...)`
 * call whose line looks like it targets a credential field (see
 * `looksLikeSecretField()`) with a call to the language-appropriate decrypt
 * helper wrapping a freshly-encrypted token — so the plaintext value is
 * encrypted before this function ever returns, and never appears again in
 * anything built from its result.
 *
 * Deliberately narrow in scope: this transforms only the COPY of the code
 * handed to the LLM (and, via the same call, the "original context" resent
 * on every Verify & Fix Code fix attempt) — never the raw recording shown
 * verbatim in the sidebar's own "Generated Code" view, which by design
 * always mirrors Playwright Codegen's real output unmodified.
 */

const FILL_CALL_PATTERN = /\.(fill|type|pressSequentially)\(\s*(['"])((?:\\.|(?!\2)[\s\S])*?)\2\s*\)/;

/**
 * "Link Existing Class file" (external review, 2026-09-18, rounds 2-5): a
 * source-aware "quoted string literal" fragment, meant to be embedded
 * inside a larger pattern via string interpolation. Recognizes every
 * string-literal SHAPE this module needs to at least IDENTIFY (not
 * necessarily safely transform — see `parseQuotedLiteral()` for the
 * distinction) in a linked existing class:
 *
 *  - an ordinary double- or single-quoted literal, with backslash escapes
 *    (`"a\"b"`, `'a\'b'`);
 *  - a Python triple-quoted literal (`"""..."""` / `'''...'''`), which can
 *    contain unescaped newlines and quote characters;
 *  - an optional 1-2 letter Python string prefix (`r`, `b`, `f`, `u`, or a
 *    combination like `rb`/`br`/`rf`/`fr`) before either form.
 *
 * Each alternative is written with its OWN hard-coded quote character
 * rather than a backreference — simpler to combine into larger patterns,
 * and just as precise, since each branch can only ever close with the same
 * quote it opened with.
 *
 * Round-5 review: earlier rounds treated EVERY matched prefix the same way
 * (strip it, decode the rest as a plain string) — which silently discarded
 * an f-string's interpolation (`f"fake-{suffix}"` decrypted back to the
 * literal text `fake-{suffix}`, `{suffix}` never evaluated) and silently
 * changed a byte-string's runtime TYPE (`b"..."` became a plain `str`).
 * `parseQuotedLiteral()` now inspects the prefix and decides, per shape,
 * whether a decrypt-call substitution can actually reproduce the original
 * runtime value — see its own doc comment.
 */
const QUOTED_LITERAL_SOURCE = '[a-zA-Z]{0,2}(?:"""[\\s\\S]*?"""|\'\'\'[\\s\\S]*?\'\'\'|"(?:\\\\.|[^"\\\\])*"|\'(?:\\\\.|[^\'\\\\])*\')';

/**
 * "Link Existing Class file" (external review, 2026-09-18, rounds 2-5): a
 * linked existing test class can contain credentials shaped nothing like a
 * recorded `.fill()`/`.type()` call — e.g. REST-Assured's
 * `given().auth().preemptive().basic("user", "pass")`, or Python's
 * `HTTPBasicAuth('user', 'pass')` / `auth=('user', 'pass')` tuple, or a
 * single bearer/API-key token passed straight to a method. None of these
 * lines contain a "password"-shaped WORD for `looksLikeSecretField()` to
 * key off (the giveaway is the METHOD/PARAMETER NAME, not label text), so
 * they need their own explicit, narrow patterns — checked independently of
 * `looksLikeSecretField()` for exactly that reason.
 *
 * Each `secretGroup` captures the ENTIRE quoted literal (see
 * `QUOTED_LITERAL_SOURCE`'s own doc comment) — prefix and quotes included,
 * never just its inner content. Passing that whole span to
 * `replaceGroupWithinMatch()` below means the replacement
 * (`` decryptCall("token") ``) takes the quotes' own place instead of
 * landing INSIDE them — an earlier fix captured only the inner content,
 * which left the surrounding quote characters in place and produced
 * invalid, double-quoted garbage (`"SecretVault.decrypt("ENC[...]")"`)
 * instead of a real expression.
 *
 * `g` + `d` flags: `matchAll()` finds EVERY occurrence in the whole file
 * (not just the first, and not restricted to one physical line — `\s`
 * already matches newlines, so a call whose arguments are split across
 * several lines is found exactly the same way as one written on a single
 * line), and `.indices` reports exactly where each captured group
 * starts/ends. This is a deliberately small, explicitly documented list of
 * well-known shapes, not a claim of universal auth-pattern coverage — an
 * unrecognized way of passing a credential is a residual, documented
 * limitation, same posture as `looksLikeSecretField()`'s own doc comment.
 */
const AUTH_CALL_PATTERNS: { pattern: RegExp; secretGroup: number }[] = [
  // REST-Assured / generic fluent Java or JS: .basic("user", "pass") —
  // also matches the "basicAuth(...)" spelling some HTTP client libraries
  // use. The username (1st arg) is left completely untouched (matched, but
  // not captured — no group wraps it).
  { pattern: new RegExp(`\\.basic(?:Auth)?\\(\\s*${QUOTED_LITERAL_SOURCE}\\s*,\\s*(${QUOTED_LITERAL_SOURCE})\\s*\\)`, 'gd'), secretGroup: 1 },
  // Python requests: HTTPBasicAuth('user', 'pass').
  { pattern: new RegExp(`HTTPBasicAuth\\(\\s*${QUOTED_LITERAL_SOURCE}\\s*,\\s*(${QUOTED_LITERAL_SOURCE})\\s*\\)`, 'gd'), secretGroup: 1 },
  // Python requests: auth=('user', 'pass') tuple, e.g. requests.get(url, auth=('user', 'pass')).
  { pattern: new RegExp(`\\bauth\\s*=\\s*\\(\\s*${QUOTED_LITERAL_SOURCE}\\s*,\\s*(${QUOTED_LITERAL_SOURCE})\\s*\\)`, 'gd'), secretGroup: 1 },
  // A single bearer token / API key passed straight to a well-named method
  // — .bearer("token"), .oauth2("token"), .apiKey("token").
  { pattern: new RegExp(`\\.(?:bearer|oauth2|apiKey)\\(\\s*(${QUOTED_LITERAL_SOURCE})\\s*\\)`, 'gd'), secretGroup: 1 }
];

/**
 * "Link Existing Class file" (external review, 2026-09-18, rounds 2-5): a
 * hardcoded credential FIELD in a linked existing class — e.g.
 * `private static final String apiKey = "sk-real-1234567890";` — needs the
 * same "encrypt the literal, leave everything else alone" treatment as a
 * recorded `.fill()` call. Deliberately narrower than
 * `chatInstructionRedactor.ts`'s own `LABEL_VALUE_PATTERN` (built for
 * free-form chat text, where a bare trailing word is still worth treating
 * as a possible secret): this pattern requires the value to actually BE a
 * quoted string literal (see `QUOTED_LITERAL_SOURCE`) — no fallback to a
 * bare/unquoted token — so a genuine existing declaration like `String
 * password = existingPassword;` (a variable REFERENCE, not a literal), or
 * `String apiKey = someFunc();` (a call), never match at all, and that
 * reused identifier/expression reaches the model completely unchanged.
 * Reusing `LABEL_VALUE_PATTERN` itself here was the exact bug this pattern
 * replaces it for: its own bare-token fallback branch is what let it treat
 * an executable expression as if it were a hardcoded secret value.
 *
 * Group 3 is the ENTIRE quoted literal (see `AUTH_CALL_PATTERNS`'s own
 * comment for why that matters). `g` + `d` flags for the same
 * find-everything, not-just-the-first-line reason as `AUTH_CALL_PATTERNS`.
 */
const FIELD_LITERAL_ASSIGNMENT_PATTERN = new RegExp(`(${SECRET_FIELD_PATTERN.source})(\\s*[:=]\\s*)(${QUOTED_LITERAL_SOURCE})`, 'gid');
const FIELD_LITERAL_SECRET_GROUP = 3;

/**
 * "Link Existing Class file" (external review, 2026-09-18, rounds 3-5): a
 * connection string embedded as a plain quoted literal —
 * `String url = "postgres://demo:FAKE_PASSWORD@localhost/db";` — has no
 * "password"-shaped variable NAME for `FIELD_LITERAL_ASSIGNMENT_PATTERN`'s
 * own label check to key off (the variable is named `url`, not
 * `password`); the credential shape is in the VALUE, not the label.
 *
 * Round-5 review: the FIRST version of this pattern never captured a
 * leading string prefix at all — for `r"postgres://demo:PASS@host/db"`,
 * the match started at the QUOTE, leaving the `r` sitting immediately
 * before the (now-parenthesized) replacement, which reads as a call to a
 * function named `r`. Group (1) now captures that OPTIONAL prefix so it
 * becomes part of the replaced span; `parseConnectionStringPrefix()`
 * decides whether the specific prefix found can be safely represented at
 * all (see its own doc comment) — an unsupported one (e.g. an f-string
 * connection string, or anything with a `b` bytes marker) is left
 * UNTRANSFORMED and reported via `RedactionResult.unsupported` instead of
 * guessed at.
 *
 * Captures: (1) an optional 1-2 letter prefix, (2) the quote character, (3)
 * everything from the scheme up to and including the colon before the
 * password, (4) the password itself, (5) everything from `@` to the end of
 * the connection string. The replacement breaks OUT of the literal before
 * the password and back INTO it after —
 * `("scheme://user:" + decrypt("ENC[...]") + "@host/db")` — valid,
 * executable Java/Python that reconstructs the exact same runtime string,
 * never a token spliced inside an otherwise-untouched literal.
 *
 * Wrapped in an OUTER pair of parentheses (round-4 review): the ORIGINAL
 * literal was one single primary expression, so any method call or
 * operation immediately after it in the source — `"...".lower()` —
 * applied to the WHOLE string. A bare, unparenthesized
 * `"a" + decrypt(...) + "b"` replacement changes that: `.lower()` would
 * then bind to only the LAST term of the concatenation (`"b"`) by normal
 * operator precedence, silently changing the expression's runtime
 * behavior even though the credential itself is correctly protected. The
 * parentheses make the replacement's own precedence match the original
 * literal's — always exactly one primary expression, regardless of what
 * follows it.
 */
const CONNECTION_STRING_IN_CODE_PATTERN = /([a-zA-Z]{0,2})(["'])([a-zA-Z][a-zA-Z0-9+.-]*:\/\/[^\s:@'"]*:)([^\s@'"]+)(@[^\s'"]*)\2/gd;

/**
 * "Link Existing Class file" (external review, 2026-09-18, round 4): a
 * proper single-pass literal-escape decoder — replaces the previous
 * sequential, independent `.replace(/\\n/g, ...)` chain, which could not
 * tell an escaped BACKSLASH (`\\` in the source, i.e. two characters: a
 * backslash then a backslash) apart from the START of some OTHER escape
 * sequence. Concretely: source text containing `\\n` (backslash, backslash,
 * n — an escaped backslash followed by a literal `n`) was WRONGLY decoded
 * to a backslash followed by a REAL newline, because the `\n`-decoding
 * pass ran independently and matched the trailing `\`+`n` pair before the
 * backslash-escaping pass ever got a chance to claim the leading `\`+`\`
 * pair — changing the actual secret value being encrypted.
 *
 * This walks the string ONCE, left to right, consuming exactly one escape
 * sequence (backslash + the character(s) it governs) per step — so a
 * backslash is always resolved against the character immediately following
 * it before either character is ever reconsidered as part of a DIFFERENT
 * escape. Supports `\n \t \r \" \' \\`, a 4-hex-digit Unicode escape
 * (`\uXXXX`, both languages), a 1-3 digit OCTAL escape (`\NNN`, digits
 * 0-7 — both languages support this, e.g. Java's `\0`-`\377`), and
 * (round-5 review, Python only — Java has no such escape at all) a
 * 2-hex-digit escape (`\xXX`). Anything else after a backslash is kept
 * literally (both characters, unchanged) rather than guessed at.
 */
function unescapeLiteral(raw: string, language: 'java' | 'python'): string {
  let result = '';
  for (let i = 0; i < raw.length; i++) {
    const ch = raw[i];
    if (ch !== '\\' || i === raw.length - 1) {
      result += ch;
      continue;
    }
    const next = raw[i + 1];

    if (next === 'u') {
      const hex = raw.slice(i + 2, i + 6);
      if (/^[0-9a-fA-F]{4}$/.test(hex)) {
        result += String.fromCharCode(parseInt(hex, 16));
        i += 5;
        continue;
      }
      // Not a valid 4-hex-digit escape — falls through to "unrecognized".
    }

    if (language === 'python' && next === 'x') {
      const hex = raw.slice(i + 2, i + 4);
      if (/^[0-9a-fA-F]{2}$/.test(hex)) {
        result += String.fromCharCode(parseInt(hex, 16));
        i += 3;
        continue;
      }
      // Not a valid 2-hex-digit escape — falls through to "unrecognized".
    }

    if (/[0-7]/.test(next)) {
      let octal = next;
      let consumed = 1;
      while (consumed < 3 && /[0-7]/.test(raw[i + 1 + consumed] ?? '')) {
        octal += raw[i + 1 + consumed];
        consumed++;
      }
      result += String.fromCharCode(parseInt(octal, 8) & 0xff);
      i += consumed;
      continue;
    }

    switch (next) {
      case 'n':
        result += '\n';
        i++;
        break;
      case 't':
        result += '\t';
        i++;
        break;
      case 'r':
        result += '\r';
        i++;
        break;
      case '"':
        result += '"';
        i++;
        break;
      case "'":
        result += "'";
        i++;
        break;
      case '\\':
        result += '\\';
        i++;
        break;
      default:
        // Unrecognized escape — keep both characters exactly as written
        // rather than inventing a transformation this module doesn't
        // explicitly document (same conservative posture as
        // `looksLikeSecretField()`'s own doc comment elsewhere in this
        // file's history).
        result += ch + next;
        i++;
        break;
    }
  }
  return result;
}

export interface RedactionResult {
  code: string;
  /** How many literals were found and encrypted — surfaced to the Output
   * channel purely for transparency ("N password(s) automatically
   * encrypted before this was sent"), never blocks or alters the flow. */
  count: number;
  /**
   * "Link Existing Class file" (external review, 2026-09-18, round 5): a
   * credential-shaped literal found in a place this module would otherwise
   * protect, but whose SHAPE cannot be safely reduced to a plain
   * decrypt-call substitution without changing what the code actually does
   * at runtime — right now, only a Python f-string (`f"...{expr}..."`),
   * since a static token can never reproduce an embedded expression's
   * runtime-evaluated value. Each entry is a short, human-readable
   * description (language-appropriate) naming the exact literal found, for
   * an actionable message telling the user to resolve it manually before
   * linking this file. Left COMPLETELY UNTRANSFORMED in `code` — this
   * module never guesses at a transformation it cannot prove preserves
   * both the credential's protection AND the surrounding code's behavior;
   * see this feature's own "if a form cannot be transformed safely, stop
   * instead of silently changing it" requirement. Empty when nothing
   * unsupported was found (the overwhelming common case).
   */
  unsupported: string[];
}

type IndexedMatch = RegExpMatchArray & { indices: Array<[number, number]> };

/**
 * The result of inspecting one matched quoted-literal SPAN (prefix + quotes
 * + content) — decides whether `encryptPasswordLiteralsInCode()` can
 * safely replace it with a decrypt-call expression, and if so, exactly how
 * to read back its real plaintext and what (if anything) needs appending
 * to the replacement so the result keeps the same RUNTIME TYPE as the
 * original literal.
 *
 * Round-5 review — the two concrete gaps this closes:
 *  - An f-string (`f"fake-{suffix}"`) is NOT a static value at all; its
 *    `{suffix}` portion is a live expression evaluated at runtime. Reading
 *    its source text back as if it were the literal string
 *    `"fake-{suffix}"` and encrypting THAT is worse than doing nothing: it
 *    silently discards the interpolation (the model, and the saved file,
 *    would see a decrypt call that always returns the literal text
 *    `fake-{suffix}`, never `suffix`'s real runtime value) while creating a
 *    false impression that the credential was "protected." Reported as
 *    `unsupported` instead.
 *  - A byte-string (`b"secret"`) is a Python `bytes` object at runtime, not
 *    `str`. `secret_vault.decrypt(...)` returns `str` — swapping one in for
 *    the other silently changes the value's TYPE, which can break any
 *    caller expecting `bytes` (e.g. a hashing/HMAC call). Appending
 *    `.encode()` to the decrypt-call replacement converts the decrypted
 *    `str` back to `bytes`, preserving the original type.
 *
 * An `r`/`R` (raw) prefix is still fully supported — it only affects how
 * the ORIGINAL source text should be read (no escape processing at all,
 * since Python raw strings never apply escapes), not the runtime type of
 * the result, so it combines freely with the bytes case (`rb"..."`).
 */
interface ParsedLiteral {
  /** `undefined` exactly when `unsupported` is true — there is no safe
   * plaintext reading for a shape this module refuses to transform. */
  plaintext: string | undefined;
  /** True when this literal's shape cannot be safely replaced with a
   * static decrypt-call expression — see this interface's own doc comment. */
  unsupported: boolean;
  /** A short, human-readable name for the shape found — used to build the
   * `RedactionResult.unsupported` message when `unsupported` is true. */
  shapeDescription: string;
  /** Appended immediately after the decrypt-call replacement — `''` for an
   * ordinary string result, `.encode()` to convert back to `bytes` for a
   * Python byte-string literal. */
  runtimeCoercion: string;
}

/** Parses one matched literal SPAN (prefix + quotes + content, exactly the
 * text `QUOTED_LITERAL_SOURCE`/`CONNECTION_STRING_IN_CODE_PATTERN`'s own
 * quote-matching produces) into a `ParsedLiteral` — see that interface's
 * own doc comment for what each field means and why. */
function parseQuotedLiteral(quotedLiteralWithPrefix: string, language: 'java' | 'python'): ParsedLiteral {
  const prefixMatch = /^[a-zA-Z]{0,2}/.exec(quotedLiteralWithPrefix)!;
  const prefix = prefixMatch[0].toLowerCase();
  const body = quotedLiteralWithPrefix.slice(prefixMatch[0].length);
  const isTriple = body.startsWith('"""') || body.startsWith("'''");
  const quoteLen = isTriple ? 3 : 1;
  const inner = body.slice(quoteLen, body.length - quoteLen);

  if (prefix.includes('f')) {
    return { plaintext: undefined, unsupported: true, shapeDescription: 'a Python f-string (interpolated string literal)', runtimeCoercion: '' };
  }
  const plaintext = prefix.includes('r') ? inner : unescapeLiteral(inner, language);
  const runtimeCoercion = language === 'python' && prefix.includes('b') ? '.encode()' : '';
  return { plaintext, unsupported: false, shapeDescription: '', runtimeCoercion };
}

/** Replaces the span of `match[group]` — which must fall entirely inside
 * `match[0]` — with `replacement`, returning the resulting text for the
 * WHOLE match. Used when only one piece of a larger matched call/statement
 * (e.g. just the password argument of `.basic("user", "pass")`) needs to
 * change; everything else in the match (method name, the other argument)
 * is copied through untouched. */
function replaceGroupWithinMatch(match: IndexedMatch, group: number, replacement: string): string {
  const [matchStart] = match.indices[0];
  const [groupStart, groupEnd] = match.indices[group];
  const whole = match[0];
  return whole.slice(0, groupStart - matchStart) + replacement + whole.slice(groupEnd - matchStart);
}

/**
 * Finds every occurrence of `pattern` (which MUST carry the `g` and `d`
 * flags) across the ENTIRE `text` — not line by line — and replaces each
 * one with whatever `buildReplacement` returns for it. `buildReplacement`
 * returns `{ replacement }` to substitute, `{ skip: true }` for a match
 * with nothing worth protecting (e.g. an empty literal — left as-is,
 * silently), or `{ unsupported: description }` for a credential-shaped
 * match this module refuses to transform (left as-is in the text, but
 * `description` is collected into the returned `unsupported` list so the
 * caller can decide to stop rather than send it along unprotected).
 *
 * Operating on the whole string at once, rather than a per-line loop, is
 * what makes this find EVERY occurrence regardless of whether a call is
 * repeated on one line or its arguments are split across several
 * (round-2/3 review). Same forward-accumulation technique as
 * `chatInstructionRedactor.ts`'s own `replaceAllAsync()`, generalized here
 * to work from `match.indices` instead of a single fixed-shape capture.
 */
type BuildReplacementResult = { replacement: string } | { skip: true } | { unsupported: string };

async function replaceAllOccurrences(text: string, pattern: RegExp, buildReplacement: (match: IndexedMatch) => Promise<BuildReplacementResult>): Promise<{ text: string; count: number; unsupported: string[] }> {
  const matches = Array.from(text.matchAll(pattern)) as IndexedMatch[];
  if (matches.length === 0) {
    return { text, count: 0, unsupported: [] };
  }
  let count = 0;
  let result = '';
  let lastEnd = 0;
  const unsupported: string[] = [];
  for (const match of matches) {
    const [start, end] = match.indices[0];
    const outcome = await buildReplacement(match);
    if ('unsupported' in outcome) {
      unsupported.push(outcome.unsupported);
      continue;
    }
    if ('skip' in outcome) {
      continue;
    }
    result += text.slice(lastEnd, start) + outcome.replacement;
    lastEnd = end;
    count++;
  }
  result += text.slice(lastEnd);
  return { text: result, count, unsupported };
}

export async function encryptPasswordLiteralsInCode(context: vscode.ExtensionContext, code: string, language: 'java' | 'python'): Promise<RedactionResult> {
  const decryptCall = language === 'java' ? 'SecretVault.decrypt' : 'secret_vault.decrypt';
  let count = 0;
  const unsupported: string[] = [];

  // Pass 1 — recorded UI actions: .fill("secret") / .type("secret") /
  // .pressSequentially("secret"), one line at a time, gated by
  // looksLikeSecretField() (the locator/label text on the line has to
  // actually look password-shaped — a recorded `.fill("Search")` on a
  // search box must never be touched). Recorded Playwright Codegen output
  // is always a plain string literal, never an f-string/byte-string/etc —
  // codegen itself only ever emits that one shape — so this pass has no
  // "unsupported shape" case to report; deliberately unchanged from before
  // this file's round-2..5 fixes.
  const lines = code.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!looksLikeSecretField(line)) {
      continue;
    }
    const match = FILL_CALL_PATTERN.exec(line);
    if (!match) {
      continue;
    }
    const [fullMatch, method, , literalRaw] = match;
    const plaintext = unescapeLiteral(literalRaw, language);
    if (!plaintext) {
      continue; // an empty fill has nothing worth protecting
    }
    const token = await encryptSecret(context, plaintext);
    const replacement = `.${method}(${decryptCall}("${token}"))`;
    lines[i] = line.slice(0, match.index) + replacement + line.slice(match.index! + fullMatch.length);
    count++;
  }
  let result = lines.join('\n');

  // Pass 2 — known auth-call SHAPES (a linked existing class's own API
  // client code) — checked regardless of looksLikeSecretField(), since the
  // giveaway here is the METHOD name (.basic(...), .bearer(...), ...), not
  // label text. Runs across the WHOLE source so a call repeated more than
  // once, or written across multiple lines, is fully covered (round-2/3
  // review) — not just the first match on whichever single line it starts
  // on.
  for (const { pattern, secretGroup } of AUTH_CALL_PATTERNS) {
    const pass = await replaceAllOccurrences(result, pattern, async (match) => {
      const parsed = parseQuotedLiteral(match[secretGroup]!, language);
      if (parsed.unsupported) {
        return { unsupported: `${parsed.shapeDescription} used as a credential argument (\`${match[0]}\`) cannot be automatically encrypted — rewrite it as a plain quoted literal before linking this file.` };
      }
      if (!parsed.plaintext) {
        return { skip: true };
      }
      const token = await encryptSecret(context, parsed.plaintext);
      return { replacement: replaceGroupWithinMatch(match, secretGroup, `${decryptCall}("${token}")${parsed.runtimeCoercion}`) };
    });
    result = pass.text;
    count += pass.count;
    unsupported.push(...pass.unsupported);
  }

  // Pass 3 — a hardcoded credential FIELD declared with a quoted literal —
  // e.g. `private static final String apiKey = "sk-real-...";`. Deliberately
  // requires an actual quoted value (see FIELD_LITERAL_ASSIGNMENT_PATTERN's
  // own doc comment) — an existing variable REFERENCE on the right-hand
  // side (`String password = existingPassword;`) never matches, so that
  // reused identifier reaches the model completely unchanged. Also runs
  // across the whole source, same reasoning as Pass 2.
  {
    const pass = await replaceAllOccurrences(result, FIELD_LITERAL_ASSIGNMENT_PATTERN, async (match) => {
      const parsed = parseQuotedLiteral(match[FIELD_LITERAL_SECRET_GROUP]!, language);
      if (parsed.unsupported) {
        return { unsupported: `${parsed.shapeDescription} assigned to \`${match[1]}\` cannot be automatically encrypted — rewrite it as a plain quoted literal before linking this file.` };
      }
      if (!parsed.plaintext) {
        return { skip: true };
      }
      const token = await encryptSecret(context, parsed.plaintext);
      return { replacement: replaceGroupWithinMatch(match, FIELD_LITERAL_SECRET_GROUP, `${decryptCall}("${token}")${parsed.runtimeCoercion}`) };
    });
    result = pass.text;
    count += pass.count;
    unsupported.push(...pass.unsupported);
  }

  // Pass 4 — a connection string embedded in a plain quoted literal, whose
  // credential is signaled by the VALUE's own shape (scheme://user:pass@host),
  // not by any "password"-looking variable NAME (round-3 review). Supports
  // no prefix or a plain `r` prefix (round-5 review — the prefix, if any,
  // is now part of the matched/replaced span, so it never leaks into the
  // surrounding code as a bogus function call); an f-string or byte-string
  // connection string is reported as unsupported rather than guessed at —
  // reconstructing a byte-typed three-way concatenation correctly is
  // disproportionate complexity for a shape this rare, and an f-string
  // connection string has the exact same "can't preserve interpolation"
  // problem as everywhere else in this file.
  {
    const pass = await replaceAllOccurrences(result, CONNECTION_STRING_IN_CODE_PATTERN, async (match) => {
      const [, rawPrefix, quote, prefixText, passwordRaw, suffix] = match;
      const prefix = (rawPrefix ?? '').toLowerCase();
      if (prefix.includes('f') || prefix.includes('b')) {
        return { unsupported: `a ${prefix}-prefixed connection-string literal (\`${match[0]}\`) cannot be automatically encrypted — rewrite it as a plain quoted literal before linking this file.` };
      }
      const plaintext = prefix.includes('r') ? passwordRaw! : unescapeLiteral(passwordRaw!, language);
      if (!plaintext) {
        return { skip: true };
      }
      const token = await encryptSecret(context, plaintext);
      return { replacement: `(${quote}${prefixText}${quote} + ${decryptCall}("${token}") + ${quote}${suffix}${quote})` };
    });
    result = pass.text;
    count += pass.count;
    unsupported.push(...pass.unsupported);
  }

  return { code: result, count, unsupported };
}
