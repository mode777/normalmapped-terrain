/**
 * Seamless diagnostic detail-normal tile.
 *
 * The tile is a periodic height field baked with the same object-space Sobel
 * path as the terrain normals (`bakeTileNormals`): R = N.x, G = N.z, B = N.y.
 * The height function is periodic in both axes and the bake wraps its halo, so
 * the tile repeats without a seam.
 *
 * This is deliberately a diagnostic tile, not beauty art: a broad fBm base, a
 * ridged layer, an anisotropic diagonal and high-frequency grain make an
 * inverted green channel or a swapped axis obvious under a low sun.
 */

import { bakeTileNormals } from '../../src/terrain/normals.ts';

/** Texels per side of the checked-in tile. */
export const DETAIL_TILE_SIZE = 512;
/** Reference world size of one tile, metres; the shader scales from this. */
export const DETAIL_TILE_WORLD_SIZE = 16;
/** Metres of relief for normalized height 1; sets the tile's slope range. */
export const DETAIL_HEIGHT_SCALE = 4;

const mod = (v: number, m: number): number => ((v % m) + m) % m;

/** Stable 2D integer hash in [0, 1]. */
function hash2(ix: number, iy: number, seed: number): number {
  let h = Math.imul(ix, 374761393) ^ Math.imul(iy, 668265263) ^ Math.imul(seed, 1442695041);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967295;
}

const smooth = (t: number): number => t * t * (3 - 2 * t);

/**
 * Periodic value noise. `x`/`y` are in lattice units and `period` is the
 * integer lattice size, so the field wraps exactly at x = period (and y).
 */
function valueNoise(x: number, y: number, period: number, seed: number): number {
  const ix = Math.floor(x);
  const iy = Math.floor(y);
  const fx = x - ix;
  const fy = y - iy;
  const u = smooth(fx);
  const v = smooth(fy);

  const x0 = mod(ix, period);
  const x1 = mod(ix + 1, period);
  const y0 = mod(iy, period);
  const y1 = mod(iy + 1, period);

  const a = hash2(x0, y0, seed);
  const b = hash2(x1, y0, seed);
  const c = hash2(x0, y1, seed);
  const d = hash2(x1, y1, seed);

  const top = a + (b - a) * u;
  const bottom = c + (d - c) * u;
  return top + (bottom - top) * v;
}

/** Periodic fBm in [0, 1]. */
function fbm(u: number, v: number, baseFreq: number, octaves: number, seed: number): number {
  let sum = 0;
  let amp = 0.5;
  let freq = baseFreq;
  let norm = 0;
  for (let o = 0; o < octaves; o++) {
    sum += amp * valueNoise(u * freq, v * freq, freq, seed + o * 101);
    norm += amp;
    amp *= 0.5;
    freq *= 2;
  }
  return sum / norm;
}

/** Periodic normalized height at tile coordinates `u`, `v` in [0, 1]. */
export function detailHeight(u: number, v: number): number {
  const base = fbm(u, v, 4, 5, 1337);
  const ridge = 1 - Math.abs(2 * fbm(u + 0.31, v + 0.17, 3, 4, 9001) - 1);
  const fine = fbm(u, v, 32, 3, 4242);
  // An anisotropic diagonal gives the tile an unmistakable direction for the
  // low-sun orientation check.
  const diagonal = 0.5 + 0.5 * Math.sin(2 * Math.PI * (3 * u + 2 * v) + 0.7);
  return 0.5 * base + 0.25 * ridge * ridge + 0.15 * fine + 0.1 * diagonal;
}

export interface DetailTile {
  size: number;
  /** `size^2 * 4` RGBA8 object-space normals. */
  normals: Uint8Array;
}

/** Builds the deterministic seamless diagnostic tile in memory. */
export function buildDetailTile(): DetailTile {
  const size = DETAIL_TILE_SIZE;
  const stride = size + 2;
  const halo = new Float32Array(stride * stride);

  for (let j = -1; j <= size; j++) {
    const v = mod(j, size) / size;
    for (let i = -1; i <= size; i++) {
      const u = mod(i, size) / size;
      halo[(j + 1) * stride + (i + 1)] = detailHeight(u, v);
    }
  }

  const normals = bakeTileNormals(
    halo,
    size,
    DETAIL_TILE_WORLD_SIZE / size,
    DETAIL_HEIGHT_SCALE,
  );
  return { size, normals };
}
