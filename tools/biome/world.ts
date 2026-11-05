/**
 * Seeded synthetic biome world.
 *
 * The height field is a pure function of (x, z): the bake samples it once into
 * the global grid, and every tile/LOD is derived from that grid. Climate is a
 * north-south coordinate warped by low-frequency noise; six equal bands give
 * the region order. Temperature and moisture are secondary material inputs,
 * not a second terrain pass.
 */

import { Perlin } from '../../src/perlin.ts';
import { makeTerrainComposer } from '../../src/terrain-compose.ts';
import type { ClimateSample } from './types.ts';

export const REGION_IDS = [
  'arctic',
  'tundra',
  'boreal',
  'temperate',
  'arid',
  'tropical',
] as const;

export const REGION_COUNT = REGION_IDS.length;
export const CLIMATE_BOUNDARIES = [1 / 6, 2 / 6, 3 / 6, 4 / 6, 5 / 6] as const;

export interface BiomeWorldOptions {
  seed: number;
  sizeMeters: number;
  /** Full transition width in metres for each of the five boundaries. */
  transitionWidths?: readonly number[];
}

export interface BiomeWorld {
  readonly seed: number;
  readonly sizeMeters: number;
  heightAt(x: number, z: number): number;
  climateAt(x: number, z: number, height?: number): ClimateSample;
}

const clamp01 = (v: number): number => (v < 0 ? 0 : v > 1 ? 1 : v);
const smoothstep = (a: number, b: number, x: number): number => {
  const t = clamp01((x - a) / (b - a));
  return t * t * (3 - 2 * t);
};

export function makeBiomeWorld({
  seed,
  sizeMeters,
  transitionWidths = [720, 720, 720, 720, 720],
}: BiomeWorldOptions): BiomeWorld {
  if (transitionWidths.length !== CLIMATE_BOUNDARIES.length) {
    throw new Error(`expected ${CLIMATE_BOUNDARIES.length} transition widths`);
  }
  const half = sizeMeters / 2;

  const { heightAt: composedHeight } = makeTerrainComposer({
    // Shorter wavelengths than the infinite world: this window is 15.36 km,
    // so a 45 km continental channel would barely vary across it.
    seed,
    warpWavelength: 4200,
    warpAmplitude: 850,
    continentWavelength: 13000,
    erosionWavelength: 7000,
    mountainWavelength: 3600,
    mountainOctaves: 7,
    spineWavelength: 5000,
    spineAnisotropy: 2.2,
    hillsWavelength: 2100,
    hillsOctaves: 4,
    roughnessWavelength: 2600,
    mountainAmp: 0.68,
    hillsAmp: 0.18,
    detailLayers: [
      { wavelength: 420, amplitude: 0.018, octaves: 3 },
      { wavelength: 110, amplitude: 0.010, octaves: 3 },
      { wavelength: 34, amplitude: 0.005, octaves: 2 },
    ],
  });

  const climateNoise = new Perlin(seed + 11001);
  const temperatureNoise = new Perlin(seed + 12001);
  const moistureNoise = new Perlin(seed + 13001);

  function heightAt(x: number, z: number): number {
    const lat = clamp01((z + half) / sizeMeters);
    const base = composedHeight(x, z);
    // High peaks live in the north; the south stays lower and warmer.
    const mountainBias = 1 - 0.55 * smoothstep(0.18, 0.82, lat);
    const northLift = 0.12 * (1 - lat);
    return clamp01((base * (0.52 + 0.48 * mountainBias) + northLift) * 0.98 + 0.01);
  }

  function climateAt(x: number, z: number, height = heightAt(x, z)): ClimateSample {
    const lat = clamp01((z + half) / sizeMeters);
    const warp = 0.032 * climateNoise.fbm(x / 6200, z / 6200, 3);
    const climate = clamp01(lat + warp);
    const regionIndex = Math.min(REGION_COUNT - 1, Math.floor(climate * REGION_COUNT));

    let transitionIndex = -1;
    let progress = 0;
    for (let i = 0; i < CLIMATE_BOUNDARIES.length; i++) {
      const boundary = CLIMATE_BOUNDARIES[i];
      const halfWidth = transitionWidths[i] / sizeMeters / 2;
      if (Math.abs(climate - boundary) <= halfWidth) {
        transitionIndex = i;
        progress = clamp01((climate - (boundary - halfWidth)) / (2 * halfWidth));
        break;
      }
    }

    // South is warm, north is cold; altitude cools every latitude.
    const temperature = clamp01(
      0.15 + 0.80 * climate - 0.55 * height
      + 0.05 * temperatureNoise.fbm(x / 3200, z / 3200, 3),
    );
    const moisture = clamp01(
      0.52 + 0.30 * moistureNoise.fbm(x / 4800, z / 4800, 3) - 0.10 * climate,
    );

    return { climate, regionIndex, transitionIndex, progress, temperature, moisture };
  }

  return { seed, sizeMeters, heightAt, climateAt };
}
