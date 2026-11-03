/**
 * Terrain datasets. Both produce the same shape so the rest of the
 * pipeline (normal baking, mesh building, shading) is agnostic:
 *
 *   { id, name, res, worldSizeX, worldSizeZ, heightScale,
 *     heights: Float32Array (res*res, 0..1), credit, info }
 */

import {
  makeTerrainComposer,
  createSpline,
  BASE_CURVE_POINTS,
  RELIEF_CURVE_POINTS,
} from './terrain-compose.js';

const smoothstep = (a, b, x) => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

/**
 * Chunked procedural heightfield so we can show progress.
 *
 * Composition lives in terrain-compose.js (multi-noise + splines + iterated
 * domain warp + anisotropic ridge spines); see docs/TERRAIN_RESEARCH.md for
 * where the recipe comes from. This wrapper scales it to the finite window
 * and applies the soft square edge falloff.
 */
async function generateProcedural(res, worldSize, heightScale, seed, onProgress) {
  const heights = new Float32Array(res * res);
  const { heightAt } = makeTerrainComposer({
    seed,
    warpWavelength: 5200,
    warpAmplitude: 1500,
    continentWavelength: 18000,
    erosionWavelength: 7000,
    mountainWavelength: 3800,
    mountainOctaves: 8,
    spineWavelength: 5200,
    spineAnisotropy: 2.6,
    hillsWavelength: 2900,
    hillsOctaves: 5,
    roughnessWavelength: 2400,
    mountainAmp: 0.78,
    hillsAmp: 0.14,
    baseCurve: createSpline(BASE_CURVE_POINTS),
    reliefCurve: createSpline(RELIEF_CURVE_POINTS),
    // Rock micro-relief (64→32 m) below the 94 m Nyquist of the 192² mesh
    // but fully resolved by the 4.4 m/px heightfield: shading detail that
    // only the normal map can carry — the PoC's whole point.
    detailLayers: [{ wavelength: 64, amplitude: 0.0045, octaves: 2 }],
  });

  const CHUNK = 128;
  for (let j0 = 0; j0 < res; j0 += CHUNK) {
    const j1 = Math.min(res, j0 + CHUNK);
    for (let j = j0; j < j1; j++) {
      const z = (j / (res - 1) - 0.5) * worldSize;
      for (let i = 0; i < res; i++) {
        const x = (i / (res - 1) - 0.5) * worldSize;
        let h = heightAt(x, z);

        // Soft square falloff so the tile edges sink below the fog line
        const dx = Math.abs(i / (res - 1) - 0.5) * 2;
        const dz = Math.abs(j / (res - 1) - 0.5) * 2;
        const edge = Math.max(dx, dz);
        h *= smoothstep(1.0, 0.86, edge);

        heights[j * res + i] = h;
      }
    }
    onProgress?.(j1 / res);
    await new Promise(r => setTimeout(r, 0)); // let the UI breathe
  }
  return heights;
}

export async function buildProceduralDataset(onProgress) {
  const res = 2048;
  const worldSize = 9000;   // metres per side
  const heightScale = 1450; // metres of relief
  const heights = await generateProcedural(res, worldSize, heightScale, 20260117, onProgress);
  return {
    id: 'procedural',
    name: 'Procedural (composed)',
    res,
    worldSizeX: worldSize,
    worldSizeZ: worldSize,
    heightScale,
    heights,
    // Boot/reset camera: overlook of the ridge chain south of the tile
    // centre (see src/main.js initScene note).
    defaultView: {
      position: [910, 1500, -4394],
      target: [400, 710, -3000],
    },
    credit: 'Heightfield: seeded multi-noise composition — continent/erosion channels through spline curves, ridged crests × anisotropic spines, iterated domain warp — generated in your browser at load time.',
    info: [
      `heightfield ${res}² samples`,
      `world ${Math.round(worldSize / 100) / 10} × ${Math.round(worldSize / 100) / 10} km`,
      `relief ${heightScale} m`,
      'multi-noise · splines · ridged 8 oct · double warp',
    ],
  };
}

export async function buildGrandCanyonDataset() {
  const meta = await (await fetch('./data/grand-canyon.json')).json();
  const buf = await (await fetch('./data/grand-canyon.bin')).arrayBuffer();
  const u16 = new Uint16Array(buf);
  const res = meta.res;
  const heights = new Float32Array(res * res);
  for (let i = 0; i < heights.length; i++) heights[i] = u16[i] / 65535;
  const kmx = (meta.worldSizeX / 1000).toFixed(1);
  const kmz = (meta.worldSizeZ / 1000).toFixed(1);
  return {
    id: 'grand-canyon',
    name: 'Grand Canyon (SRTM)',
    res,
    worldSizeX: meta.worldSizeX,
    worldSizeZ: meta.worldSizeZ,
    heightScale: meta.heightScale,
    heights,
    credit: meta.credit,
    info: [
      `heightfield ${res}² @ ~${meta.metersPerPixel} m/px`,
      `world ${kmx} × ${kmz} km`,
      `relief ${Math.round(meta.heightScale)} m`,
      `${meta.latLonBounds.south.toFixed(3)}N ${meta.latLonBounds.west.toFixed(3)}W`,
    ],
  };
}

/** Bilinear sample of the normalised heightfield at uv in [0,1]². */
export function sampleHeight(heights, res, u, v) {
  const fx = Math.min(res - 1.001, Math.max(0, u * (res - 1)));
  const fz = Math.min(res - 1.001, Math.max(0, v * (res - 1)));
  const i = fx | 0, j = fz | 0;
  const tx = fx - i, tz = fz - j;
  const h00 = heights[j * res + i];
  const h10 = heights[j * res + i + 1];
  const h01 = heights[(j + 1) * res + i];
  const h11 = heights[(j + 1) * res + i + 1];
  return (h00 * (1 - tx) + h10 * tx) * (1 - tz) + (h01 * (1 - tx) + h11 * tx) * tz;
}
