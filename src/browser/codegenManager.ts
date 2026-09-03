import * as vscode from 'vscode';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { spawn, ChildProcess } from 'child_process';
import { Language, BrowserChannel } from '../settings/settingsStore';

export type CodegenStatus =
  | { state: 'idle' }
  | { state: 'starting' }
  | { state: 'running'; url: string }
  | { state: 'error'; message: string };

/**
 * Drives Playwright's OWN `codegen` CLI tool as a child process — the sole
 * way this extension launches a browser, scans elements, and records
 * actions into generated code. Real `playwright codegen` launches and owns
 * its own browser window with its own built-in recorder overlay baked into
 * the page, and this class's whole job is spawning/killing that process and
 * streaming its output file's content back verbatim (see onCodeUpdate).
 *
 * `playwright` (the full package, not just `playwright-core`) is a real
 * dependency of this extension purely for this CLI file — never for its own
 * bundled browser. `--channel chrome`/`--channel msedge` drives the real,
 * already-installed system browser directly (Playwright resolves the
 * installed Chrome/Edge path for a named channel on its own — no separate
 * executable-finding logic needed here); Playwright's browser-download step
 * is disabled at install time for this whole project (see .npmrc), so
 * nothing is ever fetched at runtime, in keeping with the bank-environment
 * constraint that a Chromium/Firefox/WebKit binary is never downloaded.
 */
export class CodegenManager implements vscode.Disposable {
  private child: ChildProcess | undefined;
  private outputFile: string | undefined;
  private pollTimer: ReturnType<typeof setInterval> | undefined;
  private lastFileContent = '';
  private lastEmittedContent = '';
  private currentLanguage: Language = 'python';
  private currentChannel: BrowserChannel = 'chrome';

  private status: CodegenStatus = { state: 'idle' };

  private readonly statusEmitter = new vscode.EventEmitter<CodegenStatus>();
  readonly onStatusChange = this.statusEmitter.event;

  private readonly codeEmitter = new vscode.EventEmitter<string>();
  /** Fires codegen's own file content every time it writes a new version —
   * left otherwise untouched (no reformatting, no locator/action rewriting;
   * that's deliberately "as-is" per the feature's whole point) with exactly
   * one addition: a launch override that finds the real, already-installed
   * Chrome/Edge executable on disk (whichever is selected in Settings — see
   * injectBrowserChannelConfig below) and launches that directly, so code
   * saved straight from this panel never falls back to Playwright's own
   * bundled Chromium, whose download is blocked by company policy. */
  readonly onCodeUpdate = this.codeEmitter.event;

  private readonly logEmitter = new vscode.EventEmitter<string>();
  readonly onLog = this.logEmitter.event;

  getStatus(): CodegenStatus {
    return this.status;
  }

  isRunning(): boolean {
    return this.status.state === 'running' || this.status.state === 'starting';
  }

  async start(url: string, language: Language, browserChannel: BrowserChannel): Promise<void> {
    if (this.isRunning()) {
      this.log('A native Playwright codegen session is already running.');
      return;
    }

    let cliPath: string;
    try {
      cliPath = resolveCodegenCliPath();
    } catch (err) {
      this.setStatus({ state: 'error', message: describeError(err) });
      return;
    }

    const target = language === 'java' ? 'java-junit' : 'python-pytest';
    const channel = browserChannel === 'edge' ? 'msedge' : 'chrome';
    const ext = language === 'java' ? 'java' : 'py';
    this.outputFile = path.join(os.tmpdir(), `softplay-codegen-${Date.now()}.${ext}`);
    this.lastFileContent = '';
    this.lastEmittedContent = '';
    this.currentLanguage = language;
    this.currentChannel = browserChannel;

    // Empty/blank stays genuinely absent from argv — codegen opens with a
    // blank page and the user types into its own address bar, exactly like
    // running `playwright codegen` by hand with no URL at all. Passing an
    // empty string as the positional argument instead would make it try to
    // navigate to "", which is not the same thing.
    const trimmedUrl = url.trim();
    const normalizedUrl = trimmedUrl ? normalizeUrl(trimmedUrl) : '';
    const args = [cliPath, 'codegen', `--target=${target}`, `--channel=${channel}`, '-o', this.outputFile];
    if (normalizedUrl) {
      args.push(normalizedUrl);
    }

    this.setStatus({ state: 'starting' });
    this.log(`Starting native Playwright codegen: --target=${target} --channel=${channel}${normalizedUrl ? ' ' + normalizedUrl : ' (no URL — opens blank)'}`);

    const child = spawn(process.execPath, args, { detached: true, stdio: 'ignore' });
    child.unref();
    this.child = child;

    child.once('exit', (code) => {
      // Only react if this is still the child we're tracking — a Stop
      // call already replaces `this.child` with undefined before killing,
      // so a late 'exit' from an already-superseded process is a no-op.
      if (this.child === child) {
        this.stopPolling();
        this.child = undefined;
        if (this.status.state !== 'idle') {
          this.setStatus({ state: 'idle' });
        }
        if (code !== null && code !== 0) {
          this.log(`Native Playwright codegen exited with code ${code} — the codegen window may have been closed manually.`);
        }
      }
    });

    child.once('error', (err) => {
      this.setStatus({ state: 'error', message: describeError(err) });
    });

    // Empty when no URL was given — left falsy deliberately, so the panel's
    // existing `if (status.url) { urlInput.value = ... }` echo (meant for
    // the CDP-attach flow's live current-URL tracking) never overwrites the
    // URL field with a placeholder string here; native mode has no
    // comparable "current URL" to report once the browser is running.
    this.setStatus({ state: 'running', url: normalizedUrl });
    this.startPolling();
  }

