import { parseCsvStrict, stringifyCsv, MalformedCsvError } from './csvUtils';

/** F06: strips a single leading UTF-8 BOM from the header's FIRST cell
 * only — the one, explicitly documented exception to "exact header match"
 * below. A `.csv` saved by Excel/Notepad on Windows commonly carries a BOM
 * that would otherwise make an OTHERWISE-correct first column name
 * (`"﻿Summary"` vs `"Summary"`) fail an exact-string comparison for a
 * reason that has nothing to do with the actual column identity. */
function stripBom(cell: string): string {
  return cell.charCodeAt(0) === 0xfeff ? cell.slice(1) : cell;
}

/**
 * Pure post-processing for "Generate Manual Test Cases in CSV" (Total
 * Agentic Mode, see agenticModeController.ts, agenticChains.ts) — the model
 * is asked (via `Jira_test_case_template.md`'s own instructions, injected
 * into the prompt verbatim) to answer with CSV text matching the team's own
 * column spec. This file validates/normalizes that response into a real,
 * re-parseable CSV file rather than trusting the model's raw text
 * byte-for-byte — the exact same "never trust a model's formatting
 * completely" posture as rag/ragRecipeNormalizer.ts's `normalizeGeneratedRecipe()`.
 *
 * Zero `vscode` import — directly unit-testable.
 */

/** Strips a single outer fence wrapping the ENTIRE response, if the model
 * added one despite being told not to — identical rule to
 * rag/ragRecipeNormalizer.ts's `stripOuterFence()`, duplicated locally
 * rather than shared across modules whose only relationship is "both
 * post-process a Copilot text response" (an accidental coupling not worth
 * introducing for four lines of logic). */
function stripOuterFence(text: string): string {
  const trimmed = text.trim();
  const match = trimmed.match(/^```[^\n]*\n([\s\S]*)\n```$/);
  return match ? match[1].trim() : trimmed;
}

export interface NormalizedTestCaseCsv {
  /** Always valid, re-parseable CSV text (CRLF line endings) — a header
   * row plus one or more data rows, every row verified (F06 — not just
   * padded) to already be the header's own exact width. */
  content: string;
  rowCount: number;
  columnCount: number;
  /** Item 7 (soft check): non-empty when the team supplied a real example
   * CSV template (`.github/Jira_test_case_template.csv`) AND at least one
   * generated data row left a cell blank where the template's own first
   * example row was populated — appended to the caller's own success
   * message rather than blocking the save (this codebase's existing "soft
   * target, never a hard cap" precedent — see ragCorpusGenerator.ts's
   * `RAG_RECIPE_TOKEN_TARGET`). Empty string whenever there's nothing to
   * flag (no template given, or every row is as complete as the example). */
  populationNote: string;
}

/** Item 7: the team's own real example CSV — see
 * agenticModeController.ts's `readCsvTemplateExample()`, which builds
 * this. Optional; every caller of `normalizeTestCaseCsvResponse()` works
 * exactly as before this feature existed when it's omitted. */
export interface CsvTemplateExpectation {
  header: string[];
  exampleRows: string[][];
}

export class InvalidTestCaseCsvError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidTestCaseCsvError';
  }
}

/**
 * Validates and re-serializes a model's raw CSV response. Unlike
 * `normalizeGeneratedRecipe()`'s "always produce something, fall back to a
 * wrapper" posture, a manual test-case CSV has no sensible fallback shape —
 * a Jira import needs REAL rows matching REAL columns, so a response that
 * doesn't parse into at least a header row throws `InvalidTestCaseCsvError`
 * (caught by the caller and surfaced as a clear, actionable error rather
 * than silently writing a garbage file).
 *
 * F06: uses `parseCsvStrict()` (unpadded — see its own doc comment for
 * exactly why `parseCsv()`'s ingestion-oriented padding is wrong for this
 * purpose: it silently disguises a too-short header as "the right width"
 * once padded to match a wider data row). Every data row's own true width
 * must equal the header's own true width — no padding to paper over a
 * mismatch. `expected`, when the team has a real example CSV template,
 * requires an EXACT header match — cell values AND order, not just
 * length (a mismatch here is the one truly objective, deterministic part
 * of "match the template," so it's a hard `InvalidTestCaseCsvError`) —
 * plus the SOFT row-population completeness note (see
 * `NormalizedTestCaseCsv.populationNote`'s own doc comment for why that
 * one never blocks the save).
 */
