/**
 * Infinite procedural heightfield + per-tile Sobel normal baking.
 *
 * The pipeline is heightfield -> float gradient -> object-space normal map,
 * evaluated per tile at an arbitrary world coordinate. There is no global
 * terrain pass: every sample is a pure function of its position.
 *
 * The height function is deterministic for a given seed. Every tile is
 * sampled in absolute world metres, so adjacent tiles and adjacent LODs agree
 * at shared sample positions.
 */

import { makeTerrainComposer } from '../terrain-compose.ts';
import { bakeTileNormals } from '../terrain/normals.ts';

export const DEFAULT_SEED = 20260217;
export const DEFAULT_HEIGHT_SCALE = 1500; // metres of relief for h in [0,1]

export interface HeightField {
  readonly seed: number;
  readonly heightScale: number;
  heightAt(x: number, z: number): number;
}

export interface GenerateTileOptions {
  level: number;
  tx: number;
  ty: number;
  tileSize?: number;
  baseSpacing?: number;
  heightScale?: number;
  normalScale?: number;
}

export interface GeneratedTile {
  heights: Float32Array;
  normals: Uint8Array;
}

/**
 * Creates a seeded, effectively infinite height function.
 *
 * The composition (multi-noise channels + spline response curves + iterated
 * domain warp + anisotropic ridge spines) lives in src/terrain-compose.ts;
 * see docs/TERRAIN_RESEARCH.md for the recipe and its sources. A pure-function
 * height field is what makes the streaming cache work: no global passes
 * (e.g. erosion simulation) are possible without seams, so the variety comes
 * from composition alone.
 *
 * Returns normalized heights in [0,1]. Multiply by `heightScale` for metres.
 * The same object can be created in the worker and on the main thread; as
 * long as the seed matches, both evaluate the same field.
 */
export function makeHeightField(seed = DEFAULT_SEED): HeightField {
  const { heightAt } = makeTerrainComposer({
    seed,
    warpWavelength: 5900,
    warpAmplitude: 1600,
    continentWavelength: 45000,
    erosionWavelength: 14300,
    mountainWavelength: 5900,
    mountainOctaves: 7,
    spineWavelength: 6000,
    spineAnisotropy: 2.4,
    hillsWavelength: 3850,
    hillsOctaves: 4,
    roughnessWavelength: 3000,
    mountainAmp: 0.74,
    hillsAmp: 0.15,
    // Multi-scale roughness for the normal map. Wavelengths run 714 → 17 m
    // (finest octaves ≈8 m), at and below the clipmap's coarser-ring vertex
    // spacing, so a large part of this roughness is carried by the normal
    // map rather than the meshes — exactly what this PoC is meant to show.
    detailLayers: [
      { wavelength: 714, amplitude: 0.030, octaves: 3 },
      { wavelength: 154, amplitude: 0.018, octaves: 3 },
      { wavelength: 40, amplitude: 0.010, octaves: 2 },
      { wavelength: 17, amplitude: 0.004, octaves: 2 },
    ],
  });

  return { seed, heightAt, heightScale: DEFAULT_HEIGHT_SCALE };
}

/**
 * Generates one tile at a given LOD.
 *
 * Tile (tx,ty) at LOD L covers world cells
 *   [tx*T, ty*T] .. [tx*T+T-1, ty*T+T-1]
 * with spacing S_L = baseSpacing * 2^L.
 *
 * Normal maps are baked at `normalScale` times the height-tile resolution
 * (default 1x here; the infinite page passes 8x), so they can carry detail
 * below the clipmap vertex spacing. Both tiles cover the same world square.
 */
export function generateTile(
  heightField: HeightField,
  {
    level,
    tx,
    ty,
    tileSize = 64,
    baseSpacing = 8,
    heightScale = DEFAULT_HEIGHT_SCALE,
    normalScale = 1,
  }: GenerateTileOptions,
): GeneratedTile {
  const spacing = baseSpacing * Math.pow(2, level);
  const normalRes = tileSize * normalScale;
  const normalSpacing = spacing / normalScale;
  const stride = normalRes + 2;
  const halo = new Float32Array(stride * stride);
  const heights = new Float32Array(tileSize * tileSize);

  const originX = tx * tileSize * spacing;
  const originZ = ty * tileSize * spacing;

  for (let j = -1; j <= normalRes; j++) {
    const worldZ = originZ + j * normalSpacing;
    const row = (j + 1) * stride;
    for (let i = -1; i <= normalRes; i++) {
      const worldX = originX + i * normalSpacing;
      halo[row + i + 1] = heightField.heightAt(worldX, worldZ);
    }
  }

  // Height samples sit on the clipmap vertex grid (every normalScale-th
  // sample of the high-resolution halo).
  for (let j = 0; j < tileSize; j++) {
    const row = (j * normalScale + 1) * stride;
    for (let i = 0; i < tileSize; i++) {
      heights[j * tileSize + i] = halo[row + i * normalScale + 1];
    }
  }

  const normals = bakeTileNormals(halo, normalRes, normalSpacing, heightScale);
  return { heights, normals };
}
