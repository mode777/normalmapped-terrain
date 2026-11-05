#!/usr/bin/env node
/**
 * Offline checks for the synthetic biome world.
 *
 * Always runs the generator/climate/tile checks. By default it then validates
 * the checked-in dataset. Use --synthetic while developing the bake before the
 * dataset exists.
 *
 * Usage:
 *   node tools/test-biome.ts
 *   node tools/test-biome.ts --synthetic
 *   node tools/test-biome.ts --data public/data/biomes
 */

import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import {
  bakeHeightTile,
  bakeNormalTile,
  referenceNormal,
  sampleBilinear,
  tileRangeForLevel,
} from './dem/grid.ts';
import type { DemGrid } from './dem/types.ts';
import { loadBiomeWorldConfig } from './biome/world-config.ts';
import { CLIMATE_BOUNDARIES, REGION_COUNT, makeBiomeWorld } from './biome/world.ts';
import { loadMaterialLibrary } from './dem/material-stack.ts';
import {
  measureTransitionContinuity,
  resolveBiomePalettes,
} from './biome/material-stack.ts';
import { validateBiomeDataset } from './biome/validate.ts';

const near = (a: number, b: number, eps: number, message: string): void => {
  assert.ok(Math.abs(a - b) <= eps, `${message}: ${a} vs ${b}`);
};

