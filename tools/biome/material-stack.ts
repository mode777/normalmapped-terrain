/**
 * Multi-palette material stack bake for the synthetic biome world.
 *
 * The stack format stays four IDs + four weights per texel. Region interiors
 * use their authored palette. A transition band uses a fixed four-ID palette
 * and blends the two adjacent regions' weights restricted to that palette.
 * Region-specific materials that are not in the band palette fade to zero
 * before the band edge, so a nearest-sampled ID change happens only where the
 * material already has zero weight.
 */

import type { DemGrid } from '../dem/types.ts';
import { materialIndex } from '../dem/material-stack.ts';
import type { MaterialLibraryManifest } from '../dem/material-stack.ts';
import type {
  BiomeMaterialPalette,
  BiomeMaterialTransition,
  BiomeWorldConfig,
  ClimateSample,
} from './types.ts';
import type { BiomeWorld } from './world.ts';
import { CLIMATE_BOUNDARIES } from './world.ts';

export interface ResolvedBiomePalette {
  id: string;
  slots: [string, string, string, string];
  indices: [number, number, number, number];
  colors: [number, number, number][];
}

export interface ResolvedBiomeTransition {
  from: string;
  to: string;
  fromIndex: number;
  toIndex: number;
  slots: [string, string, string, string];
  indices: [number, number, number, number];
  colors: [number, number, number][];
  width: number;
  halfWidthClimate: number;
}

export interface BiomeMaterialSample {
  ids: [number, number, number, number];
  weights: [number, number, number, number];
  climate: ClimateSample;
  /** Region palette used for an interior sample. */
  regionIndex: number;
  /** -1 outside a band, otherwise the transition index. */
  transitionIndex: number;
  progress: number;
}

export interface BiomeStackOptions {
  grid: DemGrid;
  heightScale: number;
  size: number;
  extent: number;
  macroSize: number;
  mapSize: number;
  seed: number;
  world: BiomeWorld;
  palettes: ResolvedBiomePalette[];
  transitions: ResolvedBiomeTransition[];
}

export interface BiomeRegionReport {
  id: string;
  texels: number;
  fraction: number;
  weightMean: [number, number, number, number];
  weightRange: Array<[number, number]>;
}

export interface BiomeTransitionReport {
  from: string;
  to: string;
  texels: number;
  maxEdgeJump: number;
  maxNonBandWeight: number;
}

export interface BiomeStackReport {
  version: number;
  stackSize: number;
  macroSize: number;
  mapSize: number;
  extent: number;
  weightSum: { min: number; max: number };
  regions: BiomeRegionReport[];
  transitions: BiomeTransitionReport[];
}

export interface BiomeStackResult {
  ids: Uint8Array;
  weights: Uint8Array;
  macro: Uint8Array;
  map: Uint8Array;
  report: BiomeStackReport;
}

interface TerrainShape {
  height: number;
  slope: number;
  north: number;
  curvature: number;
  concavity: number;
}

interface TerrainSample extends TerrainShape {
  moisture: number;
  temperature: number;
}

const clamp01 = (v: number): number => (v < 0 ? 0 : v > 1 ? 1 : v);
const smoothstep = (a: number, b: number, x: number): number => {
  const t = clamp01((x - a) / (b - a));
  return t * t * (3 - 2 * t);
};

function hash2(x: number, z: number, seed: number): number {
  let h = Math.imul(x, 374761393) + Math.imul(z, 668265263) + Math.imul(seed, 1442695041);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}

function valueNoise(x: number, z: number, seed: number): number {
  const ix = Math.floor(x);
  const iz = Math.floor(z);
  const fx = x - ix;
  const fz = z - iz;
  const u = fx * fx * (3 - 2 * fx);
  const v = fz * fz * (3 - 2 * fz);
  const a = hash2(ix, iz, seed);
  const b = hash2(ix + 1, iz, seed);
  const c = hash2(ix, iz + 1, seed);
  const d = hash2(ix + 1, iz + 1, seed);
  return (a + (b - a) * u) * (1 - v) + (c + (d - c) * u) * v;
}

