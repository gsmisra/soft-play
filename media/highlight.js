// softPlay — lightweight, dependency-free syntax highlighter for the
// Generated Code editor. Not a full parser: a single-pass regex tokenizer
// good enough to color keywords, strings, comments, numbers, annotations/
// decorators, and method/class-name identifiers close to VS Code's Dark+
// palette — "looks like a real code editor" without bundling Monaco/CodeMirror.
(function (global) {
  var KEYWORDS = {
    java: [
      'abstract', 'assert', 'boolean', 'break', 'byte', 'case', 'catch', 'char', 'class', 'const',
      'continue', 'default', 'do', 'double', 'else', 'enum', 'extends', 'final', 'finally', 'float',
      'for', 'goto', 'if', 'implements', 'import', 'instanceof', 'int', 'interface', 'long', 'native',
      'new', 'package', 'private', 'protected', 'public', 'return', 'short', 'static', 'strictfp',
      'super', 'switch', 'synchronized', 'this', 'throw', 'throws', 'transient', 'try', 'void',
      'volatile', 'while', 'var', 'record', 'yield', 'sealed', 'permits', 'true', 'false', 'null'
    ],
    python: [
      'False', 'None', 'True', 'and', 'as', 'assert', 'async', 'await', 'break', 'class', 'continue',
      'def', 'del', 'elif', 'else', 'except', 'finally', 'for', 'from', 'global', 'if', 'import', 'in',
      'is', 'lambda', 'nonlocal', 'not', 'or', 'pass', 'raise', 'return', 'try', 'while', 'with',
      'yield', 'self'
    ],
    // "Generate Gherkin Feature File" panel's own editor — a much smaller
    // keyword set than Java/Python's (Gherkin has no expressions/operators
    // of its own), just enough to make Given/When/Then/etc. and the section
    // keywords read clearly against the plain step text around them.
    gherkin: [
      'Feature', 'Background', 'Scenario', 'Scenario Outline', 'Scenario Template', 'Examples',
      'Given', 'When', 'Then', 'And', 'But', 'Rule'
    ],
    // API Automation's raw request body editor (JSON).
    json: ['true', 'false', 'null']
  };

  // Gherkin comments use "#", same as Python -- everything else (Java)
  // uses "//"/"/* */".
  var HASH_COMMENT_LANGS = { python: true, gherkin: true };

  function escapeHtml(s) {
    return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  function buildRegex(lang) {
    var commentPattern = HASH_COMMENT_LANGS[lang] ? '#[^\\n]*' : '//[^\\n]*|/\\*[\\s\\S]*?\\*/';
    var stringPattern =
      lang === 'python'
        ? "[rRbBfFuU]{0,2}(?:'''[\\s\\S]*?'''|\"\"\"[\\s\\S]*?\"\"\"|\"(?:\\\\.|[^\"\\\\\\n])*\"|'(?:\\\\.|[^'\\\\\\n])*')"
        : '"(?:\\\\.|[^"\\\\\\n])*"|\'(?:\\\\.|[^\'\\\\\\n])*\'';
    var annotationPattern = '@[A-Za-z_][A-Za-z0-9_.]*';
    var numberPattern = '\\b\\d+(?:\\.\\d+)?[fFdDlL]?\\b';
    var identifierPattern = '[A-Za-z_][A-Za-z0-9_]*';
    var punctPattern = '[{}()\\[\\];:,.<>=+\\-*/&|!%~^?]';

    return new RegExp(
      '(' + commentPattern + ')' +
        '|(' + stringPattern + ')' +
        '|(' + annotationPattern + ')' +
        '|(' + numberPattern + ')' +
        '|(' + identifierPattern + ')' +
        '|(' + punctPattern + ')',
      'g'
    );
  }

  /** Returns HTML-escaped, <span class="tok-*">-wrapped markup for `code`. */
  function highlight(code, lang) {
    // "Text" body mode (API Automation raw body) is deliberately plain --
    // no tokenizing at all, matching Postman's own unhighlighted Text mode.
    if (lang === 'text' || !lang) {
      return escapeHtml(code);
    }
    if (lang === 'xml') {
      return highlightXml(code);
    }
    var keywordSet = {};
    (KEYWORDS[lang] || []).forEach(function (k) {
      keywordSet[k] = true;
    });
    var re = buildRegex(lang);
    var out = '';
    var lastIndex = 0;
    var match;

    while ((match = re.exec(code))) {
      if (match.index > lastIndex) {
        out += escapeHtml(code.slice(lastIndex, match.index));
      }
      var text = match[0];
      var cls = null;

      if (match[1] !== undefined) {
        cls = 'tok-comment';
      } else if (match[2] !== undefined) {
        // JSON: a quoted string immediately followed (after optional
        // whitespace) by ":" is an object KEY, not a value -- color it
        // distinctly (VS Code's own JSON highlighting does the same),
        // rather than lumping keys and values into one indistinguishable
        // string color.
        var afterString = code.slice(re.lastIndex);
        cls = lang === 'json' && /^\s*:/.test(afterString) ? 'tok-annotation' : 'tok-string';
      } else if (match[3] !== undefined) {
        cls = 'tok-annotation';
      } else if (match[4] !== undefined) {
        cls = 'tok-number';
      } else if (match[5] !== undefined) {
        if (keywordSet[text]) {
          cls = 'tok-keyword';
        } else if (code.charAt(re.lastIndex) === '(') {
          cls = 'tok-method'; // heuristic: identifier immediately followed by '(' is a call
        } else if (/^[A-Z]/.test(text)) {
          cls = 'tok-class'; // heuristic: capitalized identifier is a type/class name
        }
      }
      // Group 6 (punctuation) is intentionally left unstyled -- plain text
      // in the default foreground color, same as VS Code's own theming.

      out += cls ? '<span class="' + cls + '">' + escapeHtml(text) + '</span>' : escapeHtml(text);
      lastIndex = re.lastIndex;
    }
    if (lastIndex < code.length) {
      out += escapeHtml(code.slice(lastIndex));
    }
    return out;
  }

  // XML tags/attributes/comments/attribute-string-values are shaped
  // differently enough from a C-like language's tokens (tag names aren't
  // "identifiers" in the same sense, attribute values sit right next to a
  // bare "=") that forcing XML through the generic tokenizer above reads
  // worse than a small dedicated one — comments first (highest priority,
  // may contain anything), then a tag name right after "<"/"</", then the
  // closing "/>"/">"" , then a quoted attribute value, then a bare
  // attribute name (only recognized directly before "=" via lookahead, so
  // plain element text content never gets mistaken for one).
  var XML_TOKEN = /(<!--[\s\S]*?-->)|(<\/?[A-Za-z_][-\w:.]*)|(\/?>)|("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*')|([A-Za-z_][-\w:.]*)(?=\s*=)/g;

  function highlightXml(code) {
    var out = '';
    var lastIndex = 0;
    var match;
    while ((match = XML_TOKEN.exec(code))) {
      if (match.index > lastIndex) {
        out += escapeHtml(code.slice(lastIndex, match.index));
      }
      if (match[1] !== undefined) {
        out += '<span class="tok-comment">' + escapeHtml(match[1]) + '</span>';
      } else if (match[2] !== undefined) {
        out += '<span class="tok-keyword">' + escapeHtml(match[2]) + '</span>';
      } else if (match[3] !== undefined) {
        out += escapeHtml(match[3]);
      } else if (match[4] !== undefined) {
        out += '<span class="tok-string">' + escapeHtml(match[4]) + '</span>';
      } else if (match[5] !== undefined) {
        out += '<span class="tok-annotation">' + escapeHtml(match[5]) + '</span>';
      }
      lastIndex = XML_TOKEN.lastIndex;
    }
    if (lastIndex < code.length) {
      out += escapeHtml(code.slice(lastIndex));
    }
    return out;
  }

  global.softPlayHighlight = highlight;
})(window);
