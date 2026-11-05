/**
 * Checked-in DEM dataset validation.
 *
 * The validator is network-free: it reads the manifest, every tile, the coarse
 * grid and the seam report, reconstructs the L0 height grid, checks LOD
 * agreement, and rebakes a deterministic sample of normal tiles from the
 * reconstructed heights.
 */

import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { PNG } from 'pngjs';
import type { DemGrid, Manifest, SeamReport, TileRange } from './types.ts';
import {
  bakeNormalTile,
  decodeUint16,
  tileRangeForLevel,
} from './grid.ts';
import { loadMaterialLibrary, materialIndex } from './material-stack.ts';

export interface ValidationSummary {
  outputDir: string;
  tileCount: number;
  normalTileSize: number;
  maxSeamError: number;
  rebuiltNormals: number;
  materialStackSize?: number;
  materialMacroSize?: number;
  materialWeightMean?: [number, number, number, number];
  materialWeightRange?: Array<[number, number]>;
}

function readJson<T>(path: string): T {
  return JSON.parse(readFileSync(path, 'utf8')) as T;
}

function rangeKey(r: TileRange): string {
  return `${r.level}:${r.minTx}:${r.maxTx}:${r.minTy}:${r.maxTy}:${r.count}`;
}

function sha256File(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

function readRgba(path: string, size: number, label: string): Buffer {
  if (!existsSync(path)) throw new Error(`missing ${label}: ${path}`);
  const png = PNG.sync.read(readFileSync(path));
  if (png.width !== size || png.height !== size) {
    throw new Error(`wrong ${label} size: ${path} (${png.width}x${png.height}, expected ${size})`);
  }
  if (png.data.length !== size * size * 4) {
    throw new Error(`wrong ${label} channels: ${path} (${png.data.length} bytes)`);
  }
  return png.data;
}

function validateMaterials(
  manifest: Manifest,
  outputDir: string,
): {
  materialStackSize: number;
  materialMacroSize: number;
  materialWeightMean: [number, number, number, number];
  materialWeightRange: Array<[number, number]>;
} {
  const block = manifest.materials;
  if (!block) throw new Error('missing materials block');
  if (block.slots.length !== 4) throw new Error('material slots must contain four IDs');
  if (block.stack.extent !== manifest.localFrame.sizeMeters) {
    throw new Error(
      `material stack extent ${block.stack.extent} != local frame ${manifest.localFrame.sizeMeters}`,
    );
  }
  const publicRoot = join(outputDir, '..', '..');
  let libraryPath = join(publicRoot, block.library);
  if (!existsSync(libraryPath)) {
    // `--out` can point outside public/data/<dataset>; fall back to the
    // repository's checked-in public root.
    libraryPath = join(process.cwd(), 'public', block.library);
  }
  const library = loadMaterialLibrary(libraryPath);
  if (new Set(block.slots).size !== 4) throw new Error('material slots are not unique');
  const expectedIndices = block.slots.map((id) => materialIndex(library, id));

  // Multi-palette stacks may use a different four-ID set in each region and
  // transition band. Build the allowed quartets and validate every texel
  // against them; the single-palette path stays exactly as before.
  const paletteQuartets = new Map<string, string>();
  const transitionQuartets = new Map<string, string>();
  const hasPalettes = (block.palettes?.length ?? 0) > 0;
  if (hasPalettes) {
    const regionIds = new Set<string>();
    for (const palette of block.palettes ?? []) {
      if (!palette.id) throw new Error('material palette is missing an id');
      if (regionIds.has(palette.id)) throw new Error(`duplicate material palette ${palette.id}`);
      regionIds.add(palette.id);
      if (palette.slots.length !== 4) {
        throw new Error(`material palette ${palette.id} must have four IDs`);
      }
      if (new Set(palette.slots).size !== 4) {
        throw new Error(`material palette ${palette.id} slots are not unique`);
      }
      const indices = palette.slots.map((id) => {
        try {
          return materialIndex(library, id);
        } catch {
          throw new Error(`material palette ${palette.id} references missing material ${id}`);
        }
      });
      paletteQuartets.set(indices.join(','), `palette ${palette.id}`);
    }
    for (const transition of block.transitions ?? []) {
      const label = `transition ${transition.from}->${transition.to}`;
      if (!regionIds.has(transition.from) || !regionIds.has(transition.to)) {
        throw new Error(`${label} references an unknown region`);
      }
      if (!(transition.width > 0)) throw new Error(`${label} has invalid width`);
      if (transition.slots.length !== 4) throw new Error(`${label} must have four IDs`);
      if (new Set(transition.slots).size !== 4) throw new Error(`${label} slots are not unique`);
      const indices = transition.slots.map((id) => {
        try {
          return materialIndex(library, id);
        } catch {
          throw new Error(`${label} references missing material ${id}`);
        }
      });
      transitionQuartets.set(indices.join(','), label);
    }
    if (paletteQuartets.size + transitionQuartets.size === 0) {
      throw new Error('material palettes are declared but none are valid');
    }
  }

  const idsPath = join(outputDir, block.stack.ids);
  const weightsPath = join(outputDir, block.stack.weights);
  const macroPath = join(outputDir, block.macro);
  const ids = readRgba(idsPath, block.stack.size, 'material IDs');
  const weights = readRgba(weightsPath, block.stack.size, 'material weights');
  const macro = readRgba(macroPath, block.macroSize, 'macro albedo');

  if (!block.hashes || !block.hashes.ids || !block.hashes.weights || !block.hashes.macro) {
    throw new Error('material hashes are missing');
  }
  if (sha256File(idsPath) !== block.hashes.ids) throw new Error('material IDs hash mismatch');
  if (sha256File(weightsPath) !== block.hashes.weights) throw new Error('material weights hash mismatch');
  if (sha256File(macroPath) !== block.hashes.macro) throw new Error('macro albedo hash mismatch');

  const weightSums: [number, number, number, number] = [0, 0, 0, 0];
  const weightMin: [number, number, number, number] = [Infinity, Infinity, Infinity, Infinity];
  const weightMax: [number, number, number, number] = [-Infinity, -Infinity, -Infinity, -Infinity];
  const pixelCount = block.stack.size * block.stack.size;
  for (let i = 0; i < ids.length; i += 4) {
    if (hasPalettes) {
      const quartet = [
        ids[i] ?? 0,
        ids[i + 1] ?? 0,
        ids[i + 2] ?? 0,
        ids[i + 3] ?? 0,
      ];
      const key = quartet.join(',');
      const label = paletteQuartets.get(key) ?? transitionQuartets.get(key);
      if (!label) {
        throw new Error(
          `material IDs [${key}] at texel ${i / 4} do not match any palette or transition`,
        );
      }
    }
    for (let k = 0; k < 4; k++) {
      const id = ids[i + k] ?? 0;
      if (id >= library.materials.length) {
        throw new Error(`material ID ${id} at texel ${i / 4} is outside the library`);
      }
      if (!hasPalettes && id !== expectedIndices[k]) {
        throw new Error(`material slot ${k} uses ID ${id}, expected ${expectedIndices[k]}`);
      }
      const weight = (weights[i + k] ?? 0) / 255;
      weightSums[k] += weight;
      if (weight < weightMin[k]) weightMin[k] = weight;
      if (weight > weightMax[k]) weightMax[k] = weight;
    }
    const sum = (weights[i] ?? 0) + (weights[i + 1] ?? 0)
      + (weights[i + 2] ?? 0) + (weights[i + 3] ?? 0);
    if (sum < 254 || sum > 256) {
      throw new Error(`material weights at texel ${i / 4} sum to ${sum}, expected 255`);
    }
  }
  for (let k = 0; k < 4; k++) {
    if (weightMax[k] <= 0.001) throw new Error(`material slot ${k} is always zero`);
    if (weightMax[k] - weightMin[k] < 0.01) {
      throw new Error(`material slot ${k} has a degenerate range ${weightMin[k]}..${weightMax[k]}`);
    }
  }
  for (let i = 3; i < macro.length; i += 4) {
    if (macro[i] !== 255) throw new Error(`macro albedo alpha at texel ${(i - 3) / 4} is not opaque`);
  }

  return {
    materialStackSize: block.stack.size,
    materialMacroSize: block.macroSize,
    materialWeightMean: [
      weightSums[0] / pixelCount,
      weightSums[1] / pixelCount,
      weightSums[2] / pixelCount,
      weightSums[3] / pixelCount,
    ],
    materialWeightRange: [
      [weightMin[0], weightMax[0]],
      [weightMin[1], weightMax[1]],
      [weightMin[2], weightMax[2]],
      [weightMin[3], weightMax[3]],
    ],
  };
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

  const materialSummary = manifest.materials ? validateMaterials(manifest, outputDir) : null;

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
    ...(materialSummary ?? {}),
  };
}
