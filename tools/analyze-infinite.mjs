#!/usr/bin/env node
/**
 * Pixel-statistics checks for tools/screenshot-infinite.mjs output.
 *
 * Usage: node tools/analyze-infinite.mjs [shotsDir=shots-infinite]
 */

import { PNG } from 'pngjs';
import { readFileSync, readdirSync, existsSync } from 'node:fs';

const dir = process.argv[2] ?? 'shots-infinite';
const load = (name) => PNG.sync.read(readFileSync(`${dir}/${name}`));

function regionStats(img, x0, y0, x1, y1) {
  let n = 0, sum = 0, sumSq = 0, prev = null, hf = 0, dark = 0;
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
const check = (name, ok, detail) => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name} ${detail ?? ''}`);
  if (!ok) failures++;
};

if (existsSync(`${dir}/console.json`)) {
  const { errors } = JSON.parse(readFileSync(`${dir}/console.json`, 'utf8'));
  check('no page/console errors', errors.length === 0, `(${errors.length})`);
  if (errors.length) console.log(errors.join('\n'));
}

const files = readdirSync(dir).filter(f => f.endsWith('.png')).sort();
for (const f of files) {
  const img = load(f);
  const sky = regionStats(img, 120, 100, 1100, 240);
  const terra = regionStats(img, 120, 300, 1200, 820);
  console.log(`${f}  sky=${JSON.stringify(sky)}  terrain=${JSON.stringify(terra)}`);
  check(`${f}: terrain has variation`, terra.std > 8, `std=${terra.std}`);
  check(`${f}: no large black holes`, terra.dark < 0.08, `dark=${terra.dark}`);
  if (!f.includes('lod')) {
    check(`${f}: sky is brighter than terrain`, sky.mean > terra.mean, `sky=${sky.mean} terrain=${terra.mean}`);
  }
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

// LOD colours must be visibly varied.
try {
  const lod = regionStats(load('06-lod-debug.png'), 120, 300, 1200, 820);
  console.log(`lod-debug terrain=${JSON.stringify(lod)}`);
  check('LOD debug view is colourful', lod.std > 20, `std=${lod.std}`);
} catch {
  console.log('skip LOD debug check (shot missing)');
}

try {
  const tiles = regionStats(load('07-tile-grid.png'), 120, 300, 1200, 820);
  console.log(`tile-grid terrain=${JSON.stringify(tiles)}`);
  check('tile-grid view is varied', tiles.std > 20, `std=${tiles.std}`);
} catch {
  console.log('skip tile-grid check (shot missing)');
}

process.exit(failures ? 1 : 0);
