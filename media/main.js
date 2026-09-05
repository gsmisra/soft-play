(function () {
  const vscode = acquireVsCodeApi();

  const startBtn = document.getElementById('startBtn');
  const stopBtn = document.getElementById('stopBtn');
  const urlInput = document.getElementById('urlInput');
  const statusPill = document.getElementById('statusPill');
  const settingsBtn = document.getElementById('settingsBtn');
  const killAllBtn = document.getElementById('killAllBtn');
  const linkFeatureBtn = document.getElementById('linkFeatureBtn');
  const linkedScenarioBadge = document.getElementById('linkedScenarioBadge');
  const linkedScenarioText = document.getElementById('linkedScenarioText');
  const unlinkScenarioBtn = document.getElementById('unlinkScenarioBtn');
  const saveCodeBtn = document.getElementById('saveCodeBtn');
  const copyCodeBtn = document.getElementById('copyCodeBtn');
  const codeLanguageLabel = document.getElementById('codeLanguageLabel');
  const newCodeFlash = document.getElementById('newCodeFlash');
  const codeEditArea = document.getElementById('codeEditArea');
  const codeHighlightPre = document.getElementById('codeHighlight');
  const codeGutter = document.getElementById('codeGutter');
  const codeRefreshBanner = document.getElementById('codeRefreshBanner');
  const codeRefreshBtn = document.getElementById('codeRefreshBtn');
  const collapseCodeBtn = document.getElementById('collapseCodeBtn');
  const playwrightCodePanel = document.getElementById('playwrightCodePanel');
  const aiAssistSection = document.getElementById('aiAssistSection');
  const promptFilesList = document.getElementById('promptFilesList');
  const chatComposer = document.getElementById('chatComposer');
  const chatMessages = document.getElementById('chatMessages');
  const chatInput = document.getElementById('chatInput');
  const chatSendBtn = document.getElementById('chatSendBtn');
  const refreshPromptFilesBtn = document.getElementById('refreshPromptFilesBtn');
  const startAiProcessingBtn = document.getElementById('startAiProcessingBtn');
  const openAiCodeBtn = document.getElementById('openAiCodeBtn');
  const generateFeatureFileBtn = document.getElementById('generateFeatureFileBtn');
  const codeCorrectnessBanner = document.getElementById('codeCorrectnessBanner');
  const aiStatusLabel = document.getElementById('aiStatusLabel');
  const aiGeneratingBanner = document.getElementById('aiGeneratingBanner');
  const copilotEnabledToggle = document.getElementById('copilotEnabledToggle');
  const uiModeControls = document.getElementById('uiModeControls');
  const apiModeControls = document.getElementById('apiModeControls');
  const clearApiDataBtn = document.getElementById('clearApiDataBtn');
  const tokenBarFill = document.getElementById('tokenBarFill');
  const tokenPercentLabel = document.getElementById('tokenPercentLabel');
  const tokenModelLabel = document.getElementById('tokenModelLabel');
  const tokenUnavailableNote = document.getElementById('tokenUnavailableNote');
  const tokenBreakdown = document.getElementById('tokenBreakdown');
  const tokenSentValue = document.getElementById('tokenSentValue');
  const tokenReceivedValue = document.getElementById('tokenReceivedValue');
  const tokenTotalValue = document.getElementById('tokenTotalValue');
  const tokenMaxValue = document.getElementById('tokenMaxValue');

  // ---------------------------------------------------------------------
  // API Automation mode — Postman-styled request builder. Switching modes
  // never touches Playwright/codegen state; it only shows/hides which half
  // of the Control Panel is visible (see applyAutomationMode() below) and
  // changes what "Start AI Processing"/"Generate Gherkin Feature File"
  // bundle into their request (see collectApiRequestDetails() and the
  // click handlers further down).
  // ---------------------------------------------------------------------

  function applyAutomationMode(mode) {
    const isApi = mode === 'api';
    uiModeControls.hidden = isApi;
    apiModeControls.hidden = !isApi;
    // "Playwright Code" is never used in API Automation -- nothing records
    // it there (no browser is ever launched). "Start AI Processing"/"Open
    // AI Generated Code" stay put; they read from the API request builder
    // instead in this mode (see collectApiRequestDetails()).
    playwrightCodePanel.hidden = isApi;
    // "Clear Data" is API Automation-only (see its own handler below for
    // why -- UI mode already has "Kill All Browsers" for the equivalent
    // "start over" action, with genuinely different things to reset).
    clearApiDataBtn.hidden = !isApi;
  }

  /** Builds one Params/Headers/form-data/urlencoded key-value-description
   * table: renders from `rows`, and keeps exactly one trailing blank row
   * available to type into (Postman's own "add a row by typing in the last
   * one" pattern) — a filled-in last row spawns a fresh blank one below it;
   * an emptied non-last row is removed. Returns {getRows} to read back
   * only the genuinely filled-in rows (blank trailing row excluded).
   */
  function createKvTable(tableEl) {
    const tbody = tableEl.querySelector('tbody');
    let rows = [{ key: '', value: '', description: '' }];

    function isBlank(row) {
      return !row.key && !row.value && !row.description;
    }

    function render() {
      tbody.innerHTML = '';
      rows.forEach((row, index) => {
        const tr = document.createElement('tr');

        const keyTd = document.createElement('td');
        const keyInput = document.createElement('input');
        keyInput.type = 'text';
        keyInput.placeholder = 'Key';
        keyInput.value = row.key;
        keyInput.addEventListener('input', () => onEdit(index, 'key', keyInput.value));
        keyTd.appendChild(keyInput);

        const valueTd = document.createElement('td');
        const valueInput = document.createElement('input');
        valueInput.type = 'text';
        valueInput.placeholder = 'Value';
        valueInput.value = row.value;
        valueInput.addEventListener('input', () => onEdit(index, 'value', valueInput.value));
        valueTd.appendChild(valueInput);

        const descTd = document.createElement('td');
        const descInput = document.createElement('input');
        descInput.type = 'text';
        descInput.placeholder = 'Description';
        descInput.value = row.description;
        descInput.addEventListener('input', () => onEdit(index, 'description', descInput.value));
        descTd.appendChild(descInput);

        const removeTd = document.createElement('td');
        if (index < rows.length - 1) {
          const removeBtn = document.createElement('button');
          removeBtn.type = 'button';
          removeBtn.className = 'api-row-remove';
          removeBtn.textContent = '✕';
          removeBtn.title = 'Remove this row';
          removeBtn.addEventListener('click', () => {
            rows.splice(index, 1);
            render();
          });
          removeTd.appendChild(removeBtn);
        }

        tr.appendChild(keyTd);
        tr.appendChild(valueTd);
        tr.appendChild(descTd);
        tr.appendChild(removeTd);
        tbody.appendChild(tr);
      });
    }

    function onEdit(index, field, value) {
      rows[index] = { ...rows[index], [field]: value };
      const isLastRow = index === rows.length - 1;
      if (isLastRow && !isBlank(rows[index])) {
        rows.push({ key: '', value: '', description: '' });
        render();
        return;
      }
      // A non-last row emptied out entirely -- drop it rather than leave a
      // dead blank row in the middle of the table.
      if (!isLastRow && isBlank(rows[index])) {
        rows.splice(index, 1);
        render();
        return;
      }
      // In-place edit -- re-render is unnecessary (would steal focus), the
      // input's own value already reflects what the user typed.
    }

    render();

    return {
      getRows() {
        return rows.filter((r) => !isBlank(r));
      },
      /** Replaces every row wholesale (e.g. from a parsed curl command) —
       * always leaves one trailing blank row, same as normal editing does. */
      setRows(newRows) {
        rows = newRows.map((r) => ({ key: r.key || '', value: r.value || '', description: r.description || '' }));
        rows.push({ key: '', value: '', description: '' });
        render();
      }
    };
  }

  /** form-data's own table — a Key/Value/Description/remove table like
   * createKvTable() above, EXCEPT each row's Value cell also carries a
   * Text/File dropdown (matching Postman): "Text" is the same plain input
   * createKvTable() already has; "File" swaps it for a "Select File"
   * button that hands off to the extension host's native OS file dialog
   * (see the 'browseApiFormFile'/'apiFormFileSelected' round trip below —
   * a webview `<input type="file">` cannot reveal the real absolute path
   * the generated multipart-upload code needs, only the OS dialog can). A
   * separate function from createKvTable() on purpose: the other three
   * tables (Params/Headers/x-www-form-urlencoded) never need this and stay
   * completely unaffected. */
  function createFormDataTable(tableEl) {
    const tbody = tableEl.querySelector('tbody');
    let nextRowId = 1;
    let rows = [{ id: nextRowId++, key: '', value: '', valueType: 'text', description: '' }];

    function isBlank(row) {
      return !row.key && !row.value && !row.description;
    }

    function indexOfRowId(rowId) {
      return rows.findIndex((r) => r.id === rowId);
    }

    function render() {
      tbody.innerHTML = '';
      rows.forEach((row, index) => {
        const tr = document.createElement('tr');

        const keyTd = document.createElement('td');
        const keyInput = document.createElement('input');
        keyInput.type = 'text';
        keyInput.placeholder = 'Key';
        keyInput.value = row.key;
        keyInput.addEventListener('input', () => onEdit(index, { key: keyInput.value }));
        keyTd.appendChild(keyInput);

        const valueTd = document.createElement('td');
        valueTd.className = 'api-formdata-value-cell';
        if (row.valueType === 'file') {
          const browseBtn = document.createElement('button');
          browseBtn.type = 'button';
          browseBtn.className = 'api-browse-btn';
          browseBtn.textContent = row.value ? fileBaseName(row.value) : 'Select File';
          browseBtn.title = row.value || 'Select a file to upload';
          browseBtn.addEventListener('click', () => {
            vscode.postMessage({ type: 'browseApiFormFile', payload: { rowId: row.id } });
          });
          valueTd.appendChild(browseBtn);
        } else {
          const valueInput = document.createElement('input');
          valueInput.type = 'text';
          valueInput.placeholder = 'Value';
          valueInput.value = row.value;
          valueInput.addEventListener('input', () => onEdit(index, { value: valueInput.value }));
          valueTd.appendChild(valueInput);
        }
        const typeSelect = document.createElement('select');
        typeSelect.className = 'api-formdata-type-select';
        [
          ['text', 'Text'],
          ['file', 'File']
        ].forEach(([value, label]) => {
          const opt = document.createElement('option');
          opt.value = value;
          opt.textContent = label;
          if (row.valueType === value) opt.selected = true;
          typeSelect.appendChild(opt);
        });
        typeSelect.addEventListener('change', () => {
          // Switching type discards whatever the old value held -- a file
          // path is meaningless as text and vice versa.
          onEdit(index, { valueType: typeSelect.value, value: '' });
        });
        valueTd.appendChild(typeSelect);

        const descTd = document.createElement('td');
        const descInput = document.createElement('input');
        descInput.type = 'text';
        descInput.placeholder = 'Description';
        descInput.value = row.description;
        descInput.addEventListener('input', () => onEdit(index, { description: descInput.value }));
        descTd.appendChild(descInput);

        const removeTd = document.createElement('td');
        if (index < rows.length - 1) {
          const removeBtn = document.createElement('button');
          removeBtn.type = 'button';
          removeBtn.className = 'api-row-remove';
          removeBtn.textContent = '✕';
          removeBtn.title = 'Remove this row';
          removeBtn.addEventListener('click', () => {
            rows.splice(index, 1);
            render();
          });
          removeTd.appendChild(removeBtn);
        }

        tr.appendChild(keyTd);
        tr.appendChild(valueTd);
        tr.appendChild(descTd);
        tr.appendChild(removeTd);
        tbody.appendChild(tr);
      });
    }

    function onEdit(index, patch) {
      rows[index] = { ...rows[index], ...patch };
      const isLastRow = index === rows.length - 1;
      if (isLastRow && !isBlank(rows[index])) {
        rows.push({ id: nextRowId++, key: '', value: '', valueType: 'text', description: '' });
        render();
        return;
      }
      if (!isLastRow && isBlank(rows[index])) {
        rows.splice(index, 1);
        render();
        return;
      }
      // A file selection always needs the button's label refreshed; a
      // plain text edit doesn't need a re-render (would steal focus).
      if (patch.value !== undefined && rows[index].valueType === 'file') {
        render();
      }
    }

    render();

    return {
      getRows() {
        return rows.filter((r) => !isBlank(r)).map(({ id, ...row }) => row);
      },
      /** Replaces every row wholesale (e.g. from a parsed curl -F flag) —
       * always leaves one trailing blank row, same as normal editing does.
       * A curl command can only ever describe Text form-data values (a
       * "@path" argument is a real uploaded file, matching valueType
       * 'file' directly). */
      setRows(newRows) {
        rows = newRows.map((r) => ({
          id: nextRowId++,
          key: r.key || '',
          value: r.value || '',
          valueType: r.valueType === 'file' ? 'file' : 'text',
          description: r.description || ''
        }));
        rows.push({ id: nextRowId++, key: '', value: '', valueType: 'text', description: '' });
        render();
      },
      /** Applies a file path the user just picked via the native OS dialog
       * back onto whichever row asked for it (see the
       * 'browseApiFormFile'/'apiFormFileSelected' round trip). A no-op if
       * that row was removed while the dialog was open. */
      applyFileSelection(rowId, filePath) {
        const index = indexOfRowId(rowId);
        if (index === -1) {
          return;
        }
        onEdit(index, { value: filePath });
      }
    };
  }

  function fileBaseName(filePath) {
    const parts = filePath.split(/[\\/]/);
    return parts[parts.length - 1] || filePath;
  }

  const apiParamsTable = createKvTable(document.getElementById('apiParamsTable'));
  const apiHeadersTable = createKvTable(document.getElementById('apiHeadersTable'));
  const apiFormDataTable = createFormDataTable(document.getElementById('apiFormDataTable'));
  const apiUrlencodedTable = createKvTable(document.getElementById('apiUrlencodedTable'));

  // Tab strip (Params/Authorization/Headers/Body) -- one panel visible at a time.
  document.querySelectorAll('.api-tab').forEach((tabBtn) => {
    tabBtn.addEventListener('click', () => {
      document.querySelectorAll('.api-tab').forEach((b) => b.classList.remove('active'));
      tabBtn.classList.add('active');
      const target = tabBtn.getAttribute('data-tab');
      document.querySelectorAll('.api-tab-panel').forEach((panel) => {
        panel.hidden = panel.getAttribute('data-panel') !== target;
      });
    });
  });

  // Authorization type -> show only the matching fields.
  const apiAuthType = document.getElementById('apiAuthType');
  apiAuthType.addEventListener('change', () => {
    document.querySelectorAll('.api-auth-fields').forEach((el) => {
      el.hidden = el.getAttribute('data-auth') !== apiAuthType.value;
    });
  });

  // Body mode (none/form-data/x-www-form-urlencoded/raw) -> show only the matching panel.
  document.querySelectorAll('input[name="apiBodyMode"]').forEach((radio) => {
    radio.addEventListener('change', () => {
      if (!radio.checked) return;
      document.querySelectorAll('.api-body-panel').forEach((el) => {
        el.hidden = el.getAttribute('data-body') !== radio.value;
      });
    });
  });

  // ---------------------------------------------------------------------
  // Raw request body — a real code-editor experience (line-numbered
  // gutter, syntax color coding, directly editable) via the same
  // createCodeEditor() factory the Playwright Code/AI Generated Code
  // editors already use, rather than a plain <textarea>. JSON/XML also
  // get auto-formatted (pretty-printed) on language switch and via the
  // Beautify button — never silently on every keystroke, which would
  // fight the user's cursor while they're still typing.
  // ---------------------------------------------------------------------

  const apiRawLanguageSelect = document.getElementById('apiRawLanguage');
  const apiRawBeautifyBtn = document.getElementById('apiRawBeautifyBtn');
  const apiRawBodyEditor = window.createCodeEditor(
    document.getElementById('apiRawBody'),
    document.getElementById('apiRawHighlight'),
    document.getElementById('apiRawGutter')
  );
  // Re-highlights live as the user types -- createCodeEditor() only wires
  // that up when a caller actually asks for it via onEdit().
  apiRawBodyEditor.onEdit(() => {});

  function rawBodyEditorLanguage() {
    const value = apiRawLanguageSelect.value;
    return value === 'JSON' ? 'json' : value === 'XML' ? 'xml' : 'text';
  }

  /** Pretty-prints the raw body in place for whichever language is
   * currently selected. Silently leaves the content untouched if it isn't
   * valid JSON/XML (a mid-edit or deliberately non-JSON JSON body is not
   * an error condition worth interrupting the user over) or the language
   * is plain Text (nothing to format). */
  function beautifyRawBody() {
    const lang = rawBodyEditorLanguage();
    const current = apiRawBodyEditor.getValue();
    const formatted = lang === 'json' ? beautifyJson(current) : lang === 'xml' ? beautifyXml(current) : null;
    if (formatted !== null && formatted !== current) {
      apiRawBodyEditor.setValue(formatted);
    }
  }

  function beautifyJson(text) {
    if (!text.trim()) return null;
    try {
      return JSON.stringify(JSON.parse(text), null, 2);
    } catch (e) {
      return null;
    }
  }

  /** Best-effort XML pretty-printer: not a real parser (no attribute/entity
   * validation) -- just enough to turn well-formed-but-unindented XML into
   * something readable, the same modest bar Postman's own Beautify holds
   * itself to. Left alone (returns the original text) on anything that
   * doesn't look like it has real tags to indent. */
  function beautifyXml(text) {
    const trimmed = text.trim();
    if (!trimmed || trimmed.indexOf('<') === -1) return null;

    function classify(line) {
      if (/^<\?/.test(line) || /^<!--[\s\S]*-->$/.test(line) || /\/>$/.test(line)) {
        return 'leaf';
      }
      if (/^<([A-Za-z_][-\w:.]*)[^>]*>.*<\/\1>$/.test(line)) {
        return 'leaf'; // e.g. <name>John</name> on one line -- doesn't nest further
      }
      if (/^<\//.test(line)) return 'close';
      if (/^</.test(line)) return 'open';
      return 'leaf'; // plain text content
    }

    const lines = trimmed
      .replace(/>\s*</g, '>\n<')
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean);

    let indent = 0;
    const out = [];
    for (const line of lines) {
      const kind = classify(line);
      if (kind === 'close') indent = Math.max(indent - 1, 0);
      out.push('  '.repeat(indent) + line);
      if (kind === 'open') indent++;
    }
    return out.join('\n');
  }

  apiRawLanguageSelect.addEventListener('change', () => {
    apiRawBodyEditor.setLanguage(rawBodyEditorLanguage());
    beautifyRawBody();
  });
  apiRawBeautifyBtn.addEventListener('click', beautifyRawBody);
  apiRawBodyEditor.setLanguage(rawBodyEditorLanguage());

  // ---------------------------------------------------------------------
  // "CURL" import — paste a curl command, auto-fill Method/URL/Params/
  // Headers/Auth/Body instead of typing each field by hand. Best-effort,
  // not a full shell grammar: handles the flags real-world "Copy as cURL"
  // (Chrome/Firefox/Postman) output actually uses. Auth types that aren't
  // expressible as a handful of curl flags (OAuth 1.0/2.0, Hawk, AWS
  // Signature, NTLM, Akamai EdgeGrid) are never guessed at — only Basic
  // (-u/--user, or --digest + -u for Digest) and Bearer/Basic/Digest
  // recognized from a literal "Authorization:" header are detected.
  // ---------------------------------------------------------------------

  const CURL_FLAGS_NO_VALUE = new Set([
    '-s', '--silent', '-v', '--verbose', '-i', '--include', '-k', '--insecure', '-L', '--location',
    '--compressed', '-f', '--fail', '-4', '--ipv4', '-6', '--ipv6', '-N', '--no-buffer', '-#',
    '--progress-bar', '-g', '--globoff', '-G', '--get', '-J', '--remote-header-name', '-O',
    '--remote-name', '-n', '--netrc', '--digest', '--ntlm', '--negotiate', '--anyauth', '-1', '--tlsv1'
  ]);
  const CURL_FLAGS_WITH_VALUE = new Set([
    '--connect-timeout', '--max-time', '-m', '-o', '--output', '-x', '--proxy', '--cacert', '--cert',
    '-E', '--key', '--cookie-jar', '-c', '--interface', '--limit-rate', '--retry', '-w', '--write-out'
  ]);

  /** Splits a shell-style command line into argv tokens, honoring single-
   * and double-quoted strings (including backslash escapes inside double
   * quotes) and a bare backslash escaping the next character outside any
   * quotes -- covers the quoting styles real "Copy as cURL" output and
   * hand-written curl commands actually use. */
  function tokenizeShellCommand(str) {
    const tokens = [];
    let i = 0;
    const n = str.length;
    while (i < n) {
      while (i < n && /\s/.test(str[i])) i++;
      if (i >= n) break;
      let token = '';
      while (i < n && !/\s/.test(str[i])) {
        const ch = str[i];
        if (ch === '"' || ch === "'") {
          const quote = ch;
          i++;
          while (i < n && str[i] !== quote) {
            if (quote === '"' && str[i] === '\\' && i + 1 < n) {
              token += str[i + 1];
              i += 2;
            } else {
              token += str[i];
              i++;
            }
          }
          i++; // skip closing quote
        } else if (ch === '\\' && i + 1 < n) {
          token += str[i + 1];
          i += 2;
        } else {
          token += ch;
          i++;
        }
      }
      tokens.push(token);
    }
    return tokens;
  }

  /** Parses `raw` (a curl command, possibly multi-line with "\" or "^"
   * line continuations) into an ApiRequestDetails-shaped object. Throws
   * only on genuinely malformed input (nothing to tokenize); an
   * unrecognized flag is simply skipped rather than treated as an error --
   * a best-effort import is far more useful than an all-or-nothing one. */
  function parseCurlCommand(raw) {
    const normalized = raw.replace(/\\\r?\n\s*/g, ' ').replace(/\^\r?\n\s*/g, ' ').trim();
    let tokens = tokenizeShellCommand(normalized);
    if (tokens[0] && tokens[0].toLowerCase() === 'curl') {
      tokens = tokens.slice(1);
    }

    let method = null;
    let url = '';
    const headers = [];
    const dataParts = [];
    const formFields = [];
    let isMultipart = false;
    let basicCred = null;
    let digestFlag = false;

    for (let i = 0; i < tokens.length; i++) {
      const t = tokens[i];
      if (t === '-X' || t === '--request') {
        method = (tokens[++i] || '').toUpperCase();
      } else if (t === '-H' || t === '--header') {
        const headerStr = tokens[++i] || '';
        const idx = headerStr.indexOf(':');
        if (idx !== -1) {
          headers.push({ key: headerStr.slice(0, idx).trim(), value: headerStr.slice(idx + 1).trim(), description: '' });
        }
      } else if (t === '-d' || t === '--data' || t === '--data-raw' || t === '--data-binary' || t === '--data-ascii' || t === '--data-urlencode') {
        dataParts.push(tokens[++i] || '');
      } else if (t === '-F' || t === '--form') {
        isMultipart = true;
        const kv = tokens[++i] || '';
        const eq = kv.indexOf('=');
        if (eq !== -1) {
          const key = kv.slice(0, eq);
          let value = kv.slice(eq + 1);
          const valueType = value.charAt(0) === '@' ? 'file' : 'text';
          if (valueType === 'file') value = value.slice(1);
          formFields.push({ key, value, valueType, description: '' });
        }
      } else if (t === '-u' || t === '--user') {
        const cred = tokens[++i] || '';
        const idx = cred.indexOf(':');
        basicCred = { username: idx === -1 ? cred : cred.slice(0, idx), password: idx === -1 ? '' : cred.slice(idx + 1) };
      } else if (t === '--digest') {
        digestFlag = true;
      } else if (t === '-b' || t === '--cookie') {
        headers.push({ key: 'Cookie', value: tokens[++i] || '', description: '' });
      } else if (t === '-A' || t === '--user-agent') {
        headers.push({ key: 'User-Agent', value: tokens[++i] || '', description: '' });
      } else if (t === '-e' || t === '--referer') {
        headers.push({ key: 'Referer', value: tokens[++i] || '', description: '' });
      } else if (t === '--url') {
        url = tokens[++i] || '';
      } else if (t.charAt(0) === '-') {
        if (CURL_FLAGS_WITH_VALUE.has(t)) {
          i++; // skip this flag's value -- never mistake it for the URL
        }
        // Anything else (recognized no-value flag or truly unknown) is
        // simply skipped -- neither consumes a following token nor errors.
      } else if (!url) {
        url = t; // the one bare, non-flag argument is always the URL
      }
    }

    if (!method) {
      method = dataParts.length || formFields.length ? 'POST' : 'GET';
    }

    // Query params: parsed out of the URL for the Params tab, but the URL
    // field itself keeps the full, original URL (including the query
    // string) -- exactly what the user pasted, never silently rewritten.
    const params = [];
    const queryIndex = url.indexOf('?');
    if (queryIndex !== -1) {
      const query = url.slice(queryIndex + 1);
      query.split('&').filter(Boolean).forEach((pair) => {
        const eq = pair.indexOf('=');
        const key = decodeURIComponent((eq === -1 ? pair : pair.slice(0, eq)).replace(/\+/g, ' '));
        const value = eq === -1 ? '' : decodeURIComponent(pair.slice(eq + 1).replace(/\+/g, ' '));
        params.push({ key, value, description: '' });
      });
    }

    // Auth: an explicit Authorization header wins if present (removed from
    // the plain Headers list so it isn't double-represented once it's been
    // turned into a structured auth type); otherwise -u/--user (Digest if
    // paired with --digest, Basic otherwise).
    let authType = 'noauth';
    const auth = {};
    const authHeaderIndex = headers.findIndex((h) => h.key.toLowerCase() === 'authorization');
    if (authHeaderIndex !== -1) {
      const value = headers[authHeaderIndex].value;
      const bearerMatch = /^Bearer\s+(.+)$/i.exec(value);
      const basicMatch = /^Basic\s+(.+)$/i.exec(value);
      if (bearerMatch) {
        authType = 'bearer';
        auth.bearerToken = bearerMatch[1];
        headers.splice(authHeaderIndex, 1);
      } else if (basicMatch) {
        try {
          const decoded = atob(basicMatch[1]);
          const idx = decoded.indexOf(':');
          authType = 'basic';
          auth.basicUsername = idx === -1 ? decoded : decoded.slice(0, idx);
          auth.basicPassword = idx === -1 ? '' : decoded.slice(idx + 1);
          headers.splice(authHeaderIndex, 1);
        } catch (e) {
          // Not valid base64 -- leave it as a plain header rather than guess.
        }
      }
    } else if (basicCred) {
      authType = digestFlag ? 'digest' : 'basic';
      if (authType === 'digest') {
        auth.digestUsername = basicCred.username;
        auth.digestPassword = basicCred.password;
      } else {
        auth.basicUsername = basicCred.username;
        auth.basicPassword = basicCred.password;
      }
    }
    // A header that looks like an API key convention (never guessed at for
    // query params -- too easy to false-positive on a legitimate business
    // param there) gets promoted to the structured API Key auth type too.
    if (authType === 'noauth') {
      const apiKeyIndex = headers.findIndex((h) => /^(x-)?api[-_]?key$/i.test(h.key));
      if (apiKeyIndex !== -1) {
        authType = 'apikey';
        auth.apiKeyName = headers[apiKeyIndex].key;
        auth.apiKeyValue = headers[apiKeyIndex].value;
        auth.apiKeyAddTo = 'header';
        headers.splice(apiKeyIndex, 1);
      }
    }

    // Body.
    let bodyMode = 'none';
    let bodyRaw = '';
    let bodyRawLanguage = 'Text';
    let bodyUrlencodedFields = [];
    const contentTypeHeader = headers.find((h) => h.key.toLowerCase() === 'content-type');
    const contentType = contentTypeHeader ? contentTypeHeader.value.toLowerCase() : '';

    if (isMultipart) {
      bodyMode = 'form-data';
    } else if (dataParts.length) {
      const joined = dataParts.join('&');
      const looksLikeJson = /^\s*[[{]/.test(joined);
      const looksLikeXml = /^\s*</.test(joined);
      const looksLikeUrlencoded = !looksLikeJson && !looksLikeXml && /^[^\s{}<>]+=[^\s{}<>]*(&[^\s{}<>]+=[^\s{}<>]*)*$/.test(joined);
      if (contentType.indexOf('json') !== -1 || (looksLikeJson && !contentType)) {
        bodyMode = 'raw';
        bodyRawLanguage = 'JSON';
        bodyRaw = beautifyJson(joined) || joined;
      } else if (contentType.indexOf('xml') !== -1 || (looksLikeXml && !contentType)) {
        bodyMode = 'raw';
        bodyRawLanguage = 'XML';
        bodyRaw = beautifyXml(joined) || joined;
      } else if (looksLikeUrlencoded && contentType.indexOf('json') === -1 && contentType.indexOf('xml') === -1) {
        bodyMode = 'x-www-form-urlencoded';
        bodyUrlencodedFields = joined.split('&').filter(Boolean).map((pair) => {
          const eq = pair.indexOf('=');
          const key = decodeURIComponent((eq === -1 ? pair : pair.slice(0, eq)).replace(/\+/g, ' '));
          const value = eq === -1 ? '' : decodeURIComponent(pair.slice(eq + 1).replace(/\+/g, ' '));
          return { key, value, description: '' };
        });
      } else {
        bodyMode = 'raw';
        bodyRawLanguage = 'Text';
        bodyRaw = joined;
      }
    }

    return { method, url, headers, params, authType, auth, bodyMode, bodyRaw, bodyRawLanguage, bodyFormFields: formFields, bodyUrlencodedFields };
  }

  /** Pushes a parsed curl result into every Control Panel field it touches
   * -- dispatches 'change' on the auth-type/body-mode controls afterward
   * so their own existing listeners handle showing the right field
   * blocks, rather than duplicating that show/hide logic here. */
  function applyCurlResult(result) {
    document.getElementById('apiMethod').value = result.method;
    document.getElementById('apiUrl').value = result.url;
    apiParamsTable.setRows(result.params);
    apiHeadersTable.setRows(result.headers);

    apiAuthType.value = result.authType;
    apiAuthType.dispatchEvent(new Event('change'));
    // Explicit map (not a naming-convention derivation -- several element
    // ids are deliberately abbreviated, e.g. basicUsername's input is
    // #apiAuthBasicUser, not the "obvious" #apiAuthBasicUsername) so this
    // can never silently drift out of sync with the actual markup above.
    const AUTH_FIELD_IDS = {
      apiKeyName: 'apiAuthApiKeyName',
      apiKeyValue: 'apiAuthApiKeyValue',
      apiKeyAddTo: 'apiAuthApiKeyAddTo',
      bearerToken: 'apiAuthBearerToken',
      basicUsername: 'apiAuthBasicUser',
      basicPassword: 'apiAuthBasicPass',
      digestUsername: 'apiAuthDigestUser',
      digestPassword: 'apiAuthDigestPass',
      oauth1ConsumerKey: 'apiAuthOauth1ConsumerKey',
      oauth1ConsumerSecret: 'apiAuthOauth1ConsumerSecret',
      oauth1AccessToken: 'apiAuthOauth1AccessToken',
      oauth1TokenSecret: 'apiAuthOauth1TokenSecret',
      oauth1SignatureMethod: 'apiAuthOauth1SignatureMethod',
      oauth2AccessToken: 'apiAuthOauth2AccessToken',
      oauth2HeaderPrefix: 'apiAuthOauth2HeaderPrefix',
      hawkAuthId: 'apiAuthHawkId',
      hawkAuthKey: 'apiAuthHawkKey',
      hawkAlgorithm: 'apiAuthHawkAlgorithm',
      awsAccessKey: 'apiAuthAwsAccessKey',
      awsSecretKey: 'apiAuthAwsSecretKey',
      awsSessionToken: 'apiAuthAwsSessionToken',
      awsRegion: 'apiAuthAwsRegion',
      awsServiceName: 'apiAuthAwsServiceName',
      ntlmUsername: 'apiAuthNtlmUser',
      ntlmPassword: 'apiAuthNtlmPass',
      ntlmDomain: 'apiAuthNtlmDomain',
      ntlmWorkstation: 'apiAuthNtlmWorkstation',
      edgeGridAccessToken: 'apiAuthEdgeGridAccessToken',
      edgeGridClientToken: 'apiAuthEdgeGridClientToken',
      edgeGridClientSecret: 'apiAuthEdgeGridClientSecret'
    };
    Object.keys(result.auth).forEach((key) => {
      const el = document.getElementById(AUTH_FIELD_IDS[key]);
      if (el) el.value = result.auth[key];
    });

    const bodyModeRadio = document.querySelector('input[name="apiBodyMode"][value="' + result.bodyMode + '"]');
    if (bodyModeRadio) {
      bodyModeRadio.checked = true;
      bodyModeRadio.dispatchEvent(new Event('change'));
    }
    apiFormDataTable.setRows(result.bodyFormFields);
    apiUrlencodedTable.setRows(result.bodyUrlencodedFields);
    apiRawLanguageSelect.value = result.bodyRawLanguage;
    apiRawBodyEditor.setLanguage(rawBodyEditorLanguage());
    apiRawBodyEditor.setValue(result.bodyRaw);
  }

  const apiCurlBtn = document.getElementById('apiCurlBtn');
  const apiCurlPanel = document.getElementById('apiCurlPanel');
  const apiCurlInput = document.getElementById('apiCurlInput');
  const apiCurlImportBtn = document.getElementById('apiCurlImportBtn');
  const apiCurlCancelBtn = document.getElementById('apiCurlCancelBtn');
  const apiCurlStatus = document.getElementById('apiCurlStatus');

  function closeCurlPanel() {
    apiCurlPanel.hidden = true;
    apiCurlInput.value = '';
    apiCurlStatus.textContent = '';
  }

  apiCurlBtn.addEventListener('click', () => {
    apiCurlPanel.hidden = !apiCurlPanel.hidden;
    if (!apiCurlPanel.hidden) apiCurlInput.focus();
  });
  apiCurlCancelBtn.addEventListener('click', closeCurlPanel);
  apiCurlImportBtn.addEventListener('click', () => {
    const raw = apiCurlInput.value.trim();
    if (!raw) return;
    let result;
    try {
      result = parseCurlCommand(raw);
    } catch (e) {
      result = null;
    }
    if (!result || !result.url) {
      apiCurlStatus.textContent = 'Could not find a URL in that command — check it was pasted in full.';
      apiCurlStatus.className = 'api-curl-status error';
      return;
    }
    applyCurlResult(result);
    apiCurlStatus.textContent = 'Imported.';
    apiCurlStatus.className = 'api-curl-status success';
    setTimeout(closeCurlPanel, 900);
  });

  /** Everything currently in the API request builder, as one structured
   * object -- sent verbatim (minus redaction of secret VALUES, applied
   * server-side, never here) as the "API Request Details" context for
   * "Start AI Processing" and "Generate Gherkin Feature File" in API mode.
   * Harmless to compute in UI mode too (the extension host only reads it
   * when settings.automationMode === 'api'). */
  /** Shorthand for reading one Control Panel field's current value by id --
   * used heavily below since every auth type's own fields (11 types, most
   * with 2-5 fields each) would otherwise be a wall of repeated
   * document.getElementById(...).value calls. */
  function fieldValue(id) {
    const el = document.getElementById(id);
    return el ? el.value : '';
  }

  function collectApiRequestDetails() {
    const checkedBodyMode = document.querySelector('input[name="apiBodyMode"]:checked');
    return {
      method: document.getElementById('apiMethod').value,
      url: document.getElementById('apiUrl').value.trim(),
      params: apiParamsTable.getRows(),
      headers: apiHeadersTable.getRows(),
      authType: apiAuthType.value,
      auth: {
        apiKeyName: fieldValue('apiAuthApiKeyName'),
        apiKeyValue: fieldValue('apiAuthApiKeyValue'),
        apiKeyAddTo: fieldValue('apiAuthApiKeyAddTo') || 'header',
        bearerToken: fieldValue('apiAuthBearerToken'),
        basicUsername: fieldValue('apiAuthBasicUser'),
        basicPassword: fieldValue('apiAuthBasicPass'),
        digestUsername: fieldValue('apiAuthDigestUser'),
        digestPassword: fieldValue('apiAuthDigestPass'),
        oauth1ConsumerKey: fieldValue('apiAuthOauth1ConsumerKey'),
        oauth1ConsumerSecret: fieldValue('apiAuthOauth1ConsumerSecret'),
        oauth1AccessToken: fieldValue('apiAuthOauth1AccessToken'),
        oauth1TokenSecret: fieldValue('apiAuthOauth1TokenSecret'),
        oauth1SignatureMethod: fieldValue('apiAuthOauth1SignatureMethod') || 'HMAC-SHA1',
        oauth2AccessToken: fieldValue('apiAuthOauth2AccessToken'),
        oauth2HeaderPrefix: fieldValue('apiAuthOauth2HeaderPrefix') || 'Bearer',
        hawkAuthId: fieldValue('apiAuthHawkId'),
        hawkAuthKey: fieldValue('apiAuthHawkKey'),
        hawkAlgorithm: fieldValue('apiAuthHawkAlgorithm') || 'sha256',
        awsAccessKey: fieldValue('apiAuthAwsAccessKey'),
        awsSecretKey: fieldValue('apiAuthAwsSecretKey'),
        awsSessionToken: fieldValue('apiAuthAwsSessionToken'),
        awsRegion: fieldValue('apiAuthAwsRegion'),
        awsServiceName: fieldValue('apiAuthAwsServiceName'),
        ntlmUsername: fieldValue('apiAuthNtlmUser'),
        ntlmPassword: fieldValue('apiAuthNtlmPass'),
        ntlmDomain: fieldValue('apiAuthNtlmDomain'),
        ntlmWorkstation: fieldValue('apiAuthNtlmWorkstation'),
        edgeGridAccessToken: fieldValue('apiAuthEdgeGridAccessToken'),
        edgeGridClientToken: fieldValue('apiAuthEdgeGridClientToken'),
        edgeGridClientSecret: fieldValue('apiAuthEdgeGridClientSecret')
      },
      bodyMode: checkedBodyMode ? checkedBodyMode.value : 'none',
      bodyFormFields: apiFormDataTable.getRows(),
      bodyUrlencodedFields: apiUrlencodedTable.getRows(),
      bodyRawLanguage: apiRawLanguageSelect.value,
      bodyRaw: apiRawBodyEditor.getValue()
    };
  }

  // "Clear Data" (API Automation) -- resets every Control Panel field back
  // to blank/default, then asks the extension host to forget everything it
  // was keeping in memory on top of that (linked scenario, linked/cached
  // feature file, last-sent API request, checked Custom md files, any
  // in-flight LLM request, the AI Generated Code / Generated Feature File
  // panels' content) -- a genuine "start this API test over from nothing",
  // not just an emptied form.
  clearApiDataBtn.addEventListener('click', () => {
    document.getElementById('apiMethod').value = 'GET';
    document.getElementById('apiUrl').value = '';
    apiParamsTable.setRows([]);
    apiHeadersTable.setRows([]);

    apiAuthType.value = 'noauth';
    apiAuthType.dispatchEvent(new Event('change'));
    document.querySelectorAll('.api-auth-fields input').forEach((el) => {
      el.value = '';
    });
    // Selects with a sensible non-empty default (rather than just blank)
    // go back to that default, matching what a freshly loaded panel shows.
    document.getElementById('apiAuthApiKeyAddTo').value = 'header';
    document.getElementById('apiAuthOauth1SignatureMethod').value = 'HMAC-SHA1';
    document.getElementById('apiAuthOauth2HeaderPrefix').value = 'Bearer';
    document.getElementById('apiAuthHawkAlgorithm').value = 'sha256';

    const noneBodyMode = document.querySelector('input[name="apiBodyMode"][value="none"]');
    noneBodyMode.checked = true;
    noneBodyMode.dispatchEvent(new Event('change'));
    apiFormDataTable.setRows([]);
    apiUrlencodedTable.setRows([]);
    apiRawLanguageSelect.value = 'JSON';
    apiRawBodyEditor.setLanguage(rawBodyEditorLanguage());
    apiRawBodyEditor.setValue('');

    closeCurlPanel();

    // Custom md files -- uncheck everything currently checked.
    promptFilesList.querySelectorAll('input[type="checkbox"]').forEach((cb) => {
      cb.checked = false;
    });
    postSelectedInstructionFiles();

    // Chat composer -- discard both staged bubbles and anything unsent.
    stagedInstructions = [];
    chatMessages.innerHTML = '';
    chatInput.value = '';
    autoResizeChatInput();

    vscode.postMessage({ type: 'clearApiData' });
    scheduleTokenEstimate();
  });

  // ---------------------------------------------------------------------
  // Token Monitoring — recomputed (debounced) on essentially any change
  // anywhere in the sidebar, using the SAME data "Start AI Processing"
  // would actually send; the extension host does the real counting (via
  // the selected model's own tokenizer) and reports back. See
  // updateTokenEstimate()/recordReceivedTokens() in objectSpyPanel.ts.
  // ---------------------------------------------------------------------

  // Merges partial updates: a completed-response update only carries
  // receivedTokens (sentTokens: null), a draft-context update only carries
  // sentTokens -- each keeps whatever the other last reported rather than
  // clobbering it back to zero.
  let lastTokenState = null;

  /** Whatever's currently in the chat composer (staged bubbles + anything
   * still unsent), WITHOUT clearing it -- unlike
   * collectAndClearStagedInstructions(), typing must never itself clear
   * the composer, only actually sending does. */
  function currentCustomInstructionsPreview() {
    const unsent = chatInput.value.trim();
    const parts = unsent ? [...stagedInstructions, unsent] : stagedInstructions;
    return parts.join('\n\n');
  }

  function sendDraftContext() {
    vscode.postMessage({
      type: 'updateDraftContext',
      payload: {
        code: playwrightEditor.getValue(),
        customInstructions: currentCustomInstructionsPreview(),
        selectedFiles: selectedPromptFiles(),
        apiDetails: collectApiRequestDetails()
      }
    });
  }

  let tokenEstimateTimer = null;
  function scheduleTokenEstimate() {
    clearTimeout(tokenEstimateTimer);
    tokenEstimateTimer = setTimeout(sendDraftContext, 600);
  }

  // Delegated at the document level rather than wired to each individual
  // field -- the Params/Headers/form-data/Auth fields are numerous, several
  // tables re-render their inputs entirely on every edit, and this way
  // nothing new added to any panel in the future is silently missed.
  document.addEventListener('input', scheduleTokenEstimate);
  document.addEventListener('change', scheduleTokenEstimate);

  function applyTokenEstimate(payload) {
    if (payload.available === false) {
      lastTokenState = null;
      tokenUnavailableNote.hidden = false;
      tokenUnavailableNote.textContent = payload.reason || 'Token usage unavailable.';
      tokenBreakdown.hidden = true;
      tokenBarFill.style.width = '0%';
      tokenPercentLabel.textContent = '—';
      tokenModelLabel.textContent = '';
      return;
    }

    lastTokenState = lastTokenState || {};
    if (payload.sentTokens !== null && payload.sentTokens !== undefined) {
      lastTokenState.sentTokens = payload.sentTokens;
    }
    if (payload.receivedTokens !== null && payload.receivedTokens !== undefined) {
      lastTokenState.receivedTokens = payload.receivedTokens;
    }
    if (payload.maxInputTokens) {
      lastTokenState.maxInputTokens = payload.maxInputTokens;
    }
    if (payload.modelId) {
      lastTokenState.modelId = payload.modelId;
    }
    // A "received-only" update (a response just completed) landing before
    // any draft was ever estimated has nothing to render a percentage
    // against yet -- wait for the next real sent-token estimate.
    if (lastTokenState.sentTokens === undefined) {
      return;
    }

    tokenUnavailableNote.hidden = true;
    tokenBreakdown.hidden = false;

    const sent = lastTokenState.sentTokens;
    const received = lastTokenState.receivedTokens || 0;
    const max = lastTokenState.maxInputTokens || 0;
    const percent = max > 0 ? Math.min(100, (sent / max) * 100) : 0;

    tokenBarFill.style.width = percent + '%';
    // Green -> amber -> red thresholds, same semantic colors as every
    // other "how much headroom is left" indicator (GitHub's own status
    // colors) -- an enterprise-recognizable convention, not an invented one.
    tokenBarFill.style.background = percent >= 85 ? '#f85149' : percent >= 60 ? '#d29922' : '#3fb950';
    tokenPercentLabel.textContent = percent.toFixed(1) + '% of context window';
    tokenModelLabel.textContent = lastTokenState.modelId || '';
    tokenSentValue.textContent = sent.toLocaleString();
    tokenReceivedValue.textContent = received.toLocaleString();
    tokenTotalValue.textContent = (sent + received).toLocaleString();
    tokenMaxValue.textContent = max.toLocaleString();
  }

  let killConfirmPending = false;
  let killConfirmTimer = null;

  startBtn.addEventListener('click', () => {
    // The URL is only usable at spawn time (Playwright's own `codegen` CLI
    // takes it as a positional argument) -- there's no way to change it
    // once its browser window is already open from outside that window.
    vscode.postMessage({ type: 'start', payload: urlInput.value.trim() });
  });

  stopBtn.addEventListener('click', () => {
    vscode.postMessage({ type: 'stop' });
  });

  settingsBtn.addEventListener('click', () => {
    vscode.postMessage({ type: 'openSettings' });
  });

  saveCodeBtn.addEventListener('click', () => {
    vscode.postMessage({ type: 'saveCode', payload: playwrightEditor.getValue() });
  });

  openAiCodeBtn.addEventListener('click', () => {
    vscode.postMessage({ type: 'openAiCodePanel' });
  });

  function flashCopyBtn(btn, label) {
    const original = btn.textContent;
    btn.textContent = label;
    btn.disabled = true;
    setTimeout(() => {
      btn.textContent = original;
      btn.disabled = false;
    }, 1200);
  }

  async function copyToClipboard(text, btn) {
    try {
      await navigator.clipboard.writeText(text);
      flashCopyBtn(btn, 'Copied!');
    } catch (err) {
      // Fallback for environments where the async Clipboard API is blocked
      // (e.g. focus/permission restrictions inside a webview).
      try {
        const textarea = document.createElement('textarea');
        textarea.value = text;
        textarea.style.position = 'fixed';
        textarea.style.opacity = '0';
        document.body.appendChild(textarea);
        textarea.focus();
        textarea.select();
        document.execCommand('copy');
        document.body.removeChild(textarea);
        flashCopyBtn(btn, 'Copied!');
      } catch (fallbackErr) {
        flashCopyBtn(btn, 'Copy failed');
      }
    }
  }

  copyCodeBtn.addEventListener('click', () => {
    copyToClipboard(playwrightEditor.getValue(), copyCodeBtn);
  });

  // Collapse the Playwright Code panel down to just its header -- useful
  // once the AI Generated Code panel is open beside this sidebar and this
  // half of the picture isn't needed for a moment.
  collapseCodeBtn.addEventListener('click', () => {
    const collapsed = playwrightCodePanel.classList.toggle('collapsed');
    collapseCodeBtn.textContent = collapsed ? '▸' : '▾';
    collapseCodeBtn.title = collapsed ? 'Expand this panel' : 'Collapse this panel';
  });

  refreshPromptFilesBtn.addEventListener('click', () => {
    vscode.postMessage({ type: 'refreshPromptFiles' });
  });

  function selectedPromptFiles() {
    return Array.from(promptFilesList.querySelectorAll('input[type="checkbox"]:checked')).map((cb) => cb.value);
  }

  // AI processing never starts on its own — checking a .md file below,
  // typing in the chat composer, or a fresh Playwright recording all only
  // ever stage context. Nothing reaches the LLM until "Start AI Processing"
  // is explicitly clicked (see below), which bundles: the current
  // Playwright Code, whichever .md files are checked (selectedPromptFiles()
  // below, read fresh at click time), the linked scenario/selected steps
  // and current Settings (both read on the extension-host side), and
  // everything staged in the chat composer.
  let stagedInstructions = [];

  // Messenger-style composer: Enter/the ➤ button stages the message as a
  // bubble (does NOT send anything to the LLM), Shift+Enter inserts a
  // newline, and the textarea grows with content up to a few lines (see
  // main.css).
  function stageChatMessage() {
    const text = chatInput.value.trim();
    if (!text) {
      return;
    }
    appendChatBubble(text);
    stagedInstructions.push(text);
    chatInput.value = '';
    autoResizeChatInput();
  }

  function appendChatBubble(text) {
    const bubble = document.createElement('div');
    bubble.className = 'chat-bubble chat-bubble-sent';
    bubble.textContent = text;
    chatMessages.appendChild(bubble);
    chatMessages.scrollTop = chatMessages.scrollHeight;
  }

  function autoResizeChatInput() {
    chatInput.style.height = 'auto';
    chatInput.style.height = Math.min(chatInput.scrollHeight, 90) + 'px';
  }

  chatSendBtn.addEventListener('click', stageChatMessage);

  chatInput.addEventListener('input', autoResizeChatInput);

  chatInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      stageChatMessage();
    }
  });

  // Bundles every staged chat bubble plus whatever's still sitting unsent
  // in the input box (so the user doesn't have to remember to hit ➤ first)
  // into one customInstructions string, then clears the stage so the next
  // run starts fresh. Shared by both "Start AI Processing" and "Generate
  // Gherkin Feature File" — the two only differ in which message type they
  // post and which extension-host method picks it up from there.
  function collectAndClearStagedInstructions() {
    const unsent = chatInput.value.trim();
    const allInstructions = unsent ? [...stagedInstructions, unsent] : stagedInstructions;
    const customInstructions = allInstructions.join('\n\n');

    stagedInstructions = [];
    chatMessages.innerHTML = '';
    chatInput.value = '';
    autoResizeChatInput();

    return customInstructions;
  }

  // "Start AI Processing" — the ONLY trigger for AI code generation.
  // Bundles staged chat instructions, the current Playwright Code, and
  // checked .md files; the extension host adds Settings and the linked
  // scenario/selected steps on its own. `apiDetails` is always included —
  // harmless in UI mode, where the extension host simply ignores it (see
  // sendToLlm()/runLlmRefinement() there, gated on settings.automationMode).
  startAiProcessingBtn.addEventListener('click', () => {
    const customInstructions = collectAndClearStagedInstructions();
    vscode.postMessage({
      type: 'sendToLlm',
      payload: {
        selectedFiles: selectedPromptFiles(),
        code: playwrightEditor.getValue(),
        customInstructions,
        apiDetails: collectApiRequestDetails()
      }
    });
  });

  // "Generate Gherkin Feature File" — for when no .feature file has been
  // linked yet: turns whatever Playwright Codegen recorded (UI mode) or the
  // API request just described above (API mode) — plus staged chat
  // instructions — into a brand-new BDD feature file instead of refined
  // automation code. See generateFeatureFile() on the extension host.
  generateFeatureFileBtn.addEventListener('click', () => {
    const customInstructions = collectAndClearStagedInstructions();
    vscode.postMessage({
      type: 'generateFeatureFile',
      payload: { code: playwrightEditor.getValue(), customInstructions, apiDetails: collectApiRequestDetails() }
    });
  });

  // Kill All Browsers needs a confirmation, but VS Code webviews don't
  // reliably support window.confirm()/alert() -- a two-click "arm, then
  // confirm" pattern on the button itself avoids depending on that.
  killAllBtn.addEventListener('click', () => {
    if (!killConfirmPending) {
      armKillConfirm();
      return;
    }
    disarmKillConfirm();
    vscode.postMessage({ type: 'killAllBrowsers' });
  });

  function armKillConfirm() {
    killConfirmPending = true;
    killAllBtn.textContent = 'Click again to confirm';
    killAllBtn.classList.add('btn-danger-confirm');
    clearTimeout(killConfirmTimer);
    killConfirmTimer = setTimeout(disarmKillConfirm, 3000);
  }

  function disarmKillConfirm() {
    killConfirmPending = false;
    killAllBtn.textContent = 'Kill All Browsers';
    killAllBtn.classList.remove('btn-danger-confirm');
    clearTimeout(killConfirmTimer);
  }

  linkFeatureBtn.addEventListener('click', () => {
    vscode.postMessage({ type: 'linkFeatureFile' });
  });

  // "Link with GitHub Copilot LLM" — moved here from the Settings menu; the
  // Settings panel still owns the model picker, kept in sync via the shared
  // SettingsStore regardless of which webview flips this switch.
  copilotEnabledToggle.addEventListener('change', () => {
    vscode.postMessage({ type: 'setCopilotEnabled', payload: copilotEnabledToggle.checked });
  });

  unlinkScenarioBtn.addEventListener('click', (e) => {
    e.stopPropagation(); // don't also trigger the badge's own reopen click below
    vscode.postMessage({ type: 'unlinkFeatureFile' });
  });

  linkedScenarioText.addEventListener('click', () => {
    vscode.postMessage({ type: 'reopenFeatureFile' });
  });
  linkedScenarioText.style.cursor = 'pointer';
  linkedScenarioText.title = linkedScenarioText.title || 'Click to reopen this feature file and pick a different scenario';

  function applyLinkedScenario(scenario) {
    if (!scenario) {
      linkedScenarioBadge.hidden = true;
      linkedScenarioText.textContent = '';
      return;
    }
    linkedScenarioBadge.hidden = false;
    // Only worth calling out when it's actually a subset — a full
    // selection is the common case and needs no extra noise in the badge.
    var stepSuffix =
      typeof scenario.selectedStepCount === 'number' &&
      typeof scenario.totalStepCount === 'number' &&
      scenario.selectedStepCount < scenario.totalStepCount
        ? ' (' + scenario.selectedStepCount + '/' + scenario.totalStepCount + ' steps)'
        : '';
    linkedScenarioText.textContent =
      scenario.featureName + ' › ' + scenario.scenarioKind + ': ' + scenario.scenarioName + stepSuffix;
    linkedScenarioText.title = linkedScenarioText.textContent + ' — click to pick a different scenario from this file';
  }

  // A feature file becomes "available" the moment it's successfully
  // parsed — independent of whether a scenario has been picked from it yet
  // — and stays available (this button just reopens it, no OS dialog) for
  // the rest of the session, until a different file is linked or VS Code
  // closes. Relabeling makes that persistence discoverable instead of
  // surprising.
  function applyFeatureFileAvailable(available) {
    linkFeatureBtn.textContent = available ? 'View Feature File' : 'Link Feature File';
    linkFeatureBtn.title = available
      ? 'Reopen the linked feature file to pick a different Scenario/Scenario Outline'
      : 'Browse and select a Cucumber .feature file and pick a Scenario/Scenario Outline to link to the generated code';
  }

  // See media/codeEditor.js for the shared editor factory (line-number
  // gutter, Tab-indent, syntax highlighting) used here and by the
  // standalone AI Generated Code panel.
  const playwrightEditor = window.createCodeEditor(codeEditArea, codeHighlightPre, codeGutter);

  // Once the user hand-edits the code, a newly recorded action must not
  // silently clobber their edits -- offer a refresh instead.
  let userEditedCode = false;
  let pendingFreshCode = null;

  playwrightEditor.onEdit(() => {
    userEditedCode = true;
  });

  codeRefreshBtn.addEventListener('click', () => {
    if (pendingFreshCode) {
      applyFreshCode(pendingFreshCode);
      pendingFreshCode = null;
    }
    codeRefreshBanner.hidden = true;
  });

  function applyFreshCode(payload) {
    userEditedCode = false;
    playwrightEditor.setLanguage(payload.language);
    playwrightEditor.setValue(payload.code);
  }

  window.addEventListener('message', (event) => {
    const message = event.data;
    switch (message.type) {
      case 'status':
        applyStatus(message.payload);
        break;
      case 'code':
        applyCode(message.payload);
        break;
      case 'clearAll':
        clearAll();
        break;
      case 'copilotEnabledState':
        applyCopilotEnabledState(message.payload);
        break;
      case 'linkedScenario':
        applyLinkedScenario(message.payload);
        break;
      case 'featureFileAvailable':
        applyFeatureFileAvailable(message.payload);
        break;
      case 'promptFiles':
        renderPromptFiles(message.payload);
        break;
      case 'aiStatus':
        applyAiStatus(message.payload);
        break;
      case 'requestCurrentCode':
        // "Regenerate AI Code" (AI Generated Code panel) asking for the
        // Playwright Code editor's live content, manual edits included.
        vscode.postMessage({ type: 'currentCodeReport', payload: playwrightEditor.getValue() });
        break;
      case 'codeCorrectness':
        codeCorrectnessBanner.hidden = !message.payload;
        break;
      case 'apiFormFileSelected':
        apiFormDataTable.applyFileSelection(message.payload.rowId, message.payload.filePath);
        break;
      case 'tokenEstimate':
        applyTokenEstimate(message.payload);
        break;
      case 'requestDraftContext':
        // A settings change (model/language/automation mode) needs a fresh
        // estimate immediately -- not debounced, this isn't a burst of
        // keystrokes, it's one explicit, already-settled change.
        sendDraftContext();
        break;
    }
  });

  // One initial estimate once the webview has finished wiring itself up,
  // so Token Monitoring shows real numbers from the start rather than
  // waiting for the user's first edit.
  scheduleTokenEstimate();

  function applyCopilotEnabledState(enabled) {
    // Setting .checked programmatically does not fire 'change', so this
    // never loops back into the listener above — safe to always sync it
    // here, whether this update originated from this toggle, the Settings
    // panel, or extension activation.
    copilotEnabledToggle.checked = enabled;
    // aiAssistSection nests chatComposer, so hiding it here already hides
    // the composer too -- no need to separately toggle chatComposer.hidden.
    aiAssistSection.hidden = !enabled;
    if (enabled) {
      vscode.postMessage({ type: 'refreshPromptFiles' });
    } else {
      chatMessages.innerHTML = '';
      chatInput.value = '';
      stagedInstructions = [];
    }
  }

  function applyAiStatus(status) {
    aiGeneratingBanner.hidden = status.state !== 'generating';
    if (status.state === 'generating') {
      aiStatusLabel.textContent = '';
      aiStatusLabel.className = 'llm-status';
      aiStatusLabel.title = '';
    } else if (status.state === 'error') {
      aiStatusLabel.textContent = 'Error';
      aiStatusLabel.className = 'llm-status llm-status-error';
      aiStatusLabel.title = status.message || '';
    } else {
      aiStatusLabel.textContent = '';
      aiStatusLabel.className = 'llm-status';
      aiStatusLabel.title = '';
    }
  }

  // Tells the extension host which .md files are currently checked, so the
  // automatic AI refinement pipeline (fires on every new codegen output
  // update, no button needed) always uses the up-to-date selection. Also
  // fired once right after a re-render, since rebuilding the checkbox DOM
  // always starts unchecked -- keeps the host's tracked selection from
  // silently going stale relative to what's actually visible.
  function postSelectedInstructionFiles() {
    vscode.postMessage({ type: 'selectedInstructionFiles', payload: selectedPromptFiles() });
  }

  function renderPromptFiles(files) {
    if (!files.length) {
      promptFilesList.innerHTML = '<div class="prompt-files-empty">No .md files found under .github/.</div>';
      postSelectedInstructionFiles();
      return;
    }
    promptFilesList.innerHTML = '';
    for (const file of files) {
      const label = document.createElement('label');
      label.className = 'prompt-file-item';
      const checkbox = document.createElement('input');
      checkbox.type = 'checkbox';
      checkbox.value = file;
      checkbox.addEventListener('change', postSelectedInstructionFiles);
      label.appendChild(checkbox);
      const text = document.createElement('span');
      text.textContent = file;
      label.appendChild(text);
      promptFilesList.appendChild(label);
    }
    postSelectedInstructionFiles();
  }

  function applyCode(payload) {
    applyAutomationMode(payload.automationMode);
    codeLanguageLabel.textContent =
      '(' + payload.language[0].toUpperCase() + payload.language.slice(1) + ' ' + payload.languageVersion + ')';

    if (payload.isNewRecording) {
      flashNewCodeLabel();
    }

    if (userEditedCode) {
      // Don't silently clobber manual edits -- offer a refresh instead.
      pendingFreshCode = payload;
      codeRefreshBanner.hidden = false;
      return;
    }
    applyFreshCode(payload);
  }

  let newCodeFlashTimer = null;
  function flashNewCodeLabel() {
    newCodeFlash.hidden = false;
    clearTimeout(newCodeFlashTimer);
    newCodeFlashTimer = setTimeout(() => {
      newCodeFlash.hidden = true;
    }, 2500);
  }

  function clearAll() {
    userEditedCode = false;
    pendingFreshCode = null;
    codeRefreshBanner.hidden = true;
    playwrightEditor.setValue('// Click Start and interact with the codegen browser window.');
    clearTimeout(newCodeFlashTimer);
    newCodeFlash.hidden = true;
  }

  function applyStatus(status) {
    statusPill.className = 'status-pill';
    statusPill.title = '';

    switch (status.state) {
      case 'idle':
        statusPill.classList.add('status-idle');
        statusPill.textContent = 'Idle';
        startBtn.disabled = false;
        stopBtn.disabled = true;
        break;
      case 'connecting':
        statusPill.classList.add('status-connecting');
        statusPill.textContent = status.detail || 'Connecting…';
        startBtn.disabled = true;
        stopBtn.disabled = false;
        break;
      case 'connected':
        statusPill.classList.add('status-connected');
        statusPill.textContent = 'Connected';
        startBtn.disabled = true;
        stopBtn.disabled = false;
        if (status.url) {
          urlInput.value = status.url;
        }
        break;
      case 'error':
        statusPill.classList.add('status-error');
        statusPill.textContent = 'Error';
        statusPill.title = status.message;
        startBtn.disabled = false;
        stopBtn.disabled = true;
        break;
    }
  }
})();
