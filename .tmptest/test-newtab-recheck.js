const path = require('path');
const fs = require('fs');
const { chromium } = require('playwright-core');
const { findChromeExecutable } = require(path.join(__dirname, '..', 'out', 'browser', 'chromeFinder.js'));
const AGENT_SCRIPT = fs.readFileSync(path.join(__dirname, '..', 'agent', 'pageAgent.js'), 'utf8');

(async () => {
  const executable = findChromeExecutable();
  const browser = await chromium.launch({ executablePath: executable, headless: true });
  const context = await browser.newContext();
  const page = await context.newPage();

  const pages = new Set();
  const stateInitScripts = new Map();
  const captures = [];
  let spyEnabled = true, recording = false;

  async function applyDesiredStateInitScript(p) {
    const previous = stateInitScripts.get(p);
    const state = { locatorType: 'css', enabled: spyEnabled, recording, recordingPaused: false };
    const disposable = await p.addInitScript((s) => { globalThis.__objectSpyDesiredState = s; }, state);
    stateInitScripts.set(p, disposable);
    if (previous) await previous.dispose().catch(() => undefined);
  }

  async function installPageAgent(p) {
    if (pages.has(p)) return;
    pages.add(p);
    p.on('framenavigated', async (frame) => { try { await frame.evaluate(AGENT_SCRIPT); } catch {} });
    await applyDesiredStateInitScript(p);
    await p.addInitScript({ content: AGENT_SCRIPT });
    await p.exposeFunction('__objectSpyCapture', (info) => captures.push(Object.assign({ from: 'capture' }, info)));
    await p.exposeFunction('__objectSpyAction', (info) => captures.push(Object.assign({ from: 'action' }, info)));
  }

  context.on('page', (newPage) => { void installPageAgent(newPage); });

  await context.route('https://example.test/**', (route) =>
    route.fulfill({ contentType: 'text/html', body: '<html><body><button data-testid="btn">In new tab</button></body></html>' })
  );

  await installPageAgent(page);
  await page.setContent('<a id="opener" target="_blank" href="https://example.test/newtab">Open link</a><button id="hereBtn" data-testid="here">Here</button>');
  await page.evaluate(AGENT_SCRIPT);
  await page.evaluate(() => window.__objectSpySetRecording(true));
  recording = true;

  console.log('--- capturing a click BEFORE opening the new tab, to confirm existing behavior still works ---');
  await page.click('#hereBtn');
  await page.waitForTimeout(50);

  console.log('--- opening new tab and capturing a click inside it ---');
  const [newPage] = await Promise.all([context.waitForEvent('page'), page.click('#opener')]);
  await newPage.waitForLoadState('load').catch(() => {});
  console.log('newPage url:', newPage.url()); console.log('recording on new tab:', await newPage.evaluate(() => window.__objectSpyRecording));
  console.log('installed on new tab:', await newPage.evaluate(() => window.__objectSpyInstalled));
  await newPage.click('[data-testid="btn"]');
  await newPage.waitForTimeout(150);

  console.log(JSON.stringify(captures, null, 2));
  const originalTabCapture = captures.find((c) => c.locator === '#hereBtn' || c.locator === '[data-testid="here"]');
  const newTabCapture = captures.find((c) => c.locator === '[data-testid="btn"]');
  if (originalTabCapture && newTabCapture) {
    console.log('PASS: both original-tab and new-tab captures worked.');
  } else {
    console.log('FAIL');
    process.exit(1);
  }
  await browser.close();
})().catch((e) => { console.error(e); process.exit(1); });
