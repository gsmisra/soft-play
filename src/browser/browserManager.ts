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

export type RecordedActionType = 'click' | 'fill' | 'selectOption' | 'check' | 'uncheck' | 'press' | 'navigate';

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
  // Every page/tab/popup we've installed the agent on — Object Spy and
  // Generate Code work in ANY of them (a new tab opened by a link or
  // window.open() is otherwise invisible to the extension entirely, since
  // Playwright's exposeFunction()/addInitScript() are bound per-Page, not
  // per-BrowserContext). `this.page` itself stays the single "primary" tab
  // for Start/Stop/Navigate/Highlight On Page/title tracking — this set is
  // only for broadcasting spy/recording state and wiring up reporting.
  private readonly pages = new Set<import('playwright-core').Page>();
  // The page agent script AND the "desired state" it reads on startup (see
  // pageAgent.js's `__desired` handling) are registered TOGETHER as a single
  // addInitScript at the BROWSER CONTEXT level — see
  // applyCombinedInitScript() for why both of those choices matter: (1)
  // context-level, not per-page, so Chrome applies it to every future
  // page/tab/popup from its very first document with no async race against
  // that page's own navigation, confirmed against a real fast-redirect
  // timing test where a per-page addInitScript call still lost that race;
  // (2) bundled into ONE script, not two, because addInitScript has no way
  // to insert a replacement in the middle of an existing registration
  // order — a separate "state" script re-registered after the "main" one
  // was already added always ends up running AFTER it, even though the
  // main script needs to read the state that the state script sets. Baking
  // both into one script generated fresh on every state change sidesteps
  // that entirely. This Disposable is the currently-registered copy; kept
  // so it can be replaced (not stacked) whenever state changes.
  private combinedInitScript: import('playwright-core').Disposable | undefined;

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
  // True only while an ambiguous locator is awaiting resolution in the
  // panel — see setRecordingPaused(). Deliberately NOT the same as flipping
  // `recording` off: doing that used to fall back to Object Spy's own
  // click-blocking capture mode for the click that triggered the pause and
  // every click after it until the user resolved the banner, since
  // `spyEnabled` is never cleared just because recording paused (see
  // setRecording() below) — a real bug where a real link/button click
  // would get captured but never actually navigate. Pausing must keep
  // clicks passing through exactly like active recording does; it only
  // suppresses reporting NEW actions while paused.
  private recordingPaused = false;
  // The last URL a navigate action was actually recorded for — the single
  // source of truth all three navigate-capture paths (session start,
  // explicit Navigate button, and typing directly into the real browser's
  // own address bar) dedupe against, so e.g. resuming a paused session
  // without navigating anywhere new never re-emits a duplicate step for the
  // same URL. See setRecording(), navigate(), and the 'load' handler in
  // installPageAgent().
  private lastRecordedNavigateUrl = '';
  // Timestamp of the last action (click/fill/.../press) reported from ANY
  // page — used to tell "the user just typed a new URL into the real
  // browser's address bar" apart from "this navigation is the side effect
  // of the action we just recorded" (e.g. clicking a link, or pressing
  // Enter to submit a search) when a full page load fires. Heuristic, not
  // exact: a page that takes a very long time to navigate after a click
  // could still get one redundant (harmless) extra navigate() step; see the
  // 'load' handler in installPageAgent() for the window this guards.
  private lastReportedActionAt = 0;
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
   * Toggles Object Spy hover-highlight + click-to-capture — in every tab,
   * not just the primary one. Safe to call before a page exists — the
   * state is applied as soon as one is.
   */
  async setSpyEnabled(enabled: boolean): Promise<void> {
    this.spyEnabled = enabled;
    await this.applySpyState();
  }

  async setLocatorType(type: LocatorType): Promise<void> {
    this.locatorType = type;
    await this.applySpyState();
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
    } else {
      // Stopping the whole session (as opposed to a transient ambiguity
      // pause) also clears any leftover pause state.
      this.recordingPaused = false;
    }
    await this.applySpyState();

    // Capture the page's current URL as the flow's opening navigation —
    // otherwise a generated test that never navigates anywhere is
    // unrunnable. Explicit/typed mid-session navigations are captured
    // separately, in navigate() and installPageAgent()'s 'load' handler.
    if (enabled && this.page) {
      this.recordNavigateIfNew(this.page.url());
    }
  }

  /** Fires a navigate action for `url`, unless it's blank or the same URL
   * the last navigate action already recorded — the single dedup point for
   * all three ways a navigation gets captured (see `lastRecordedNavigateUrl`). */
  private recordNavigateIfNew(url: string): void {
    if (!url || url === 'about:blank' || url === this.lastRecordedNavigateUrl) {
      return;
    }
    this.lastRecordedNavigateUrl = url;
    this.actionEmitter.fire(this.buildNavigateAction(url));
  }

  /** Pauses/resumes reporting NEW actions while an ambiguous locator awaits
   * resolution in the panel — deliberately distinct from setRecording(),
   * which also controls whether clicks get blocked (see the field comment
   * on `recordingPaused` for the bug this separation fixes). */
  async setRecordingPaused(paused: boolean): Promise<void> {
    this.recordingPaused = paused;
    await this.applySpyState();
  }

  private buildNavigateAction(url: string): RecordedActionEvent {
    // A navigation isn't tied to any DOM element, so most CapturedElement
    // fields are meaningless placeholders here — objectSpyPanel.ts special-
    // cases actionType 'navigate' to skip the Elements table/ambiguity-check
    // paths that would otherwise try to use them.
    return {
      actionType: 'navigate',
      tag: '',
      text: url,
      elementName: 'navigate',
      locatorType: this.locatorType,
      locator: '',
      tier: 'css',
      qualityLabel: 'Excellent · Unique',
      matches: 1,
      inIframe: false,
      inShadowDom: false,
      value: url
    };
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

      // Register the agent script (with the current desired state baked in)
      // at the CONTEXT level before anything else touches a page — see the
      // `combinedInitScript` field comment for why this must be one script,
      // not two, and why context-level rather than per-page. This is what
      // guarantees a brand-new tab/window/popup (including one several hops
      // into a fast redirect chain, like a real sign-in flow) starts in the
      // correct enabled/recording state from its very first document,
      // instead of racing a per-page setup call against that page's own
      // navigation.
      await this.applyCombinedInitScript();

      // Object Spy/Generate Code must work in EVERY tab, not just the first
      // one — a new tab or window (a link with target="_blank", a
      // window.open() call, Gmail/most real sites do this constantly) is
      // otherwise a page our extension never even sees. Cover any tabs that
      // were already open when we attached, and any opened later.
      // installPageAgent() itself guards against double-installing on a
      // page it's already seen, so registering this before vs. after the
      // pages-that-already-exist loop below can't race or double-bind.
      this.context.on('page', (newPage) => {
        void this.installPageAgent(newPage).catch(() => undefined);
      });

      const pages = this.context.pages();
      this.page = pages[0] ?? (await this.context.newPage());
      for (const existingPage of this.context.pages()) {
        await this.installPageAgent(existingPage);
      }

      browser.on('disconnected', () => {
        this.log('Chrome disconnected.');
        this.browser = undefined;
        this.context = undefined;
        this.page = undefined;
        this.pages.clear();
        this.combinedInitScript = undefined;
        this.spyEnabled = false;
        this.recording = false;
        this.recordingPaused = false;
        this.lastRecordedNavigateUrl = '';
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

    // An explicit, deliberate navigation via this method (the Navigate
    // button) during an active Generate Code session gets its own step —
    // e.g. testing a flow that starts by typing a second URL mid-recording.
    if (this.recording) {
      this.recordNavigateIfNew(this.page.url());
    }
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
      this.pages.clear();
      this.combinedInitScript = undefined;
      this.launchedProcess = undefined;
      this.spyEnabled = false;
      this.recording = false;
      this.recordingPaused = false;
      this.lastRecordedNavigateUrl = '';
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
    if (this.pages.has(page)) {
      return; // already installed -- exposeFunction() throws if bound twice on the same page
    }
    this.pages.add(page);
    page.once('close', () => this.pages.delete(page));

    // Registered BEFORE any `await` below, synchronously, so a real
    // navigation that's already racing ahead in this brand-new tab (Chrome
    // opens the tab and starts loading its target URL immediately for a
    // real <a target="_blank"> link — unlike a plain window.open('about:
    // blank')) can never fire its 'framenavigated'/'load' event before we're
    // listening for it. Everything after the first `await` in an async
    // function only runs once that await resolves, so writing these two
    // page.on() calls any later would leave exactly that gap.
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
      // covers the Navigate button/initial start URL. Only the primary tab
      // names the generated class, though — a background tab's title
      // shouldn't override it.
      if (frame === page.mainFrame() && page === this.page) {
        this.refreshPageTitle(page);
      }
    });
    // 'load' fires once the full navigation (and its subresources) settle —
    // a more reliable moment to read <title> than right after
    // framenavigated, when a client-rendered page's JS may not have set it
    // yet. framenavigated's own refresh above still covers same-document
    // (pushState) SPA route changes, where 'load' never fires again. Also
    // where a navigation typed directly into the real browser's own address
    // bar gets captured as a step — see recordNavigateIfNew() and the
    // `lastReportedActionAt` comment above for how a click/press-triggered
    // navigation avoids getting a redundant extra step here.
    page.on('load', () => {
      if (page === this.page) {
        this.refreshPageTitle(page);
      }
      if (this.recording && !this.recordingPaused && Date.now() - this.lastReportedActionAt > 2000) {
        this.recordNavigateIfNew(page.url());
      }
    });

    // The main agent script and its desired-state seed are registered at
    // the browser CONTEXT level (see start() and applyCombinedInitScript())
    // — not here — precisely so they're already active for this page before
    // this function even starts running, no matter how fast its navigation
    // is. All that's left to do per-page is exposeFunction (Playwright has
    // no context-level equivalent) and the live evaluate() safety net below
    // for whatever document is *already* loaded on a pre-existing page.
    await page.exposeFunction('__objectSpyCapture', (info: CapturedElement) => {
      this.captureEmitter.fire(info);
    });
    await page.exposeFunction('__objectSpyAction', (info: RecordedActionEvent) => {
      // Tracked for the 'load' handler above, to tell "the user just typed
      // a new URL into the address bar" apart from "this navigation is the
      // side effect of the action just recorded".
      this.lastReportedActionAt = Date.now();
      this.actionEmitter.fire(info);
    });

    await this.injectIntoAllFrames(page);
  }

  /** (Re-)registers the CONTEXT-level addInitScript that seeds
   * window.__objectSpyDesiredState and then runs the page agent itself —
   * see the `combinedInitScript` field comment for why the state seed and
   * the agent script must be ONE script, generated fresh every time state
   * changes, rather than two separately-registered ones (whichever was
   * registered first always runs first for every future document — fine
   * for the one-time initial registration, but wrong forever after the
   * first state change once the agent script already "holds" the later
   * position). Registered at the browser-context level, not per-page,
   * specifically so it's active for a brand-new tab/window from the instant
   * Chrome creates it, with no async setup call of ours to race against
   * that page's own navigation — a per-page version of this (an earlier
   * iteration of this fix) was confirmed via a real timing test to still
   * lose that race for a fast redirect chain. Disposes the previous copy
   * first (addInitScript has no "replace" — each call adds one more), so a
   * long session doesn't accumulate one script per toggle for the life of
   * the context. */
  private async applyCombinedInitScript(): Promise<void> {
    if (!this.context) {
      return;
    }
    const previous = this.combinedInitScript;
    const state = {
      locatorType: this.locatorType,
      enabled: this.spyEnabled,
      recording: this.recording,
      recordingPaused: this.recordingPaused
    };
    try {
      this.combinedInitScript = await this.context.addInitScript(
        (params) => {
          (globalThis as any).__objectSpyDesiredState = params.state;
          // eslint-disable-next-line no-new-func -- running our own trusted
          // agent script text, not user input; Function avoids a literal
          // `eval` call while doing the same thing.
          new Function(params.script)();
        },
        { state, script: PAGE_AGENT_SCRIPT }
      );
    } catch {
      // Context closed mid-call — nothing to recover from.
      return;
    }
    if (previous) {
      await previous.dispose().catch(() => undefined);
    }
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
          (globalThis as any).__objectSpySetRecordingPaused?.(state.recordingPaused);
        },
        {
          locatorType: this.locatorType,
          enabled: this.spyEnabled,
          recording: this.recording,
          recordingPaused: this.recordingPaused
        }
      )
      .catch(() => undefined);
  }

  /** Broadcasts current locatorType/spyEnabled/recording/recordingPaused to
   * every tracked page (and every frame within each) — not just the primary
   * tab, so a new tab or window is never silently left out. */
  private async applySpyState(): Promise<void> {
    // Live-apply to whatever's currently loaded in every tracked page
    // (instant feedback in the tab you're looking at right now)...
    for (const page of this.pages) {
      for (const frame of page.frames()) {
        await this.applyStateToFrame(frame);
      }
    }
    // ...and persist it, once, at the context level for whatever any page
    // navigates to NEXT (including a tab that doesn't even exist yet) — a
    // toggle made while a redirect chain is mid-flight still takes effect
    // the instant that next document is created, rather than only once a
    // live evaluate() call gets a chance to catch up with it.
    await this.applyCombinedInitScript();
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
