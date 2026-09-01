import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { spawn, ChildProcess } from 'child_process';
import { findChromeExecutable, defaultUserDataDir, BrowserChannel } from './chromeFinder';

export type { BrowserChannel };

export type BrowserStatus =
  | { state: 'idle' }
  | { state: 'connecting'; detail?: string }
  | { state: 'connected'; url: string }
  | { state: 'error'; message: string };

export type LocatorType = 'css' | 'xpath';

export interface CapturedElement {
  tag: string;
  text: string;
  /** Short camelCase name derived from visible text/a stable attribute/tag — see agent/pageAgent.js elementNameFor(). */
  elementName: string;
  locatorType: LocatorType;
  locator: string;
  tier: 'testid' | 'id' | 'aria' | 'css' | 'sibling' | 'index' | 'xpath';
  qualityLabel: string;
  matches: number;
  inIframe: boolean;
  inShadowDom: boolean;
}

export type RecordedActionType = 'click' | 'fill' | 'selectOption' | 'check' | 'uncheck' | 'press';

export interface RecordedActionEvent extends CapturedElement {
  actionType: RecordedActionType;
  value?: string;
  /** True for a click on an <a>, a submit button, or an input[type=submit|button] —
   * the code generator uses this to add a settle/navigation wait after the step. */
  submitLike?: boolean;
}

// Read once at module load — this is the script injected into the real
// Chrome page (see agent/pageAgent.js for the full implementation and
// rationale). It lives outside src/ deliberately: .vscodeignore excludes
// src/**/*.ts from the packaged extension, but this file must ship as-is
// since it is evaluated verbatim inside the target page, not compiled.
const PAGE_AGENT_SCRIPT = fs.readFileSync(
  path.join(__dirname, '..', '..', 'agent', 'pageAgent.js'),
  'utf8'
);

/**
 * Owns the CDP-attached Chrome session for the extension.
 *
 * Architecture (see project doc "Master Build Prompt", section 2): we never render
 * target sites inside a VS Code webview iframe — real banking sites send
 * X-Frame-Options/CSP headers that would silently block that. Instead we drive a
 * real, visible Chrome window over the Chrome DevTools Protocol:
 *   1. Try to attach to an already-running, debug-enabled Chrome on the configured
 *      port (http://localhost:<port>/json/version).
 *   2. If none is found, launch a new Chrome process ourselves with
 *      --remote-debugging-port=<port>, then attach.
 * Either way, once attached, playwright-core drives the page identically.
 *
 * The debug port is always bound to localhost/127.0.0.1 — never expose it more
 * broadly. Anything with access to it has full control of the browser session,
 * which matters in a bank environment.
 */
export class BrowserManager implements vscode.Disposable {
  // playwright-core types are loaded dynamically (see start()) so the extension
  // host doesn't pay the require() cost until the user actually clicks Start.
  private browser: import('playwright-core').Browser | undefined;
  private context: import('playwright-core').BrowserContext | undefined;
  private page: import('playwright-core').Page | undefined;

  // Only set when *we* spawned the Chrome process — we must never kill a Chrome
  // window the user already had running before we attached to it.
  private launchedProcess: ChildProcess | undefined;

  private readonly statusEmitter = new vscode.EventEmitter<BrowserStatus>();
  readonly onStatusChange = this.statusEmitter.event;

  private readonly logEmitter = new vscode.EventEmitter<string>();
  readonly onLog = this.logEmitter.event;

  private readonly captureEmitter = new vscode.EventEmitter<CapturedElement>();
  readonly onCapture = this.captureEmitter.event;

  private readonly actionEmitter = new vscode.EventEmitter<RecordedActionEvent>();
  readonly onAction = this.actionEmitter.event;

  private status: BrowserStatus = { state: 'idle' };
  private spyEnabled = false;
  private recording = false;
  // Matches SettingsStore's own default — ObjectSpyPanel always pushes the
  // real value in via setLocatorType() at construction anyway, but this
  // keeps BrowserManager sensible if ever used standalone.
  private locatorType: LocatorType = 'xpath';
  private lastPageTitle = '';
  // Matches SettingsStore's own default. Chrome/Edge only — this extension
  // never downloads or bundles a browser of its own (see chromeFinder.ts).
  private browserChannel: BrowserChannel = 'chrome';