export function resolveBiomePalettes(
  config: BiomeWorldConfig,
  library: MaterialLibraryManifest,
): { palettes: ResolvedBiomePalette[]; transitions: ResolvedBiomeTransition[] } {
  const byId = new Map<string, number>();
  const palettes = config.materials.palettes.map((palette, index): ResolvedBiomePalette => {
    if (!palette.id || byId.has(palette.id)) {
      throw new Error(`duplicate or missing biome palette id ${palette.id}`);
    }
    byId.set(palette.id, index);
    return resolvePalette(palette, library);
  });
  if (palettes.length !== config.biomes.regions.length) {
    throw new Error('biome palettes and regions must have the same length');
  }
  for (let i = 0; i < palettes.length; i++) {
    if (palettes[i].id !== config.biomes.regions[i]?.id) {
      throw new Error(`biome palette ${palettes[i].id} does not match region order`);
    }
  }
  const transitions = config.materials.transitions.map((transition): ResolvedBiomeTransition => {
    const fromIndex = byId.get(transition.from);
    const toIndex = byId.get(transition.to);
    if (fromIndex === undefined || toIndex === undefined) {
      throw new Error(`transition ${transition.from}->${transition.to} references an unknown palette`);
    }
    if (toIndex !== fromIndex + 1) {
      throw new Error(`transition ${transition.from}->${transition.to} is not adjacent`);
    }
    const resolved = resolvePalette(transition, library);
    return {
      from: transition.from,
      to: transition.to,
      fromIndex,
      toIndex,
      slots: resolved.slots,
      indices: resolved.indices,
      colors: resolved.colors,
      width: transition.width,
      halfWidthClimate: transition.width / config.sizeMeters / 2,
    };
  });
  for (let i = 0; i < CLIMATE_BOUNDARIES.length; i++) {
    const transition = transitions[i];
    if (!transition || transition.fromIndex !== i) {
      throw new Error(`missing transition for climate boundary ${i}`);
    }
  }
  return { palettes, transitions };
}

function resolvePalette(
  palette: BiomeMaterialPalette | BiomeMaterialTransition,
  library: MaterialLibraryManifest,
): ResolvedBiomePalette {
  if (new Set(palette.slots).size !== 4) {
    throw new Error(`palette ${'id' in palette ? palette.id : `${palette.from}->${palette.to}`} `
      + 'must contain four unique materials');
  }
  const indices = palette.slots.map((id) => materialIndex(library, id)) as [
    number, number, number, number,
  ];
  const colors = indices.map((index) => {
    const entry = library.materials[index];
    if (!entry) throw new Error(`material ${index} is missing from the library`);
    return entry.averageColor;
  }) as [number, number, number][];
  return {
    id: 'id' in palette ? palette.id : `${palette.from}->${palette.to}`,
    slots: palette.slots,
    indices,
    colors,
  };
}

function terrainSample(
  grid: DemGrid,
  x: number,
  z: number,
  d: number,
  heightScale: number,
): TerrainShape {
  const sample = (px: number, pz: number): number => {
    const half = (grid.cols * grid.spacing) / 2;
    const fx = Math.max(0, Math.min(grid.cols - 1, (px + half) / grid.spacing));
    const fz = Math.max(0, Math.min(grid.rows - 1, (pz + half) / grid.spacing));
    const i0 = Math.floor(fx);
    const j0 = Math.floor(fz);
    const i1 = Math.min(grid.cols - 1, i0 + 1);
    const j1 = Math.min(grid.rows - 1, j0 + 1);
    const tx = fx - i0;
    const tz = fz - j0;
    const a = grid.data[j0 * grid.cols + i0];
    const b = grid.data[j0 * grid.cols + i1];
    const c = grid.data[j1 * grid.cols + i0];
    const e = grid.data[j1 * grid.cols + i1];
    return (a * (1 - tx) + b * tx) * (1 - tz) + (c * (1 - tx) + e * tx) * tz;
  };
  const h = sample(x, z);
  const hx0 = sample(x - d, z);
  const hx1 = sample(x + d, z);
  const hz0 = sample(x, z - d);
  const hz1 = sample(x, z + d);
  const gx = (hx1 - hx0) * heightScale / (2 * d);
  const gz = (hz1 - hz0) * heightScale / (2 * d);
  const length = Math.hypot(-gx, 1, -gz);
  const ny = 1 / length;
  const nz = -gz / length;
  const curvature = clamp01((h - (hx0 + hx1 + hz0 + hz1) / 4) * 600);
  return {
    height: h,
    slope: 1 - ny,
    north: clamp01(-nz),
    curvature,
    concavity: clamp01(-(h - (hx0 + hx1 + hz0 + hz1) / 4) * 600),
  };
}

