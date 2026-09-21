/**
 * Safe, dependency-free text extraction for Atlassian content. Nothing here
 * executes or fetches anything: it only walks markup and produces plain text
 * the model can read. Anything it cannot faithfully convert is REPORTED (in
 * `notes`) rather than guessed at.
 */

// ---------------------------------------------------------------------------
// Atlassian Document Format (Jira Cloud / API v3 style rich text)
// ---------------------------------------------------------------------------

interface AdfNode {
  type?: string;
  text?: string;
  attrs?: Record<string, unknown>;
  marks?: { type?: string; attrs?: Record<string, unknown> }[];
  content?: AdfNode[];
}

const asAdf = (v: unknown): AdfNode => (v && typeof v === 'object' ? (v as AdfNode) : {});

function adfInline(nodes: AdfNode[] | undefined): string {
  return (nodes ?? []).map((n) => adfNode(n)).join('');
}

function adfNode(raw: unknown): string {
  const node = asAdf(raw);
  const children = node.content ?? [];
  switch (node.type) {
    case 'doc':
      return children.map((c) => adfNode(c)).filter(Boolean).join('\n');
    case 'text': {
      const link = node.marks?.find((m) => m.type === 'link');
      const href = link?.attrs?.href;
      return `${node.text ?? ''}${typeof href === 'string' && href !== node.text ? ` (${href})` : ''}`;
    }
    case 'hardBreak':
      return '\n';
    case 'paragraph':
      return adfInline(children);
    case 'heading': {
      const level = Number(node.attrs?.level);
      return `${'#'.repeat(Number.isInteger(level) && level >= 1 && level <= 6 ? level : 1)} ${adfInline(children)}`;
    }
    case 'bulletList':
      return children.map((c) => `- ${adfNode(c)}`).join('\n');
    case 'orderedList':
      return children.map((c, i) => `${i + 1}. ${adfNode(c)}`).join('\n');
    case 'listItem':
      return children.map((c) => adfNode(c)).join(' ').replace(/\n/g, ' ');
    case 'codeBlock':
      return `\`\`\`\n${adfInline(children)}\n\`\`\``;
    case 'blockquote':
      return children.map((c) => `> ${adfNode(c)}`).join('\n');
    case 'rule':
      return '---';
    case 'panel':
      return children.map((c) => adfNode(c)).join('\n');
    case 'table':
      return children.map((c) => adfNode(c)).join('\n');
    case 'tableRow':
      return `| ${children.map((c) => adfNode(c).replace(/\n/g, ' ')).join(' | ')} |`;
    case 'tableHeader':
    case 'tableCell':
      return children.map((c) => adfNode(c)).join(' ');
    case 'mention':
      return String(node.attrs?.text ?? '@user');
    case 'emoji':
      return String(node.attrs?.text ?? node.attrs?.shortName ?? '');
    case 'inlineCard':
      return String(node.attrs?.url ?? '[link]');
    case 'status':
      return `[${String(node.attrs?.text ?? '')}]`;
    case 'date':
      return String(node.attrs?.timestamp ?? '');
    case 'media':
      return `[attachment: ${String(node.attrs?.alt ?? node.attrs?.id ?? 'file')}]`;
    case 'mediaSingle':
    case 'mediaGroup':
      return children.map((c) => adfNode(c)).join(' ');
    default:
      return children.length ? children.map((c) => adfNode(c)).join('\n') : node.type ? `[unsupported: ${node.type}]` : '';
  }
}

/** Renders an Atlassian Document Format tree as readable text. */
export function renderAdf(doc: unknown): string {
  return adfNode(doc).replace(/\n{3,}/g, '\n\n').trim();
}

/** A Jira field value as text: plain string, ADF document, or a list of either. */
export function fieldValueToText(value: unknown): string {
  if (value === null || value === undefined) {
    return '';
  }
  if (typeof value === 'string') {
    return value.trim();
  }
  if (Array.isArray(value)) {
    return value.map(fieldValueToText).filter(Boolean).join('\n');
  }
  if (typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    if (obj.type === 'doc') {
      return renderAdf(obj);
    }
    for (const key of ['value', 'name', 'displayName']) {
      if (typeof obj[key] === 'string') {
        return obj[key] as string;
      }
    }
    return '';
  }
  return String(value);
}

// ---------------------------------------------------------------------------
// Confluence storage format / HTML
// ---------------------------------------------------------------------------

const NAMED_ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
  ndash: '–',
  mdash: '—',
  hellip: '…',
  lsquo: '‘',
  rsquo: '’',
  ldquo: '“',
  rdquo: '”',
  bull: '•'
};

export function decodeEntities(text: string): string {
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (whole, body: string) => {
    if (body[0] === '#') {
      const code = body[1].toLowerCase() === 'x' ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10);
      return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : whole;
    }
    return NAMED_ENTITIES[body.toLowerCase()] ?? whole;
  });
}

const escapeXml = (s: string): string => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** Macros whose body is ordinary content: it is kept, the wrapper is dropped. */
const TRANSPARENT_MACROS = new Set(['info', 'note', 'warning', 'tip', 'panel', 'expand', 'excerpt', 'section', 'column', 'details', 'ui-expand']);
const CODE_MACROS = new Set(['code', 'noformat']);

function attr(tag: string, name: string): string | undefined {
  const m = new RegExp(`\\b${name.replace(/[:.-]/g, '\\$&')}\\s*=\\s*("([^"]*)"|'([^']*)')`, 'i').exec(tag);
  return m ? decodeEntities(m[2] ?? m[3] ?? '') : undefined;
}

