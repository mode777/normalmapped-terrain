// Pixel-statistics sanity checks for tools/screenshot.mjs output.
// The core assertion: the normal-mapped side of a split screenshot must
// carry far more high-frequency shading detail than the vertex-normal side.
//
// Usage:  node tools/analyze-shots.mjs [shotsDir=shots]

import { PNG } from 'pngjs';
import { readFileSync, readdirSync } from 'node:fs';

const dir = process.argv[2] ?? 'shots';

const load = (name) => PNG.sync.read(readFileSync(`${dir}/${name}`));

// "hf" = mean |Δluminance| between horizontally adjacent samples:
// an unbiased-enough proxy for shading detail at pixel scale.
function regionStats(img, x0, y0, x1, y1) {
  let n = 0, sum = 0, sumSq = 0, rs = 0, gs = 0, bs = 0, prev = null, hf = 0;
  for (let y = y0; y < y1; y += 2) {
    for (let x = x0; x < x1; x += 2) {
      const i = (y * img.width + x) * 4;
      const r = img.data[i], g = img.data[i + 1], b = img.data[i + 2];
      const lum = 0.2126 * r + 0.7152 * g + 0.0722 * b;
      sum += lum; sumSq += lum * lum; rs += r; gs += g; bs += b;
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
    rgb: [rs / n | 0, gs / n | 0, bs / n | 0],
  };
}

let failures = 0;
const check = (name, ok, detail) => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name} ${detail ?? ''}`);
  if (!ok) failures++;
};

// ---- per-shot liveness ----------------------------------------------------
for (const f of readdirSync(dir).filter(f => f.endsWith('.png')).sort()) {
  const img = load(f);
  const sky = regionStats(img, 600, 20, 1000, 120);
  const terra = regionStats(img, 500, 450, 1100, 850);
  console.log(`${f}  sky=${JSON.stringify(sky)}  terra=${JSON.stringify(terra)}`);
  check(`${f}: terrain has variation (not blank)`, terra.std > 8, `std=${terra.std}`);
}

// ---- the PoC assertion: split detail differential --------------------------
for (const f of ['04-procedural-split.png', '07-grand-canyon-split.png']) {
  try {
    const img = load(f);
    const left = regionStats(img, 100, 400, 600, 850);   // vertex normals
    const right = regionStats(img, 1000, 400, 1500, 850); // normal map
    console.log(`${f} SPLIT left=${JSON.stringify(left)} right=${JSON.stringify(right)}`);
    check(`${f}: normal-map side has ≥3x more detail`, right.hf > 3 * left.hf,
      `hf ${left.hf} -> ${right.hf}`);
  } catch { console.log(`skip ${f} (not captured)`); }
}

// ---- B vs A vs C ------------------------------------------------------------
try {
  const a = load('03-procedural-A.png'), b = load('02-procedural-B.png'), c = load('05-procedural-C.png');
  const hfA = regionStats(a, 500, 450, 1100, 850).hf;
  const hfB = regionStats(b, 500, 450, 1100, 850).hf;
  const hfC = regionStats(c, 500, 450, 1100, 850).hf;
  console.log(`detail(hf) A=${hfA} B=${hfB} C=${hfC}`);
  check('B more detailed than A', hfB > 1.2 * hfA);
  check('B recovers >=70% of reference C', hfB >= 0.7 * hfC, `B/C=${(hfB / hfC * 100) | 0}%`);
} catch { console.log('skip A/B/C comparison (shots missing)'); }

process.exit(failures ? 1 : 0);
