/**
 * Infinite procedural heightfield + per-tile Sobel normal baking.
 *
 * This is the large-world sibling of src/terrain-data.js / src/normalmap.js:
 * the same heightfield -> float gradient -> object-space normal-map pipeline,
 * but evaluated per tile at an arbitrary world coordinate instead of being
 * generated once for a finite square.
 *
 * The height function is deterministic for a given seed. Every tile is
 * sampled in absolute world metres, so adjacent tiles and adjacent LODs agree
 * at shared sample positions.
 */

import { Perlin } from '../perlin.js';

export const DEFAULT_SEED = 20260214;
export const DEFAULT_HEIGHT_SCALE = 1500; // metres of relief for h in [0,1]

const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);
const smoothstep = (a, b, x) => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

/**
 * Creates a seeded, effectively infinite height function.
 *
 * Returns normalized heights in [0,1]. Multiply by `heightScale` for metres.
 * The same object can be created in the worker and on the main thread; as
 * long as the seed matches, both evaluate the same field.
 */
export function makeHeightField(seed = DEFAULT_SEED) {
  const warpA = new Perlin(seed + 11);
  const warpB = new Perlin(seed + 29);
  const continent = new Perlin(seed + 53);
  const maskNoise = new Perlin(seed + 71);
  const hillsNoise = new Perlin(seed + 97);
  const ridgeNoise = new Perlin(seed + 131);
  const detailNoise = new Perlin(seed + 173);
  const fineNoise = new Perlin(seed + 211);
  const microNoise = new Perlin(seed + 257);
  const micro2Noise = new Perlin(seed + 283);

  function heightAt(x, z) {
    // Domain warp keeps the ranges from looking axis-aligned. Roughly 6 km
    // wavelength at the warp frequency; amplitude is in metres.
    const wx = x + 1900 * warpA.noise2(x * 1.7e-4 + 7.3, z * 1.7e-4);
    const wz = z + 1900 * warpB.noise2(x * 1.7e-4, z * 1.7e-4 + 3.1);

    // Very low frequency continent/plateau variation (~45 km).
    const cont = continent.fbm(wx * 2.2e-5, wz * 2.2e-5, 2) * 0.5 + 0.5;

    // Where mountain ranges live (~14 km).
    let mask = maskNoise.fbm(wx * 7.0e-5, wz * 7.0e-5, 3) * 0.5 + 0.5;
    mask = smoothstep(0.36, 0.68, mask);

    // Rolling hills (~3.8 km base wavelength).
    const hills = hillsNoise.fbm(wx * 2.6e-4, wz * 2.6e-4, 5) * 0.5 + 0.5;

    // Ridged multifractal crests (~5.9 km base wavelength).
    const ridge = Math.min(ridgeNoise.ridged(wx * 1.7e-4, wz * 1.7e-4, 7), 1.25) / 1.25;

    // Multi-scale roughness for the normal map. `fine` and `micro` are below
    // the clipmap's 8 m vertex spacing, so they live almost entirely in the
    // normal map — exactly what this PoC is meant to show.
    const detail = detailNoise.fbm(wx * 1.4e-3, wz * 1.4e-3, 3);
    const fine = fineNoise.fbm(wx * 6.5e-3, wz * 6.5e-3, 3);
    const micro = microNoise.fbm(wx * 2.5e-2, wz * 2.5e-2, 2);
    const micro2 = micro2Noise.fbm(wx * 6.0e-2, wz * 6.0e-2, 2);

    let h = hills * 0.32 * (1 - mask * 0.55)
          + ridge * 0.82 * mask
          + mask * 0.18;

    h = Math.pow(h, 1.28);
    h *= 0.72 + 0.55 * cont;
    // The 4x normal map can resolve these; the 16m mesh cannot.
    h += detail * 0.030;
    h += fine * 0.018;
    h += micro * 0.010;
    h += micro2 * 0.004;

    return clamp01(h);
  }

  return { seed, heightAt, heightScale: DEFAULT_HEIGHT_SCALE };
}

