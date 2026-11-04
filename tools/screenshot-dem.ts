// Headless QA driver for dem.html.
//
// Requires puppeteer-core next to the repo:
//   npm install --no-save puppeteer-core
//
// Usage:
//   node tools/screenshot-dem.ts --url http://127.0.0.1:4173/dem.html --out shots-dem
//
// This optional driver is excluded from `tsc --noEmit` because puppeteer-core
// is not a dependency of the app; install it before running.

import puppeteer from 'puppeteer-core';
import { mkdirSync, writeFileSync } from 'node:fs';

const arg = (name: string, def: string): string => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : def;
};

const TARGET = arg('url', 'http://127.0.0.1:4173/dem.html');
const OUT = arg('out', 'shots-dem');
// Diagnostic tile strength: strong enough to read in a still, below the
// crunchy end of the slider. Production tuning is recorded in the findings.
const DETAIL_STRENGTH = 0.35;
const CHROME = arg('chrome', process.env.CHROME_SHELL_PATH ||
  '/home/devuser/browsers/chrome-headless-shell/linux-131.0.6778.264/chrome-headless-shell-linux64/chrome-headless-shell');

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
const messages: string[] = [];
const errors: string[] = [];

mkdirSync(OUT, { recursive: true });

const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: true,
  args: ['--no-sandbox', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
  defaultViewport: { width: 1600, height: 900 },
});

const page = await browser.newPage();
page.on('console', (m) => {
  messages.push(`[${m.type()}] ${m.text()}`);
  if (m.type() === 'error') errors.push(`CONSOLE: ${m.text()}`);
});
page.on('pageerror', (e) => errors.push(`PAGEERROR: ${e.message}`));
page.on('requestfailed', (r) => errors.push(`REQFAIL: ${r.url()} ${r.failure()?.errorText}`));

const url = new URL(TARGET);
url.searchParams.set('cruise', '0');
console.log(`goto ${url}`);
await page.goto(url.toString(), { waitUntil: 'domcontentloaded', timeout: 60000 });

console.log('waiting for dataset + visible tiles…');
try {
  await page.waitForFunction(() => window.__dem !== undefined, { timeout: 180000 });
} catch {
  errors.push('BOOT TIMEOUT: DEM scene never became ready');
  const status = await page.evaluate(() => document.getElementById('loading-status')?.textContent ?? '(none)');
  errors.push('status was: ' + status);
}
await sleep(2500);

const read = () => page.evaluate(() => {
  const q = window.__dem;
  return {
    dataset: q.manifest.dataset,
    config: q.config,
    stats: q.streamer.getStats(),
    flight: q.flight.getInfo(),
    state: q.state,
    ground: q.groundHeight(),
    detailStrength: q.state.detailStrength,
    camera: q.camera.position.toArray(),
  };
});

const shot = async (name: string): Promise<void> => {
  await sleep(600);
  await page.screenshot({ path: `${OUT}/${name}.png` });
};

const setNormal = (value: number): Promise<void> => page.evaluate((v) => {
  const s = document.getElementById('normal-strength') as HTMLInputElement;
  s.value = String(v);
  s.dispatchEvent(new Event('input', { bubbles: true }));
}, value);

const setDetail = (value: number): Promise<void> => page.evaluate((v) => {
  window.__dem.setDetailStrength(v);
}, value);

const setSun = (azimuth: number, elevation: number): Promise<void> => page.evaluate(({ az, el }) => {
  const azInput = document.getElementById('sun-azimuth') as HTMLInputElement;
  const elInput = document.getElementById('sun-elevation') as HTMLInputElement;
  azInput.value = String(az);
  elInput.value = String(el);
  azInput.dispatchEvent(new Event('input', { bubbles: true }));
  elInput.dispatchEvent(new Event('input', { bubbles: true }));
}, { az: azimuth, el: elevation });

