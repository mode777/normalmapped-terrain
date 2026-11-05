#!/usr/bin/env node
/**
 * Pixel/console assertions for tools/screenshot-biome.ts output.
 *
 * Usage: node tools/analyze-biome.ts [shotsDir=shots-biome]
 */

import { PNG } from 'pngjs';
import { readFileSync, readdirSync, existsSync } from 'node:fs';

interface RegionStats {
  mean: number;
  std: number;
  hf: number;
  dark: number;
}

const dir = process.argv[2] ?? 'shots-biome';
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
  const stats = JSON.parse(readFileSync(`${dir}/biome-stats.json`, 'utf8')) as {
    dataset: string;
    material: {
      libraryCount: number;
      stackSize: number;
      stackExtent: number;
      macroSize: number;
      textureUnits: number;
      maxTextureUnits: number;
      approxTextureMiB: number;
      mode: string;
    };
    biome: {
      regions: Array<{ id: string; label: string; center: [number, number] }>;
      transitions: Array<{ from: string; to: string; width: number }>;
    };
    biomeMapSize: number;
  };
  console.log(`biome stats: ${JSON.stringify(stats)}`);
  check('dataset is biomes', stats.dataset === 'biomes', `(${stats.dataset})`);
  check('six biome regions', stats.biome.regions.length === 6, `(${stats.biome.regions.length})`);
  check('five transition bands', stats.biome.transitions.length === 5, `(${stats.biome.transitions.length})`);
  check('biome map is 1024px', stats.biomeMapSize === 1024, `(${stats.biomeMapSize})`);
  check('material library has 20 layers', stats.material.libraryCount === 20,
    `(${stats.material.libraryCount})`);
  check('material stack is 2048px', stats.material.stackSize === 2048, `(${stats.material.stackSize})`);
  check('material macro is 1024px', stats.material.macroSize === 1024, `(${stats.material.macroSize})`);
  check('material stack extent is 15360m', stats.material.stackExtent === 15360,
    `(${stats.material.stackExtent})`);
  check('material mode starts on', stats.material.mode === 'on', `(${stats.material.mode})`);
  check('material texture units fit', stats.material.textureUnits <= stats.material.maxTextureUnits,
    `${stats.material.textureUnits}/${stats.material.maxTextureUnits}`);
  check('material texture budget is plausible',
    stats.material.approxTextureMiB > 40 && stats.material.approxTextureMiB < 120,
    `${stats.material.approxTextureMiB.toFixed(1)} MiB`);
} catch {
  console.log('skip biome stats checks (biome-stats.json missing)');
}

const files = readdirSync(dir).filter((f) => f.endsWith('.png')).sort();
for (const f of files) {
  if (f === '26-material-swatches.png') continue;
  const img = load(f);
  const sky = regionStats(img, 120, 100, 1100, 240);
  const terra = regionStats(img, 120, 300, 1200, 820);
  console.log(`${f}  sky=${JSON.stringify(sky)}  terrain=${JSON.stringify(terra)}`);
  check(`${f}: terrain has variation`, terra.std > 8, `std=${terra.std}`);
  check(`${f}: no large black holes`, terra.dark < 0.12, `dark=${terra.dark}`);
}

// Biome captures should be visibly different from one another.
try {
  const biomeFiles = files.filter((f) => /^\d+-biome-/.test(f));
  const means = biomeFiles.map((f) => ({ f, ...regionStats(load(f), 120, 300, 1200, 820) }));
  console.log('biome means:', means.map((m) => `${m.f}:${m.mean}`).join(' '));
  check('all six biome captures exist', biomeFiles.length === 6, `(${biomeFiles.length})`);
  const values = means.map((m) => m.mean);
  check('biome means span a wide range', Math.max(...values) - Math.min(...values) > 12,
    `range=${(Math.max(...values) - Math.min(...values)).toFixed(1)}`);
  let distinctPairs = 0;
  for (let i = 0; i < values.length; i++) {
    for (let j = i + 1; j < values.length; j++) {
      if (Math.abs(values[i] - values[j]) > 4) distinctPairs++;
    }
  }
  check('at least eight biome pairs are distinct', distinctPairs >= 8, `(${distinctPairs})`);
} catch {
  console.log('skip biome distinctness checks (shots missing)');
}

// Transition close-ups: the band must carry variation, not a flat strip.
try {
  const transitionFiles = files.filter((f) => /-transition-/.test(f) && !/-sun-/.test(f));
  check('all five transition captures exist', transitionFiles.length === 5,
    `(${transitionFiles.length})`);
  for (const f of transitionFiles) {
    const band = regionStats(load(f), 200, 380, 1400, 560);
    console.log(`${f} band=${JSON.stringify(band)}`);
    check(`${f}: transition band is not flat`, band.std > 5, `std=${band.std}`);
  }
} catch {
  console.log('skip transition checks (shots missing)');
}

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
  const far = regionStats(load('18-material-distance.png'), 120, 300, 1200, 820);
  console.log(`material distance=${JSON.stringify(far)}`);
  check('far field retains macro variation', far.std > 8 && far.dark < 0.08,
    `std=${far.std} dark=${far.dark}`);
} catch {
  console.log('skip distance check (shot missing)');
}

try {
  const debug = regionStats(load('19-material-debug.png'), 120, 300, 1200, 820);
  console.log(`material debug=${JSON.stringify(debug)}`);
  check('material debug view distinguishes materials', debug.std > 12, `std=${debug.std}`);
} catch {
  console.log('skip debug check (shot missing)');
}

try {
  const on = regionStats(load('16-material-on.png'), 200, 300, 1400, 850);
  const flat = regionStats(load('20-material-normal0.png'), 200, 300, 1400, 850);
  console.log(`material normals on hf=${on.hf} mean=${on.mean}  off hf=${flat.hf} mean=${flat.mean}`);
  check('material normal strength preserves albedo mean', Math.abs(on.mean - flat.mean) < 20,
    `mean ${on.mean} -> ${flat.mean}`);
  check('material normals add shading relief', on.hf > flat.hf * 1.02,
    `hf ${flat.hf} -> ${on.hf}`);
} catch {
  console.log('skip material normal comparison (shots missing)');
}

try {
  const lod = regionStats(load('21-lod-debug.png'), 120, 300, 1200, 820);
  console.log(`lod-debug terrain=${JSON.stringify(lod)}`);
  check('LOD debug view is colourful', lod.std > 20, `std=${lod.std}`);
} catch {
  console.log('skip LOD debug check (shot missing)');
}

try {
  const tiles = regionStats(load('22-tile-grid.png'), 120, 300, 1200, 820);
  console.log(`tile-grid terrain=${JSON.stringify(tiles)}`);
  check('tile-grid view is varied', tiles.std > 20, `std=${tiles.std}`);
} catch {
  console.log('skip tile-grid check (shot missing)');
}

try {
  const img = load('23-cracks.png');
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

try {
  const swatch = load('26-material-swatches.png');
  const grid = regionStats(swatch, 100, 100, Math.max(200, swatch.width - 100), Math.max(200, swatch.height - 100));
  console.log(`material swatches ${swatch.width}x${swatch.height} grid=${JSON.stringify(grid)}`);
  check('material swatch page is populated', swatch.width >= 1000 && grid.std > 8,
    `${swatch.width}x${swatch.height} std=${grid.std}`);
} catch {
  console.log('skip material swatch check (shot missing)');
}

process.exit(failures ? 1 : 0);