function syntheticChecks(): void {
  const config = loadBiomeWorldConfig('tools/biome/config.json');
  const widths = config.materials.transitions.map((t) => t.width);
  const world = makeBiomeWorld({
    seed: config.seed,
    sizeMeters: config.sizeMeters,
    transitionWidths: widths,
  });
  const worldAgain = makeBiomeWorld({
    seed: config.seed,
    sizeMeters: config.sizeMeters,
    transitionWidths: widths,
  });

  // Deterministic pure functions.
  for (const [x, z] of [[0, 0], [1234, -4321], [-7000, 6400]] as const) {
    near(world.heightAt(x, z), worldAgain.heightAt(x, z), 0, 'height reproducibility');
    near(world.climateAt(x, z).climate, worldAgain.climateAt(x, z).climate, 0, 'climate reproducibility');
  }

  // Height range and region coverage.
  const half = config.sizeMeters / 2;
  const counts = new Array(REGION_COUNT).fill(0);
  let min = Infinity;
  let max = -Infinity;
  let previousClimate = -1;
  for (let j = 0; j < 128; j++) {
    const z = -half + (j + 0.5) * (config.sizeMeters / 128);
    for (let i = 0; i < 128; i++) {
      const x = -half + (i + 0.5) * (config.sizeMeters / 128);
      const h = world.heightAt(x, z);
      min = Math.min(min, h);
      max = Math.max(max, h);
      const climate = world.climateAt(x, z, h);
      counts[climate.regionIndex]++;
      assert.ok(climate.temperature >= 0 && climate.temperature <= 1, 'temperature in range');
      assert.ok(climate.moisture >= 0 && climate.moisture <= 1, 'moisture in range');
    }
    const lineClimate = world.climateAt(0, z).climate;
    assert.ok(lineClimate >= previousClimate - 1e-6, `climate monotonic at z=${z}`);
    previousClimate = lineClimate;
  }
  assert.ok(min > 0.01 && min < 0.25, `height minimum plausible: ${min}`);
  assert.ok(max > 0.8 && max < 0.995, `height maximum plausible: ${max}`);
  for (let i = 0; i < REGION_COUNT; i++) {
    assert.ok(counts[i] > 0, `region ${i} has coverage`);
  }

  // Every boundary has a transition band with progress 0..1.
  for (let i = 0; i < CLIMATE_BOUNDARIES.length; i++) {
    const boundary = CLIMATE_BOUNDARIES[i];
    const z = -half + boundary * config.sizeMeters;
    const sample = world.climateAt(0, z);
    assert.equal(sample.transitionIndex, i, `boundary ${i} is inside its band`);
    assert.ok(sample.progress >= 0 && sample.progress <= 1, `boundary ${i} progress in range`);
  }

  // Use a smaller synthetic grid for tile/LOD and normal-boundary checks.
  const spacing = 60;
  const cols = 192;
  const rows = 192;
  const data = new Float32Array(cols * rows);
  for (let j = 0; j < rows; j++) {
    const z = -cols * spacing / 2 + j * spacing;
    for (let i = 0; i < cols; i++) {
      data[j * cols + i] = world.heightAt(-cols * spacing / 2 + i * spacing, z);
    }
  }
  const grid: DemGrid = { data, cols, rows, spacing };
  const sizeMeters = cols * spacing;
  for (let level = 0; level < 4; level++) {
    const range = tileRangeForLevel({
      level,
      sizeMeters,
      baseSpacing: spacing,
      tileSize: 64,
    });
    assert.ok(range.count > 0, `L${level} has tiles`);
  }
  for (const level of [0, 1, 2]) {
    const tile = bakeHeightTile(grid, level, 0, 0, 64, spacing);
    const levelSpacing = spacing * Math.pow(2, level);
    for (let j = 0; j < 64; j += 7) {
      for (let i = 0; i < 64; i += 7) {
        const expected = sampleBilinear(grid, i * levelSpacing, j * levelSpacing);
        near(tile[j * 64 + i], expected, 1e-6, `L${level} height ${i},${j}`);
      }
    }
  }
  const normalScale = 2;
  const normalTileSize = 64 * normalScale;
  const normalSpacing = spacing / normalScale;
  const left = bakeNormalTile(grid, 0, -1, 0, 64, spacing, normalScale, config.heightScale);
  const right = bakeNormalTile(grid, 0, 0, 0, 64, spacing, normalScale, config.heightScale);
  for (const [tile, i, x] of [
    [left, normalTileSize - 1, -normalSpacing],
    [right, 0, 0],
  ] as const) {
    for (let j = 0; j < normalTileSize; j += 11) {
      const expected = referenceNormal(grid, x, j * normalSpacing, normalSpacing, config.heightScale);
      const o = (j * normalTileSize + i) * 4;
      for (let c = 0; c < 3; c++) {
        near(tile[o + c], expected[c], 1, `normal boundary ${i},${j},${c}`);
      }
    }
  }

  // Transition-band continuity: the band edge must match the adjacent region
  // restricted to the band palette, and non-band materials must be zero there.
  const library = loadMaterialLibrary(config.materials.library);
  const { palettes, transitions } = resolveBiomePalettes(config, library);
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
  for (let i = 0; i < transitions.length; i++) {
    const continuity = measureTransitionContinuity(options, i);
    assert.ok(
      continuity.maxEdgeJump < 1 / 255,
      `transition ${i} edge jump ${continuity.maxEdgeJump}`,
    );
    assert.ok(
      continuity.maxNonBandWeight < 1 / 255,
      `transition ${i} non-band weight ${continuity.maxNonBandWeight}`,
    );
  }

  console.log('biome synthetic checks: OK');
}

const args = process.argv.slice(2);
const syntheticOnly = args.includes('--synthetic');
const dataIndex = args.indexOf('--data');
const dataDir = dataIndex >= 0 ? args[dataIndex + 1] : 'public/data/biomes';

syntheticChecks();
if (syntheticOnly) process.exit(0);

if (!existsSync(dataDir)) {
  console.error(`biome dataset checks: missing ${dataDir}`);
  console.error('run `npm run bake:biome` first');
  process.exit(1);
}
const summary = validateBiomeDataset(dataDir);
console.log(
  `biome dataset checks: OK (${summary.tileCount} tiles, normal ${summary.normalTileSize}px, `
  + `max seam ${summary.maxSeamError}, ${summary.biomeRegionCount} regions, `
  + `${summary.biomeTransitionCount} transitions, map ${summary.biomeMapSize}px, `
  + `max edge jump ${summary.maxTransitionJump.toFixed(6)})`,
);