const detailPose = async (
  x: number,
  z: number,
  altitude: number,
  pitch: number,
  yaw: number,
): Promise<void> => {
  await page.evaluate(async ({ px, pz, alt, p, y }) => {
    await window.__dem.warpTo(px, pz);
    const ground = window.__dem.groundHeight();
    await window.__dem.warpTo(px, pz, ground + alt);
    window.__dem.flight.pitch = p;
    window.__dem.flight.yaw = y;
  }, { px: x, pz: z, alt: altitude, p: pitch, y: yaw });
  await sleep(900);
};

console.log('stats initial:', JSON.stringify(await read()));
await shot('01-default');

// Same pose, flat normal: isolates the normal map's contribution.
await setNormal(0);
await setDetail(0);
await shot('02-normal0');

await setNormal(1);
await setDetail(0);
await shot('02b-detail-off');

await setDetail(DETAIL_STRENGTH);
await shot('02c-detail-on');
await setDetail(0);

// Orbit movement.
await page.evaluate(() => window.__dem.setAutoCruise(true));
const before = await page.evaluate(() => window.__dem.flight.getInfo());
await sleep(4000);
const after = await page.evaluate(() => window.__dem.flight.getInfo());
console.log('orbit delta:', { dx: after.x - before.x, dz: after.z - before.z });
await shot('03-orbit');

// Move to a different part of the massif.
await page.evaluate(async () => { await window.__dem.warpTo(1500, 800); });
await sleep(1000);
console.log('stats warp:', JSON.stringify(await read()));
await shot('04-warp');

// LOD/wire debug.
await page.evaluate(() => {
  window.__dem.setLodDebug(true);
  window.__dem.setWireframe(true);
});
await shot('05-lod-debug');

// Tile-cache checkerboard.
await page.evaluate(() => {
  window.__dem.setLodDebug(false);
  window.__dem.setWireframe(false);
  window.__dem.setTileDebug(true);
});
await shot('06-tile-grid');

// Crack hunt: hide the sky and clear to magenta.
await page.evaluate(() => {
  window.__dem.setTileDebug(false);
  window.__dem.setCrackDebug(true);
});
await shot('07-cracks');
await page.evaluate(() => window.__dem.setCrackDebug(false));

// Boundary view: free flight is not clamped; the source clamps to the nearest
// edge tile instead.
await page.evaluate(async () => { await window.__dem.warpTo(6000, 0); });
await sleep(1000);
console.log('stats boundary:', JSON.stringify(await read()));
await shot('08-boundary');

// Detail-layer checks. The close-up pair is the same-pose analyzer input;
// the orientation pair uses a low sun on the diagnostic tile.
await detailPose(2500, 0, 80, -0.35, Math.PI / 2);
await setDetail(0);
await shot('09-detail-closeup-off');
await setDetail(DETAIL_STRENGTH);
await shot('10-detail-closeup-on');

await setSun(90, 20);
await shot('11-detail-sun-east');
await setSun(270, 20);
await shot('12-detail-sun-west');
await setSun(305, 34);

await detailPose(2500, 0, 60, -0.2, Math.PI / 2);
await setDetail(DETAIL_STRENGTH);
await shot('13-detail-cliff');

// Warp away and back at the same close pose: the detail pattern must stay
// world-locked across the floating-origin rebase.
await detailPose(2500, 0, 80, -0.35, Math.PI / 2);
await setDetail(DETAIL_STRENGTH);
await shot('14-detail-warp-before');
await page.evaluate(async () => { await window.__dem.warpTo(25000, 0); });
await page.evaluate(async () => { await window.__dem.warpTo(2500, 0); });
await detailPose(2500, 0, 80, -0.35, Math.PI / 2);
await shot('15-detail-warp-after');

writeFileSync(`${OUT}/console.json`, JSON.stringify({ errors, messages }, null, 2));
console.log('ERRORS:', JSON.stringify(errors, null, 2));
console.log('console tail:', messages.slice(-8).join('\n'));
await browser.close();
process.exit(errors.length ? 1 : 0);
