/**
 * Shared file writers for the offline pre-baked dataset tools.
 *
 * Both the Kartverket DEM bake and the synthetic biome bake write the same
 * tile formats: little-endian normalized uint16 heights, RGBA8 normal PNGs and
 * RGBA8 stack/macro PNGs. Keeping the writers here avoids the two bake CLIs
 * drifting on encoding or PNG settings.
 */

import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { PNG } from 'pngjs';
import { encodeUint16 } from '../dem/grid.ts';

export function writeHeightTile(path: string, heights: Float32Array): void {
  const buffer = Buffer.allocUnsafe(heights.length * 2);
  for (let i = 0; i < heights.length; i++) {
    buffer.writeUInt16LE(encodeUint16(heights[i]), i * 2);
  }
  writeFileSync(path, buffer);
}

export function writeNormalPng(path: string, normals: Uint8Array, size: number): void {
  const png = new PNG({ width: size, height: size });
  png.data.set(normals);
  writeFileSync(path, PNG.sync.write(png));
}

export function writeRgbaPng(path: string, data: Uint8Array, size: number): void {
  if (data.length !== size * size * 4) {
    throw new Error(`RGBA buffer ${path} has ${data.length} bytes, expected ${size * size * 4}`);
  }
  const png = new PNG({ width: size, height: size });
  png.data.set(data);
  writeFileSync(path, PNG.sync.write(png));
}

export function sha256File(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}