  setBrowserChannel(channel: BrowserChannel): void {
    this.browserChannel = channel;
  }

  getStatus(): BrowserStatus {
    return this.status;
  }

  isSpyEnabled(): boolean {
    return this.spyEnabled;
  }

  /**
   * Toggles Object Spy hover-highlight + click-to-capture in the page. Safe
   * to call before a page exists — the state is applied as soon as one is.
   */
  async setSpyEnabled(enabled: boolean): Promise<void> {
    this.spyEnabled = enabled;
    if (this.page) {
      await this.page
        .evaluate((e) => (globalThis as any).__objectSpySetEnabled?.(e), enabled)
        .catch(() => undefined);
    }
  }

  async setLocatorType(type: LocatorType): Promise<void> {
    this.locatorType = type;
    if (this.page) {
      await this.page
        .evaluate((cfg) => (globalThis as any).__objectSpySetConfig?.(cfg), { locatorType: type })
        .catch(() => undefined);
    }
  }

  isRecording(): boolean {
    return this.recording;
  }

  /**
   * Toggles Generate Code's action recorder. Per the Master Build Prompt
   * (§3.7), Generate Code auto-enables Object Spy — but unlike the click-to-
   * capture flow, recording must never block the click: the real app has to
   * actually navigate/submit/etc. so the recorded flow matches what really
   * happened (see agent/pageAgent.js onClick).
   */
  async setRecording(enabled: boolean): Promise<void> {
    this.recording = enabled;
    if (enabled) {
      this.spyEnabled = true;
    }
    if (this.page) {
      await this.page
        .evaluate(
          (state) => {
            (globalThis as any).__objectSpySetEnabled?.(state.spyEnabled);
            (globalThis as any).__objectSpySetRecording?.(state.recording);
          },
          { spyEnabled: this.spyEnabled, recording: enabled }
        )
        .catch(() => undefined);
    }
  }

  /**
   * Re-verifies a (possibly user-edited) locator against the live DOM —
   * used when resolving an ambiguous (count > 1) capture in Generate Code
   * mode, so the panel can confirm a fix actually reached uniqueness before
   * resuming recording.
   *
   * KNOWN LIMITATION: this always checks the main frame. An action recorded
   * inside an iframe (fully supported for capture/hover — see
   * installPageAgent) is still verified/generated as a bare page.locator(),
   * not wrapped in page.frameLocator(iframeSelector). Actions don't yet
   * carry which frame they came from, so a recording that touches an
   * iframe's contents will need that wrapping added by hand before the
   * generated code will find the element. Tracked as follow-up work.
   */
  async verifyLocatorCount(locatorType: LocatorType, locator: string): Promise<number> {
    if (!this.page) {
      return -1;
    }
    return this.page
      .evaluate(
        ({ type, loc }) => {
          const doc: any = (globalThis as any).document;
          try {
            if (type === 'xpath') {
              const result = doc.evaluate(loc, doc, null, 7 /* XPathResult.ORDERED_NODE_SNAPSHOT_TYPE */, null);
              return result.snapshotLength;
            }
            return doc.querySelectorAll(loc).length;
          } catch {
            return -1;
          }
        },
        { type: locatorType, loc: locator }
      )
      .catch(() => -1);
  }

  getPage(): import('playwright-core').Page | undefined {
    return this.page;
  }

  /**
   * "Highlight On Page" — brings the real Chrome tab to the front and asks
   * the page agent to flash a blinking red box around the first element the
   * given locator matches. Returns false when the browser isn't connected
   * or the locator matches nothing on the current page (e.g. the element
   * was captured on a page you've since navigated away from).
   */
  async highlightElement(locatorType: LocatorType, locator: string): Promise<boolean> {
    if (!this.page) {
      return false;
    }
    await this.page.bringToFront().catch(() => undefined);
    return this.page
      .evaluate(
        ({ type, loc }) => (globalThis as any).__objectSpyFlashHighlight?.(type, loc) ?? false,
        { type: locatorType, loc: locator }
      )
      .catch(() => false);
  }

