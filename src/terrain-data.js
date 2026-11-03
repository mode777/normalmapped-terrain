/**
 * Terrain datasets. Both produce the same shape so the rest of the
 * pipeline (normal baking, mesh building, shading) is agnostic:
 *
 *   { id, name, res, worldSizeX, worldSizeZ, heightScale,
 *     heights: Float32Array (res*res, 0..1), credit, info }
 */

import { Perlin } from './perlin.js';

const smoothstep = (a, b, x) => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

/** Chunked procedural heightfield so we can show progress. */
async function generateProcedural(res, worldSize, heightScale, seed, onProgress) {
  const heights = new Float32Array(res * res);
  const noise = new Perlin(seed);
  const noiseWarpA = new Perlin(seed + 101);
  const noiseWarpB = new Perlin(seed + 202);
  const noiseMask = new Perlin(seed + 303);

  const CHUNK = 128;
  for (let j0 = 0; j0 < res; j0 += CHUNK) {
    const j1 = Math.min(res, j0 + CHUNK);
    for (let j = j0; j < j1; j++) {
      const z = (j / (res - 1) - 0.5) * worldSize;
      for (let i = 0; i < res; i++) {
        const x = (i / (res - 1) - 0.5) * worldSize;

        // Domain warp: bend the input coords so ranges don't look grid-aligned
        const wx = x + 1500 * noiseWarpA.noise2(x * 2.1e-4 + 7.3, z * 2.1e-4);
        const wz = z + 1500 * noiseWarpB.noise2(x * 2.1e-4, z * 2.1e-4 + 3.1);

        // Where do mountains live? (low frequency, warped)
        let mask = noiseMask.fbm(wx * 1.05e-4, wz * 1.05e-4, 3) * 0.5 + 0.5;
        mask = smoothstep(0.38, 0.66, mask);

        // Rolling hills everywhere
        const hills = noise.fbm(wx * 3.4e-4, wz * 3.4e-4, 6) * 0.5 + 0.5;

        // Sharp ridges in mountain regions
        const ridge = Math.min(noise.ridged(wx * 2.6e-4, wz * 2.6e-4, 8), 1.25) / 1.25;

        let h = hills * 0.30 * (1 - mask * 0.6)   // hills fade under ranges
              + ridge * 0.78 * mask               // ranges rise
              + mask * 0.16;                      // plateau lift

        // Carve valleys a bit (flattens the low end)
        h = Math.pow(h, 1.30);

        // Soft square falloff so the tile edges sink below the fog line
        const dx = Math.abs(i / (res - 1) - 0.5) * 2;
        const dz = Math.abs(j / (res - 1) - 0.5) * 2;
        const edge = Math.max(dx, dz);
        h *= smoothstep(1.0, 0.86, edge);

        heights[j * res + i] = h;
      }
    }
    onProgress?.(j1 / res);
    await new Promise(r => setTimeout(r, 0)); // let the UI breathe
  }
  return heights;
}

export async function buildProceduralDataset(onProgress) {
  const res = 2048;
  const worldSize = 9000;   // metres per side
  const heightScale = 1450; // metres of relief
  const heights = await generateProcedural(res, worldSize, heightScale, 20260117, onProgress);
  return {
    id: 'procedural',
    name: 'Procedural fBM',
    res,
    worldSizeX: worldSize,
    worldSizeZ: worldSize,
    heightScale,
    heights,
    credit: 'Heightfield: seeded fBM Perlin + ridged multifractal + domain warp, generated in your browser at load time.',
    info: [
      `heightfield ${res}² samples`,
      `world ${Math.round(worldSize / 100) / 10} × ${Math.round(worldSize / 100) / 10} km`,
      `relief ${heightScale} m`,
      'fBM 6 oct · ridged 8 oct · warped',
    ],
  };
}

export async function buildGrandCanyonDataset() {
  const meta = await (await fetch('./data/grand-canyon.json')).json();
  const buf = await (await fetch('./data/grand-canyon.bin')).arrayBuffer();
  const u16 = new Uint16Array(buf);
  const res = meta.res;
  const heights = new Float32Array(res * res);
  for (let i = 0; i < heights.length; i++) heights[i] = u16[i] / 65535;
  const kmx = (meta.worldSizeX / 1000).toFixed(1);
  const kmz = (meta.worldSizeZ / 1000).toFixed(1);
  return {
    id: 'grand-canyon',
    name: 'Grand Canyon (SRTM)',
    res,
    worldSizeX: meta.worldSizeX,
    worldSizeZ: meta.worldSizeZ,
    heightScale: meta.heightScale,
    heights,
    credit: meta.credit,
    info: [
      `heightfield ${res}² @ ~${meta.metersPerPixel} m/px`,
      `world ${kmx} × ${kmz} km`,
      `relief ${Math.round(meta.heightScale)} m`,
      `${meta.latLonBounds.south.toFixed(3)}N ${meta.latLonBounds.west.toFixed(3)}W`,
    ],
  };
}

/** Bilinear sample of the normalised heightfield at uv in [0,1]². */
export function sampleHeight(heights, res, u, v) {
  const fx = Math.min(res - 1.001, Math.max(0, u * (res - 1)));
  const fz = Math.min(res - 1.001, Math.max(0, v * (res - 1)));
  const i = fx | 0, j = fz | 0;
  const tx = fx - i, tz = fz - j;
  const h00 = heights[j * res + i];
  const h10 = heights[j * res + i + 1];
  const h01 = heights[(j + 1) * res + i];
  const h11 = heights[(j + 1) * res + i + 1];
  return (h00 * (1 - tx) + h10 * tx) * (1 - tz) + (h01 * (1 - tx) + h11 * tx) * tz;
}
