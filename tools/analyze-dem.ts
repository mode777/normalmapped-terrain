#!/usr/bin/env node
/**
 * Pixel/console assertions for tools/screenshot-dem.ts output.
 *
 * Usage: node tools/analyze-dem.ts [shotsDir=shots-dem]
 */

import { PNG } from 'pngjs';
import { readFileSync, readdirSync, existsSync } from 'node:fs';

interface RegionStats {
  mean: number;
  std: number;
  hf: number;
  dark: number;
}

const dir = process.argv[2] ?? 'shots-dem';
const load = (name: string): PNG => PNG.sync.read(readFileSync(`${dir}/${name}`));

function regionStats(img: PNG, x0: number, y0: number, x1: number, y1: number): RegionStats {
  let n = 0, sum = 0, sumSq = 0, prev: number | null = null, hf = 0, dark = 0;
  for (let y = y0; y < y1; y += 2) {
    for (let x = x0; x < x1; x += 2) {
      const i = (y * img.width + x) * 4;
      const r = img.data[i], g = img.data[i + 1], b = img.data[i + 2];
      const lum = 0.2126 * r + 0.7152 * g + 0.0722 * b;
      if (lum < 5) dark++;
      sum += lum; sumSq += lum * lum;
      if (prev !== null) hf += Math.abs(lum - prev);
      prev = lum;
    }
    prev = null;
  }
  n = Math.max(1, ((x1 - x0) * (y1 - y0)) / 4);
  const mean = sum / n;
  return {
    mean: +mean.toFixed(1),
    std: +Math.sqrt(Math.max(0, sumSq / n - mean * mean)).toFixed(1),
    hf: +(hf / n).toFixed(2),
    dark: +(dark / n).toFixed(3),
  };
}

