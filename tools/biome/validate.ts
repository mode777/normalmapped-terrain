/**
 * Biome-specific validation on top of the generic pre-baked dataset checks.
 *
 * The generic validator proves tile/LOD/normal/hash correctness and checks
 * every stack ID quartet against the manifest palettes. This layer proves the
 * biome map/report agree with the stack, hashes match, and the transition bands
 * are still continuous at their edges.
 */

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { PNG } from 'pngjs';
import type { Manifest } from '../dem/types.ts';
import { loadMaterialLibrary } from '../dem/material-stack.ts';
import { loadDatasetGrid } from '../dem/material-stack.ts';
import { validateDataset } from '../dem/validate.ts';
import type { ValidationSummary } from '../dem/validate.ts';
import { sha256File } from '../prebaked/io.ts';
import { CLIMATE_BOUNDARIES, makeBiomeWorld } from './world.ts';
import {
  measureTransitionContinuity,
  resolveBiomePalettes,
  sampleBiomeMaterial,
} from './material-stack.ts';
import { loadBiomeWorldConfig } from './world-config.ts';

export interface BiomeValidationSummary extends ValidationSummary {
  biomeRegionCount: number;
  biomeTransitionCount: number;
  biomeMapSize: number;
  maxTransitionJump: number;
  maxNonBandWeight: number;
}

const EDGE_TOLERANCE = 1 / 255 + 1e-6;

function readJson<T>(path: string): T {
  return JSON.parse(readFileSync(path, 'utf8')) as T;
}

function readRgba(path: string, size: number, label: string): Buffer {
  if (!existsSync(path)) throw new Error(`missing ${label}: ${path}`);
  const png = PNG.sync.read(readFileSync(path));
  if (png.width !== size || png.height !== size) {
    throw new Error(`wrong ${label} size: ${path} (${png.width}x${png.height}, expected ${size})`);
  }
  return png.data;
}

