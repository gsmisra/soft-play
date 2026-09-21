/**
 * Shared, zero-`vscode` types for Total Agentic Mode (see
 * agenticModeController.ts, textIngestion.ts, xlsxIngestion.ts,
 * docxIngestion.ts, pdfIngestion.ts, agenticIngestionPanel.ts) — kept in
 * their own file so both the pure ingestion logic and the vscode-glue
 * controller/panel agree on one shape without a circular import.
 */

/** Every input format this extension parses meaningfully. An uploaded file
 * whose extension doesn't match one of these still gets accepted and
 * treated as `'text'` (best-effort raw text) rather than rejected outright
 * — see `detectAgenticFileKind()`. `'xlsx'`/`'docx'`/`'pdf'` are Phase 2 —
 * each has its own parser module (xlsxIngestion.ts/docxIngestion.ts/
 * pdfIngestion.ts) since none of them can be sliced as plain text the way
 * csv/json/xml/yaml/text can. */
export type AgenticFileKind = 'csv' | 'json' | 'xml' | 'yaml' | 'text' | 'xlsx' | 'docx' | 'pdf';

/** How much of ONE ingested file to actually bring into the LLM's context
 * — set by the user in the Ingestion Configuration panel
 * (agenticIngestionPanel.ts). Every field is optional/omittable, always
 * defaulting to "the whole file" (bounded only by the hard character cap),
 * so a user who ingests a small file and never touches its config still
 * gets its full content. */
export interface AgenticIngestionConfig {
  /** 1-based inclusive line range for text/json/xml/yaml (and the fallback
   * `'text'` kind) — omit either bound to mean "from the start"/"to the
   * end". Ignored for `'csv'`/`'xlsx'`, which use `rowRange`/`columns`
   * instead, and for `'docx'`/`'pdf'`, which use `headingRange`/`pageRange`. */
  lineRange?: { from?: number; to?: number };
  /** 1-based inclusive row range for `'csv'`/`'xlsx'`, counted over DATA
   * rows only (the header row is always kept, since a data row divorced
   * from its column names is meaningless to an LLM). Omit either bound for
   * "from the first data row"/"to the last". */
  rowRange?: { from?: number; to?: number };
  /** Exact column names to keep for `'csv'`/`'xlsx'` — omitted/empty means
   * every column. A name not present in the file's actual header is
   * ignored (never an error), so an edited config against a re-dropped,
   * slightly different file degrades gracefully rather than breaking
   * ingestion. */
  columns?: string[];
  /** `'xlsx'` only — which sheet `rowRange`/`columns` apply to. Omitted
   * means the workbook's FIRST sheet (matching "no config = everything
   * from the obvious default" elsewhere in this feature). A name not
   * present in the workbook falls back to the first sheet too, rather than
   * silently sending nothing. */
  sheetName?: string;
  /** `'docx'` only — a 1-based inclusive range over the document's OWN
   * ordered list of headings (see `AgenticFileMeta.docxPreview`), since a
   * .docx file has no real, stored "page" boundaries (those are a
   * rendering-time outcome of margins/fonts, not document data) — a
   * heading range is the closest meaningful equivalent to "a specific part
   * of this document". Omit either bound for "from the very start"/"to the
   * very end" of the document. A document with no headings at all always
   * sends its full text regardless of this field. */
  headingRange?: { fromIndex?: number; toIndex?: number };
  /** `'pdf'` only — a 1-based inclusive PAGE range (PDF genuinely stores
   * page boundaries, unlike docx) — omit either bound for "from the first
   * page"/"to the last". */
  pageRange?: { from?: number; to?: number };
}

export interface AgenticFileMeta {
  /** Stable id for this session — the order the file was dropped in,
   * stringified; never re-used even if an earlier file is removed. */
  id: string;
  fileName: string;
  kind: AgenticFileKind;
  /** Present only for a file imported from a Jira/Confluence attachment:
   * which service, resource and attachment it came from and when. A locally
   * dropped file has none. */
  provenance?: import('./knowledge/knowledgeTypes').AttachmentProvenance;
  /** Original upload size in bytes — shown in the Ingestion Configuration
   * panel so a user can judge "is this worth trimming down" at a glance. */
  sizeBytes: number;
  /** Populated only for `'csv'` — the header row and total data-row count,
   * so the Ingestion Configuration panel can render an actual column
   * checklist / a real "rows 1-N" range control instead of guessing. */
  csvPreview?: { headers: string[]; dataRowCount: number };
  /** Populated only for `'xlsx'` — every sheet's name plus its own header/
   * data-row-count preview, so the panel can render a sheet picker whose
   * row/column controls update the moment a different sheet is chosen. */
  xlsxPreview?: { sheets: { name: string; headers: string[]; dataRowCount: number }[] };
  /** Populated only for `'docx'` — the document's own ordered heading
   * outline (text + level), so the panel can render a "from heading X to
   * heading Y" range picker instead of an abstract index. Empty array for
   * a document with no headings at all (its full text is always sent). */
  docxPreview?: { headings: { text: string; level: number }[] };
  /** Populated only for `'pdf'` — the total page count, so the panel can
   * render a real "pages 1-N" range control. */
  pdfPreview?: { pageCount: number };
}

