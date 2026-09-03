// Shared code-editor factory — used by both the sidebar's Playwright Code
// view (main.js) and the standalone AI Generated Code panel (aiCodePanel.js).
// A transparent, editable <textarea> stacked exactly over a
// syntax-highlighted <pre> (see highlight.js), with a line-number gutter to
// its left kept in lockstep on scroll/edit — the closest a plain webview
// gets to a real code editor's feel without pulling in Monaco (a multi-MB
// dependency with its own worker/CSP requirements this extension's small,
// dependency-free footprint deliberately avoids).
//
// Real-editor touches beyond plain <textarea> behavior (which already gives
// native cut/copy/paste/undo/redo/find via the browser for free): a
// left-margin gutter with line numbers, and Tab/Shift+Tab indenting the
// current line/selection instead of moving focus out of the editor.
(function () {
  function createCodeEditor(textarea, pre, gutter) {
    const codeEl = pre.querySelector('code');
    let language = 'java';

    function lineCount(text) {
      return text.length === 0 ? 1 : text.split('\n').length;
    }

    function renderGutter() {
      const n = lineCount(textarea.value);
      // Built as one string join, not one appendChild per line -- this can
      // run on every keystroke for a long file, so avoid the DOM-churn cost.
      let html = '';
      for (let i = 1; i <= n; i++) {
        html += i + '\n';
      }
      gutter.textContent = html;
    }

    function syncScroll() {
      pre.scrollTop = textarea.scrollTop;
      pre.scrollLeft = textarea.scrollLeft;
      gutter.scrollTop = textarea.scrollTop;
    }

    function render() {
      codeEl.innerHTML = window.softPlayHighlight(textarea.value, language);
      renderGutter();
    }

    textarea.addEventListener('scroll', syncScroll);

    // Tab indents (4 spaces) the current line, or every selected line, at
    // its start, instead of the browser's default "leave the textarea"
    // behavior; Shift+Tab removes one level of indent the same way.
    textarea.addEventListener('keydown', (e) => {
      if (e.key !== 'Tab') {
        return;
      }
      e.preventDefault();
      const value = textarea.value;
      const start = textarea.selectionStart;
      const end = textarea.selectionEnd;
      const lineStart = value.lastIndexOf('\n', start - 1) + 1;
      const multiLine = value.slice(start, end).includes('\n');

      if (!e.shiftKey && !multiLine) {
        // Simple case: just insert 4 spaces at the caret.
        textarea.setRangeText('    ', start, end, 'end');
        render();
        return;
      }

      const lineEnd = end === start ? value.indexOf('\n', end) : end;
      const blockEnd = lineEnd === -1 ? value.length : lineEnd;
      const block = value.slice(lineStart, blockEnd);
      const lines = block.split('\n');
      let addedFirstLine = 0;
      let delta = 0;
      const newLines = lines.map((line, idx) => {
        if (e.shiftKey) {
          const removed = line.match(/^ {1,4}/);
          if (removed) {
            delta -= removed[0].length;
            if (idx === 0) addedFirstLine = -removed[0].length;
            return line.slice(removed[0].length);
          }
          return line;
        }
        delta += 4;
        if (idx === 0) addedFirstLine = 4;
        return '    ' + line;
      });
      const newBlock = newLines.join('\n');
      textarea.setRangeText(newBlock, lineStart, blockEnd, 'preserve');
      textarea.selectionStart = start + addedFirstLine;
      textarea.selectionEnd = end + delta;
      render();
    });

    render(); // placeholder text present in the markup on first load

    return {
      setLanguage(lang) {
        language = lang;
      },
      setValue(text) {
        textarea.value = text;
        render();
        syncScroll();
      },
      appendValue(text) {
        textarea.value += text;
        render();
        textarea.scrollTop = textarea.scrollHeight;
        syncScroll();
      },
      getValue() {
        return textarea.value;
      },
      onEdit(handler) {
        textarea.addEventListener('input', () => {
          render();
          handler();
        });
      }
    };
  }

  window.createCodeEditor = createCodeEditor;
})();
