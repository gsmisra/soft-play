import * as vscode from 'vscode';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { spawn, ChildProcess } from 'child_process';
import { Language } from '../settings/settingsStore';
import { BrowserChannel } from './chromeFinder';

export type CodegenStatus =
  | { state: 'idle' }
  | { state: 'starting' }
  | { state: 'running'; url: string }
  | { state: 'error'; message: string };

/**
 * Drives Playwright's OWN `codegen` CLI tool as a child process — the
 * "Use native Playwright feature" mode (Settings, default ON). This is
 * deliberately a completely separate code path from BrowserManager: real
 * `playwright codegen` launches and owns its own browser window with its
 * own built-in recorder overlay baked into the page. It has no supported
 * way to attach to an externally-launched Chrome/Edge the way this
 * extension's CDP-attach architecture works, so it can't share a browser
 * (or a session) with Object Spy/Generate Code at all — hence the UI hides
 * that whole side of the panel while a codegen session is running (see
 * objectSpyPanel.ts's nativeModeActive wiring).
 *
 * `playwright` (the full package, not just `playwright-core`) is a real
 * dependency of this extension purely for this CLI file — never for its own
 * bundled browser. `--channel chrome`/`--channel msedge` drives the same
 * already-installed system browser as everywhere else in this extension
 * (see chromeFinder.ts); Playwright's browser-download step is disabled at
 * install time for this whole project (see .npmrc), so nothing is ever
 * fetched at runtime, in keeping with the bank-environment constraint that
 * a Chromium/Firefox/WebKit binary is never downloaded.
 */
export class CodegenManager implements vscode.Disposable {
  private child: ChildProcess | undefined;
  private outputFile: string | undefined;
  private pollTimer: ReturnType<typeof setInterval> | undefined;
  private lastFileContent = '';

  private status: CodegenStatus = { state: 'idle' };

  private readonly statusEmitter = new vscode.EventEmitter<CodegenStatus>();
  readonly onStatusChange = this.statusEmitter.event;

  private readonly codeEmitter = new vscode.EventEmitter<string>();
  /** Fires the raw file content verbatim every time `codegen` writes a new
   * version of it — no processing, no reformatting; this is deliberately
   * "as-is" per the feature's whole point. */
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
   * it (same Windows/macOS/Linux "kill the parent, the OS's job-object/
   * process-group cleanup takes the children too" mechanism verified for
   * BrowserManager's own launched Chrome/Edge process). */
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
        this.codeEmitter.fire(content);
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

/** Mirrors browserManager.ts's own normalizeUrl() — a bare host/path typed
 * without a scheme is assumed to be https://, same as everywhere else in
 * this extension a URL is accepted from the user. */
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