/** One parsed Excel sheet — a plain 2D grid of already-stringified cell
 * values (numbers/dates/formulas all rendered to their displayed text),
 * the same shape `csvUtils.ts`'s rows already use, so `'xlsx'` reuses the
 * exact same row/column extraction logic as `'csv'` (see
 * xlsxIngestion.ts). */
export interface AgenticXlsxSheet {
  name: string;
  /** First row is the header, exactly like a parsed CSV file. */
  rows: string[][];
}

export interface AgenticXlsxData {
  sheets: AgenticXlsxSheet[];
}

/** One heading-delimited section of a Word document — `text` is everything
 * from just after this heading up to (not including) the next heading at
 * ANY level, or the end of the document for the last heading. A document
 * with no headings at all is represented as a single section with an empty
 * `heading`/`level: 0`. */
export interface AgenticDocxSection {
  heading: string;
  level: number;
  text: string;
}

export interface AgenticDocxData {
  sections: AgenticDocxSection[];
}

export interface AgenticPdfData {
  /** One entry per page, in order — plain extracted text, no layout/column
   * reconstruction beyond what pdf.js's own text-content stream gives. */
  pages: string[];
}

export interface AgenticIngestedFile extends AgenticFileMeta {
  /** Raw file content exactly as uploaded, UTF-8 decoded — populated for
   * the text-like kinds (`csv`/`json`/`xml`/`yaml`/`text`) ONLY. Empty
   * string for `xlsx`/`docx`/`pdf`, which carry their parsed structure in
   * the `parsedXlsx`/`parsedDocx`/`parsedPdf` fields below instead (a
   * binary spreadsheet/document/PDF has no meaningful "raw text" to slice
   * by line the way the text-like kinds do). */
  rawText: string;
  parsedXlsx?: AgenticXlsxData;
  parsedDocx?: AgenticDocxData;
  parsedPdf?: AgenticPdfData;
  config: AgenticIngestionConfig;
}

/** Result of applying one file's `AgenticIngestionConfig` to its parsed
 * content — what actually gets folded into the LLM prompt for that file,
 * plus the info the Token Monitoring / Ingestion Configuration panels need
 * to show without re-deriving it themselves. */
export interface AgenticExtractedSegment {
  fileName: string;
  /** The text actually contributed to the prompt for this file — already
   * capped at `AGENTIC_MAX_SEGMENT_CHARS` (see textIngestion.ts). */
  text: string;
  /** True when the hard character cap actually truncated this file's
   * selected segment — surfaced in the UI so a user knows their selection
   * (or the whole file, if unconfigured) didn't fully make it into context. */
  truncated: boolean;
}

/** Hard per-file safety cap, regardless of what the user's config selects —
 * protects the prompt (and the Copilot request itself) from one
 * pathological/misconfigured file ("the whole rows" on a 500k-row CSV)
 * blowing the context window on its own. Generous enough for a genuinely
 * large requirements doc or data excerpt. */
export const AGENTIC_MAX_SEGMENT_CHARS = 60_000;

/** Extensions recognized for structured ingestion — anything else dropped
 * is still accepted, just treated as best-effort raw `'text'` (see
 * `detectAgenticFileKind()` in textIngestion.ts). Legacy binary `.xls`/
 * `.doc` (pre-2007 Office formats) are deliberately NOT included — they
 * are entirely different binary formats from `.xlsx`/`.docx` (OOXML zip
 * packages) that exceljs/mammoth do not read; a dropped `.xls`/`.doc` is
 * rejected with a clear message rather than silently mis-parsed. */
export const AGENTIC_STRUCTURED_EXTENSIONS: Record<string, AgenticFileKind> = {
  '.csv': 'csv',
  '.json': 'json',
  '.xml': 'xml',
  '.yml': 'yaml',
  '.yaml': 'yaml',
  '.txt': 'text',
  '.md': 'text',
  '.log': 'text',
  '.xlsx': 'xlsx',
  '.docx': 'docx',
  '.pdf': 'pdf'
};

/** Extensions that LOOK like they should be supported but are a different,
 * unreadable binary format — surfaced with a specific, actionable message
 * (see agenticModeController.ts) rather than lumped in with genuinely
 * unrecognized extensions (which fall back to best-effort raw `'text'`, a
 * fallback that would just produce mangled binary garbage for these). */
export const AGENTIC_LEGACY_UNSUPPORTED_EXTENSIONS: Record<string, string> = {
  '.xls': 'Legacy Excel (.xls) — save it as .xlsx and re-drop it.',
  '.doc': 'Legacy Word (.doc) — save it as .docx and re-drop it.'
};
