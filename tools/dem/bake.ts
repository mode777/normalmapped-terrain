/**
 * Offline DEM bake.
 *
 * One global height grid feeds every LOD. Normals are baked per tile from a
 * one-texel halo of that same grid, which keeps shared boundaries continuous.
 */

import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { PNG } from 'pngjs';
import type {
  DemConfig,
  DemGrid,
  Manifest,
  SeamLevelReport,
  SeamReport,
  TileRange,
} from './types.ts';
import {
  bakeCoarseGrid,
  bakeHeightTile,
  bakeNormalTile,
  encodeUint16,
  referenceNormal,
  sampleBilinear,
  tileRangeForLevel,
  tileWorldForLevel,
} from './grid.ts';
import { loadSourceGrid } from './kartverket.ts';

const BAKE_VERSION = 1;
const COARSE_SIZE = 1024;
const SEAM_THRESHOLD = 2;

export interface BakeSummary {
  outputDir: string;
  tileCount: number;
  heightRange: [number, number];
  maxSeamError: number;
  sourceLastModified?: string;
}

function ensureCleanOutput(outputDir: string): void {
  mkdirSync(outputDir, { recursive: true });
  for (const name of ['h', 'n', 'manifest.json', 'seam-report.json', 'coarse-height.bin', 'preview.png']) {
    rmSync(join(outputDir, name), { recursive: true, force: true });
  }
}

function writeHeightTile(path: string, heights: Float32Array): void {
  const buffer = Buffer.allocUnsafe(heights.length * 2);
  for (let i = 0; i < heights.length; i++) {
    buffer.writeUInt16LE(encodeUint16(heights[i]), i * 2);
  }
  writeFileSync(path, buffer);
}

function writeNormalPng(path: string, normals: Uint8Array, size: number): void {
  const png = new PNG({ width: size, height: size });
  png.data.set(normals);
  writeFileSync(path, PNG.sync.write(png));
}

function writePreview(path: string, grid: DemGrid, size: number, heightRange: [number, number]): void {
  const png = new PNG({ width: size, height: size });
  const half = (grid.cols * grid.spacing) / 2;
  const step = (grid.cols * grid.spacing) / (size - 1);
  let min = Infinity;
  let max = -Infinity;
  const heights = new Float32Array(size * size);
  for (let j = 0; j < size; j++) {
    const z = -half + j * step;
    for (let i = 0; i < size; i++) {
      const x = -half + i * step;
      const h = sampleBilinear(grid, x, z);
      heights[j * size + i] = h;
      if (h < min) min = h;
      if (h > max) max = h;
    }
  }

  for (let j = 0; j < size; j++) {
    for (let i = 0; i < size; i++) {
      const h = heights[j * size + i];
      const left = heights[j * size + Math.max(0, i - 1)];
      const right = heights[j * size + Math.min(size - 1, i + 1)];
      const up = heights[Math.max(0, j - 1) * size + i];
      const down = heights[Math.min(size - 1, j + 1) * size + i];
      const gx = (right - left) / (2 * step);
      const gz = (down - up) / (2 * step);
      let nx = -gx * 1.5;
      let ny = 1;
      let nz = -gz * 1.5;
      const inv = 1 / Math.hypot(nx, ny, nz);
      nx *= inv; ny *= inv; nz *= inv;
      const shade = Math.max(0, 0.3 + 0.7 * (nx * -0.45 + ny * 0.75 + nz * -0.45));
      const t = (h - min) / Math.max(1e-9, max - min);
      let r: number, g: number, b: number;
      if (t < 0.55) {
        const k = t / 0.55;
        r = 40 + 80 * k; g = 70 + 70 * k; b = 35 + 45 * k;
      } else {
        const k = (t - 0.55) / 0.45;
        r = 120 + 125 * k; g = 140 + 105 * k; b = 80 + 170 * k;
      }
      const o = (j * size + i) * 4;
      png.data[o] = Math.min(255, Math.max(0, r * shade));
      png.data[o + 1] = Math.min(255, Math.max(0, g * shade));
      png.data[o + 2] = Math.min(255, Math.max(0, b * shade));
      png.data[o + 3] = 255;
    }
  }
  // Keep the parameter meaningful in the signature even if the preview uses
  // the sampled min/max above.
  void heightRange;
  writeFileSync(path, PNG.sync.write(png));
}

