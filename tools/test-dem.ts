#!/usr/bin/env node
/**
 * Offline checks for the DEM bake pipeline.
 *
 * Always runs the synthetic grid/tile/normal checks. By default it then
 * validates the checked-in Jotunheimen dataset. Use `--synthetic` while
 * developing the bake tool before the dataset exists.
 *
 * Usage:
 *   node tools/test-dem.ts
 *   node tools/test-dem.ts --synthetic
 *   node tools/test-dem.ts --data public/data/jotunheimen
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
import { validateDataset } from './dem/validate.ts';

const near = (a: number, b: number, eps: number, message: string): void => {
  assert.ok(Math.abs(a - b) <= eps, `${message}: ${a} vs ${b}`);
};

function syntheticChecks(): void {
  const spacing = 10;
  const cols = 256;
  const rows = 256;
  const data = new Float32Array(cols * rows);
  for (let j = 0; j < rows; j++) {
    for (let i = 0; i < cols; i++) {
      const x = (i - cols / 2) * spacing;
      const z = (j - rows / 2) * spacing;
      data[j * cols + i] = 0.5
        + 0.12 * Math.sin(x / 310)
        + 0.08 * Math.cos(z / 227)
        + 0.03 * Math.sin((x + z) / 97);
    }
  }
  const grid: DemGrid = { data, cols, rows, spacing };

  // Tile ranges cover the data and are non-overlapping.
  for (let level = 0; level < 6; level++) {
    const range = tileRangeForLevel({
      level,
      sizeMeters: cols * spacing,
      baseSpacing: spacing,
      tileSize: 64,
    });
    assert.ok(range.count > 0, `L${level} has tiles`);
    assert.ok(range.minTx <= range.maxTx && range.minTy <= range.maxTy, `L${level} range valid`);
  }

  // Height tiles sample the same field as the global grid.
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

  // Adjacent normal tiles use the same boundary reference.
  const level = 0;
  const normalScale = 2;
  const normalTileSize = 64 * normalScale;
  const normalSpacing = spacing / normalScale;
  const left = bakeNormalTile(grid, level, -1, 0, 64, spacing, normalScale, 1500);
  const right = bakeNormalTile(grid, level, 0, 0, 64, spacing, normalScale, 1500);
  for (const [tile, i, x] of [
    [left, normalTileSize - 1, -normalSpacing],
    [right, 0, 0],
  ] as const) {
    for (let j = 0; j < normalTileSize; j += 11) {
      const expected = referenceNormal(grid, x, j * normalSpacing, normalSpacing, 1500);
      const o = (j * normalTileSize + i) * 4;
      for (let c = 0; c < 3; c++) {
        near(tile[o + c], expected[c], 1, `normal boundary ${i},${j},${c}`);
      }
    }
  }

  console.log('dem synthetic checks: OK');
}

const args = process.argv.slice(2);
const syntheticOnly = args.includes('--synthetic');
const dataIndex = args.indexOf('--data');
const dataDir = dataIndex >= 0 ? args[dataIndex + 1] : 'public/data/jotunheimen';

syntheticChecks();

if (syntheticOnly) {
  process.exit(0);
}

if (!existsSync(dataDir)) {
  console.error(`dem dataset checks: missing ${dataDir}`);
  console.error('run `npm run bake:dem -- --config tools/dem/jotunheimen.json` first');
  process.exit(1);
}

const summary = validateDataset(dataDir);
const material = summary.materialWeightMean && summary.materialWeightRange
  ? `, materials ${summary.materialStackSize}px/${summary.materialMacroSize}px `
    + `mean ${summary.materialWeightMean.map((v) => v.toFixed(3)).join('/')} `
    + `range ${summary.materialWeightRange.map(([a, b]) => `${a.toFixed(2)}-${b.toFixed(2)}`).join('/')}`
  : '';
console.log(
  `dem dataset checks: OK (${summary.tileCount} tiles, normal ${summary.normalTileSize}px, `
  + `max seam ${summary.maxSeamError}, rebaked ${summary.rebuiltNormals} normals${material})`,
);
