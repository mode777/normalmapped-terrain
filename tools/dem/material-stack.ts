/**
 * Jotunheimen material stack bake.
 *
 * The stack is a whole-window 2048^2 map of four material IDs and four
 * normalized weights. This first slice uses a fixed four-material palette
 * (rock, scree, snow, grass); only the weights vary. The macro albedo is a
 * 1024^2 low-frequency version of the same blend for the far field.
 *
 * Heights are normalized to 0..1 (metres / heightScale), row 0 is north and
 * +z is south. The stack and macro row order matches the PNG/`flipY = false`
 * convention used by the renderer.
 */

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { decodeUint16, sampleBilinear } from './grid.ts';
import type { DemGrid, Manifest } from './types.ts';

export interface MaterialLibraryEntry {
  id: string;
  name: string;
  averageColor: [number, number, number];
  tileMeters: number;
  projection: 'planar' | 'triplanar';
  normalStrength: number;
  roughness: number;
  specular: number;
  slopeScale: number;
}

export interface MaterialLibraryManifest {
  packSize: number;
  materials: MaterialLibraryEntry[];
}

export interface MaterialStackSlot {
  id: string;
  /** Zero-based layer index in the material library array. */
  index: number;
  averageColor: [number, number, number];
}

export interface MaterialStackOptions {
  grid: DemGrid;
  heightScale: number;
  size: number;
  extent: number;
  macroSize: number;
  seed: number;
  slots: readonly [MaterialStackSlot, MaterialStackSlot, MaterialStackSlot, MaterialStackSlot];
}

export interface MaterialStackStats {
  weightMin: [number, number, number, number];
  weightMax: [number, number, number, number];
  weightMean: [number, number, number, number];
  sumMin: number;
  sumMax: number;
  sumMean: number;
}

export interface MaterialStackResult {
  ids: Uint8Array;
  weights: Uint8Array;
  macro: Uint8Array;
  stats: MaterialStackStats;
}

const SNOW_START = 0.84;
const clamp01 = (v: number): number => (v < 0 ? 0 : v > 1 ? 1 : v);
const smoothstep = (a: number, b: number, x: number): number => {
  const t = clamp01((x - a) / (b - a));
  return t * t * (3 - 2 * t);
};

/** Deterministic 32-bit integer hash in [0,1). */
function hash2(x: number, z: number, seed: number): number {
  let h = Math.imul(x, 374761393) + Math.imul(z, 668265263) + Math.imul(seed, 1442695041);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}

/** Bilinear value noise; periodic enough for a low-frequency break-up. */
function valueNoise(x: number, z: number, seed: number): number {
  const ix = Math.floor(x);
  const iz = Math.floor(z);
  const fx = x - ix;
  const fz = z - iz;
  const u = fx * fx * (3 - 2 * fx);
  const v = fz * fz * (3 - 2 * fz);
  const a = hash2(ix, iz, seed);
  const b = hash2(ix + 1, iz, seed);
  const c = hash2(ix, iz + 1, seed);
  const d = hash2(ix + 1, iz + 1, seed);
  return (a + (b - a) * u) * (1 - v) + (c + (d - c) * u) * v;
}

interface TerrainSample {
  height: number;
  slope: number;
  north: number;
  curvature: number;
  concavity: number;
  ridge: number;
}

function terrainSample(grid: DemGrid, x: number, z: number, d: number, heightScale: number): TerrainSample {
  const h = sampleBilinear(grid, x, z);
  const hx0 = sampleBilinear(grid, x - d, z);
  const hx1 = sampleBilinear(grid, x + d, z);
  const hz0 = sampleBilinear(grid, x, z - d);
  const hz1 = sampleBilinear(grid, x, z + d);
  const gx = (hx1 - hx0) * heightScale / (2 * d);
  const gz = (hz1 - hz0) * heightScale / (2 * d);
  const length = Math.hypot(-gx, 1, -gz);
  const ny = 1 / length;
  const nz = -gz / length;
  const curvature = clamp01((h - (hx0 + hx1 + hz0 + hz1) / 4) * 600);
  return {
    height: h,
    slope: 1 - ny,
    north: clamp01(-nz),
    curvature,
    concavity: clamp01(-(h - (hx0 + hx1 + hz0 + hz1) / 4) * 600),
    ridge: curvature,
  };
}

