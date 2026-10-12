#!/usr/bin/env node
/**
 * Headless browser smoke test for cloud sessions (no browser pane, no phone).
 *
 *   node tools/smoke.cjs            # serves the repo on a free port itself
 *
 * Serves the app over plain http on localhost, fakes speechSynthesis so the
 * workout clock advances, clicks through every Home section, runs a short
 * workout, aborts it, and exits non-zero on any console error or page error.
 * It cannot check the voice, wake lock or service-worker updates: those need
 * the phone. Extend it for the screens a change touches.
 *
 * Needs Playwright and Chromium, which the cloud container has globally.
 * Dev tooling only: not shipped, not in the service worker.
 */

const { execSync, spawn } = require('node:child_process');
const path = require('node:path');
const net = require('node:net');

function loadPlaywright() {
  try { return require('playwright'); } catch { /* fall through */ }
  const root = execSync('npm root -g').toString().trim();
  return require(path.join(root, 'playwright'));
}

function freePort() {
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.listen(0, () => { const { port } = srv.address(); srv.close(() => resolve(port)); });
  });
}

(async () => {
  const { chromium } = loadPlaywright();
  const port = await freePort();
  // A fresh port each run, so no cached ES modules from an earlier run.
  const server = spawn('python3', ['-m', 'http.server', String(port)], {
    cwd: path.join(__dirname, '..'), stdio: 'ignore',
  });
  const errors = [];
  let browser;
  try {
    await new Promise((r) => setTimeout(r, 800));
    browser = await chromium.launch();
    const page = await browser.newPage({ viewport: { width: 375, height: 812 } });
    page.on('console', (m) => { if (m.type() === 'error') errors.push(`console: ${m.text()}`); });
    page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
    await page.addInitScript(() => {
      window.__said = [];
      window.SpeechSynthesisUtterance = class { constructor(t) { this.text = t; } };
      Object.defineProperty(window, 'speechSynthesis', {
        value: {
          speaking: false, pending: false, getVoices: () => [], cancel() {}, pause() {}, resume() {},
          addEventListener() {}, removeEventListener() {},
          speak(u) {
            window.__said.push(u.text);
            setTimeout(() => { u.onstart?.(); u.onend?.(); }, 300);
          },
        },
      });
    });

    await page.goto(`http://localhost:${port}/`);
    await page.waitForSelector('#start-round');

    // Every chip in every Home group, once each, then back to defaults-ish.
    for (const group of ['sport', 'tier', 'intensity', 'workoutMode', 'emphasis', 'roundLengthMin']) {
      const values = await page.$$eval(`[data-group="${group}"] [data-value]`, (els) => els.map((e) => e.dataset.value));
      for (const v of values) await page.click(`[data-group="${group}"] [data-value="${v}"]`);
      console.log(`${group}: ${values.join(', ')}`);
    }
    console.log('pool line:', await page.$eval('#pool-size', (e) => e.textContent));
    const scrollWidth = await page.evaluate(() => document.documentElement.scrollWidth);
    if (scrollWidth > 375) errors.push(`horizontal scroll: page is ${scrollWidth}px wide at 375`);

    await page.click('[data-group="tier"] [data-value="advanced"]');
    await page.click('[data-group="intensity"] [data-value="hard"]');
    await page.click('#start-round');
    const seen = [];
    for (let i = 0; i < 30; i++) {
      await page.waitForTimeout(500);
      const line = await page.evaluate(() => {
        const c = document.querySelector('#wk-combo')?.textContent ?? '';
        const r = document.querySelector('#wk-rung')?.textContent ?? '';
        return c ? c + (r ? `  [${r}]` : '') : '';
      });
      if (line && seen[seen.length - 1] !== line) seen.push(line);
    }
    console.log('workout screen:\n  ' + (seen.join('\n  ') || '(nothing shown)'));
    if (!seen.length) errors.push('the workout showed no callouts');
    await page.click('#wk-abort');
    await page.waitForTimeout(300);
    console.log('notice:', await page.$eval('#home-notice', (e) => e.textContent.trim()));
  } catch (e) {
    errors.push(`smoke script: ${e.message}`);
  } finally {
    await browser?.close();
    server.kill();
  }

  if (errors.length) {
    console.error('\nSMOKE FAILED:\n  ' + errors.join('\n  '));
    process.exit(1);
  }
  console.log('\nSmoke OK: no console errors.');
})();