/** Raw per-material weight fields, independent of which palette uses them. */
function materialWeight(
  id: string,
  sample: TerrainSample,
  x: number,
  z: number,
  seed: number,
  regionId: string,
): number {
  const n1 = valueNoise(x / 900, z / 900, seed);
  const n2 = valueNoise(x / 2600, z / 2600, seed + 1);
  const n3 = valueNoise(x / 4200, z / 4200, seed + 2);
  const cliff = smoothstep(0.28, 0.62, sample.slope);
  // The arctic band is cold enough to carry snow well below the world's
  // highest peaks; the other palettes do not include a snow material.
  const arctic = regionId === 'arctic';
  const snowCover = smoothstep(arctic ? 0.24 : 0.70, arctic ? 0.44 : 0.90, sample.height);
  const low = 1 - smoothstep(0.44, 0.70, sample.height);
  const gentle = 1 - smoothstep(0.16, 0.42, sample.slope);
  const steep = smoothstep(0.24, 0.56, sample.slope);
  const dry = 1 - sample.concavity * 0.35;
  switch (id) {
    case 'snow_02':
      return snowCover * (1 - 0.65 * steep) * (0.55 + 0.45 * sample.north)
        * (0.82 + 0.18 * n1);
    case 'snow_field_aerial':
      return smoothstep(arctic ? 0.32 : 0.76, arctic ? 0.54 : 0.92, sample.height)
        * (1 - 0.45 * steep) * (0.80 + 0.20 * n2);
    case 'rock_face_03':
      return cliff * (0.55 + 0.45 * n1);
    case 'rocky_terrain_02':
      return (1 - cliff) * (0.65 + 0.35 * (1 - snowCover)) * (0.80 + 0.20 * n2);
    case 'rock_pitted_mossy':
      return (1 - cliff) * gentle * (0.45 + 0.55 * sample.moisture) * (0.80 + 0.20 * n1);
    case 'lichen_rock':
      return (1 - cliff) * (0.25 + 0.75 * gentle) * (0.35 + 0.65 * sample.moisture)
        * (0.75 + 0.25 * n2);
    case 'sparse_grass':
      return 0.35 * low * gentle * (0.60 + 0.40 * sample.moisture) * (1 - cliff);
    case 'forest_ground_04':
      return low * gentle * (0.55 + 0.45 * sample.moisture) * (1 - cliff);
    case 'brown_mud_leaves_01':
      return low * (1 - 0.5 * steep) * (0.35 + 0.65 * sample.concavity) * (0.80 + 0.20 * n3);
    case 'mossy_rock':
      return steep * (0.30 + 0.70 * sample.moisture) * (0.75 + 0.25 * n1);
    case 'leafy_grass':
      return low * gentle * (0.60 + 0.40 * sample.moisture) * (1 - cliff);
    case 'brown_mud_03':
      return low * (1 - 0.35 * steep) * (0.35 + 0.65 * sample.concavity) * (0.85 + 0.15 * n2);
    case 'sand_01':
      return low * gentle * (0.55 + 0.45 * dry) * (0.70 + 0.30 * n1) * (1 - cliff);
    case 'dry_ground_rocks':
      return (0.35 + 0.65 * steep) * (0.45 + 0.55 * dry) * (0.80 + 0.20 * n2);
    case 'sandstone_cracks':
      return low * gentle * (0.50 + 0.50 * dry) * (0.80 + 0.20 * n3);
    case 'forest_leaves_02':
      return low * gentle * (0.60 + 0.40 * sample.moisture) * (1 - cliff);
    case 'red_laterite_soil_stones':
      return (0.40 + 0.60 * steep) * (0.55 + 0.45 * dry) * (0.80 + 0.20 * n1);
    default:
      return 0;
  }
}

function normalize4(weights: [number, number, number, number]): [number, number, number, number] {
  const total = weights[0] + weights[1] + weights[2] + weights[3];
  if (total <= 1e-9) return [1, 0, 0, 0];
  return [weights[0] / total, weights[1] / total, weights[2] / total, weights[3] / total];
}