/**
 * Four weights in slot order [rock, scree, snow, grass]. Rock is the implicit
 * base; the overlays are reduced on steep and convex ground, so steepness
 * drives rock/cliff without a separate mask.
 */
export function weightsAt(
  grid: DemGrid,
  x: number,
  z: number,
  d: number,
  heightScale: number,
  seed: number,
): [number, number, number, number] {
  const sample = terrainSample(grid, x, z, d, heightScale);
  const ridgeNoise = valueNoise(x / 900, z / 900, seed);
  const bandNoise = valueNoise(x / 2600, z / 2600, seed + 1);
  const patchNoise = valueNoise(x / 4200, z / 4200, seed + 2);

  let snow = smoothstep(SNOW_START, SNOW_START + 0.14, sample.height * 1.06)
    * (1 - 0.7 * smoothstep(0.30, 0.62, sample.slope))
    * (0.55 + 0.45 * sample.north)
    * (0.82 + 0.18 * ridgeNoise);
  let grass = (1 - smoothstep(0.42, 0.60, sample.height))
    * (0.55 + 0.45 * bandNoise)
    * (1 - 0.85 * smoothstep(0.26, 0.55, sample.slope))
    * (0.65 + 0.35 * sample.concavity);
  let scree = smoothstep(0.18, 0.42, sample.slope)
    * (1 - 0.65 * snow)
    * (0.40 + 0.60 * bandNoise)
    * (0.75 + 0.25 * patchNoise)
    * (0.60 + 0.40 * (1 - smoothstep(0.55, 0.85, sample.height)));

  snow *= 1 - 0.25 * sample.ridge;
  grass *= 1 - 0.45 * sample.ridge;
  scree *= 1 - 0.10 * sample.ridge;

  snow = clamp01(snow);
  grass = clamp01(grass);
  scree = clamp01(scree);
  const overlays = snow + scree + grass;
  if (overlays > 0.94) {
    const k = 0.94 / overlays;
    snow *= k;
    scree *= k;
    grass *= k;
  }
  const rock = Math.max(0, 1 - snow - scree - grass);
  return [rock, scree, snow, grass];
}

/** Loads and minimally validates the packed material library manifest. */
export function loadMaterialLibrary(path: string): MaterialLibraryManifest {
  if (!existsSync(path)) throw new Error(`missing material library: ${path}`);
  const manifest = JSON.parse(readFileSync(path, 'utf8')) as MaterialLibraryManifest;
  if (!Array.isArray(manifest.materials) || manifest.materials.length === 0) {
    throw new Error(`material library has no materials: ${path}`);
  }
  if (manifest.materials.length > 24) {
    throw new Error(`material library has ${manifest.materials.length} materials, cap is 24`);
  }
  for (const entry of manifest.materials) {
    if (!entry.id || !Array.isArray(entry.averageColor) || entry.averageColor.length !== 3) {
      throw new Error(`material library entry is invalid: ${String(entry.id)}`);
    }
  }
  return manifest;
}

export function materialIndex(library: MaterialLibraryManifest, id: string): number {
  const index = library.materials.findIndex((m) => m.id === id);
  if (index < 0) throw new Error(`material ${id} is not in the library`);
  return index;
}

/**
 * Reconstructs the 10 m L0 grid from the checked-in height tiles. This lets the
 * material stack be rebaked without the source GeoTIFF.
 */
export function loadDatasetGrid(manifest: Manifest, outputDir: string): DemGrid {
  const cols = Math.round(manifest.localFrame.sizeMeters / manifest.localFrame.spacing);
  const rows = cols;
  const offset = manifest.localFrame.sizeMeters / (2 * manifest.localFrame.spacing);
  const tileSize = manifest.tileSize;
  const range = manifest.tileRanges[0];
  if (!range) throw new Error('manifest has no L0 tile range');
  const data = new Float32Array(cols * rows);
  const seen = new Uint8Array(cols * rows);

  for (let ty = range.minTy; ty <= range.maxTy; ty++) {
    for (let tx = range.minTx; tx <= range.maxTx; tx++) {
      const path = join(outputDir, 'h', '0', `${tx}_${ty}.bin`);
      if (!existsSync(path)) throw new Error(`missing L0 height tile: ${path}`);
      const buffer = readFileSync(path);
      if (buffer.length !== tileSize * tileSize * 2) {
        throw new Error(`wrong L0 height tile size: ${path} (${buffer.length})`);
      }
      for (let j = 0; j < tileSize; j++) {
        for (let i = 0; i < tileSize; i++) {
          const gx = tx * tileSize + i + offset;
          const gy = ty * tileSize + j + offset;
          if (gx < 0 || gx >= cols || gy < 0 || gy >= rows) continue;
          const index = gy * cols + gx;
          if (seen[index] !== 0) throw new Error(`L0 grid overlap at ${gx},${gy}`);
          seen[index] = 1;
          data[index] = decodeUint16(buffer.readUInt16LE((j * tileSize + i) * 2));
        }
      }
    }
  }
  for (let i = 0; i < seen.length; i++) {
    if (seen[i] !== 1) throw new Error(`L0 grid gap at sample ${i}`);
  }
  return { data, cols, rows, spacing: manifest.localFrame.spacing };
}