  /** Best-effort title of the page last navigated to — used to name the
   * generated Page Object/test class (see codeGenerator.ts) instead of a
   * generic "GeneratedPage". Empty string if unavailable. */
  getPageTitle(): string {
    return this.lastPageTitle;
  }

  async start(): Promise<void> {
    if (this.status.state === 'connected') {
      this.log('Already connected.');
      return;
    }

    const config = vscode.workspace.getConfiguration('objectSpy');
    const port = config.get<number>('cdpPort', 9222);
    const configuredExecutable = config.get<string>('chromeExecutablePath', '').trim();
    const useRealProfile = config.get<boolean>('useRealChromeProfile', false);
    const configuredUserDataDir = config.get<string>('userDataDir', '').trim();
    const startUrl = config.get<string>('startUrl', 'about:blank') || 'about:blank';
    // Note: locatorType is intentionally NOT read from vscode workspace
    // config here — it's owned by SettingsStore (context.globalState, via
    // the Settings panel) and pushed in through setLocatorType(). this.locatorType
    // already carries whatever was last set, defaulting to 'css'.

    this.setStatus({ state: 'connecting', detail: 'Checking for an existing Chrome debug session…' });

    try {
      // Playwright's public API names this browser-type object "chromium"
      // because it's the umbrella driver for every Chromium-based browser —
      // Chrome and Edge included, not just the open-source Chromium browser.
      // Aliased here so that name doesn't otherwise appear in our source:
      // we only ever use it to connectOverCDP() into a real Chrome/Edge
      // process we found or launched ourselves — never to download or
      // launch a bundled browser of its own.
      const { chromium: cdpBrowserType } = await import('playwright-core');

      let connected = await this.tryConnectExisting(cdpBrowserType, port, false);

      if (!connected) {
        this.setStatus({ state: 'connecting', detail: `Launching ${this.browserChannel === 'edge' ? 'Edge' : 'Chrome'}…` });
        const executable = configuredExecutable || findChromeExecutable(this.browserChannel);
        if (!executable) {
          throw new Error(
            'Could not find a Chrome/Edge installation. Set "objectSpy.chromeExecutablePath" in Settings.'
          );
        }
        const userDataDir = configuredUserDataDir || defaultUserDataDir(useRealProfile, this.browserChannel);
        await this.launchChrome(executable, port, userDataDir);
        connected = await this.tryConnectExisting(cdpBrowserType, port, true);
        if (!connected) {
          throw new Error(
            `Launched Chrome but could not attach to the CDP endpoint on port ${port}. ` +
              'If "Use Real Chrome Profile" is on, note that recent Chrome versions block ' +
              'remote debugging on the live default profile directory — try a dedicated profile instead.'
          );
        }
      }

      const browser = this.browser;
      if (!browser) {
        throw new Error('Internal error: no browser after a successful connect.');
      }

      const contexts = browser.contexts();
      this.context = contexts[0] ?? (await browser.newContext());
      const pages = this.context.pages();
      this.page = pages[0] ?? (await this.context.newPage());

      await this.installPageAgent(this.page);

      browser.on('disconnected', () => {
        this.log('Chrome disconnected.');
        this.browser = undefined;
        this.context = undefined;
        this.page = undefined;
        this.spyEnabled = false;
        this.recording = false;
        this.setStatus({ state: 'idle' });
      });

      if (startUrl) {
        await this.navigate(startUrl);
      } else {
        this.setStatus({ state: 'connected', url: this.page.url() });
      }
    } catch (err) {
      const message = describeError(err);
      this.setStatus({ state: 'error', message });
      throw err;
    }
  }