function regionPaletteWeights(
  palette: ResolvedBiomePalette,
  sample: TerrainSample,
  x: number,
  z: number,
  seed: number,
): [number, number, number, number] {
  const raw: [number, number, number, number] = [0, 0, 0, 0];
  for (let k = 0; k < 4; k++) {
    raw[k] = materialWeight(palette.slots[k], sample, x, z, seed, palette.id);
  }
  return normalize4(raw);
}

function restrictedWeights(
  palette: ResolvedBiomePalette,
  transition: ResolvedBiomeTransition,
  sample: TerrainSample,
  x: number,
  z: number,
  seed: number,
): [number, number, number, number] {
  const raw = regionPaletteWeights(palette, sample, x, z, seed);
  const out: [number, number, number, number] = [0, 0, 0, 0];
  for (let k = 0; k < 4; k++) {
    const id = palette.slots[k];
    const target = transition.slots.indexOf(id);
    if (target >= 0) out[target] += raw[k];
  }
  return normalize4(out);
}

function edgeKeep(
  palette: ResolvedBiomePalette,
  transition: ResolvedBiomeTransition | undefined,
  distance: number,
  fade: number,
  slot: number,
): number {
  if (!transition) return 1;
  if (transition.slots.includes(palette.slots[slot])) return 1;
  const edge = transition.halfWidthClimate;
  return smoothstep(edge, edge + fade, distance);
}

/** Samples the four IDs and weights at one world position. */
export function sampleBiomeMaterial(options: BiomeStackOptions, x: number, z: number, d: number): BiomeMaterialSample {
  const { grid, heightScale, world, palettes, transitions, seed } = options;
  const shape = terrainSample(grid, x, z, d, heightScale);
  const climate = world.climateAt(x, z, shape.height);
  const terrain: TerrainSample = {
    ...shape,
    moisture: climate.moisture,
    temperature: climate.temperature,
  };
  const regionIndex = climate.regionIndex;

  if (climate.transitionIndex >= 0) {
    const transition = transitions[climate.transitionIndex];
    if (!transition) throw new Error(`missing transition ${climate.transitionIndex}`);
    const from = palettes[transition.fromIndex];
    const to = palettes[transition.toIndex];
    if (!from || !to) throw new Error(`missing palette for transition ${transition.from}->${transition.to}`);
    const left = restrictedWeights(from, transition, terrain, x, z, seed);
    const right = restrictedWeights(to, transition, terrain, x, z, seed);
    const p = smoothstep(0, 1, climate.progress);
    const weights = normalize4([
      left[0] * (1 - p) + right[0] * p,
      left[1] * (1 - p) + right[1] * p,
      left[2] * (1 - p) + right[2] * p,
      left[3] * (1 - p) + right[3] * p,
    ]);
    return {
      ids: transition.indices,
      weights,
      climate,
      regionIndex,
      transitionIndex: climate.transitionIndex,
      progress: climate.progress,
    };
  }

  const palette = palettes[regionIndex];
  if (!palette) throw new Error(`missing palette for region ${regionIndex}`);
  const raw = regionPaletteWeights(palette, terrain, x, z, seed);
  const leftBoundary = regionIndex > 0 ? CLIMATE_BOUNDARIES[regionIndex - 1] : undefined;
  const rightBoundary = regionIndex < CLIMATE_BOUNDARIES.length
    ? CLIMATE_BOUNDARIES[regionIndex]
    : undefined;
  const leftTransition = regionIndex > 0 ? transitions[regionIndex - 1] : undefined;
  const rightTransition = regionIndex < transitions.length ? transitions[regionIndex] : undefined;
  const fade = 0.025;
  const leftDistance = leftBoundary === undefined ? Infinity : climate.climate - leftBoundary;
  const rightDistance = rightBoundary === undefined ? Infinity : rightBoundary - climate.climate;
  const kept: [number, number, number, number] = [0, 0, 0, 0];
  for (let k = 0; k < 4; k++) {
    const keepLeft = edgeKeep(palette, leftTransition, leftDistance, fade, k);
    const keepRight = edgeKeep(palette, rightTransition, rightDistance, fade, k);
    kept[k] = raw[k] * Math.min(keepLeft, keepRight);
  }
  return {
    ids: palette.indices,
    weights: normalize4(kept),
    climate,
    regionIndex,
    transitionIndex: -1,
    progress: 0,
  };
}