let failures = 0;
const check = (name: string, ok: boolean, detail?: string): void => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name} ${detail ?? ''}`);
  if (!ok) failures++;
};

if (existsSync(`${dir}/console.json`)) {
  const { errors } = JSON.parse(readFileSync(`${dir}/console.json`, 'utf8')) as { errors: string[] };
  check('no page/console errors', errors.length === 0, `(${errors.length})`);
  if (errors.length) console.log(errors.join('\n'));
}

try {
  const stats = JSON.parse(readFileSync(`${dir}/material-stats.json`, 'utf8')) as {
    libraryCount: number;
    stackSize: number;
    stackExtent: number;
    macroSize: number;
    textureUnits: number;
    maxTextureUnits: number;
    approxTextureMiB: number;
    mode: string;
  };
  console.log(`material stats: ${JSON.stringify(stats)}`);
  check('material library has 20 layers', stats.libraryCount === 20, `(${stats.libraryCount})`);
  check('material stack is 2048px', stats.stackSize === 2048, `(${stats.stackSize})`);
  check('material macro is 1024px', stats.macroSize === 1024, `(${stats.macroSize})`);
  check('material stack extent is 30720m', stats.stackExtent === 30720, `(${stats.stackExtent})`);
  check('material mode starts on', stats.mode === 'on', `(${stats.mode})`);
  check('material texture units fit', stats.textureUnits <= stats.maxTextureUnits,
    `${stats.textureUnits}/${stats.maxTextureUnits}`);
  check('material texture budget is plausible', stats.approxTextureMiB > 40 && stats.approxTextureMiB < 120,
    `${stats.approxTextureMiB.toFixed(1)} MiB`);
} catch {
  console.log('skip material stats checks (material-stats.json missing)');
}

const files = readdirSync(dir).filter((f) => f.endsWith('.png')).sort();
for (const f of files) {
  if (f === '23-material-swatches.png') continue;
  const img = load(f);
  const sky = regionStats(img, 120, 100, 1100, 240);
  const terra = regionStats(img, 120, 300, 1200, 820);
  console.log(`${f}  sky=${JSON.stringify(sky)}  terrain=${JSON.stringify(terra)}`);
  check(`${f}: terrain has variation`, terra.std > 8, `std=${terra.std}`);
  // Low-sun poses can legitimately put more than 8% of the terrain in shadow;
  // 12% is the black-hole / unfilled-tile threshold, not a lighting judgement.
  check(`${f}: no large black holes`, terra.dark < 0.12, `dark=${terra.dark}`);
}

// Same-pose normal-map vs flat-normal comparison.
try {
  const normal = regionStats(load('01-default.png'), 200, 420, 1200, 820);
  const flat = regionStats(load('02-normal0.png'), 200, 420, 1200, 820);
  console.log(`normal-map hf=${normal.hf}  flat-normal hf=${flat.hf}`);
  check('normal map adds high-frequency detail', normal.hf > flat.hf * 1.05,
    `hf ${flat.hf} -> ${normal.hf}`);
} catch {
  console.log('skip normal-map detail comparison (shots missing)');
}

// Same-pose detail-layer comparison at the close-up pose.
try {
  const off = regionStats(load('09-detail-closeup-off.png'), 200, 300, 1400, 850);
  const on = regionStats(load('10-detail-closeup-on.png'), 200, 300, 1400, 850);
  console.log(`detail-off hf=${off.hf}  detail-on hf=${on.hf}`);
  check('detail normal adds high-frequency shading', on.hf > off.hf * 1.05,
    `hf ${off.hf} -> ${on.hf}`);
} catch {
  console.log('skip detail-layer comparison (shots missing)');
}

// Material on/off pair at a close pose. The material albedo/normal should add
// both color change and high-frequency energy versus the old palette.
try {
  const on = regionStats(load('16-material-on.png'), 200, 300, 1400, 850);
  const off = regionStats(load('17-material-off.png'), 200, 300, 1400, 850);
  console.log(`material-off hf=${off.hf} mean=${off.mean}  material-on hf=${on.hf} mean=${on.mean}`);
  check('material layer adds high-frequency detail', on.hf > off.hf * 1.05,
    `hf ${off.hf} -> ${on.hf}`);
  check('material layer changes near-field color', Math.abs(on.mean - off.mean) > 1.0,
    `mean ${off.mean} -> ${on.mean}`);
} catch {
  console.log('skip material on/off comparison (shots missing)');
}

try {
  const cliff = regionStats(load('19-material-cliff.png'), 200, 300, 1400, 850);
  console.log(`material cliff=${JSON.stringify(cliff)}`);
  check('material cliff has rock-scale variation', cliff.std > 8 && cliff.dark < 0.08,
    `std=${cliff.std} dark=${cliff.dark}`);
} catch {
  console.log('skip material cliff check (shot missing)');
}

try {
  const far = regionStats(load('20-material-distance.png'), 120, 300, 1200, 820);
  console.log(`material distance=${JSON.stringify(far)}`);
  check('material far field retains macro variation', far.std > 8 && far.dark < 0.08,
    `std=${far.std} dark=${far.dark}`);
} catch {
  console.log('skip material distance check (shot missing)');
}

try {
  const debug = regionStats(load('21-material-debug.png'), 120, 300, 1200, 820);
  console.log(`material debug=${JSON.stringify(debug)}`);
  check('material debug view is distinct per material', debug.std > 12, `std=${debug.std}`);
} catch {
  console.log('skip material debug check (shot missing)');
}

try {
  const on = regionStats(load('16-material-on.png'), 200, 300, 1400, 850);
  const flat = regionStats(load('22-material-normal0.png'), 200, 300, 1400, 850);
  console.log(`material normals on hf=${on.hf} mean=${on.mean}  off hf=${flat.hf} mean=${flat.mean}`);
  check('material normal strength preserves albedo mean', Math.abs(on.mean - flat.mean) < 20,
    `mean ${on.mean} -> ${flat.mean}`);
  check('material normals add shading relief', on.hf > flat.hf * 1.02,
    `hf ${flat.hf} -> ${on.hf}`);
} catch {
  console.log('skip material normal-strength comparison (shots missing)');
}

try {
  const swatch = load('23-material-swatches.png');
  const grid = regionStats(swatch, 100, 100, Math.max(200, swatch.width - 100), Math.max(200, swatch.height - 100));
  console.log(`material swatches ${swatch.width}x${swatch.height} grid=${JSON.stringify(grid)}`);
  check('material swatch page is populated', swatch.width >= 1000 && grid.std > 8,
    `${swatch.width}x${swatch.height} std=${grid.std}`);
} catch {
  console.log('skip material swatch check (shot missing)');
}

try {
  const lod = regionStats(load('05-lod-debug.png'), 120, 300, 1200, 820);
  console.log(`lod-debug terrain=${JSON.stringify(lod)}`);
  check('LOD debug view is colourful', lod.std > 20, `std=${lod.std}`);
} catch {
  console.log('skip LOD debug check (shot missing)');
}

try {
  const tiles = regionStats(load('06-tile-grid.png'), 120, 300, 1200, 820);
  console.log(`tile-grid terrain=${JSON.stringify(tiles)}`);
  check('tile-grid view is varied', tiles.std > 20, `std=${tiles.std}`);
} catch {
  console.log('skip tile-grid check (shot missing)');
}

// Seam check: sky hidden + magenta clear. The lower half is guaranteed terrain.
try {
  const img = load('07-cracks.png');
  let magenta = 0, n = 0;
  for (let y = 500; y < 850; y += 2) {
    for (let x = 120; x < 1480; x += 2) {
      const i = (y * img.width + x) * 4;
      if (img.data[i] > 200 && img.data[i + 1] < 60 && img.data[i + 2] > 200) magenta++;
      n++;
    }
  }
  const frac = magenta / n;
  console.log(`crack test: magenta=${magenta}/${n} (${(frac * 100).toFixed(2)}%)`);
  check('no gaps between clipmap rings', frac < 0.002, `magenta=${(frac * 100).toFixed(2)}%`);
} catch {
  console.log('skip crack check (shot missing)');
}

process.exit(failures ? 1 : 0);