  /** Terminates the spawned `codegen` process — its browser goes down with
   * it (verified: the OS's own job-object/process-group cleanup takes down
   * a launched Chrome/Edge's child processes when the parent process that
   * launched it is killed, with no need to enumerate and kill them
   * ourselves). */
  async stop(): Promise<void> {
    this.stopPolling();
    const child = this.child;
    this.child = undefined;
    if (child && !child.killed) {
      try {
        child.kill();
      } catch (err) {
        this.log(`Error stopping native Playwright codegen: ${describeError(err)}`);
      }
    }
    const outputFile = this.outputFile;
    this.outputFile = undefined;
    if (outputFile) {
      await fs.promises.unlink(outputFile).catch(() => undefined);
    }
    this.setStatus({ state: 'idle' });
  }

  private startPolling(): void {
    this.stopPolling();
    this.pollTimer = setInterval(() => void this.pollOutputFile(), 700);
  }

  private stopPolling(): void {
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = undefined;
    }
  }

  private async pollOutputFile(): Promise<void> {
    if (!this.outputFile) {
      return;
    }
    try {
      const content = await fs.promises.readFile(this.outputFile, 'utf8');
      if (content !== this.lastFileContent) {
        this.lastFileContent = content;
        const augmented = injectBrowserChannelConfig(content, this.currentLanguage, this.currentChannel);
        if (augmented !== this.lastEmittedContent) {
          this.lastEmittedContent = augmented;
          this.codeEmitter.fire(augmented);
        }
      }
    } catch {
      // Not written yet (no action recorded in the codegen browser so far),
      // or momentarily mid-write — next poll picks it up.
    }
  }

  private setStatus(status: CodegenStatus): void {
    this.status = status;
    this.statusEmitter.fire(status);
  }

  private log(message: string): void {
    this.logEmitter.fire(message);
  }

  dispose(): void {
    void this.stop();
    this.statusEmitter.dispose();
    this.codeEmitter.dispose();
    this.logEmitter.dispose();
  }
}

/** Locates the `playwright` package's `cli.js` on disk without going through
 * Node's module `exports` map (the `playwright` package doesn't expose
 * `./cli.js` as a public subpath export, even though the file itself ships
 * and is exactly what its own `bin` entry points at) — resolving
 * `playwright/package.json` instead and joining `cli.js` next to it sidesteps
 * that restriction legitimately, since we're only building a filesystem
 * path, not asking the module resolver to load an unexported subpath. */
function resolveCodegenCliPath(): string {
  const pkgPath = require.resolve('playwright/package.json');
  const cliPath = path.join(path.dirname(pkgPath), 'cli.js');
  if (!fs.existsSync(cliPath)) {
    throw new Error('Could not locate the Playwright CLI (playwright/cli.js) — is the "playwright" package installed?');
  }
  return cliPath;
}

/** A bare host/path typed without a scheme is assumed to be https://, same
 * as everywhere else in this extension a URL is accepted from the user. */
function normalizeUrl(input: string): string {
  const trimmed = input.trim();
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(trimmed)) {
    return trimmed;
  }
  return `https://${trimmed}`;
}

