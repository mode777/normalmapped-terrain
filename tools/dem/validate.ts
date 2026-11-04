/**
 * Checked-in DEM dataset validation.
 *
 * The validator is network-free: it reads the manifest, every tile, the coarse
 * grid and the seam report, reconstructs the L0 height grid, checks LOD
 * agreement, and rebakes a deterministic sample of normal tiles from the
 * reconstructed heights.
 */

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { PNG } from 'pngjs';
import type { DemGrid, Manifest, SeamReport, TileRange } from './types.ts';
import {
  bakeNormalTile,
  decodeUint16,
  tileRangeForLevel,
} from './grid.ts';

export interface ValidationSummary {
  outputDir: string;
  tileCount: number;
  normalTileSize: number;
  maxSeamError: number;
  rebuiltNormals: number;
}

function readJson<T>(path: string): T {
  return JSON.parse(readFileSync(path, 'utf8')) as T;
}

function rangeKey(r: TileRange): string {
  return `${r.level}:${r.minTx}:${r.maxTx}:${r.minTy}:${r.maxTy}:${r.count}`;
}

export function validateDataset(outputDir: string): ValidationSummary {
  const manifestPath = join(outputDir, 'manifest.json');
  if (!existsSync(manifestPath)) throw new Error(`missing manifest: ${manifestPath}`);
  const manifest = readJson<Manifest>(manifestPath);

  const cols = Math.round(manifest.localFrame.sizeMeters / manifest.localFrame.spacing);
  const rows = cols;
  const offset = manifest.localFrame.sizeMeters / (2 * manifest.localFrame.spacing);
  const tileSize = manifest.tileSize;
  const normalTileSize = tileSize * manifest.normalScale;
  const baseSpacing = manifest.localFrame.spacing;

  const expectedRanges = Array.from({ length: manifest.levels }, (_, level) => tileRangeForLevel({
    level,
    sizeMeters: manifest.localFrame.sizeMeters,
    baseSpacing,
    tileSize,
  }));
  if (expectedRanges.length !== manifest.tileRanges.length) {
    throw new Error('manifest tileRanges length does not match levels');
  }
  for (let i = 0; i < expectedRanges.length; i++) {
    if (rangeKey(expectedRanges[i]) !== rangeKey(manifest.tileRanges[i])) {
      throw new Error(`tile range mismatch at L${i}`);
    }
  }
  const expectedCount = expectedRanges.reduce((sum, r) => sum + r.count, 0);
  if (manifest.tileCount !== expectedCount) {
    throw new Error(`manifest tileCount ${manifest.tileCount} != expected ${expectedCount}`);
  }

  const l0 = expectedRanges[0];
  const l0Grid = new Float32Array(cols * rows);
  const l0Count = new Uint8Array(cols * rows);

  const heightPath = (level: number, tx: number, ty: number): string =>
    join(outputDir, 'h', String(level), `${tx}_${ty}.bin`);
  const normalPath = (level: number, tx: number, ty: number): string =>
    join(outputDir, 'n', String(level), `${tx}_${ty}.png`);

  const readHeights = (level: number, tx: number, ty: number): Float32Array => {
    const path = heightPath(level, tx, ty);
    if (!existsSync(path)) throw new Error(`missing height tile: ${path}`);
    const data = readFileSync(path);
    if (data.length !== tileSize * tileSize * 2) {
      throw new Error(`wrong height tile size: ${path} (${data.length})`);
    }
    const out = new Float32Array(tileSize * tileSize);
    for (let i = 0; i < out.length; i++) out[i] = decodeUint16(data.readUInt16LE(i * 2));
    return out;
  };

  const readNormals = (level: number, tx: number, ty: number): Buffer => {
    const path = normalPath(level, tx, ty);
    if (!existsSync(path)) throw new Error(`missing normal tile: ${path}`);
    const png = PNG.sync.read(readFileSync(path));
    if (png.width !== normalTileSize || png.height !== normalTileSize) {
      throw new Error(`wrong normal tile size: ${path} (${png.width}x${png.height})`);
    }
    return png.data;
  };

  // Reconstruct the 10 m L0 grid; every sample must be covered exactly once.
  for (let ty = l0.minTy; ty <= l0.maxTy; ty++) {
    for (let tx = l0.minTx; tx <= l0.maxTx; tx++) {
      const heights = readHeights(0, tx, ty);
      for (let j = 0; j < tileSize; j++) {
        for (let i = 0; i < tileSize; i++) {
          const gx = tx * tileSize + i + offset;
          const gy = ty * tileSize + j + offset;
          // Coarse or non-aligned datasets can have partial edge tiles;
          // their out-of-bounds samples are clamped and not part of the grid.
          if (gx < 0 || gx >= cols || gy < 0 || gy >= rows) continue;
          const index = gy * cols + gx;
          if (l0Count[index] !== 0) {
            throw new Error(`L0 grid coverage overlap at ${gx},${gy}`);
          }
          l0Count[index] = 1;
          l0Grid[index] = heights[j * tileSize + i];
        }
      }
    }
  }
  for (let i = 0; i < l0Count.length; i++) {
    if (l0Count[i] !== 1) throw new Error(`L0 grid gap at sample ${i}`);
  }

  // Every LOD sample must agree with the same world position in the L0 grid.
  for (const range of expectedRanges) {
    const levelSpacing = baseSpacing * Math.pow(2, range.level);
    const tileWorld = tileSize * levelSpacing;
    for (let ty = range.minTy; ty <= range.maxTy; ty++) {
      for (let tx = range.minTx; tx <= range.maxTx; tx++) {
        const heights = readHeights(range.level, tx, ty);
        for (let j = 0; j < tileSize; j++) {
          const z = ty * tileWorld + j * levelSpacing;
          const gy = Math.round((z + manifest.localFrame.sizeMeters / 2) / baseSpacing);
          for (let i = 0; i < tileSize; i++) {
            const x = tx * tileWorld + i * levelSpacing;
            const gx = Math.round((x + manifest.localFrame.sizeMeters / 2) / baseSpacing);
            if (gx < 0 || gx >= cols || gy < 0 || gy >= rows) continue;
            const expected = l0Grid[gy * cols + gx];
            const actual = heights[j * tileSize + i];
            if (Math.abs(actual - expected) > 1.5 / 65535) {
              throw new Error(
                `LOD mismatch L${range.level} tile ${tx},${ty} sample ${i},${j}: ${actual} vs ${expected}`,
              );
            }
          }
        }
      }
    }
  }

  // Every normal tile exists with the declared dimensions.
  for (const range of expectedRanges) {
    for (let ty = range.minTy; ty <= range.maxTy; ty++) {
      for (let tx = range.minTx; tx <= range.maxTx; tx++) {
        readNormals(range.level, tx, ty);
      }
    }
  }

  const seamReportPath = join(outputDir, manifest.seamReport.file);
  if (!existsSync(seamReportPath)) throw new Error(`missing seam report: ${seamReportPath}`);
  const seamReport = readJson<SeamReport>(seamReportPath);
  if (seamReport.levels.length !== manifest.levels) {
    throw new Error('seam report level count does not match manifest');
  }
  for (const level of seamReport.levels) {
    if (level.maxError > seamReport.threshold) {
      throw new Error(`L${level.level} normal seam error ${level.maxError} > ${seamReport.threshold}`);
    }
  }
  if (manifest.seamReport.maxError > seamReport.threshold) {
    throw new Error(`manifest seam error ${manifest.seamReport.maxError} > ${seamReport.threshold}`);
  }

  const coarsePath = join(outputDir, manifest.coarseHeight.file);
  if (!existsSync(coarsePath)) throw new Error(`missing coarse height: ${coarsePath}`);
  const coarse = readFileSync(coarsePath);
  if (coarse.length !== manifest.coarseHeight.size * manifest.coarseHeight.size * 2) {
    throw new Error(`wrong coarse height size: ${coarse.length}`);
  }

  const previewPath = join(outputDir, manifest.paths.preview);
  if (!existsSync(previewPath)) throw new Error(`missing preview: ${previewPath}`);

  // Deterministic boundary rebake sample: one interior and one edge tile per
  // level, from the reconstructed L0 grid.
  const demGrid: DemGrid = { data: l0Grid, cols, rows, spacing: baseSpacing };
  let rebuiltNormals = 0;
  for (const range of expectedRanges) {
    const candidates = [
      [0, 0],
      [range.minTx, range.minTy],
      [range.maxTx, range.maxTy],
    ] as const;
    for (const [tx, ty] of candidates) {
      const expected = readNormals(range.level, tx, ty);
      const actual = bakeNormalTile(
        demGrid,
        range.level,
        tx,
        ty,
        tileSize,
        baseSpacing,
        manifest.normalScale,
        manifest.heightScale,
      );
      let maxError = 0;
      for (let i = 0; i < actual.length; i++) {
        maxError = Math.max(maxError, Math.abs(actual[i] - expected[i]));
      }
      if (maxError > 2) {
        throw new Error(`normal rebake mismatch L${range.level} tile ${tx},${ty}: ${maxError}`);
      }
      rebuiltNormals++;
    }
  }

  return {
    outputDir,
    tileCount: manifest.tileCount,
    normalTileSize,
    maxSeamError: manifest.seamReport.maxError,
    rebuiltNormals,
  };
}