  async navigate(rawUrl: string): Promise<void> {
    if (!this.page) {
      await this.start();
    }
    if (!this.page) {
      throw new Error('No active browser page to navigate.');
    }
    const url = normalizeUrl(rawUrl);
    this.log(`Navigating to ${url}`);
    await this.page.goto(url, { waitUntil: 'domcontentloaded' });
    this.lastPageTitle = await this.page.title().catch(() => '');
    this.setStatus({ state: 'connected', url: this.page.url() });
  }

  async stop(): Promise<void> {
    try {
      if (this.browser) {
        // For a CDP-attached browser, close() disconnects the Playwright client;
        // it does not by itself guarantee the OS process exits, which is why we
        // separately kill launchedProcess below when we own it.
        await this.browser.close();
      }
    } catch (err) {
      this.log(`Error while closing the browser connection: ${describeError(err)}`);
    } finally {
      if (this.launchedProcess && !this.launchedProcess.killed) {
        this.launchedProcess.kill();
      }
      this.browser = undefined;
      this.context = undefined;
      this.page = undefined;
      this.launchedProcess = undefined;
      this.spyEnabled = false;
      this.recording = false;
      this.setStatus({ state: 'idle' });
    }
  }

  /**
   * "Kill All Browser Instances" — closes the CDP connection and, if this
   * extension itself launched the Chrome process, kills it. Scope note:
   * this can only reliably target a process THIS extension spawned
   * (tracked via `launchedProcess`); it deliberately never scans the OS for
   * other `chrome.exe` processes to kill, since that could just as easily
   * kill the user's own everyday browsing Chrome — an unacceptably
   * destructive side effect for a "clear my automation session" button. If
   * you attached to an already-running Chrome instead of launching one,
   * that Chrome is left running, exactly like a plain Stop.
   */
  async killAllAndClear(): Promise<void> {
    await this.stop();
  }

  dispose(): void {
    void this.stop();
    this.statusEmitter.dispose();
    this.logEmitter.dispose();
    this.captureEmitter.dispose();
    this.actionEmitter.dispose();
  }

  /**
   * Installs the Object Spy page agent (agent/pageAgent.js) on a freshly
   * attached page, and every frame in it — including cross-origin iframes.
   * Playwright's exposeFunction/addInitScript already operate per-frame on
   * their own (per Playwright's docs: exposeFunction binds on every frame's
   * window, and addInitScript re-runs for every frame attach/navigation),
   * and — crucially — via CDP rather than in-page script, so the DOM's
   * same-origin policy that would normally block reaching into a
   * cross-origin iframe never applies here. This matters for real banking
   * pages, which commonly embed cross-origin iframes (payment widgets,
   * SSO/2FA frames, etc.) that Object Spy still needs to be able to inspect.
   *
   *   1. exposeFunction so the in-page script can report captured elements
   *      / actions back to the extension host — bound once per Page.
   *   2. addInitScript so the agent re-runs in every future frame document.
   *   3. An immediate evaluate() in every *existing* frame as a safety net —
   *      addInitScript only affects documents loaded after it's registered,
   *      so a page (or iframe) we attached to mid-session needs this too.
   *   4. A framenavigated listener (fires for ANY frame, not just main) that
   *      re-applies current spy/config/recording state, covering
   *      same-document (SPA) navigations where a fresh reload — and
   *      therefore addInitScript — never happens.
   */
  private async installPageAgent(page: import('playwright-core').Page): Promise<void> {
    await page.exposeFunction('__objectSpyCapture', (info: CapturedElement) => {
      this.captureEmitter.fire(info);
    });
    await page.exposeFunction('__objectSpyAction', (info: RecordedActionEvent) => {
      this.actionEmitter.fire(info);
    });

    await page.addInitScript({ content: PAGE_AGENT_SCRIPT });
    await this.injectIntoAllFrames(page);

    page.on('framenavigated', async (frame) => {
      try {
        await frame.evaluate(PAGE_AGENT_SCRIPT);
        await this.applyStateToFrame(frame);
      } catch {
        // Navigated to a new document mid-check, a frame that refuses
        // script injection (e.g. chrome://), or one that detached before
        // this ran — nothing to recover from here.
      }
      // Keep the class-naming title (see getPageTitle()) current no matter
      // HOW the user got to a new page — clicking a link or submitting a
      // form in the real Chrome window (the normal way this extension gets
      // used) never goes through our own navigate() method, which only
      // covers the Navigate button/initial start URL.
      if (frame === page.mainFrame()) {
        this.refreshPageTitle(page);
      }
    });
    // 'load' fires once the full navigation (and its subresources) settle —
    // a more reliable moment to read <title> than right after
    // framenavigated, when a client-rendered page's JS may not have set it
    // yet. framenavigated's own refresh above still covers same-document
    // (pushState) SPA route changes, where 'load' never fires again.
    page.on('load', () => this.refreshPageTitle(page));
  }

