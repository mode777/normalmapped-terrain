// Headless QA driver: loads the site in chrome-headless-shell (SwiftShader
// WebGL), walks the comparison modes, screenshots each and dumps console
// errors. Pair with tools/analyze-shots.mjs.
//
// Needs puppeteer-core next to the repo:  npm install --no-save puppeteer-core
//
// Usage:
//   node tools/screenshot.mjs --url http://127.0.0.1:4173/ --out shots
//   node tools/screenshot.mjs --url https://mode777.github.io/normalmapped-terrain/ --out live
//
// --chrome /path/to/chrome-headless-shell overrides CHROME_SHELL_PATH.

import puppeteer from 'puppeteer-core';
import { mkdirSync, writeFileSync } from 'node:fs';

const arg = (name, def) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : def;
};

const URL = arg('url', 'http://127.0.0.1:4173/');
const OUT = arg('out', 'shots');
const CHROME = arg('chrome', process.env.CHROME_SHELL_PATH ||
  '/home/devuser/browsers/chrome-headless-shell/linux-131.0.6778.264/chrome-headless-shell-linux64/chrome-headless-shell');

const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const console_msgs = [];
const errors = [];

mkdirSync(OUT, { recursive: true });

const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: true,
  args: ['--no-sandbox', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
  defaultViewport: { width: 1600, height: 900 },
});

const page = await browser.newPage();
page.on('console', m => console_msgs.push(`[${m.type()}] ${m.text()}`));
page.on('pageerror', e => errors.push(`PAGEERROR: ${e.message}`));
page.on('requestfailed', r => errors.push(`REQFAIL: ${r.url()} ${r.failure()?.errorText}`));

console.log(`goto ${URL}`);
await page.goto(URL, { waitUntil: 'domcontentloaded', timeout: 60000 });

console.log('waiting for boot (heightfield gen + normal bake + first mesh)…');
try {
  await page.waitForFunction(() => !document.getElementById('loading'), { timeout: 120000 });
} catch {
  errors.push('BOOT TIMEOUT: loading overlay never finished');
  const status = await page.evaluate(() => document.getElementById('loading-status')?.textContent ?? '(none)');
  errors.push('status was: ' + status);
}
await sleep(4000); // settle + let the background dataset preload

const stats = () => page.evaluate(() => ({
  fps: document.getElementById('stat-fps')?.textContent,
  tris: document.getElementById('stat-tris')?.textContent,
  mesh: document.getElementById('stat-mesh')?.textContent,
  map: document.getElementById('stat-map')?.textContent,
}));

console.log('stats B:', JSON.stringify(await stats()));
await page.screenshot({ path: `${OUT}/02-procedural-B.png` });

const clickMode = async (mode) => {
  await page.evaluate(m => document.querySelector(`.mode-btn[data-mode="${m}"]`)?.click(), mode);
  await sleep(2500);
};

await clickMode('A');
await page.screenshot({ path: `${OUT}/03-procedural-A.png` });

await clickMode('split');
await sleep(500);
await page.screenshot({ path: `${OUT}/04-procedural-split.png` });

await clickMode('C');
await sleep(6000); // high-res reference mesh build
console.log('stats C:', JSON.stringify(await stats()));
await page.screenshot({ path: `${OUT}/05-procedural-C.png` });

// Real-world dataset (preloaded in the background after boot)
await page.evaluate(() => document.querySelector('#dataset-select button[data-ds="grand-canyon"]')?.click());
await sleep(6000);
console.log('stats GC:', JSON.stringify(await stats()));
await page.screenshot({ path: `${OUT}/06-grand-canyon-B.png` });

await clickMode('split');
await sleep(500);
await page.screenshot({ path: `${OUT}/07-grand-canyon-split.png` });

writeFileSync(`${OUT}/console.json`, JSON.stringify({ errors, console_msgs }, null, 2));
console.log('ERRORS:', JSON.stringify(errors, null, 2));
await browser.close();
process.exit(errors.length ? 1 : 0);
