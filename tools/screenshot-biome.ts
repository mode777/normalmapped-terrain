// Headless QA driver for biome.html.
//
// Requires puppeteer-core next to the repo:
//   npm install --no-save puppeteer-core
//
// Usage:
//   node tools/screenshot-biome.ts --url http://127.0.0.1:4173/biome.html --out shots-biome
//
// This optional driver is excluded from `tsc --noEmit` because puppeteer-core
// is not a dependency of the app; install it before running.

import puppeteer from 'puppeteer-core';
import { mkdirSync, writeFileSync } from 'node:fs';

const arg = (name: string, def: string): string => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : def;
};

const TARGET = arg('url', 'http://127.0.0.1:4173/biome.html');
const OUT = arg('out', 'shots-biome');
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
  protocolTimeout: 900000,
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
  await page.waitForFunction(() => window.__biome !== undefined, { timeout: 180000 });
} catch {
  errors.push('BOOT TIMEOUT: biome scene never became ready');
  const status = await page.evaluate(() => document.getElementById('loading-status')?.textContent ?? '(none)');
  errors.push('status was: ' + status);
}
await sleep(2500);

const read = () => page.evaluate(() => {
  const q = window.__biome;
  return {
    dataset: q.manifest.dataset,
    config: q.config,
    stats: q.streamer.getStats(),
    flight: q.flight.getInfo(),
    state: q.state,
    ground: q.groundHeight(),
    material: q.getMaterialStats(),
    biome: q.getBiomeStats(),
    biomeMapSize: q.manifest.biomes?.mapSize ?? 0,
    camera: q.camera.position.toArray(),
  };
});

const shot = async (name: string, settle = 600): Promise<void> => {
  await sleep(settle);
  await page.screenshot({ path: `${OUT}/${name}.png` });
};

const setNormal = (value: number): Promise<void> => page.evaluate((v) => {
  const s = document.getElementById('normal-strength') as HTMLInputElement;
  s.value = String(v);
  s.dispatchEvent(new Event('input', { bubbles: true }));
}, value);

const setDetail = (value: number): Promise<void> => page.evaluate((v) => {
  window.__biome.setDetailStrength(v);
}, value);

const setMaterialMode = (mode: 'on' | 'off' | 'debug'): Promise<void> => page.evaluate((m) => {
  window.__biome.setMaterialMode(m);
}, mode);

const setHeightBlend = (value: number): Promise<void> => page.evaluate((v) => {
  window.__biome.setHeightBlend(v);
}, value);

const setMaterialNormalStrength = (value: number): Promise<void> => page.evaluate((v) => {
  window.__biome.setMaterialNormalStrength(v);
}, value);

const setSun = (azimuth: number, elevation: number): Promise<void> => page.evaluate(({ az, el }) => {
  const azInput = document.getElementById('sun-azimuth') as HTMLInputElement;
  const elInput = document.getElementById('sun-elevation') as HTMLInputElement;
  azInput.value = String(az);
  elInput.value = String(el);
  azInput.dispatchEvent(new Event('input', { bubbles: true }));
  elInput.dispatchEvent(new Event('input', { bubbles: true }));
}, { az: azimuth, el: elevation });

const pose = async (
  x: number,
  z: number,
  altitude: number,
  pitch: number,
  yaw: number,
): Promise<void> => {
  await page.evaluate(async ({ px, pz, alt, p, y }) => {
    const q = window.__biome;
    await q.warpTo(px, pz);
    const ground = q.groundHeight();
    await q.warpTo(px, pz, ground + alt);
    q.flight.pitch = p;
    q.flight.yaw = y;
  }, { px: x, pz: z, alt: altitude, p: pitch, y: yaw });
  await sleep(900);
};

const biomeShot = async (id: string): Promise<void> => {
  await page.evaluate(async (biome) => {
    await window.__biome.warpToBiome(biome);
    window.__biome.flight.pitch = -0.20;
    window.__biome.flight.yaw = 0;
  }, id);
  await sleep(900);
};

const initial = await read();
writeFileSync(`${OUT}/biome-stats.json`, JSON.stringify(initial, null, 2));
console.log('stats initial:', JSON.stringify(initial));
await shot('01-default');

