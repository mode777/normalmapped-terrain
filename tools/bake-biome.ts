#!/usr/bin/env node
/**
 * Synthetic biome world bake CLI.
 *
 * Usage:
 *   node tools/bake-biome.ts --config tools/biome/config.json
 *   node tools/bake-biome.ts --config tools/biome/config.json --check
 *   node tools/bake-biome.ts --config tools/biome/config.json --out /tmp/biome-bake
 */

import {
  bakeBiome,
  bakeBiomeMaterials,
  checkBiomeMaterialBake,
  readBiomeConfig,
} from './biome/bake.ts';
import { validateBiomeDataset } from './biome/validate.ts';

const arg = (name: string, fallback?: string): string | undefined => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : fallback;
};

const configPath = arg('config', 'tools/biome/config.json');
if (!configPath) throw new Error('missing --config path');
const config = readBiomeConfig(configPath);
const out = arg('out');
if (out) config.outputDir = out;

if (process.argv.includes('--check')) {
  const summary = validateBiomeDataset(config.outputDir);
  console.log(
    `biome dataset OK: ${summary.tileCount} tiles, normal ${summary.normalTileSize}px, `
    + `max seam ${summary.maxSeamError}, ${summary.biomeRegionCount} regions, `
    + `${summary.biomeTransitionCount} transitions, max edge jump `
    + `${summary.maxTransitionJump.toFixed(6)}`,
  );
} else if (process.argv.includes('--check-materials')) {
  const summary = checkBiomeMaterialBake(config);
  console.log(
    `biome material rebake OK: ${summary.stackSize}px stack, ${summary.macroSize}px macro, `
    + `${summary.mapSize}px map, hashes match`,
  );
} else if (process.argv.includes('--materials-only')) {
  console.log(`Baking materials for ${config.dataset} -> ${config.outputDir}`);
  const summary = bakeBiomeMaterials(config);
  console.log(
    `biome material stack OK: ${summary.stackSize}px stack, ${summary.macroSize}px macro, `
    + `${summary.mapSize}px map`,
  );
} else {
  console.log(`Baking ${config.dataset} -> ${config.outputDir}`);
  const summary = bakeBiome(config);
  console.log(
    `Baked ${summary.tileCount} tiles, heights ${summary.heightRange[0].toFixed(1)}..`
    + `${summary.heightRange[1].toFixed(1)} m, max seam error ${summary.maxSeamError}`,
  );
}