/**
 * Bakes a tile of object-space normals from a float height patch.
 *
 * @param {Float32Array} heightsHalo (tileSize+2)^2, row-major, one-sample halo
 * @param {number} tileSize         samples per side of the output tile
 * @param {number} spacing          metres between samples
 * @param {number} heightScale      metres for heights going 0 -> 1
 * @returns {Uint8Array} tileSize^2 * 4, RGBA8 (R=N.x, G=N.z, B=N.y)
 */
export function bakeTileNormals(heightsHalo, tileSize, spacing, heightScale) {
  const out = new Uint8Array(tileSize * tileSize * 4);
  const stride = tileSize + 2;
  const gradScale = heightScale / (8 * spacing);

  for (let j = 0; j < tileSize; j++) {
    const row = (j + 1) * stride;
    const rowUp = j * stride;
    const rowDown = (j + 2) * stride;

    for (let i = 0; i < tileSize; i++) {
      const c = i + 1;

      const tl = heightsHalo[rowUp + c - 1], t = heightsHalo[rowUp + c], tr = heightsHalo[rowUp + c + 1];
      const l = heightsHalo[row + c - 1], r = heightsHalo[row + c + 1];
      const bl = heightsHalo[rowDown + c - 1], b = heightsHalo[rowDown + c], br = heightsHalo[rowDown + c + 1];

      // Sobel X (columns = world x) and Z (rows = world z). Same derivation
      // as src/normalmap.js: response is divided by 8 * pixelSpacing and
      // multiplied by heightScale before forming N ∝ (-dh/dx, 1, -dh/dz).
      const gx = (tr + 2 * r + br) - (tl + 2 * l + bl);
      const gz = (bl + 2 * b + br) - (tl + 2 * t + tr);

      let nx = -gx * gradScale;
      let ny = 1.0;
      let nz = -gz * gradScale;
      const inv = 1.0 / Math.sqrt(nx * nx + ny * ny + nz * nz);
      nx *= inv; ny *= inv; nz *= inv;

      const o = (j * tileSize + i) * 4;
      out[o] = Math.round((nx * 0.5 + 0.5) * 255);
      out[o + 1] = Math.round((nz * 0.5 + 0.5) * 255);
      out[o + 2] = Math.round((ny * 0.5 + 0.5) * 255);
      out[o + 3] = 255;
    }
  }

  return out;
}

/**
 * Generates one tile at a given LOD.
 *
 * Tile (tx,ty) at LOD L covers world cells
 *   [tx*T, ty*T] .. [tx*T+T-1, ty*T+T-1]
 * with spacing S_L = baseSpacing * 2^L.
 *
 * Normal maps are baked at `normalScale` times the height-tile resolution
 * (default 2x), so they can carry detail below the clipmap vertex spacing.
 * Both tiles cover the same world square.
 *
 * @returns {{heights: Float32Array, normals: Uint8Array}}
 */
export function generateTile(heightField, {
  level,
  tx,
  ty,
  tileSize = 64,
  baseSpacing = 8,
  heightScale = DEFAULT_HEIGHT_SCALE,
  normalScale = 1,
}) {
  const spacing = baseSpacing * Math.pow(2, level);
  const normalRes = tileSize * normalScale;
  const normalSpacing = spacing / normalScale;
  const stride = normalRes + 2;
  const halo = new Float32Array(stride * stride);
  const heights = new Float32Array(tileSize * tileSize);

  const originX = tx * tileSize * spacing;
  const originZ = ty * tileSize * spacing;

  for (let j = -1; j <= normalRes; j++) {
    const worldZ = originZ + j * normalSpacing;
    const row = (j + 1) * stride;
    for (let i = -1; i <= normalRes; i++) {
      const worldX = originX + i * normalSpacing;
      halo[row + i + 1] = heightField.heightAt(worldX, worldZ);
    }
  }

  // Height samples sit on the clipmap vertex grid (every normalScale-th
  // sample of the high-resolution halo).
  for (let j = 0; j < tileSize; j++) {
    const row = (j * normalScale + 1) * stride;
    for (let i = 0; i < tileSize; i++) {
      heights[j * tileSize + i] = halo[row + i * normalScale + 1];
    }
  }

  const normals = bakeTileNormals(halo, normalRes, normalSpacing, heightScale);
  return { heights, normals };
}
