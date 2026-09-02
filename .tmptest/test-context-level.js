const path = require('path');
const fs = require('fs');
const { chromium } = require('playwright-core');
const { findChromeExecutable } = require(path.join(__dirname, '..', 'out', 'browser', 'chromeFinder.js'));
const AGENT_SCRIPT = fs.readFileSync(path.join(__dirname, '..', 'agent', 'pageAgent.js'), 'utf8');

// Mirrors the REAL, current browserManager.ts architecture: main script +
// desired-state seed registered ONCE at the browser-context level (zero
// race with any page's navigation, no matter how fast), exposeFunction
// still per-page (unavoidable — Playwright has no context-level version).
(async () => {
  const executable = findChromeExecutable();
  const browser = await chromium.launch({ executablePath: executable, headless: true });
  const context = await browser.newContext();

  const pages = new Set();
  const captures = [];
  let combinedInitScript;
  let spyEnabled = true, recording = false, recordingPaused = false;

  async function applyCombinedInitScript() {
    const previous = combinedInitScript;
    const state = { locatorType: 'css', enabled: spyEnabled, recording, recordingPaused };
    combinedInitScript = await context.addInitScript(
      (params) => {
        globalThis.__objectSpyDesiredState = params.state;
        new Function(params.script)();
      },
      { state, script: AGENT_SCRIPT }
    );
    if (previous) await previous.dispose().catch(() => undefined);
  }

  await applyCombinedInitScript();

  async function installPageAgent(p) {
    if (pages.has(p)) return;
    pages.add(p);
    p.on('framenavigated', async (frame) => { try { await frame.evaluate(AGENT_SCRIPT); } catch {} });
    await p.exposeFunction('__objectSpyCapture', (info) => captures.push(Object.assign({ from: 'capture' }, info)));
    await p.exposeFunction('__objectSpyAction', (info) => captures.push(Object.assign({ from: 'action' }, info)));
    for (const frame of p.frames()) {
      try { await frame.evaluate(AGENT_SCRIPT); } catch {}
    }
  }

  context.on('page', (newPage) => { void installPageAgent(newPage); });

  const page = await context.newPage();
  await installPageAgent(page);

  // Zero artificial delay — the exact scenario that broke the per-page
  // addInitScript approach.
  await context.route('https://example.test/**', (route) =>
    route.fulfill({ contentType: 'text/html', body: '<html><body><button data-testid="btn">In new tab</button></body></html>' })
  );

  await page.setContent('<a id="opener" target="_blank" href="https://example.test/newtab">Open link</a>');
  await page.evaluate(() => window.__objectSpySetRecording(true));
  recording = true;
  await applyCombinedInitScript(); // mirrors setRecording() calling applySpyState()

  const [newPage] = await Promise.all([context.waitForEvent('page'), page.click('#opener')]);
  console.log('popup url immediately:', newPage.url());
  console.log('popup desiredState immediately:', await newPage.evaluate(() => window.__objectSpyDesiredState).catch((e) => 'ERR:' + e.message));
  console.log('recording on new tab immediately:', await newPage.evaluate(() => window.__objectSpyRecording).catch((e) => 'ERR:' + e.message));

  await newPage.waitForURL('https://example.test/**').catch(() => {});
  console.log('popup url after waitForURL:', newPage.url());
  console.log('popup desiredState after nav:', await newPage.evaluate(() => window.__objectSpyDesiredState).catch((e) => 'ERR:' + e.message));
  console.log('recording after nav:', await newPage.evaluate(() => window.__objectSpyRecording).catch((e) => 'ERR:' + e.message));

  await newPage.click('[data-testid="btn"]');
  await newPage.waitForTimeout(150);

  console.log(JSON.stringify(captures, null, 2));
  const newTabCapture = captures.find((c) => c.locator === '[data-testid="btn"]');
  if (newTabCapture) {
    console.log('PASS: zero-delay new-tab capture worked with context-level init scripts.');
  } else {
    console.log('FAIL');
    process.exit(1);
  }
  await browser.close();
})().catch((e) => { console.error(e); process.exit(1); });