export async function bakeDem(config: DemConfig): Promise<BakeSummary> {
  const outputDir = config.outputDir;
  ensureCleanOutput(outputDir);

  process.stderr.write(`Reading ${config.dataset} source...\n`);
  const source = await loadSourceGrid(config);
  const elevations = source.elevations;
  let minElevation = Infinity;
  let maxElevation = -Infinity;
  const normalized = new Float32Array(elevations.length);
  for (let i = 0; i < elevations.length; i++) {
    const e = elevations[i];
    if (e < minElevation) minElevation = e;
    if (e > maxElevation) maxElevation = e;
    normalized[i] = Math.max(0, Math.min(1, e / config.heightScale));
  }

  const grid: DemGrid = {
    data: normalized,
    cols: source.grid.cols,
    rows: source.grid.rows,
    spacing: source.grid.spacing,
  };

  const tileRanges: TileRange[] = [];
  const seamLevels: SeamLevelReport[] = [];
  let tileCount = 0;
  let maxSeamError = 0;

  for (let level = 0; level < config.levels; level++) {
    const range = tileRangeForLevel({
      level,
      sizeMeters: config.sizeMeters,
      baseSpacing: config.spacing,
      tileSize: config.tileSize,
    });
    tileRanges.push(range);
    tileCount += range.count;
    const spacing = config.spacing * Math.pow(2, level);
    const tileWorld = tileWorldForLevel(config.spacing, config.tileSize, level);
    const normalTileSize = config.tileSize * config.normalScale;
    const normalSpacing = spacing / config.normalScale;
    const heightDir = join(outputDir, 'h', String(level));
    const normalDir = join(outputDir, 'n', String(level));
    mkdirSync(heightDir, { recursive: true });
    mkdirSync(normalDir, { recursive: true });

    let seamSamples = 0;
    let seamErrorSum = 0;
    let seamMax = 0;

    for (let ty = range.minTy; ty <= range.maxTy; ty++) {
      for (let tx = range.minTx; tx <= range.maxTx; tx++) {
        const heights = bakeHeightTile(grid, level, tx, ty, config.tileSize, config.spacing);
        writeHeightTile(join(heightDir, `${tx}_${ty}.bin`), heights);
        const normals = bakeNormalTile(
          grid, level, tx, ty, config.tileSize, config.spacing,
          config.normalScale, config.heightScale,
        );
        writeNormalPng(join(normalDir, `${tx}_${ty}.png`), normals, normalTileSize);

        // Reference-check every normal texel on the tile perimeter.
        for (let edge = 0; edge < 4; edge++) {
          for (let k = 0; k < normalTileSize; k++) {
            let i: number, j: number;
            if (edge === 0) { i = k; j = 0; }
            else if (edge === 1) { i = k; j = normalTileSize - 1; }
            else if (edge === 2) { i = 0; j = k; }
            else { i = normalTileSize - 1; j = k; }
            const x = tx * tileWorld + i * normalSpacing;
            const z = ty * tileWorld + j * normalSpacing;
            const expected = referenceNormal(grid, x, z, normalSpacing, config.heightScale);
            const o = (j * normalTileSize + i) * 4;
            let err = 0;
            for (let c = 0; c < 3; c++) {
              err = Math.max(err, Math.abs(normals[o + c] - expected[c]));
            }
            seamSamples++;
            seamErrorSum += err;
            if (err > seamMax) seamMax = err;
          }
        }
      }
    }

    const levelReport: SeamLevelReport = {
      level,
      samples: seamSamples,
      maxError: seamMax,
      meanError: seamSamples > 0 ? seamErrorSum / seamSamples : 0,
    };
    seamLevels.push(levelReport);
    if (seamMax > maxSeamError) maxSeamError = seamMax;
    process.stderr.write(
      `  L${level}: ${range.count} tiles, ${seamSamples} seam samples, max error ${seamMax}\n`,
    );
  }

  const coarse = bakeCoarseGrid(grid, COARSE_SIZE);
  writeFileSync(join(outputDir, 'coarse-height.bin'), Buffer.from(coarse.data.buffer));
  writePreview(join(outputDir, 'preview.png'), grid, 1024, [minElevation, maxElevation]);

  const seamReport: SeamReport = {
    version: 1,
    threshold: SEAM_THRESHOLD,
    levels: seamLevels,
  };
  writeFileSync(join(outputDir, 'seam-report.json'), `${JSON.stringify(seamReport, null, 2)}\n`);

  let minNorm = Infinity;
  let maxNorm = -Infinity;
  for (const v of normalized) {
    if (v < minNorm) minNorm = v;
    if (v > maxNorm) maxNorm = v;
  }

  const manifestSource: Manifest['source'] = {
    type: source.sourceType,
    crs: config.source.type === 'kartverket-wcs'
      ? config.source.crs
      : (config.source.crs ?? 'EPSG:25833'),
    bbox: [source.bbox.west, source.bbox.south, source.bbox.east, source.bbox.north],
    resolution: config.spacing,
  };
  if (config.source.type === 'kartverket-wcs') {
    manifestSource.url = config.source.url;
    manifestSource.coverage = config.source.coverage;
  } else {
    manifestSource.path = config.source.path;
  }
  if (source.lastModified !== undefined) manifestSource.lastModified = source.lastModified;

  const manifest: Manifest = {
    version: 1,
    dataset: config.dataset,
    bakeVersion: BAKE_VERSION,
    source: manifestSource,
    license: config.license,
    attribution: config.attribution,
    localFrame: {
      centerE: config.centerE,
      centerN: config.centerN,
      sizeMeters: config.sizeMeters,
      spacing: config.spacing,
      xAxis: 'east',
      zAxis: 'south',
      origin: 'center',
    },
    baseSpacing: config.spacing,
    tileSize: config.tileSize,
    normalScale: config.normalScale,
    levels: config.levels,
    heightScale: config.heightScale,
    heightRange: [minElevation, maxElevation],
    normalizedRange: [minNorm, maxNorm],
    heightEncoding: 'uint16le-normalized',
    normalEncoding: 'rgba8-objectspace',
    paths: {
      height: 'h/{level}/{tx}_{ty}.bin',
      normal: 'n/{level}/{tx}_{ty}.png',
      coarseHeight: 'coarse-height.bin',
      seamReport: 'seam-report.json',
      preview: 'preview.png',
    },
    coarseHeight: {
      file: 'coarse-height.bin',
      size: COARSE_SIZE,
      spacing: coarse.spacing,
      encoding: 'uint16le-normalized',
      heightScale: config.heightScale,
    },
    tileRanges,
    tileCount,
    seamReport: {
      file: 'seam-report.json',
      threshold: SEAM_THRESHOLD,
      maxError: maxSeamError,
    },
  };
  writeFileSync(join(outputDir, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);

  const summary: BakeSummary = {
    outputDir,
    tileCount,
    heightRange: [minElevation, maxElevation],
    maxSeamError,
  };
  if (source.lastModified !== undefined) summary.sourceLastModified = source.lastModified;
  return summary;
}
