import * as path from 'path';
// Type-only — erased at compile time, so this stays free of any RUNTIME
// vscode dependency (see this file's own top-of-file doc comment); only
// used to type `LinkedSourceFile.uri` below.
import type * as vscode from 'vscode';

/**
 * "Link Existing Class file" (Control Panel, Generated Code section) — lets
 * a user point SoftPlay at an existing `.java`/`.py` test class BEFORE
 * clicking "Start AI Code Generation", so the model retrofits the newly
 * recorded/described automation INTO that file instead of generating a
 * brand-new one from scratch. This module holds the small, pure, per-file
 * pieces shared by BOTH automation modes (UI and API) and both languages —
 * language detection from a filename, size/emptiness validation, and the
 * "what filename should a save suggest" derivation — so
 * `objectSpyPanel.ts`'s orchestration (the actual `vscode.workspace.fs`
 * read, the two-pass credential redaction, and the prompt-section
 * rendering) has exactly ONE place to call into for each of these
 * decisions, instead of four near-identical copies (one per
 * mode x language combination).
 *
 * Deliberately narrow: this module does NOT parse Java/Python source at
 * all (no regex-based "is this syntactically valid Java" check — the
 * project's own standing rule is that fragile regex parsing is not proof of
 * syntactic validity). Whether a linked file's content is well-formed
 * source is left entirely to the model itself; this module only ever
 * decides two purely mechanical things: what language a FILENAME implies,
 * and whether the file's raw byte/character content is even worth sending
 * (non-empty, not absurdly large).
 */

export type LinkedSourceLanguage = 'java' | 'python';

/** Identity of a currently-linked file — deliberately tiny and
 * content-free, so it's safe to hold as long-lived panel state and to post
 * to the webview for the compact status chip/tooltip. The actual file
 * content is never stored here; it's re-read (through the existing
 * mtime-validated cache) once per generation request — see
 * `objectSpyPanel.ts`'s `resolveLinkedSourceForRequest()`. */
export interface LinkedSourceFile {
  /** The ORIGINAL `vscode.Uri` exactly as returned by the file picker — ANY
   * scheme (`file:`, `vscode-remote:`, `vscode-vfs:`, ...), never
   * reconstructed. Reconstructing an identity from a bare `fsPath` string
   * via `vscode.Uri.file()` would silently force the `file:` scheme,
   * discarding a remote/virtual workspace's real scheme+authority — this
   * feature's own "read through vscode.workspace.fs to support remote
   * workspaces" requirement only actually holds if the ORIGINAL URI is
   * what every later read uses, not a same-looking but differently-scoped
   * reconstruction. */
  uri: vscode.Uri;
  /** Just the filename (e.g. "CassandraHelper.java") — shown in the compact
   * status chip and used to derive a save-name suggestion compatible with
   * this file's own (preserved) class/module name. */
  fileName: string;
  language: LinkedSourceLanguage;
}

/** The linked file's content after it has been read and put through the
 * existing credential-protection pipeline — the exact, single snapshot
 * reused for BOTH mandatory-token measurement and the real prompt (see
 * `runLlmRefinement()`'s own "snapshot once, reuse everywhere" discipline).
 * Never persisted anywhere; lives only for the duration of one request. */
export interface PreparedLinkedSource {
  fileName: string;
  language: LinkedSourceLanguage;
  content: string;
  /** How many credential-shaped literals were encrypted while preparing
   * this snapshot — purely for the Output channel's own transparency line,
   * mirroring the existing `encryptedCount` reported for recorded code and
   * chat text. */
  encryptedCount: number;
}

/** A generous but real ceiling — large enough for any genuine single test
 * class/module, small enough that a multi-megabyte accidental selection
 * (e.g. a whole bundled jar mis-picked, or a giant generated file) fails
 * fast with an actionable message instead of silently blowing the model's
 * context budget once mixed with everything else this feature also sends. */
export const MAX_LINKED_SOURCE_CHARS = 200_000;

/** Detects Java/Python purely from a filename's extension, case-insensitive
 * — the ONLY signal this feature uses to decide a linked file's language.
 * Returns `undefined` for anything else (the picker itself is already
 * restricted to `.java`/`.py`, but a defensive check costs nothing). */
export function detectLinkedSourceLanguage(fileName: string): LinkedSourceLanguage | undefined {
  const ext = path.extname(fileName).toLowerCase();
  if (ext === '.java') {
    return 'java';
  }
  if (ext === '.py') {
    return 'python';
  }
  return undefined;
}

/** The filename with its extension stripped — used as a save-name
 * suggestion compatible with the linked file's OWN (preserved) class/module
 * name, e.g. so a Java save never suggests a different name than the
 * public class the model was told to keep. Deliberately just strips the
 * extension rather than re-deriving anything from content — the supplied
 * file's own name IS the name to preserve, by definition of "retrofit this
 * file," so there's nothing to compute beyond removing the extension. */
export function linkedSourceBaseName(fileName: string): string {
  const ext = path.extname(fileName);
  return ext ? fileName.slice(0, -ext.length) : fileName;
}

export type LinkedSourceValidationError =
  | { kind: 'empty' }
  | { kind: 'too-large'; chars: number; maxChars: number };

/** Checks the two purely mechanical, content-independent problems a linked
 * file's content can have — empty, or unreasonably large. Anything about
 * whether the content is syntactically valid Java/Python is deliberately
 * out of scope (see this module's own top-of-file doc comment). Returns
 * `undefined` when the content is fine to proceed with. */
export function validateLinkedSourceContent(content: string): LinkedSourceValidationError | undefined {
  if (!content.trim()) {
    return { kind: 'empty' };
  }
  if (content.length > MAX_LINKED_SOURCE_CHARS) {
    return { kind: 'too-large', chars: content.length, maxChars: MAX_LINKED_SOURCE_CHARS };
  }
  return undefined;
}

/** Renders a `LinkedSourceValidationError` into the exact user-facing
 * message `objectSpyPanel.ts` shows via `vscode.window.showErrorMessage()`
 * — kept here, next to the check itself, so the wording for a given error
 * kind is defined exactly once. */
export function describeLinkedSourceValidationError(fileName: string, error: LinkedSourceValidationError): string {
  switch (error.kind) {
    case 'empty':
      return `"${fileName}" is empty — link a file that already has some content to retrofit.`;
    case 'too-large':
      return (
        `"${fileName}" is too large to link (${error.chars.toLocaleString()} characters, ` +
        `limit ${error.maxChars.toLocaleString()}) — pick a smaller file, or split this one before linking it.`
      );
  }
}

/** The exact retrofit comment this feature asks the model to add, once, to
 * a retrofitted result — see this feature's own generation-instructions
 * section for placement rules. Defined once here so the prompt-building
 * code and any test asserting on it never risk drifting apart. */
export function retrofitComment(language: LinkedSourceLanguage): string {
  return language === 'java' ? '// New code retrofitted into existing class provided by user.' : '# New code retrofitted into existing class provided by user.';
}