function quantize(weights: [number, number, number, number]): [number, number, number, number] {
  const q: [number, number, number, number] = [0, 0, 0, 0];
  let total = 0;
  for (let k = 0; k < 4; k++) {
    q[k] = Math.round(weights[k] * 255);
    total += q[k];
  }
  let diff = 255 - total;
  if (diff !== 0) {
    let largest = 0;
    for (let k = 1; k < 4; k++) if (q[k] > q[largest]) largest = k;
    q[largest] = Math.max(0, Math.min(255, q[largest] + diff));
    diff = 255 - (q[0] + q[1] + q[2] + q[3]);
    if (diff !== 0) q[0] = Math.max(0, Math.min(255, q[0] + diff));
  }
  return q;
}

export function bakeBiomeStack(options: BiomeStackOptions): BiomeStackResult {
  const { grid, size, extent, macroSize, mapSize, palettes, transitions, seed, world } = options;
  const half = extent / 2;
  const stackSpacing = extent / size;
  const macroSpacing = extent / macroSize;
  const ids = new Uint8Array(size * size * 4);
  const weights = new Uint8Array(size * size * 4);
  const regionTexels = new Array(palettes.length).fill(0);
  const regionWeightSum = palettes.map(() => [0, 0, 0, 0] as [number, number, number, number]);
  const regionWeightMin = palettes.map(() => [Infinity, Infinity, Infinity, Infinity] as [number, number, number, number]);
  const regionWeightMax = palettes.map(() => [-Infinity, -Infinity, -Infinity, -Infinity] as [number, number, number, number]);
  const transitionTexels = new Array(transitions.length).fill(0);
  let sumMin = Infinity;
  let sumMax = -Infinity;

  for (let j = 0; j < size; j++) {
    const z = -half + (j + 0.5) * stackSpacing;
    for (let i = 0; i < size; i++) {
      const x = -half + (i + 0.5) * stackSpacing;
      const sample = sampleBiomeMaterial(options, x, z, stackSpacing);
      const q = quantize(sample.weights);
      const o = (j * size + i) * 4;
      for (let k = 0; k < 4; k++) ids[o + k] = sample.ids[k];
      let sum = 0;
      for (let k = 0; k < 4; k++) {
        weights[o + k] = q[k];
        sum += q[k];
      }
      sum /= 255;
      sumMin = Math.min(sumMin, sum);
      sumMax = Math.max(sumMax, sum);
      if (sample.transitionIndex >= 0) {
        transitionTexels[sample.transitionIndex]++;
      } else {
        const r = sample.regionIndex;
        regionTexels[r]++;
        for (let k = 0; k < 4; k++) {
          regionWeightSum[r][k] += sample.weights[k];
          regionWeightMin[r][k] = Math.min(regionWeightMin[r][k], sample.weights[k]);
          regionWeightMax[r][k] = Math.max(regionWeightMax[r][k], sample.weights[k]);
        }
      }
    }
  }

  const macro = new Uint8Array(macroSize * macroSize * 4);
  for (let j = 0; j < macroSize; j++) {
    const z = -half + (j + 0.5) * macroSpacing;
    for (let i = 0; i < macroSize; i++) {
      const x = -half + (i + 0.5) * macroSpacing;
      const sample = sampleBiomeMaterial(options, x, z, macroSpacing);
      const variation = 0.90 + 0.20 * valueNoise(x / 3200, z / 3200, seed + 3);
      const o = (j * macroSize + i) * 4;
      for (let c = 0; c < 3; c++) {
        let color = 0;
        for (let k = 0; k < 4; k++) {
          const id = sample.ids[k];
          const palette = sample.transitionIndex >= 0
            ? transitions[sample.transitionIndex]
            : palettes[sample.regionIndex];
          const colorIndex = palette.indices.indexOf(id);
          const rgb = colorIndex >= 0 ? palette.colors[colorIndex] : [0.5, 0.5, 0.5];
          color += sample.weights[k] * (rgb?.[c] ?? 0.5);
        }
        macro[o + c] = Math.round(clamp01(color * variation) * 255);
      }
      macro[o + 3] = 255;
    }
  }

  const map = new Uint8Array(mapSize * mapSize * 4);
  const mapSpacing = extent / mapSize;
  for (let j = 0; j < mapSize; j++) {
    const z = -half + (j + 0.5) * mapSpacing;
    for (let i = 0; i < mapSize; i++) {
      const x = -half + (i + 0.5) * mapSpacing;
      const terrain = terrainSample(grid, x, z, mapSpacing, options.heightScale);
      const climate = world.climateAt(x, z, terrain.height);
      const o = (j * mapSize + i) * 4;
      map[o] = climate.regionIndex;
      map[o + 1] = climate.transitionIndex + 1;
      map[o + 2] = Math.round(clamp01(climate.progress) * 255);
      map[o + 3] = Math.round(clamp01(climate.climate) * 255);
    }
  }

  const totalTexels = size * size;
  const regions: BiomeRegionReport[] = palettes.map((palette, index) => {
    const count = regionTexels[index];
    return {
      id: palette.id,
      texels: count,
      fraction: count / totalTexels,
      weightMean: (count > 0
        ? regionWeightSum[index].map((v) => v / count)
        : [0, 0, 0, 0]) as [number, number, number, number],
      weightRange: regionWeightMin[index].map((v, k) => [
        v === Infinity ? 0 : v,
        regionWeightMax[index][k] === -Infinity ? 0 : regionWeightMax[index][k],
      ]) as Array<[number, number]>,
    };
  });

  const transitionsReport: BiomeTransitionReport[] = transitions.map((transition, index) => {
    const continuity = measureTransitionContinuity(options, index);
    return {
      from: transition.from,
      to: transition.to,
      texels: transitionTexels[index],
      maxEdgeJump: continuity.maxEdgeJump,
      maxNonBandWeight: continuity.maxNonBandWeight,
    };
  });

  return {
    ids,
    weights,
    macro,
    map,
    report: {
      version: 1,
      stackSize: size,
      macroSize,
      mapSize,
      extent,
      weightSum: { min: sumMin, max: sumMax },
      regions,
      transitions: transitionsReport,
    },
  };
}

