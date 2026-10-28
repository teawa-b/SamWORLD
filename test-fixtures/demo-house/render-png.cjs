// Rasterise the plan SVGs to PNG (1:1 pixel space) for model input.
// Usage: node test-fixtures/demo-house/render-png.cjs  (uses the preinstalled Playwright Chromium)
const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');
(async () => {
  // PLAYWRIGHT_CHROMIUM lets you point at a system Chromium if the bundled one is missing.
  const browser = await chromium.launch(process.env.PLAYWRIGHT_CHROMIUM ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM } : {});
  const page = await browser.newPage();
  for (const f of ['plan-ground.svg', 'plan-first.svg']) {
    const svg = fs.readFileSync(path.join(__dirname, f), 'utf8');
    const [, w, h] = svg.match(/width="(\d+)" height="(\d+)"/);
    await page.setViewportSize({ width: +w, height: +h });
    await page.setContent(`<html><body style="margin:0">${svg}</body></html>`);
    await page.screenshot({ path: path.join(__dirname, f.replace('.svg', '.png')), clip: { x: 0, y: 0, width: +w, height: +h } });
    console.log('wrote', f.replace('.svg', '.png'));
  }
  await browser.close();
})();
