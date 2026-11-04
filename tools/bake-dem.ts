#!/usr/bin/env node
/**
 * DEM bake CLI.
 *
 * Usage:
 *   node tools/bake-dem.ts --config tools/dem/jotunheimen.json
 *   node tools/bake-dem.ts --check --config tools/dem/jotunheimen.json
 *   node tools/bake-dem.ts --config ... --input /path/to/source.tif --out /tmp/out
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { bakeDem, bakeDemMaterials, checkMaterialBake } from './dem/bake.ts';
import { validateDataset } from './dem/validate.ts';
import type { DemConfig } from './dem/types.ts';

const arg = (name: string, fallback?: string): string | undefined => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : fallback;
};

const configPath = arg('config', 'tools/dem/jotunheimen.json');
if (!configPath) throw new Error('missing --config path');

const config = JSON.parse(readFileSync(configPath, 'utf8')) as DemConfig;
const out = arg('out');
if (out) config.outputDir = out;

const input = arg('input');
if (input) {
  config.source = { type: 'local-geotiff', path: resolve(input) };
}

if (process.argv.includes('--check')) {
  const summary = validateDataset(config.outputDir);
  console.log(
    `dataset OK: ${summary.tileCount} tiles, normal ${summary.normalTileSize}px, `
    + `max seam ${summary.maxSeamError}, rebaked ${summary.rebuiltNormals} normals`,
  );
} else if (process.argv.includes('--check-materials')) {
  const summary = checkMaterialBake(config);
  console.log(
    `material rebake OK: ${summary.block.stack.size}px stack, `
    + `${summary.block.macroSize}px macro, hashes match`,
  );
} else if (process.argv.includes('--materials-only')) {
  console.log(`Baking materials for ${config.dataset} -> ${config.outputDir}`);
  const summary = bakeDemMaterials(config);
  console.log(
    `material stack OK: ${summary.block.stack.size}px stack, ${summary.block.macroSize}px macro, `
    + `weights mean ${summary.stats.weightMean.map((v) => v.toFixed(3)).join('/')} `
    + `range ${summary.stats.weightMin.map((v, k) => `${v.toFixed(2)}-${summary.stats.weightMax[k].toFixed(2)}`).join('/')}`,
  );
} else {
  console.log(`Baking ${config.dataset} -> ${config.outputDir}`);
  const summary = await bakeDem(config);
  console.log(
    `Baked ${summary.tileCount} tiles, heights ${summary.heightRange[0].toFixed(1)}..`
    + `${summary.heightRange[1].toFixed(1)} m, max seam error ${summary.maxSeamError}`,
  );
  if (summary.sourceLastModified) console.log(`Source last modified: ${summary.sourceLastModified}`);
}