/** Compares the zone weights just outside a band with the band weights at its edges. */
export function measureTransitionContinuity(
  options: BiomeStackOptions,
  transitionIndex: number,
): { maxEdgeJump: number; maxNonBandWeight: number } {
  const transition = options.transitions[transitionIndex];
  if (!transition) throw new Error(`missing transition ${transitionIndex}`);
  const boundary = CLIMATE_BOUNDARIES[transitionIndex];
  const width = transition.width / options.extent / 2;
  const step = 2e-5;
  const zFor = (target: number): number => {
    const half = options.extent / 2;
    let lo = -half;
    let hi = half;
    for (let i = 0; i < 40; i++) {
      const mid = (lo + hi) / 2;
      if (options.world.climateAt(0, mid).climate < target) lo = mid; else hi = mid;
    }
    return (lo + hi) / 2;
  };
  const transitionIds = transition.slots.map((id) => id);
  let maxEdgeJump = 0;
  let maxNonBandWeight = 0;
  for (const side of [0, 1] as const) {
    const edgeClimate = boundary + (side === 0 ? -width : width);
    const outsideZ = zFor(edgeClimate + (side === 0 ? -step : step));
    const insideZ = zFor(edgeClimate + (side === 0 ? step : -step));
    const outside = sampleBiomeMaterial(options, 0, outsideZ, options.extent / options.size);
    const inside = sampleBiomeMaterial(options, 0, insideZ, options.extent / options.size);
    const outsideById = new Map<number, number>();
    const insideById = new Map<number, number>();
    for (let k = 0; k < 4; k++) {
      outsideById.set(outside.ids[k], (outsideById.get(outside.ids[k]) ?? 0) + outside.weights[k]);
      insideById.set(inside.ids[k], (insideById.get(inside.ids[k]) ?? 0) + inside.weights[k]);
    }
    const ids = new Set([...outsideById.keys(), ...insideById.keys()]);
    for (const id of ids) {
      maxEdgeJump = Math.max(
        maxEdgeJump,
        Math.abs((outsideById.get(id) ?? 0) - (insideById.get(id) ?? 0)),
      );
    }
    if (outside.transitionIndex < 0) {
      for (let k = 0; k < 4; k++) {
        if (!transitionIds.includes(options.palettes[outside.regionIndex]?.slots[k] ?? '')) {
          maxNonBandWeight = Math.max(maxNonBandWeight, outside.weights[k]);
        }
      }
    }
  }
  return { maxEdgeJump, maxNonBandWeight };
}