const regions = initial.biome.regions.map((region: { id: string }) => region.id);
for (let i = 0; i < regions.length; i++) {
  await biomeShot(regions[i]);
  await shot(`${String(i + 2).padStart(2, '0')}-biome-${regions[i]}`);
}

// Wide north -> south traversal. The camera keeps the same heading so the
// palette change is the only large difference between the pairs.
await pose(0, -6500, 2200, -0.16, 0);
await shot('08-traversal-north');
await pose(0, 0, 2200, -0.16, 0);
await shot('09-traversal-mid');
await pose(0, 6500, 2200, -0.16, 0);
await shot('10-traversal-south');

// Transition close-ups at the midpoint between adjacent region centres.
const regionCenter = new Map(
  initial.biome.regions.map((region: { id: string; center: [number, number] }) =>
    [region.id, region.center] as const),
);
for (const [index, transition] of (initial.biome.transitions as Array<{
  from: string;
  to: string;
}>).entries()) {
  const from = regionCenter.get(transition.from);
  const to = regionCenter.get(transition.to);
  if (!from || !to) continue;
  await pose(0, (from[1] + to[1]) / 2, 520, -0.35, 0);
  await shot(`${String(11 + index).padStart(2, '0')}-transition-${transition.from}-${transition.to}`);
}

// Material A/B at a temperate/boreal close pose.
await setDetail(0);
await setMaterialMode('on');
await setHeightBlend(0.25);
await setMaterialNormalStrength(1);
await pose(0, -900, 140, -0.35, 0);
await shot('16-material-on');
await setMaterialMode('off');
await shot('17-material-off');

await setMaterialMode('on');
await pose(0, -900, 900, -0.18, 0);
await shot('18-material-distance');

await setMaterialMode('debug');
await pose(0, 0, 1200, -0.18, Math.PI);
await shot('19-material-debug');

await setMaterialMode('on');
await pose(0, -900, 140, -0.35, 0);
await setMaterialNormalStrength(0);
await shot('20-material-normal0');
await setMaterialNormalStrength(1);

// LOD / tile / crack checks at a wide pose so several rings are visible.
await pose(0, 0, 2200, -0.18, Math.PI);
await page.evaluate(() => {
  window.__biome.setLodDebug(true);
  window.__biome.setWireframe(true);
});
await shot('21-lod-debug');
await page.evaluate(() => {
  window.__biome.setLodDebug(false);
  window.__biome.setWireframe(false);
  window.__biome.setTileDebug(true);
});
await shot('22-tile-grid');
await page.evaluate(() => {
  window.__biome.setTileDebug(false);
  window.__biome.setCrackDebug(true);
});
await shot('23-cracks');
await page.evaluate(() => window.__biome.setCrackDebug(false));

// Low-sun orientation pair on a transition band.
await setSun(90, 20);
await pose(0, -5120, 420, -0.25, 0);
await shot('24-transition-sun-east');
await setSun(270, 20);
await shot('25-transition-sun-west');
await setSun(305, 34);

// Asset-level swatch page. Let the tile queue drain before navigating: an
// in-flight tile fetch aborted by the navigation would otherwise appear as a
// request failure and console error in the capture log.
await page.waitForFunction(() => {
  const stats = window.__biome.streamer.getStats();
  return stats.queued + stats.inFlight === 0;
}, { timeout: 120000 });
await sleep(800);
const swatchUrl = new URL('materials.html', TARGET).toString();
console.log(`goto ${swatchUrl}`);
await page.goto(swatchUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
try {
  await page.waitForFunction(() => window.__materials?.ready === true, { timeout: 120000 });
} catch {
  errors.push('SWATCH TIMEOUT: materials.html never finished loading');
}
await sleep(800);
await page.screenshot({ path: `${OUT}/26-material-swatches.png`, fullPage: true });

writeFileSync(`${OUT}/console.json`, JSON.stringify({ errors, messages }, null, 2));
console.log('ERRORS:', JSON.stringify(errors, null, 2));
console.log('console tail:', messages.slice(-8).join('\n'));
await browser.close();
process.exit(errors.length ? 1 : 0);
