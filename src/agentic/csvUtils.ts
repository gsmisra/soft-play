/**
 * A tiny, dependency-free RFC 4180-ish CSV reader/writer — shared by Total
 * Agentic Mode's file ingestion (reading a dropped `.csv` input file, see
 * textIngestion.ts) and its manual-test-case CSV output (see
 * csvTestCaseGenerator.ts), so both directions of "this extension touches a
 * CSV file" go through exactly one, well-tested implementation rather than
 * two ad-hoc `.split(',')` calls (which silently corrupt any field
 * containing a comma, quote, or newline — a real risk for a "Description"
 * or "Step Explanation" column in a manual test case). Pure, zero `vscode`
 * import — directly unit-testable.
 */

/** Parses CSV text into rows of raw string cells. Handles quoted fields
 * (embedded commas, embedded newlines, and an escaped `""` for a literal
 * quote), CRLF and bare LF line endings, and a trailing blank line (which
 * is skipped rather than yielding a phantom empty row). Every row is
 * padded to the same width, so a data row can never wrongly reference an
 * out-of-bounds header column. */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let inQuotes = false;
  let i = 0;
  const n = text.length;

  const endField = () => {
    row.push(field);
    field = '';
  };
  const endRow = () => {
    endField();
    rows.push(row);
    row = [];
  };

  while (i < n) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 2;
          continue;
        }
        inQuotes = false;
        i += 1;
        continue;
      }
      field += ch;
      i += 1;
      continue;
    }

    if (ch === '"') {
      inQuotes = true;
      i += 1;
      continue;
    }
    if (ch === ',') {
      endField();
      i += 1;
      continue;
    }
    if (ch === '\r') {
      // Peek past an optional following \n to treat CRLF as one line break.
      if (text[i + 1] === '\n') {
        i += 1;
      }
      endRow();
      i += 1;
      continue;
    }
    if (ch === '\n') {
      endRow();
      i += 1;
      continue;
    }
    field += ch;
    i += 1;
  }

  // Flush a final field/row that wasn't terminated by a trailing newline —
  // but not a phantom empty row for a file that already ended cleanly.
  if (field.length > 0 || row.length > 0) {
    endRow();
  }

  const width = rows.reduce((max, r) => Math.max(max, r.length), 0);
  return rows.map((r) => (r.length < width ? [...r, ...Array(width - r.length).fill('')] : r));
}

export class MalformedCsvError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MalformedCsvError';
  }
}

/** F06: the SAME tokenizer as `parseCsv()` above, minus its final
 * padding step — every row is returned at its OWN true width, never
 * widened to match the widest row in the file. `parseCsv()` itself stays
 * untouched (ingestion elsewhere depends on its padding leniency — "never
 * let a data row reference an out-of-bounds header column" is the right
 * behavior for reading an arbitrary UPLOADED file); this exists
 * specifically for validating GENERATED output/a real example template,
 * where a short header silently padded to look the right width is exactly
 * the bug to catch, not paper over. Also rejects a genuinely unterminated
 * quoted field (a `"` opened but never closed before EOF) — `parseCsv()`
 * silently accepts that as "the rest of the file," which is never
 * correct for output this extension is about to trust structurally. */
export function parseCsvStrict(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let inQuotes = false;
  let i = 0;
  const n = text.length;

  const endField = () => {
    row.push(field);
    field = '';
  };
  const endRow = () => {
    endField();
    rows.push(row);
    row = [];
  };

  while (i < n) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 2;
          continue;
        }
        inQuotes = false;
        i += 1;
        continue;
      }
      field += ch;
      i += 1;
      continue;
    }

    if (ch === '"') {
      inQuotes = true;
      i += 1;
      continue;
    }
    if (ch === ',') {
      endField();
      i += 1;
      continue;
    }
    if (ch === '\r') {
      if (text[i + 1] === '\n') {
        i += 1;
      }
      endRow();
      i += 1;
      continue;
    }
    if (ch === '\n') {
      endRow();
      i += 1;
      continue;
    }
    field += ch;
    i += 1;
  }

  if (inQuotes) {
    throw new MalformedCsvError('An opening quote (") is never closed before the end of the text.');
  }
  if (field.length > 0 || row.length > 0) {
    endRow();
  }

  return rows;
}

/** Quotes a single CSV field only when required (contains a comma, quote,
 * or newline) — matches how most spreadsheet tools write CSV, so a
 * generated file's plain fields stay easy to read/diff. */
export function csvEscapeField(value: string): string {
  if (/[",\r\n]/.test(value)) {
    return `"${value.replace(/"/g, '""')}"`;
  }
  return value;
}

/** Serializes rows of cells back into CSV text (CRLF line endings, per RFC
 * 4180 — the safest default for a file destined for Jira/Excel import). */
export function stringifyCsv(rows: string[][]): string {
  return rows.map((row) => row.map(csvEscapeField).join(',')).join('\r\n') + '\r\n';
}
