/**
 * Offline bake for the synthetic biome world.
 *
 * The height field is sampled once into a global 15 m grid. Height tiles,
 * normal tiles and the coarse grid are then derived with the same helpers as
 * the DEM bake, so the runtime sees one dataset contract. The material stack is
 * added by the biome material bake in this module's caller.
 */

import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PNG } from 'pngjs';
import type {
  BiomeDatasetBlock,
  Manifest,
  MaterialDatasetBlock,
  SeamLevelReport,
  SeamReport,
  TileRange,
} from '../dem/types.ts';
import {
  bakeCoarseGrid,
  bakeHeightTile,
  bakeNormalTile,
  referenceNormal,
  tileRangeForLevel,
  tileWorldForLevel,
} from '../dem/grid.ts';
import type { DemGrid } from '../dem/types.ts';
import { sha256File, writeHeightTile, writeNormalPng, writeRgbaPng } from '../prebaked/io.ts';
import { loadDatasetGrid, loadMaterialLibrary } from '../dem/material-stack.ts';
import { makeBiomeWorld } from './world.ts';
import { loadBiomeWorldConfig } from './world-config.ts';
import { bakeBiomeStack, resolveBiomePalettes } from './material-stack.ts';
import type { BiomeWorldConfig } from './types.ts';

const BAKE_VERSION = 1;
const COARSE_SIZE = 1024;
const SEAM_THRESHOLD = 2;

export interface BiomeBakeSummary {
  outputDir: string;
  tileCount: number;
  heightRange: [number, number];
  maxSeamError: number;
  grid: DemGrid;
}

function ensureCleanOutput(outputDir: string): void {
  mkdirSync(outputDir, { recursive: true });
  for (const name of [
    'h',
    'n',
    'manifest.json',
    'seam-report.json',
    'coarse-height.bin',
    'preview.png',
    'stack-ids.png',
    'stack-weights.png',
    'macro-albedo.png',
    'biome-map.png',
    'biome-report.json',
  ]) {
    rmSync(join(outputDir, name), { recursive: true, force: true });
  }
}

function writePreview(
  path: string,
  config: BiomeWorldConfig,
  grid: DemGrid,
  world: ReturnType<typeof makeBiomeWorld>,
  size: number,
): void {
  const png = new PNG({ width: size, height: size });
  const half = (grid.cols * grid.spacing) / 2;
  const step = (grid.cols * grid.spacing) / (size - 1);
  const heights = new Float32Array(size * size);
  let min = Infinity;
  let max = -Infinity;
  for (let j = 0; j < size; j++) {
    const z = -half + j * step;
    for (let i = 0; i < size; i++) {
      const x = -half + i * step;
      const h = world.heightAt(x, z);
      heights[j * size + i] = h;
      if (h < min) min = h;
      if (h > max) max = h;
    }
  }
  const regionColors = new Map(config.biomes.regions.map((r) => [r.id, r.color]));
  const regionOrder = config.biomes.regions.map((r) => regionColors.get(r.id) ?? [0.5, 0.5, 0.5]);

  for (let j = 0; j < size; j++) {
    const z = -half + j * step;
    for (let i = 0; i < size; i++) {
      const x = -half + i * step;
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
      const sample = world.climateAt(x, z, h);
      const color = regionOrder[sample.regionIndex] ?? [0.5, 0.5, 0.5];
      const tint = 0.72 + 0.28 * (1 - (h - min) / Math.max(1e-9, max - min));
      const o = (j * size + i) * 4;
      png.data[o] = Math.min(255, Math.max(0, color[0] * shade * tint * 255));
      png.data[o + 1] = Math.min(255, Math.max(0, color[1] * shade * tint * 255));
      png.data[o + 2] = Math.min(255, Math.max(0, color[2] * shade * tint * 255));
      png.data[o + 3] = 255;
    }
  }
  writeFileSync(path, PNG.sync.write(png));
}

