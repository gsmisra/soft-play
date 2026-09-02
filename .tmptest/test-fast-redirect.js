const path = require('path');
const fs = require('fs');
const { chromium } = require('playwright-core');
const { findChromeExecutable } = require(path.join(__dirname, '..', 'out', 'browser', 'chromeFinder.js'));
const AGENT_SCRIPT = fs.readFileSync(path.join(__dirname, '..', 'agent', 'pageAgent.js'), 'utf8');

// Mirrors browserManager.ts's REAL installPageAgent()/applyDesiredStateInitScript()
// logic, to confirm state is seeded correctly even when a brand-new tab's
// real target navigation (with a mid-flight server redirect, like Google's
// sign-in chain) races ahead of our own async setup.
(async () => {
  const executable = findChromeExecutable();
  const browser = await chromium.launch({ executablePath: executable, headless: true });
  const context = await browser.newContext();
  const page = await context.newPage();

  const pages = new Set();
  const stateInitScripts = new Map();
  const captures = [];
  let spyEnabled = true;
  let recording = false;

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
    const t0 = Date.now();
    // Synchronous listener registration FIRST, matching the real fix.
    p.on('framenavigated', async (frame) => {
      try { await frame.evaluate(AGENT_SCRIPT); } catch {}
    });
    await applyDesiredStateInitScript(p);
    console.log('  [debug] desired-state addInitScript done at +' + (Date.now() - t0) + 'ms');
    await p.addInitScript({ content: AGENT_SCRIPT });
    console.log('  [debug] main addInitScript done at +' + (Date.now() - t0) + 'ms');
    await p.exposeFunction('__objectSpyCapture', (info) => captures.push(info));
    console.log('  [debug] exposeFunction x1 done at +' + (Date.now() - t0) + 'ms');
    await p.exposeFunction('__objectSpyAction', (info) => captures.push(info));
    console.log('  [debug] exposeFunction x2 done at +' + (Date.now() - t0) + 'ms');
  }

  context.on('page', (newPage) => {
    void installPageAgent(newPage);
  });

  // Simulate a rapid multi-hop redirect chain landing on the FINAL url —
  // fulfilled instantly (no real network latency) to maximize the chance of
  // racing ahead of our async setup, worst-case style.
  // A tiny bit of simulated network latency on each hop — a same-process
  // route.fulfill() with zero delay is unrealistically faster than any real
  // website (DNS/TLS/download/parse all take real time), so a completely
  // instant local mock isn't representative of the real Google redirect
  // chain this is modeling. 20-30ms per hop is still far faster than any
  // real page load, so this remains a stress test, not a softball.
  await context.route('https://step1.test/**', async (route) => {
    await new Promise((r) => setTimeout(r, 20));
    await route.fulfill({
      contentType: 'text/html',
      body: '<html><head><meta http-equiv="refresh" content="0;url=https://step2.test/final"></head><body>Redirecting…</body></html>'
    });
  });
  await context.route('https://step2.test/**', async (route) => {
    await new Promise((r) => setTimeout(r, 20));
    await route.fulfill({ contentType: 'text/html', body: '<html><body><button data-testid="btn">Click</button></body></html>' });
  });

  await installPageAgent(page);
  await page.setContent('<a id="opener" target="_blank" href="https://step1.test/start">Sign in</a>');
  await page.evaluate(AGENT_SCRIPT);
  // Recording mode on the ORIGINAL page — like a real Generate Code session
  // clicking a "Sign in" link — so the click isn't blocked (Object Spy's own
  // pure-capture mode intentionally blocks default actions, which would
  // prevent the link from opening a new tab at all; that's correct spy
  // behavior, not this bug).
  await page.evaluate(() => window.__objectSpySetRecording(true));
  recording = true; // keep the new page's seeded desired-state consistent

  const [newPage] = await Promise.all([context.waitForEvent('page'), page.click('#opener')]);
  newPage.on('framenavigated', (f) => {
    if (f === newPage.mainFrame()) console.log('  [debug] framenavigated ->', f.url());
  });
  await newPage.waitForURL('https://step1.test/**').catch((e) => console.log('  [debug] never saw step1:', e.message));
  console.log('  [debug] recording on step1 doc:', await newPage.evaluate(() => window.__objectSpyRecording).catch((e) => 'ERR:' + e.message));
  console.log('  [debug] desiredState on step1 doc:', await newPage.evaluate(() => window.__objectSpyDesiredState).catch((e) => 'ERR:' + e.message));
  await newPage.waitForLoadState('load').catch(() => {});
  await newPage.waitForTimeout(200);

  console.log('Landed on:', newPage.url());
  console.log('Recording state on final doc:', await newPage.evaluate(() => window.__objectSpyRecording));

  await newPage.click('[data-testid="btn"]');
  await newPage.waitForTimeout(150);

  console.log('Captured:', JSON.stringify(captures, null, 2));
  const buttonCapture = captures.find((c) => c.tag === 'button');
  if (newPage.url() === 'https://step2.test/final' && buttonCapture) {
    console.log('PASS: capture worked on the redirect-chain landing page.');
  } else {
    console.log('FAIL: capture did not happen on the correct landing page.');
    process.exit(1);
  }

  await browser.close();
})().catch((e) => { console.error(e); process.exit(1); });
