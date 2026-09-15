import { parseFeatureFile } from './gherkinParser';

/**
 * F09: a small, EXPLICITLY-SCOPED additional check on top of
 * `gherkinParser.ts`'s own lenient `parseFeatureFile()` — deliberately NOT
 * a full Gherkin grammar/CFG parser. `gherkinParser.ts`'s own doc comment
 * already documents this codebase's considered choice to avoid
 * `@cucumber/gherkin`'s large/WASM dependency tree for a small,
 * line-oriented parser that "degrades to plain text rather than breaking"
 * on anything it doesn't fully understand — which is exactly why it never
 * throws or signals an error for a genuinely malformed file (an
 * unterminated doc string silently swallows the rest of the file as
 * "content"; a mismatched Examples table is accepted as-is). This module
 * closes exactly those two reproduced gaps, deterministically, without
 * reversing that earlier, documented dependency decision.
 *
 * This is NOT a claim of full Gherkin-spec conformance — a file that
 * passes `validateFeatureFileStructure()` is not guaranteed valid by the
 * official Gherkin grammar, only free of the SPECIFIC structural defects
 * this function actually checks for (see each check's own comment).
 */

export interface FeatureStructuralValidationResult {
  ok: boolean;
  /** Present only when `ok` is false — a human-readable, specific reason
   * (never a generic "invalid Gherkin"). */
  reason?: string;
  /** The text to actually use — `content` with exactly one outer
   * Markdown fence stripped, if the ENTIRE response was wrapped in one
   * despite being asked not to (a model this codebase supports has, in
   * practice, still occasionally done this — see the identical
   * `stripOuterFence()` precedent in `rag/ragRecipeNormalizer.ts` and
   * `agentic/csvTestCaseGenerator.ts`). Callers should save/measure THIS
   * text, never the original `content` passed in. */
  normalized: string;
}

/** Strips exactly one outer fence (```` ```gherkin ... ``` ```` or a bare
 * ```` ``` ... ``` ````) wrapping the ENTIRE text — never a fence
 * appearing partway through (that's either a real doc string the checks
 * below examine, or genuinely malformed content this function isn't
 * trying to repair). */
function stripOuterFence(text: string): string {
  const trimmed = text.trim();
  const match = trimmed.match(/^```[^\n]*\n([\s\S]*)\n```$/);
  return match ? match[1].trim() : trimmed;
}

/** An unterminated `"""`/```` ``` ```` doc string — opened on some step's
 * line, never closed before EOF. `gherkinParser.ts`'s own step-parsing
 * loop (`consumeSteps()`) treats "ran out of lines while still inside a
 * doc string" as "the doc string is everything remaining" and returns
 * successfully — no signal anywhere that anything went wrong. Detected
 * here by literally replaying the same "am I inside a doc string"
 * state machine ourselves and checking whether it's STILL open at EOF. */
function findUnterminatedDocString(lines: string[]): string | undefined {
  let openFence: string | undefined;
  for (const line of lines) {
    const trimmed = line.trim();
    if (openFence) {
      if (trimmed.startsWith(openFence)) {
        openFence = undefined;
      }
      continue;
    }
    if (trimmed.startsWith('"""') || trimmed.startsWith('```')) {
      openFence = trimmed.slice(0, 3);
    }
  }
  return openFence ? `An opening ${openFence} doc-string delimiter is never closed before the end of the file.` : undefined;
}

/** Every `Examples:` table's own data rows must have the SAME cell count
 * as that SAME table's header row — `gherkinParser.ts`'s own table
 * consumption (`consumeTable()`) accepts any row shape as-is, including
 * one with a different column count than its own header, which would
 * either silently drop or misalign example values at Scenario Outline
 * expansion time. Checked by re-scanning raw `Examples:` blocks directly
 * (not `parseFeatureFile()`'s own already-parsed `GherkinExamples`, which
 * doesn't preserve enough position/row-shape detail for this specific
 * check) — a lightweight, targeted re-scan, not a second full parser. */
function findMismatchedExamplesTable(lines: string[]): string | undefined {
  for (let i = 0; i < lines.length; i++) {
    if (!lines[i].trim().startsWith('Examples:')) {
      continue;
    }
    let j = i + 1;
    while (j < lines.length && !lines[j].trim().startsWith('|')) {
      j++;
    }
    if (j >= lines.length) {
      continue; // an Examples: header with no table at all — not this check's concern
    }
    const headerCells = lines[j].trim().split('|').slice(1, -1).length;
    let k = j + 1;
    while (k < lines.length && lines[k].trim().startsWith('|')) {
      const rowCells = lines[k].trim().split('|').slice(1, -1).length;
      if (rowCells !== headerCells) {
        return `An Examples: table (around line ${k + 1}) has a row with ${rowCells} cell(s), but its own header row has ${headerCells}.`;
      }
      k++;
    }
  }
  return undefined;
}

/** The one entry point — see this module's own doc comment for exact
 * scope. `content` is expected to already be `.trim()`-ed by the caller
 * (matching `parseFeatureFile()`'s own convention); this function trims
 * again defensively regardless. */
export function validateFeatureFileStructure(content: string): FeatureStructuralValidationResult {
  const normalized = stripOuterFence(content);
  const lines = normalized.split(/\r?\n/);

  const docStringReason = findUnterminatedDocString(lines);
  if (docStringReason) {
    return { ok: false, reason: docStringReason, normalized };
  }
  const examplesReason = findMismatchedExamplesTable(lines);
  if (examplesReason) {
    return { ok: false, reason: examplesReason, normalized };
  }
  if (parseFeatureFile(normalized).scenarios.length === 0) {
    return { ok: false, reason: 'No parseable Scenario/Scenario Outline block was found.', normalized };
  }
  return { ok: true, normalized };
}