export function bakeMaterialStack(options: MaterialStackOptions): MaterialStackResult {
  const { grid, heightScale, size, extent, macroSize, seed, slots } = options;
  const half = extent / 2;
  const stackSpacing = extent / size;
  const macroSpacing = extent / macroSize;
  const ids = new Uint8Array(size * size * 4);
  const weights = new Uint8Array(size * size * 4);

  const weightMin: [number, number, number, number] = [Infinity, Infinity, Infinity, Infinity];
  const weightMax: [number, number, number, number] = [-Infinity, -Infinity, -Infinity, -Infinity];
  const weightSum: [number, number, number, number] = [0, 0, 0, 0];
  let sumMin = Infinity;
  let sumMax = -Infinity;
  let sumTotal = 0;

  for (let j = 0; j < size; j++) {
    const z = -half + (j + 0.5) * stackSpacing;
    for (let i = 0; i < size; i++) {
      const x = -half + (i + 0.5) * stackSpacing;
      const w = weightsAt(grid, x, z, stackSpacing, heightScale, seed);
      const o = (j * size + i) * 4;

      let total = 0;
      const q: [number, number, number, number] = [0, 0, 0, 0];
      for (let k = 0; k < 4; k++) {
        ids[o + k] = slots[k].index;
        q[k] = Math.round(w[k] * 255);
        total += q[k];
        weightMin[k] = Math.min(weightMin[k], w[k]);
        weightMax[k] = Math.max(weightMax[k], w[k]);
        weightSum[k] += w[k];
      }
      // Force the four quantized weights to sum to exactly 255.
      let diff = 255 - total;
      if (diff !== 0) {
        let largest = 0;
        for (let k = 1; k < 4; k++) if (q[k] > q[largest]) largest = k;
        q[largest] = Math.max(0, Math.min(255, q[largest] + diff));
        diff = 255 - (q[0] + q[1] + q[2] + q[3]);
        if (diff !== 0) q[0] = Math.max(0, Math.min(255, q[0] + diff));
      }
      const sum = (q[0] + q[1] + q[2] + q[3]) / 255;
      sumMin = Math.min(sumMin, sum);
      sumMax = Math.max(sumMax, sum);
      sumTotal += sum;
      for (let k = 0; k < 4; k++) weights[o + k] = q[k];
    }
  }

  const macro = new Uint8Array(macroSize * macroSize * 4);
  for (let j = 0; j < macroSize; j++) {
    const z = -half + (j + 0.5) * macroSpacing;
    for (let i = 0; i < macroSize; i++) {
      const x = -half + (i + 0.5) * macroSpacing;
      const w = weightsAt(grid, x, z, macroSpacing, heightScale, seed);
      const variation = 0.88 + 0.24 * valueNoise(x / 3200, z / 3200, seed + 3);
      const o = (j * macroSize + i) * 4;
      for (let c = 0; c < 3; c++) {
        const color = w[0] * slots[0].averageColor[c]
          + w[1] * slots[1].averageColor[c]
          + w[2] * slots[2].averageColor[c]
          + w[3] * slots[3].averageColor[c];
        macro[o + c] = Math.round(clamp01(color * variation) * 255);
      }
      macro[o + 3] = 255;
    }
  }

  const pixels = size * size;
  return {
    ids,
    weights,
    macro,
    stats: {
      weightMin,
      weightMax,
      weightMean: [
        weightSum[0] / pixels,
        weightSum[1] / pixels,
        weightSum[2] / pixels,
        weightSum[3] / pixels,
      ],
      sumMin,
      sumMax,
      sumMean: sumTotal / pixels,
    },
  };
}
