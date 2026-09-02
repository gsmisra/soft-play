const { chromium } = require('playwright-core');
const path = require('path');
const { findChromeExecutable } = require(path.join(__dirname, '..', 'out', 'browser', 'chromeFinder.js'));

(async () => {
  const executable = findChromeExecutable();
  const browser = await chromium.launch({ executablePath: executable, headless: true });
  const context = await browser.newContext();

  let d1 = await context.addInitScript((s) => { globalThis.__x = s; }, { v: 1 });
  console.log('registered v1');

  const p1 = await context.newPage();
  await p1.goto('about:blank');
  console.log('p1 __x after v1:', await p1.evaluate(() => globalThis.__x));

  let d2 = await context.addInitScript((s) => { globalThis.__x = s; }, { v: 2 });
  await d1.dispose();
  console.log('disposed v1, registered v2');

  const p2 = await context.newPage();
  await p2.goto('about:blank');
  console.log('p2 __x after v2 (should be v:2):', await p2.evaluate(() => globalThis.__x));

  // Also test popup opened via window.open from p1 (already has __x=v1 baked
  // in from ITS OWN init script list at the time p1 was created -- does a
  // POPUP see p1's snapshot, or the context's CURRENT init script list?)
  const [popup] = await Promise.all([
    context.waitForEvent('page'),
    p1.evaluate(() => { window.open('about:blank', '_blank'); })
  ]);
  await popup.waitForLoadState('load').catch(() => {});
  console.log('popup-from-p1 __x (should be v:2 if context-level is live):', await popup.evaluate(() => globalThis.__x));

  await browser.close();
})().catch((e) => { console.error(e); process.exit(1); });