function describeError(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * `playwright codegen --channel=...` only steers the browser codegen itself
 * launches to record the flow — verified against Playwright's own
 * `python-pytest`/`java-junit` templates, neither one writes any launch
 * config into the *generated test file* on its own (the fixture-based
 * `pytest-playwright` plugin and the `@UsePlaywright` JUnit extension both
 * default to downloading and launching Playwright's own bundled Chromium
 * unless the test file itself says otherwise). Since a Chromium/Firefox/
 * WebKit download is blocked by company policy here, this stitches in an
 * override that finds the real, already-installed Chrome/Edge executable on
 * disk directly (`executablePath`, resolved from a list of the standard
 * per-machine/per-user install locations, with an env-var override for a
 * nonstandard install) — a stronger guarantee than Playwright's own
 * `channel` resolution, which still depends on Playwright recognizing the
 * install itself. Same override the AI refinement prompt is told to
 * reproduce (see prompts/senior-qe-instructions.md).
 */
function injectBrowserChannelConfig(content: string, language: Language, browserChannel: BrowserChannel): string {
  return language === 'java' ? injectJavaExecutablePath(content, browserChannel) : injectPythonExecutablePath(content, browserChannel);
}

function injectPythonExecutablePath(content: string, browserChannel: BrowserChannel): string {
  const lines = content.split('\n');
  let importEnd = 0;
  while (importEnd < lines.length && (/^\s*(import |from )/.test(lines[importEnd]) || lines[importEnd].trim() === '')) {
    importEnd++;
  }
  const isEdge = browserChannel === 'edge';
  const envVar = isEdge ? 'EDGE_EXECUTABLE_PATH' : 'CHROME_EXECUTABLE_PATH';
  const exeName = isEdge ? 'msedge.exe' : 'chrome.exe';
  const browserLabel = isEdge ? 'Microsoft Edge' : 'Google Chrome';
  // Each a separate os.path.join() argument below, never concatenated with
  // a literal "\" ourselves — a bare "\" inside a normal (non-raw) Python
  // string is an invalid/deprecated escape sequence unless the following
  // character happens to form a real one; letting os.path.join supply the
  // separator sidesteps that entirely, on top of being the idiomatic way to
  // build a path in Python regardless.
  const vendor = isEdge ? 'Microsoft' : 'Google';
  const product = isEdge ? 'Edge' : 'Chrome';
  // Exact locations Chrome/Edge actually install to on Windows — Chrome
  // under Program Files, Edge under Program Files (x86) — checked first;
  // the other Program Files variant and the per-user LOCALAPPDATA install
  // follow as fallbacks for a non-default install.
  const primaryProgramFilesVar = isEdge ? 'PROGRAMFILES(X86)' : 'PROGRAMFILES';
  const primaryProgramFilesDefault = isEdge ? 'C:\\Program Files (x86)' : 'C:\\Program Files';
  const secondaryProgramFilesVar = isEdge ? 'PROGRAMFILES' : 'PROGRAMFILES(X86)';
  const secondaryProgramFilesDefault = isEdge ? 'C:\\Program Files' : 'C:\\Program Files (x86)';
  const candidateLines = [
    `        os.environ.get("${envVar}"),`,
    `        os.path.join(os.environ.get("${primaryProgramFilesVar}", r"${primaryProgramFilesDefault}"), "${vendor}", "${product}", "Application", "${exeName}"),`,
    `        os.path.join(os.environ.get("${secondaryProgramFilesVar}", r"${secondaryProgramFilesDefault}"), "${vendor}", "${product}", "Application", "${exeName}"),`,
    `        os.path.join(os.environ.get("LOCALAPPDATA", ""), "${vendor}", "${product}", "Application", "${exeName}"),`
  ];
  const fixtureBlock = [
    'import os',
    'import pytest',
    '',
    '',
    `def _resolve_${isEdge ? 'edge' : 'chrome'}_executable():`,
    `    # Chromium/Firefox/WebKit downloads are blocked by company policy — find the`,
    `    # real, already-installed ${browserLabel} on disk instead (an explicit`,
    `    # ${envVar} override first, then the standard per-machine/per-user install`,
    `    # locations) and launch that directly, never Playwright's own bundled browser.`,
    '    candidates = [',
    ...candidateLines,
    '    ]',
    '    for path in candidates:',
    '        if path and os.path.isfile(path):',
    '            return path',
    '    raise RuntimeError(',
    `        "Could not find a locally installed ${browserLabel} (${exeName}). Chromium downloads are disabled by "`,
    `        "company policy — install ${browserLabel}, or set the ${envVar} environment variable to its full path."`,
    '    )',
    '',
    '',
    '@pytest.fixture(scope="session")',
    'def browser_type_launch_args(browser_type_launch_args):',
    `    return {**browser_type_launch_args, "executable_path": _resolve_${isEdge ? 'edge' : 'chrome'}_executable()}`,
    ''
  ];
  const hasOsImport = lines.slice(0, importEnd).some((l) => /^\s*import os\s*$/.test(l));
  const hasPytestImport = lines.slice(0, importEnd).some((l) => /^\s*import pytest\s*$/.test(l));
  const block = fixtureBlock.filter((line) => {
    if (hasOsImport && line === 'import os') return false;
    if (hasPytestImport && line === 'import pytest') return false;
    return true;
  });
  const result = [...lines.slice(0, importEnd), ...block, ...lines.slice(importEnd)];
  return result.join('\n');
}

function injectJavaExecutablePath(content: string, browserChannel: BrowserChannel): string {
  const classMatch = content.match(/public\s+class\s+(\w+)/);
  if (!classMatch) {
    return content;
  }
  const className = classMatch[1];
  let result = content;

  if (!result.includes('import com.microsoft.playwright.junit.Options;')) {
    result = result.replace(
      /import com\.microsoft\.playwright\.junit\.UsePlaywright;/,
      `import com.microsoft.playwright.junit.UsePlaywright;\nimport com.microsoft.playwright.junit.Options;\nimport com.microsoft.playwright.junit.OptionsFactory;\nimport java.io.File;\nimport java.nio.file.Paths;`
    );
  }

  // Point @UsePlaywright at this class's own Options factory (added below)
  // instead of the bare, browser-default-launching form codegen emits.
  result = result.replace('@UsePlaywright', `@UsePlaywright(${className}.SoftPlayOptions.class)`);

  const isEdge = browserChannel === 'edge';
  const envVar = isEdge ? 'EDGE_EXECUTABLE_PATH' : 'CHROME_EXECUTABLE_PATH';
  const exeName = isEdge ? 'msedge.exe' : 'chrome.exe';
  const browserLabel = isEdge ? 'Microsoft Edge' : 'Google Chrome';
  const vendorDir = isEdge ? 'Microsoft\\\\Edge' : 'Google\\\\Chrome';
  const methodName = isEdge ? 'resolveEdgeExecutable' : 'resolveChromeExecutable';
  // Exact locations Chrome/Edge actually install to on Windows — Chrome
  // under Program Files, Edge under Program Files (x86) — checked first;
  // the other Program Files variant follows as a fallback for a
  // non-default install.
  const primaryVar = isEdge ? 'PROGRAMFILES(X86)' : 'PROGRAMFILES';
  const primaryDefault = isEdge ? 'C:\\\\Program Files (x86)' : 'C:\\\\Program Files';
  const secondaryVar = isEdge ? 'PROGRAMFILES' : 'PROGRAMFILES(X86)';
  const secondaryDefault = isEdge ? 'C:\\\\Program Files' : 'C:\\\\Program Files (x86)';

  const optionsClass =
    `\n  /** Chromium/Firefox/WebKit downloads are blocked by company policy —\n` +
    `   * finds the real, already-installed ${browserLabel} on disk instead and\n` +
    `   * launches that directly, never Playwright's own bundled browser. */\n` +
    `  public static class SoftPlayOptions implements OptionsFactory {\n` +
    `    @Override\n` +
    `    public Options getOptions() {\n` +
    `      return new Options().setLaunchOptions(\n` +
    `          new com.microsoft.playwright.BrowserType.LaunchOptions().setExecutablePath(Paths.get(${methodName}())));\n` +
    `    }\n\n` +
    `    private static String ${methodName}() {\n` +
    `      String primaryDir = System.getenv().getOrDefault("${primaryVar}", "${primaryDefault}");\n` +
    `      String secondaryDir = System.getenv().getOrDefault("${secondaryVar}", "${secondaryDefault}");\n` +
    `      String localAppData = System.getenv().getOrDefault("LOCALAPPDATA", "");\n` +
    `      String[] candidates = new String[] {\n` +
    `          System.getenv("${envVar}"),\n` +
    `          primaryDir + "\\\\${vendorDir}\\\\Application\\\\${exeName}",\n` +
    `          secondaryDir + "\\\\${vendorDir}\\\\Application\\\\${exeName}",\n` +
    `          localAppData + "\\\\${vendorDir}\\\\Application\\\\${exeName}"\n` +
    `      };\n` +
    `      for (String candidate : candidates) {\n` +
    `        if (candidate != null && new File(candidate).isFile()) {\n` +
    `          return candidate;\n` +
    `        }\n` +
    `      }\n` +
    `      throw new IllegalStateException(\n` +
    `          "Could not find a locally installed ${browserLabel} (${exeName}). Chromium downloads are disabled by "\n` +
    `              + "company policy — install ${browserLabel}, or set the ${envVar} environment variable to its full path.");\n` +
    `    }\n` +
    `  }\n`;

  const lastBraceIndex = result.lastIndexOf('}');
  if (lastBraceIndex === -1) {
    return result;
  }
  return result.slice(0, lastBraceIndex) + optionsClass + result.slice(lastBraceIndex);
}