export function normalizeTestCaseCsvResponse(rawResponse: string, expected?: CsvTemplateExpectation): NormalizedTestCaseCsv {
  const candidate = stripOuterFence(rawResponse);
  let parsedRows: string[][];
  try {
    parsedRows = parseCsvStrict(candidate);
  } catch (err) {
    if (err instanceof MalformedCsvError) {
      throw new InvalidTestCaseCsvError(`The model's response is not valid CSV: ${err.message}`);
    }
    throw err;
  }
  const rows = parsedRows.filter((row) => row.some((cell) => cell.trim().length > 0));
  if (rows.length === 0) {
    throw new InvalidTestCaseCsvError('The model\'s response did not contain any parseable CSV rows.');
  }
  const [rawHeader, ...dataRows] = rows;
  const header = rawHeader.length > 0 ? [stripBom(rawHeader[0]), ...rawHeader.slice(1)] : rawHeader;
  if (header.every((cell) => cell.trim().length === 0)) {
    throw new InvalidTestCaseCsvError('The model\'s response is missing a header row.');
  }
  if (dataRows.length === 0) {
    throw new InvalidTestCaseCsvError('The model\'s response had a header row but no actual test-case data rows.');
  }
  // F06: every row's own TRUE width (no padding) must match the header's —
  // a short OR a long row is equally invalid; naming the row lets a human
  // find it immediately in whatever the model actually returned.
  dataRows.forEach((row, i) => {
    if (row.length !== header.length) {
      throw new InvalidTestCaseCsvError(
        `Row ${i + 1} of the model's response has ${row.length} column(s), but the header has ${header.length}. ` +
          `Every row must have exactly as many columns as the header — regenerate.`
      );
    }
  });
  if (expected) {
    const expectedHeader = expected.header.length > 0 ? [stripBom(expected.header[0]), ...expected.header.slice(1)] : expected.header;
    const matches = header.length === expectedHeader.length && header.every((cell, i) => cell === expectedHeader[i]);
    if (!matches) {
      throw new InvalidTestCaseCsvError(
        `The response's header ("${header.join('", "')}") does not exactly match .github/Jira_test_case_template.csv's ` +
          `header ("${expectedHeader.join('", "')}") — same column names, in the same order, are required. Regenerate.`
      );
    }
  }

  // Item 7 (soft): flag any generated data-row cell left blank where the
  // template's own first example row was populated in that same column
  // position — never blocks the save, just surfaces the note for review.
  let populationNote = '';
  if (expected && expected.exampleRows.length > 0) {
    const templateRow = expected.exampleRows[0];
    let incompleteCells = 0;
    let incompleteRows = 0;
    for (const row of dataRows) {
      let rowIsIncomplete = false;
      for (let i = 0; i < templateRow.length && i < row.length; i++) {
        if (templateRow[i].trim().length > 0 && row[i].trim().length === 0) {
          incompleteCells++;
          rowIsIncomplete = true;
        }
      }
      if (rowIsIncomplete) {
        incompleteRows++;
      }
    }
    if (incompleteCells > 0) {
      populationNote = ` Note: ${incompleteCells} cell(s) across ${incompleteRows} row(s) look less complete than the template's own example — review before import.`;
    }
  }

  return {
    content: stringifyCsv([header, ...dataRows]),
    rowCount: dataRows.length,
    columnCount: header.length,
    populationNote
  };
}
