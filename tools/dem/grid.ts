/**
 * Local metric grid, tile sampling and normal-halo helpers for the DEM bake.
 *
 * The local frame is centred at (0,0): +x is east, +z is south. Row 0 of the
 * source grid is north, matching the renderer's row j -> +z convention.
 */

import { bakeTileNormals } from '../../src/terrain/normals.ts';
import type { DemGrid, TileRange } from './types.ts';

export interface TileRangeOptions {
  level: number;
  sizeMeters: number;
  baseSpacing: number;
  tileSize: number;
}

export function tileRangeForLevel({
  level,
  sizeMeters,
  baseSpacing,
  tileSize,
}: TileRangeOptions): TileRange {
  const tileWorld = tileSize * baseSpacing * Math.pow(2, level);
  const half = sizeMeters / 2;
  const eps = 1e-9;
  const minTx = Math.floor(-half / tileWorld + eps);
  const maxTx = Math.floor((half - eps) / tileWorld);
  const minTy = minTx;
  const maxTy = maxTx;
  return {
    level,
    minTx,
    maxTx,
    minTy,
    maxTy,
    count: (maxTx - minTx + 1) * (maxTy - minTy + 1),
  };
}

export function tileWorldForLevel(baseSpacing: number, tileSize: number, level: number): number {
  return tileSize * baseSpacing * Math.pow(2, level);
}

export function sampleBilinear(grid: DemGrid, x: number, z: number): number {
  const half = (grid.cols * grid.spacing) / 2;
  const fx = (x + half) / grid.spacing;
  const fz = (z + half) / grid.spacing;
  const cx = Math.max(0, Math.min(grid.cols - 1, fx));
  const cz = Math.max(0, Math.min(grid.rows - 1, fz));
  const i0 = Math.floor(cx);
  const j0 = Math.floor(cz);
  const i1 = Math.min(grid.cols - 1, i0 + 1);
  const j1 = Math.min(grid.rows - 1, j0 + 1);
  const tx = cx - i0;
  const tz = cz - j0;
  const h00 = grid.data[j0 * grid.cols + i0];
  const h10 = grid.data[j0 * grid.cols + i1];
  const h01 = grid.data[j1 * grid.cols + i0];
  const h11 = grid.data[j1 * grid.cols + i1];
  return (h00 * (1 - tx) + h10 * tx) * (1 - tz)
    + (h01 * (1 - tx) + h11 * tx) * tz;
}

/** Samples one 64 x 64 height tile at a LOD. */
export function bakeHeightTile(
  grid: DemGrid,
  level: number,
  tx: number,
  ty: number,
  tileSize: number,
  baseSpacing: number,
): Float32Array {
  const spacing = baseSpacing * Math.pow(2, level);
  const tileWorld = tileSize * spacing;
  const out = new Float32Array(tileSize * tileSize);
  for (let j = 0; j < tileSize; j++) {
    const z = ty * tileWorld + j * spacing;
    for (let i = 0; i < tileSize; i++) {
      const x = tx * tileWorld + i * spacing;
      out[j * tileSize + i] = sampleBilinear(grid, x, z);
    }
  }
  return out;
}

/**
 * Bakes one normal tile from a one-texel halo at normal spacing. The halo and
 * the height tiles come from the same global grid, so adjacent tiles use the
 * same samples at their shared boundary.
 */
export function bakeNormalTile(
  grid: DemGrid,
  level: number,
  tx: number,
  ty: number,
  tileSize: number,
  baseSpacing: number,
  normalScale: number,
  heightScale: number,
): Uint8Array {
  const spacing = baseSpacing * Math.pow(2, level);
  const normalSpacing = spacing / normalScale;
  const normalTileSize = tileSize * normalScale;
  const tileWorld = tileSize * spacing;
  const stride = normalTileSize + 2;
  const halo = new Float32Array(stride * stride);

  for (let j = -1; j <= normalTileSize; j++) {
    const z = ty * tileWorld + j * normalSpacing;
    const row = (j + 1) * stride;
    for (let i = -1; i <= normalTileSize; i++) {
      const x = tx * tileWorld + i * normalSpacing;
      halo[row + i + 1] = sampleBilinear(grid, x, z);
    }
  }

  return bakeTileNormals(halo, normalTileSize, normalSpacing, heightScale);
}

/**
 * Reference normal at one world position, using the same Sobel formulation as
 * bakeTileNormals. Used by the bake-time seam report.
 */
export function referenceNormal(
  grid: DemGrid,
  x: number,
  z: number,
  normalSpacing: number,
  heightScale: number,
): [number, number, number, number] {
  const h00 = sampleBilinear(grid, x - normalSpacing, z - normalSpacing);
  const h01 = sampleBilinear(grid, x, z - normalSpacing);
  const h02 = sampleBilinear(grid, x + normalSpacing, z - normalSpacing);
  const h10 = sampleBilinear(grid, x - normalSpacing, z);
  const h12 = sampleBilinear(grid, x + normalSpacing, z);
  const h20 = sampleBilinear(grid, x - normalSpacing, z + normalSpacing);
  const h21 = sampleBilinear(grid, x, z + normalSpacing);
  const h22 = sampleBilinear(grid, x + normalSpacing, z + normalSpacing);
  const gradScale = heightScale / (8 * normalSpacing);
  const gx = (h02 + 2 * h12 + h22) - (h00 + 2 * h10 + h20);
  const gz = (h20 + 2 * h21 + h22) - (h00 + 2 * h01 + h02);
  let nx = -gx * gradScale;
  let ny = 1;
  let nz = -gz * gradScale;
  const inv = 1 / Math.sqrt(nx * nx + ny * ny + nz * nz);
  nx *= inv; ny *= inv; nz *= inv;
  return [
    Math.round((nx * 0.5 + 0.5) * 255),
    Math.round((nz * 0.5 + 0.5) * 255),
    Math.round((ny * 0.5 + 0.5) * 255),
    255,
  ];
}

export interface CoarseGrid {
  data: Uint16Array;
  size: number;
  spacing: number;
}

export function bakeCoarseGrid(grid: DemGrid, size: number): CoarseGrid {
  const spacing = (grid.cols * grid.spacing) / (size - 1);
  const half = (grid.cols * grid.spacing) / 2;
  const data = new Uint16Array(size * size);
  for (let j = 0; j < size; j++) {
    const z = -half + j * spacing;
    for (let i = 0; i < size; i++) {
      const x = -half + i * spacing;
      data[j * size + i] = encodeUint16(sampleBilinear(grid, x, z));
    }
  }
  return { data, size, spacing };
}

export function encodeUint16(h: number): number {
  return Math.max(0, Math.min(65535, Math.round(h * 65535)));
}

export function decodeUint16(v: number): number {
  return v / 65535;
}