export function bakeBiome(config: BiomeWorldConfig): BiomeBakeSummary {
  const outputDir = config.outputDir;
  ensureCleanOutput(outputDir);

  const cols = Math.round(config.sizeMeters / config.spacing);
  const rows = cols;
  if (Math.abs(cols * config.spacing - config.sizeMeters) > 1e-6) {
    throw new Error('sizeMeters must be an integer multiple of spacing');
  }
  const world = makeBiomeWorld({
    seed: config.seed,
    sizeMeters: config.sizeMeters,
    transitionWidths: config.materials.transitions.map((t) => t.width),
  });
  const half = config.sizeMeters / 2;
  const data = new Float32Array(cols * rows);
  let minNorm = Infinity;
  let maxNorm = -Infinity;
  for (let j = 0; j < rows; j++) {
    const z = -half + j * config.spacing;
    for (let i = 0; i < cols; i++) {
      const x = -half + i * config.spacing;
      // Quantize before any derived bake so the materials-only path, which
      // reconstructs this grid from uint16 L0 tiles, produces identical hashes.
      const h = Math.round(world.heightAt(x, z) * 65535) / 65535;
      data[j * cols + i] = h;
      if (h < minNorm) minNorm = h;
      if (h > maxNorm) maxNorm = h;
    }
  }
  const grid: DemGrid = { data, cols, rows, spacing: config.spacing };

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
        const heights = bakeHeightTile(
          grid, level, tx, ty, config.tileSize, config.spacing,
        );
        writeHeightTile(join(heightDir, `${tx}_${ty}.bin`), heights);
        const normals = bakeNormalTile(
          grid, level, tx, ty, config.tileSize, config.spacing,
          config.normalScale, config.heightScale,
        );
        writeNormalPng(join(normalDir, `${tx}_${ty}.png`), normals, normalTileSize);

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
    process.stderr.write(`  L${level}: ${range.count} tiles, max seam error ${seamMax}\n`);
  }

  const coarse = bakeCoarseGrid(grid, COARSE_SIZE);
  writeFileSync(join(outputDir, 'coarse-height.bin'), Buffer.from(coarse.data.buffer));
  writePreview(join(outputDir, 'preview.png'), config, grid, world, 512);

  const seamReport: SeamReport = {
    version: 1,
    threshold: SEAM_THRESHOLD,
    levels: seamLevels,
  };
  writeFileSync(join(outputDir, 'seam-report.json'), `${JSON.stringify(seamReport, null, 2)}\n`);

  const { materialBlock, biomeBlock } = bakeBiomeMaterialMaps(config, grid, world);

  const manifest: Manifest = {
    version: 2,
    dataset: config.dataset,
    bakeVersion: BAKE_VERSION,
    source: {
      type: 'synthetic',
      crs: 'local',
      bbox: [-half, -half, half, half],
      resolution: config.spacing,
      generator: 'tools/biome/world.ts',
      seed: config.seed,
      version: 1,
    },
    license: config.license,
    attribution: config.attribution,
    localFrame: {
      centerE: 0,
      centerN: 0,
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
    heightRange: [minNorm * config.heightScale, maxNorm * config.heightScale],
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
    materials: materialBlock,
    biomes: biomeBlock,
  };
  writeFileSync(join(outputDir, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);

  return {
    outputDir,
    tileCount,
    heightRange: [minNorm * config.heightScale, maxNorm * config.heightScale],
    maxSeamError,
    grid,
  };
}

export interface BiomeMaterialBakeSummary {
  materialBlock: MaterialDatasetBlock;
  biomeBlock: BiomeDatasetBlock;
  stackSize: number;
  macroSize: number;
  mapSize: number;
}

/** Bakes and writes the material stack, macro, biome map and report. */
export function bakeBiomeMaterialMaps(
  config: BiomeWorldConfig,
  grid: DemGrid,
  world: ReturnType<typeof makeBiomeWorld>,
): BiomeMaterialBakeSummary {
  const materialLibrary = loadMaterialLibrary(config.materials.library);
  const { palettes, transitions } = resolveBiomePalettes(config, materialLibrary);
  process.stderr.write(`  materials: ${palettes.map((p) => p.id).join(', ')}\n`);
  const stack = bakeBiomeStack({
    grid,
    heightScale: config.heightScale,
    size: config.materials.stackSize,
    extent: config.sizeMeters,
    macroSize: config.materials.macroSize,
    mapSize: config.biomes.mapSize,
    seed: config.materials.seed,
    world,
    palettes,
    transitions,
  });

  const idsPath = join(config.outputDir, 'stack-ids.png');
  const weightsPath = join(config.outputDir, 'stack-weights.png');
  const macroPath = join(config.outputDir, 'macro-albedo.png');
  const mapPath = join(config.outputDir, 'biome-map.png');
  const reportPath = join(config.outputDir, 'biome-report.json');
  writeRgbaPng(idsPath, stack.ids, config.materials.stackSize);
  writeRgbaPng(weightsPath, stack.weights, config.materials.stackSize);
  writeRgbaPng(macroPath, stack.macro, config.materials.macroSize);
  writeRgbaPng(mapPath, stack.map, config.biomes.mapSize);
  writeFileSync(reportPath, `${JSON.stringify(stack.report, null, 2)}\n`);

  const materialBlock: MaterialDatasetBlock = {
    library: 'materials/manifest.json',
    slots: config.materials.palettes[0].slots,
    palettes: config.materials.palettes,
    transitions: config.materials.transitions,
    stack: {
      ids: 'stack-ids.png',
      weights: 'stack-weights.png',
      size: config.materials.stackSize,
      extent: config.sizeMeters,
      encoding: 'rgba8-ids-weights',
    },
    macro: 'macro-albedo.png',
    macroSize: config.materials.macroSize,
    macroEncoding: 'rgba8',
    bakeVersion: 1,
    seed: config.materials.seed,
    hashes: {
      ids: sha256File(idsPath),
      weights: sha256File(weightsPath),
      macro: sha256File(macroPath),
    },
  };
  const biomeBlock: BiomeDatasetBlock = {
    map: 'biome-map.png',
    mapSize: config.biomes.mapSize,
    encoding: 'rgba8-region-transition-progress-climate',
    report: 'biome-report.json',
    regions: config.biomes.regions,
    transitions: config.materials.transitions.map(({ from, to, width }) => ({ from, to, width })),
    hashes: {
      map: sha256File(mapPath),
      report: sha256File(reportPath),
    },
  };

  return {
    materialBlock,
    biomeBlock,
    stackSize: config.materials.stackSize,
    macroSize: config.materials.macroSize,
    mapSize: config.biomes.mapSize,
  };
}

function readManifest(outputDir: string): Manifest {
  const path = join(outputDir, 'manifest.json');
  if (!existsSync(path)) throw new Error(`missing biome manifest: ${path}`);
  return JSON.parse(readFileSync(path, 'utf8')) as Manifest;
}

/**
 * Rebakes only the material stack/macro/map from the checked-in L0 height
 * tiles. This avoids re-baking 344 height/normal tiles when only a palette,
 * threshold or noise seed changes.
 */
export function bakeBiomeMaterials(config: BiomeWorldConfig): BiomeMaterialBakeSummary {
  const manifest = readManifest(config.outputDir);
  const grid = loadDatasetGrid(manifest, config.outputDir);
  const world = makeBiomeWorld({
    seed: config.seed,
    sizeMeters: config.sizeMeters,
    transitionWidths: config.materials.transitions.map((t) => t.width),
  });
  const summary = bakeBiomeMaterialMaps(config, grid, world);
  manifest.version = Math.max(2, manifest.version);
  manifest.materials = summary.materialBlock;
  manifest.biomes = summary.biomeBlock;
  writeFileSync(
    join(config.outputDir, 'manifest.json'),
    `${JSON.stringify(manifest, null, 2)}\n`,
  );
  return summary;
}

/**
 * Rebakes the stack/macro/map into a temporary directory and compares hashes
 * with the checked-in manifest. Names the first mismatching artifact.
 */
export function checkBiomeMaterialBake(config: BiomeWorldConfig): BiomeMaterialBakeSummary {
  const manifest = readManifest(config.outputDir);
  if (!manifest.materials) throw new Error('biome dataset has no materials block');
  if (!manifest.biomes) throw new Error('biome dataset has no biomes block');
  const expected = {
    ids: manifest.materials.hashes.ids,
    weights: manifest.materials.hashes.weights,
    macro: manifest.materials.hashes.macro,
    map: manifest.biomes.hashes.map,
    report: manifest.biomes.hashes.report,
  };
  const grid = loadDatasetGrid(manifest, config.outputDir);
  const world = makeBiomeWorld({
    seed: config.seed,
    sizeMeters: config.sizeMeters,
    transitionWidths: config.materials.transitions.map((t) => t.width),
  });
  const tempDir = mkdtempSync(join(tmpdir(), 'normalmapped-biome-materials-'));
  try {
    const summary = bakeBiomeMaterialMaps({ ...config, outputDir: tempDir }, grid, world);
    const actual = {
      ids: summary.materialBlock.hashes.ids,
      weights: summary.materialBlock.hashes.weights,
      macro: summary.materialBlock.hashes.macro,
      map: summary.biomeBlock.hashes.map,
      report: summary.biomeBlock.hashes.report,
    };
    for (const key of Object.keys(expected) as Array<keyof typeof expected>) {
      if (actual[key] !== expected[key]) {
        throw new Error(`biome material ${key} hash mismatch on rebake`);
      }
    }
    return summary;
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
}

export const readBiomeConfig = loadBiomeWorldConfig;