/**
 * Converts Confluence storage-format (XHTML + `ac:`/`ri:` elements) or plain
 * HTML into text, keeping headings, lists and tables. Scripts/styles are
 * dropped; unsupported macros are replaced by a visible placeholder AND listed
 * in `notes`, never silently omitted or invented.
 */
export function storageToText(input: string): { text: string; notes: string[] } {
  const notes = new Set<string>();
  let src = input.replace(/<!--[\s\S]*?-->/g, '').replace(/<(script|style)\b[\s\S]*?<\/\1\s*>/gi, () => {
    notes.add('Embedded script/style content was removed.');
    return '';
  });
  src = src.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, (_m, body: string) => escapeXml(body));

  const out: string[] = [];
  const lists: { ordered: boolean; n: number }[] = [];
  const macros: { mode: 'skip' | 'code' | 'pass' }[] = [];
  let skip = 0;
  let raw = 0; // inside code/pre: whitespace is kept
  let inImage = 0;
  const emit = (s: string): void => {
    if (skip === 0) {
      out.push(s);
    }
  };
  const openMacro = (tag: string, selfClosing: boolean): void => {
    const name = (attr(tag, 'ac:name') ?? 'unknown').toLowerCase();
    let mode: 'skip' | 'code' | 'pass' = 'skip';
    if (CODE_MACROS.has(name)) {
      mode = 'code';
    } else if (TRANSPARENT_MACROS.has(name)) {
      mode = 'pass';
    } else {
      notes.add(`Unsupported Confluence macro "${name}" was not converted.`);
      emit(`\n[unsupported macro: ${name}]\n`);
    }
    if (selfClosing) {
      return;
    }
    macros.push({ mode });
    if (mode === 'skip') {
      skip++;
    } else if (mode === 'code') {
      raw++;
      emit('\n```\n');
    } else if (name !== 'section' && name !== 'column' && name !== 'details') {
      emit(`\n[${name}] `);
    }
  };

  const tokenRe = /<(\/?)([A-Za-z][\w:.-]*)((?:\s[^<>]*)?)\s*(\/?)>|([^<]+)|</g;
  let m: RegExpExecArray | null;
  while ((m = tokenRe.exec(src)) !== null) {
    if (m[5] !== undefined || m[2] === undefined) {
      const chunk = decodeEntities(m[5] ?? '<');
      emit(raw > 0 ? chunk : chunk.replace(/\s+/g, ' '));
      continue;
    }
    const closing = m[1] === '/';
    const name = m[2].toLowerCase();
    const attrs = m[3] ?? '';
    const selfClosing = m[4] === '/';
    if (!closing) {
      if (/^h[1-6]$/.test(name)) {
        emit(`\n${'#'.repeat(Number(name[1]))} `);
      } else if (name === 'p' || name === 'div' || name === 'blockquote' || name === 'section') {
        emit('\n');
      } else if (name === 'br') {
        emit('\n');
      } else if (name === 'hr') {
        emit('\n---\n');
      } else if (name === 'ul' || name === 'ol') {
        // A nested list continues the parent item's line structure — no blank line.
        emit(lists.length === 0 ? '\n' : '');
        lists.push({ ordered: name === 'ol', n: 0 });
      } else if (name === 'li') {
        const top = lists[lists.length - 1];
        emit(`\n${'  '.repeat(Math.max(0, lists.length - 1))}${top?.ordered ? `${++top.n}. ` : '- '}`);
      } else if (name === 'table') {
        emit('\n');
      } else if (name === 'tr') {
        emit('\n|');
      } else if (name === 'td' || name === 'th') {
        emit(' ');
      } else if (name === 'pre') {
        raw++;
        emit('\n');
      } else if (name === 'ac:structured-macro') {
        openMacro(attrs, selfClosing);
      } else if (name === 'ac:parameter' || name === 'ac:task-id' || name === 'ac:task-status') {
        if (!selfClosing) {
          skip++;
        }
      } else if (name === 'ac:task') {
        emit('\n- [ ] ');
      } else if (name === 'ac:image') {
        emit('[image]');
        if (!selfClosing) {
          inImage++;
        }
      } else if (name === 'ri:attachment' && inImage === 0) {
        emit(`[attachment: ${attr(attrs, 'ri:filename') ?? 'file'}]`);
      } else if (name === 'ri:page' && inImage === 0) {
        emit(`[page: ${attr(attrs, 'ri:content-title') ?? 'link'}]`);
      } else if (name === 'time') {
        emit(attr(attrs, 'datetime') ?? '');
      }
    } else if (/^h[1-6]$/.test(name) || name === 'p' || name === 'div' || name === 'blockquote' || name === 'section' || name === 'table') {
      emit('\n');
    } else if (name === 'ul' || name === 'ol') {
      lists.pop();
      emit(lists.length === 0 ? '\n' : '');
    } else if (name === 'td' || name === 'th') {
      emit(' |'); // each cell closes itself; the row needs no closing bar of its own
    } else if (name === 'pre') {
      raw = Math.max(0, raw - 1);
      emit('\n');
    } else if (name === 'ac:structured-macro') {
      const macro = macros.pop();
      if (macro?.mode === 'skip') {
        skip = Math.max(0, skip - 1);
      } else if (macro?.mode === 'code') {
        raw = Math.max(0, raw - 1);
        emit('\n```\n');
      }
    } else if (name === 'ac:parameter' || name === 'ac:task-id' || name === 'ac:task-status') {
      skip = Math.max(0, skip - 1);
    } else if (name === 'ac:image') {
      inImage = Math.max(0, inImage - 1);
    }
  }

  const text = out
    .join('')
    .replace(/\r/g, '')
    .split('\n')
    .map((line) => line.replace(/[ \t]+$/g, ''))
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  return { text, notes: [...notes] };
}
