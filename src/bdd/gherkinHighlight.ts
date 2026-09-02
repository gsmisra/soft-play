/**
 * Renders raw Gherkin text as syntax-highlighted HTML — server-side (in the
 * extension host), not via a client-side tokenizer, since the whole feature
 * file is already fully available as a string and this is simpler and more
 * robust than shipping a second lexer. Used by featureFilePanel.ts.
 *
 * Per the feature spec: Gherkin keywords bold + italic in their own color,
 * plain step text in a neutral color on the panel's dark background, and
 * every data table / Examples table cell in bright yellow.
 */

const KEYWORD_PATTERN =
  /^(\s*)(Feature|Background|Scenario Outline|Scenario Template|Scenario|Examples|Given|When|Then|And|But|\*)(:?)(\s|$)/;

export function highlightGherkin(rawText: string): string {
  const lines = rawText.split(/\r?\n/);
  return lines.map(highlightLine).join('\n');
}

function highlightLine(line: string): string {
  const trimmedStart = line.match(/^\s*/)?.[0] ?? '';
  const rest = line.slice(trimmedStart.length);

  if (!rest) {
    return escapeHtml(line);
  }

  // Comment line.
  if (rest.startsWith('#')) {
    return escapeHtml(trimmedStart) + `<span class="gk-comment">${escapeHtml(rest)}</span>`;
  }

  // Tag line (one or more @tags, possibly the whole line).
  if (rest.startsWith('@')) {
    return escapeHtml(trimmedStart) + `<span class="gk-tag">${escapeHtml(rest)}</span>`;
  }

  // Table row — every cell in bright yellow, the pipes themselves neutral.
  if (rest.startsWith('|')) {
    const cells = rest.split('|');
    const htmlCells = cells.map((c, idx) => {
      if (idx === 0 || idx === cells.length - 1) {
        return escapeHtml(c); // leading/trailing empty segments from split
      }
      return `<span class="gk-table-cell">${escapeHtml(c)}</span>`;
    });
    return escapeHtml(trimmedStart) + htmlCells.join('<span class="gk-pipe">|</span>');
  }

  // Doc string fence.
  if (rest.startsWith('"""') || rest.startsWith('```')) {
    return escapeHtml(trimmedStart) + `<span class="gk-docstring-fence">${escapeHtml(rest)}</span>`;
  }

  const keywordMatch = rest.match(KEYWORD_PATTERN);
  if (keywordMatch) {
    const [, , keyword, colon] = keywordMatch;
    const afterKeyword = rest.slice(keyword.length + colon.length);
    // Step text (Given/When/Then/And/But/*) may itself contain "..."
    // quoted parameter values and <placeholder> Scenario Outline
    // references — highlight those distinctly within the plain text too.
    return (
      escapeHtml(trimmedStart) +
      `<span class="gk-keyword">${escapeHtml(keyword)}</span>` +
      (colon ? `<span class="gk-colon">:</span>` : '') +
      highlightStepText(afterKeyword)
    );
  }

  return escapeHtml(trimmedStart) + highlightStepText(rest);
}

/** Within plain step/description text: "quoted strings" and <placeholders>
 * get their own subtle highlight (they're the parameterized parts of a
 * step) — everything else stays the plain/neutral color. */
function highlightStepText(text: string): string {
  const escaped = escapeHtml(text);
  return escaped
    .replace(/(&quot;[^&]*?&quot;)/g, '<span class="gk-param">$1</span>')
    .replace(/(&lt;[^&]*?&gt;)/g, '<span class="gk-param">$1</span>');
}

export function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
