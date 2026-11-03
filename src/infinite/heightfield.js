/**
 * Infinite procedural heightfield + per-tile Sobel normal baking.
 *
 * This is the large-world sibling of src/terrain-data.js / src/normalmap.js:
 * the same heightfield -> float gradient -> object-space normal-map pipeline,
 * but evaluated per tile at an arbitrary world coordinate instead of being
 * generated once for a finite square.
 *
 * The height function is deterministic for a given seed. Every tile is
 * sampled in absolute world metres, so adjacent tiles and adjacent LODs agree
 * at shared sample positions.
 */

import { makeTerrainComposer } from '../terrain-compose.js';

export const DEFAULT_SEED = 20260217;
export const DEFAULT_HEIGHT_SCALE = 1500; // metres of relief for h in [0,1]

/**
 * Creates a seeded, effectively infinite height function.
 *
 * The composition (multi-noise channels + spline response curves + iterated
 * domain warp + anisotropic ridge spines) lives in src/terrain-compose.js
 * and is shared with the finite PoC; see docs/TERRAIN_RESEARCH.md for the
 * recipe and its sources. A pure-function height field is what makes the
 * streaming cache work: no global passes (e.g. erosion simulation) are
 * possible without seams, so the variety comes from composition alone.
 *
 * Returns normalized heights in [0,1]. Multiply by `heightScale` for metres.
 * The same object can be created in the worker and on the main thread; as
 * long as the seed matches, both evaluate the same field.
 */
export function makeHeightField(seed = DEFAULT_SEED) {
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
 * Bakes a tile of object-space normals from a float height patch.
 *
 * @param {Float32Array} heightsHalo (tileSize+2)^2, row-major, one-sample halo
 * @param {number} tileSize         samples per side of the output tile
 * @param {number} spacing          metres between samples
 * @param {number} heightScale      metres for heights going 0 -> 1
 * @returns {Uint8Array} tileSize^2 * 4, RGBA8 (R=N.x, G=N.z, B=N.y)
 */
export function bakeTileNormals(heightsHalo, tileSize, spacing, heightScale) {
  const out = new Uint8Array(tileSize * tileSize * 4);
  const stride = tileSize + 2;
  const gradScale = heightScale / (8 * spacing);

  for (let j = 0; j < tileSize; j++) {
    const row = (j + 1) * stride;
    const rowUp = j * stride;
    const rowDown = (j + 2) * stride;

    for (let i = 0; i < tileSize; i++) {
      const c = i + 1;

      const tl = heightsHalo[rowUp + c - 1], t = heightsHalo[rowUp + c], tr = heightsHalo[rowUp + c + 1];
      const l = heightsHalo[row + c - 1], r = heightsHalo[row + c + 1];
      const bl = heightsHalo[rowDown + c - 1], b = heightsHalo[rowDown + c], br = heightsHalo[rowDown + c + 1];

      // Sobel X (columns = world x) and Z (rows = world z). Same derivation
      // as src/normalmap.js: response is divided by 8 * pixelSpacing and
      // multiplied by heightScale before forming N ∝ (-dh/dx, 1, -dh/dz).
      const gx = (tr + 2 * r + br) - (tl + 2 * l + bl);
      const gz = (bl + 2 * b + br) - (tl + 2 * t + tr);

      let nx = -gx * gradScale;
      let ny = 1.0;
      let nz = -gz * gradScale;
      const inv = 1.0 / Math.sqrt(nx * nx + ny * ny + nz * nz);
      nx *= inv; ny *= inv; nz *= inv;

      const o = (j * tileSize + i) * 4;
      out[o] = Math.round((nx * 0.5 + 0.5) * 255);
      out[o + 1] = Math.round((nz * 0.5 + 0.5) * 255);
      out[o + 2] = Math.round((ny * 0.5 + 0.5) * 255);
      out[o + 3] = 255;
    }
  }

  return out;
}

/**
 * Generates one tile at a given LOD.
 *
 * Tile (tx,ty) at LOD L covers world cells
 *   [tx*T, ty*T] .. [tx*T+T-1, ty*T+T-1]
 * with spacing S_L = baseSpacing * 2^L.
 *
 * Normal maps are baked at `normalScale` times the height-tile resolution
 * (default 2x), so they can carry detail below the clipmap vertex spacing.
 * Both tiles cover the same world square.
 *
 * @returns {{heights: Float32Array, normals: Uint8Array}}
 */
export function generateTile(heightField, {
  level,
  tx,
  ty,
  tileSize = 64,
  baseSpacing = 8,
  heightScale = DEFAULT_HEIGHT_SCALE,
  normalScale = 1,
}) {
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