  private refreshPageTitle(page: import('playwright-core').Page): void {
    void page
      .title()
      .then((title) => {
        this.lastPageTitle = title;
      })
      .catch(() => undefined);
  }

  private async injectIntoAllFrames(page: import('playwright-core').Page): Promise<void> {
    for (const frame of page.frames()) {
      try {
        await frame.evaluate(PAGE_AGENT_SCRIPT);
        await this.applyStateToFrame(frame);
      } catch {
        // A detached frame, or one (e.g. about:blank placeholders) that
        // refuses script injection — skip it, nothing to recover from.
      }
    }
  }

  private async applyStateToFrame(frame: import('playwright-core').Frame): Promise<void> {
    await frame
      .evaluate(
        (state) => {
          (globalThis as any).__objectSpySetConfig?.({ locatorType: state.locatorType });
          (globalThis as any).__objectSpySetEnabled?.(state.enabled);
          (globalThis as any).__objectSpySetRecording?.(state.recording);
        },
        { locatorType: this.locatorType, enabled: this.spyEnabled, recording: this.recording }
      )
      .catch(() => undefined);
  }

  private async applySpyState(): Promise<void> {
    if (!this.page) {
      return;
    }
    for (const frame of this.page.frames()) {
      await this.applyStateToFrame(frame);
    }
  }

  private async tryConnectExisting(
    cdpBrowserType: typeof import('playwright-core').chromium,
    port: number,
    retryUntilTimeout: boolean
  ): Promise<boolean> {
    const endpoint = `http://localhost:${port}`;
    const deadline = Date.now() + (retryUntilTimeout ? 15000 : 1200);

    do {
      try {
        const reachable = await pingCdpEndpoint(endpoint);
        if (reachable) {
          this.browser = await cdpBrowserType.connectOverCDP(endpoint);
          this.log(`Attached to Chrome on ${endpoint}.`);
          return true;
        }
      } catch (err) {
        if (!retryUntilTimeout) {
          return false;
        }
        this.log(`Waiting for Chrome debug endpoint on port ${port}… (${describeError(err)})`);
      }
      if (retryUntilTimeout) {
        await delay(400);
      }
    } while (retryUntilTimeout && Date.now() < deadline);

    return false;
  }

  private async launchChrome(executable: string, port: number, userDataDir: string): Promise<void> {
    this.log(`Launching Chrome at "${executable}" (port ${port}, profile "${userDataDir}")`);
    const args = [
      `--remote-debugging-port=${port}`,
      '--remote-debugging-address=127.0.0.1',
      `--user-data-dir=${userDataDir}`,
      '--no-first-run',
      '--no-default-browser-check'
    ];
    const child = spawn(executable, args, {
      detached: true,
      stdio: 'ignore'
    });
    child.unref();
    this.launchedProcess = child;
  }

  private setStatus(status: BrowserStatus): void {
    this.status = status;
    this.statusEmitter.fire(status);
  }

  private log(message: string): void {
    this.logEmitter.fire(message);
  }
}

async function pingCdpEndpoint(endpoint: string): Promise<boolean> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 1000);
  try {
    const res = await fetch(`${endpoint}/json/version`, { signal: controller.signal });
    return res.ok;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function normalizeUrl(input: string): string {
  const trimmed = input.trim();
  if (trimmed === 'about:blank' || /^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(trimmed)) {
    return trimmed;
  }
  return `https://${trimmed}`;
}

function describeError(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