export function validateBiomeDataset(
  outputDir: string,
  configPath = 'tools/biome/config.json',
): BiomeValidationSummary {
  const generic = validateDataset(outputDir);
  const manifest = readJson<Manifest>(join(outputDir, 'manifest.json'));
  const biomes = manifest.biomes;
  const materials = manifest.materials;
  if (!biomes) throw new Error('biome manifest has no biomes block');
  if (!materials) throw new Error('biome manifest has no materials block');
  if (!materials.palettes || materials.palettes.length !== biomes.regions.length) {
    throw new Error('biome palettes do not match the region count');
  }
  if (!materials.transitions || materials.transitions.length !== biomes.transitions.length) {
    throw new Error('biome transitions do not match the transition count');
  }

  const mapPath = join(outputDir, biomes.map);
  const reportPath = join(outputDir, biomes.report);
  if (sha256File(mapPath) !== biomes.hashes.map) throw new Error('biome map hash mismatch');
  if (sha256File(reportPath) !== biomes.hashes.report) throw new Error('biome report hash mismatch');

  const map = readRgba(mapPath, biomes.mapSize, 'biome map');
  for (let i = 0; i < map.length; i += 4) {
    const region = map[i] ?? 0;
    const transition = map[i + 1] ?? 0;
    if (region >= biomes.regions.length) {
      throw new Error(`biome map texel ${i / 4} has region ${region}`);
    }
    if (transition > biomes.transitions.length) {
      throw new Error(`biome map texel ${i / 4} has transition ${transition}`);
    }
  }

  const report = readJson<{
    version: number;
    stackSize: number;
    macroSize: number;
    mapSize: number;
    extent: number;
    weightSum: { min: number; max: number };
    regions: Array<{ id: string; texels: number; fraction: number }>;
    transitions: Array<{ from: string; to: string; texels: number; maxEdgeJump: number; maxNonBandWeight: number }>;
  }>(reportPath);
  if (report.stackSize !== materials.stack.size) throw new Error('biome report stack size mismatch');
  if (report.macroSize !== materials.macroSize) throw new Error('biome report macro size mismatch');
  if (report.mapSize !== biomes.mapSize) throw new Error('biome report map size mismatch');
  if (report.extent !== materials.stack.extent) throw new Error('biome report extent mismatch');
  if (report.regions.length !== biomes.regions.length) throw new Error('biome report region count mismatch');
  if (report.transitions.length !== biomes.transitions.length) {
    throw new Error('biome report transition count mismatch');
  }

  // Count the stack's ID quartets against the palette and transition sets.
  const stackIds = readRgba(
    join(outputDir, materials.stack.ids),
    materials.stack.size,
    'material IDs',
  );
  const stackWeights = readRgba(
    join(outputDir, materials.stack.weights),
    materials.stack.size,
    'material weights',
  );
  const regionKeys = new Map<string, number>();
  const transitionKeys = new Map<string, number>();
  for (let r = 0; r < materials.palettes.length; r++) {
    const palette = materials.palettes[r];
    const key = palette.slots.map((id) => materialIndexFromManifest(manifest, id)).join(',');
    regionKeys.set(key, r);
  }
  for (let t = 0; t < materials.transitions.length; t++) {
    const transition = materials.transitions[t];
    const key = transition.slots.map((id) => materialIndexFromManifest(manifest, id)).join(',');
    transitionKeys.set(key, t);
  }
  const regionCounts = new Array(biomes.regions.length).fill(0);
  const transitionCounts = new Array(biomes.transitions.length).fill(0);
  for (let i = 0; i < stackIds.length; i += 4) {
    const key = [stackIds[i], stackIds[i + 1], stackIds[i + 2], stackIds[i + 3]].join(',');
    const region = regionKeys.get(key);
    if (region !== undefined) {
      regionCounts[region]++;
      continue;
    }
    const transition = transitionKeys.get(key);
    if (transition !== undefined) {
      transitionCounts[transition]++;
      continue;
    }
    throw new Error(`stack texel ${i / 4} uses an unknown ID quartet [${key}]`);
  }
  let regionFractionSum = 0;
  for (let r = 0; r < regionCounts.length; r++) {
    const entry = report.regions[r];
    if (!entry || entry.id !== biomes.regions[r].id) {
      throw new Error(`biome report region ${r} does not match the manifest`);
    }
    if (entry.texels !== regionCounts[r]) {
      throw new Error(`biome report region ${entry.id} texels ${entry.texels} != ${regionCounts[r]}`);
    }
    if (!(entry.texels > 0) || !(entry.fraction > 0.01)) {
      throw new Error(`biome report region ${entry.id} has insufficient coverage`);
    }
    regionFractionSum += entry.fraction;
  }
  if (Math.abs(regionFractionSum - 1) > 0.25) {
    throw new Error(`biome report region fractions sum to ${regionFractionSum}`);
  }
  for (let t = 0; t < transitionCounts.length; t++) {
    const entry = report.transitions[t];
    const expected = biomes.transitions[t];
    if (!entry || entry.from !== expected.from || entry.to !== expected.to) {
      throw new Error(`biome report transition ${t} does not match the manifest`);
    }
    if (entry.texels !== transitionCounts[t]) {
      throw new Error(
        `biome report transition ${entry.from}->${entry.to} texels `
        + `${entry.texels} != ${transitionCounts[t]}`,
      );
    }
    if (!(entry.maxEdgeJump <= EDGE_TOLERANCE)) {
      throw new Error(
        `biome transition ${entry.from}->${entry.to} edge jump ${entry.maxEdgeJump} `
        + `exceeds ${EDGE_TOLERANCE}`,
      );
    }
    if (!(entry.maxNonBandWeight <= EDGE_TOLERANCE)) {
      throw new Error(
        `biome transition ${entry.from}->${entry.to} non-band weight `
        + `${entry.maxNonBandWeight} exceeds ${EDGE_TOLERANCE}`,
      );
    }
  }

  // Recompute the edge continuity from the reconstructed L0 grid.
  const config = loadBiomeWorldConfig(configPath);
  const library = loadMaterialLibrary(config.materials.library);
  const { palettes, transitions } = resolveBiomePalettes(config, library);
  const world = makeBiomeWorld({
    seed: config.seed,
    sizeMeters: config.sizeMeters,
    transitionWidths: config.materials.transitions.map((t) => t.width),
  });
  const grid = loadDatasetGrid(manifest, outputDir);
  const options = {
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
  };
  const stackSpacing = materials.stack.extent / materials.stack.size;
  const stackHalf = materials.stack.extent / 2;
  const zForClimate = (x: number, target: number): number => {
    let lo = -stackHalf;
    let hi = stackHalf;
    for (let i = 0; i < 40; i++) {
      const mid = (lo + hi) / 2;
      if (world.climateAt(x, mid).climate < target) lo = mid; else hi = mid;
    }
    return (lo + hi) / 2;
  };
  const tx = Math.max(0, Math.min(materials.stack.size - 1,
    Math.floor((0 + stackHalf) / stackSpacing)));
  const xCenter = -stackHalf + (tx + 0.5) * stackSpacing;
  for (let i = 0; i < transitions.length; i++) {
    const transition = transitions[i];
    const boundary = CLIMATE_BOUNDARIES[i];
    for (const p of [0.05, 0.25, 0.5, 0.75, 0.95]) {
      // Sample at the actual stack texel centre so the expected value uses the
      // same x/z as the bake, not a point that falls between texels.
      const z = zForClimate(xCenter, boundary - transition.width / config.sizeMeters / 2
        + p * transition.width / config.sizeMeters);
      const ty = Math.max(0, Math.min(materials.stack.size - 1,
        Math.floor((z + stackHalf) / stackSpacing)));
      const zCenter = -stackHalf + (ty + 0.5) * stackSpacing;
      const expected = sampleBiomeMaterial(options, xCenter, zCenter, stackSpacing);
      const o = (ty * materials.stack.size + tx) * 4;
      for (let k = 0; k < 4; k++) {
        if ((stackIds[o + k] ?? 0) !== expected.ids[k]) {
          throw new Error(
            `transition ${transition.from}->${transition.to} texel ${tx},${ty} `
            + `slot ${k} ID ${stackIds[o + k]} != ${expected.ids[k]}`,
          );
        }
        const actualWeight = (stackWeights[o + k] ?? 0) / 255;
        if (Math.abs(actualWeight - expected.weights[k]) > 2 / 255) {
          throw new Error(
            `transition ${transition.from}->${transition.to} texel ${tx},${ty} `
            + `slot ${k} weight ${actualWeight.toFixed(4)} != ${expected.weights[k].toFixed(4)}`,
          );
        }
      }
    }
  }

  let maxTransitionJump = 0;
  let maxNonBandWeight = 0;
  for (let i = 0; i < transitions.length; i++) {
    const continuity = measureTransitionContinuity(options, i);
    maxTransitionJump = Math.max(maxTransitionJump, continuity.maxEdgeJump);
    maxNonBandWeight = Math.max(maxNonBandWeight, continuity.maxNonBandWeight);
  }
  if (maxTransitionJump > EDGE_TOLERANCE) {
    throw new Error(`recomputed transition edge jump ${maxTransitionJump} exceeds tolerance`);
  }
  if (maxNonBandWeight > EDGE_TOLERANCE) {
    throw new Error(`recomputed non-band weight ${maxNonBandWeight} exceeds tolerance`);
  }

  return {
    ...generic,
    biomeRegionCount: biomes.regions.length,
    biomeTransitionCount: biomes.transitions.length,
    biomeMapSize: biomes.mapSize,
    maxTransitionJump,
    maxNonBandWeight,
  };
}

const indexCache = new WeakMap<Manifest, Map<string, number>>();

function materialIndexFromManifest(manifest: Manifest, id: string): number {
  let cache = indexCache.get(manifest);
  if (!cache) {
    cache = new Map();
    const library = loadMaterialLibrary(
      join(process.cwd(), 'public', manifest.materials?.library ?? 'materials/manifest.json'),
    );
    for (const entry of library.materials) cache.set(entry.id, cache.size);
    indexCache.set(manifest, cache);
  }
  const index = cache.get(id);
  if (index === undefined) throw new Error(`material ${id} is missing from the library`);
  return index;
}
