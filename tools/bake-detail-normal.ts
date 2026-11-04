#!/usr/bin/env node
/**
 * Writes the checked-in diagnostic detail-normal tile.
 *
 * The tile is deterministic: re-running this command reproduces the PNG
 * byte-for-byte. See public/materials/README.md for the convention.
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PNG } from 'pngjs';
import { buildDetailTile } from './detail/tile.ts';

const output = resolve(
  fileURLToPath(new URL('../public/materials/detail-diagnostic-normal.png', import.meta.url)),
);
const { size, normals } = buildDetailTile();

const png = new PNG({ width: size, height: size });
png.data = Buffer.from(normals);

mkdirSync(dirname(output), { recursive: true });
writeFileSync(output, PNG.sync.write(png));
console.log(`wrote ${output} (${size}x${size} RGBA8 object-space normals)`);
