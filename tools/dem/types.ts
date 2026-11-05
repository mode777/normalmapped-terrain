/** Shared types for the offline DEM bake and validation tools. */

export interface WcsSourceConfig {
  type: 'kartverket-wcs';
  url: string;
  coverage: string;
  crs: string;
  chunkPixels?: number;
}

export interface LocalGeoTiffSourceConfig {
  type: 'local-geotiff';
  path: string;
  crs?: string;
}

export interface SyntheticSourceConfig {
  type: 'synthetic';
  /** Repository-relative generator module or label. */
  generator: string;
  seed: number;
  version: number;
}

export type DemSourceConfig = WcsSourceConfig | LocalGeoTiffSourceConfig | SyntheticSourceConfig;

export interface DemMaterialConfig {
  /** Packed material library manifest, relative to the repo root. */
  library: string;
  /** Four material IDs for the fixed stack palette. */
  slots: [string, string, string, string];
  /** Authored region palettes for a multi-biome stack. */
  palettes?: MaterialPalette[];
  /** Authored transition palettes between adjacent regions. */
  transitions?: MaterialTransition[];
  stackSize: number;
  macroSize: number;
  seed: number;
}

export interface MaterialPalette {
  /** Stable region identifier. */
  id: string;
  slots: [string, string, string, string];
}

export interface MaterialTransition {
  from: string;
  to: string;
  slots: [string, string, string, string];
  /** Full transition width in metres. */
  width: number;
}

export interface BiomeRegionManifest {
  id: string;
  label: string;
  /** Local-frame x/z viewpoint centre for the page and QA. */
  center: [number, number];
  /** Debug/legend color in linear 0..1 RGB. */
  color: [number, number, number];
}

export interface BiomeTransitionManifest {
  from: string;
  to: string;
  width: number;
}

export interface BiomeDatasetBlock {
  map: string;
  mapSize: number;
  encoding: 'rgba8-region-transition-progress-climate';
  report: string;
  regions: BiomeRegionManifest[];
  transitions: BiomeTransitionManifest[];
  hashes: {
    map: string;
    report: string;
  };
}

export interface DemConfig {
  dataset: string;
  source: DemSourceConfig;
  centerE: number;
  centerN: number;
  sizeMeters: number;
  spacing: number;
  heightScale: number;
  normalScale: number;
  levels: number;
  tileSize: number;
  outputDir: string;
  cacheDir?: string;
  license: string;
  attribution: string;
  materials?: DemMaterialConfig;
}

export interface DemGrid {
  /** Normalized heights, row-major, row 0 is north and +z is south. */
  data: Float32Array;
  cols: number;
  rows: number;
  spacing: number;
}

export interface SourceGridResult {
  grid: DemGrid;
  /** Raw elevations in metres, same dimensions as the grid. */
  elevations: Float32Array;
  bbox: { west: number; south: number; east: number; north: number };
  lastModified?: string;
  sourceType: DemSourceConfig['type'];
}

export interface TileRange {
  level: number;
  minTx: number;
  maxTx: number;
  minTy: number;
  maxTy: number;
  count: number;
}

export interface SeamLevelReport {
  level: number;
  samples: number;
  maxError: number;
  meanError: number;
}

export interface SeamReport {
  version: number;
  threshold: number;
  levels: SeamLevelReport[];
}

export interface MaterialDatasetBlock {
  /** Runtime-relative path under public/. */
  library: string;
  /** Legacy/default palette; per-texel IDs are authoritative when palettes exist. */
  slots: [string, string, string, string];
  palettes?: MaterialPalette[];
  transitions?: MaterialTransition[];
  stack: {
    ids: string;
    weights: string;
    size: number;
    extent: number;
    encoding: 'rgba8-ids-weights';
  };
  macro: string;
  macroSize: number;
  macroEncoding: 'rgba8';
  bakeVersion: number;
  seed: number;
  hashes: {
    ids: string;
    weights: string;
    macro: string;
  };
}

export interface Manifest {
  version: number;
  dataset: string;
  bakeVersion: number;
  source: {
    type: DemSourceConfig['type'];
    url?: string;
    coverage?: string;
    path?: string;
    crs: string;
    bbox: [number, number, number, number];
    resolution: number;
    lastModified?: string;
    generator?: string;
    seed?: number;
    version?: number;
  };
  license: string;
  attribution: string;
  localFrame: {
    centerE: number;
    centerN: number;
    sizeMeters: number;
    spacing: number;
    xAxis: 'east';
    zAxis: 'south';
    origin: 'center';
  };
  baseSpacing: number;
  tileSize: number;
  normalScale: number;
  levels: number;
  heightScale: number;
  heightRange: [number, number];
  normalizedRange: [number, number];
  heightEncoding: 'uint16le-normalized';
  normalEncoding: 'rgba8-objectspace';
  paths: {
    height: string;
    normal: string;
    coarseHeight: string;
    seamReport: string;
    preview: string;
  };
  coarseHeight: {
    file: string;
    size: number;
    spacing: number;
    encoding: 'uint16le-normalized';
    heightScale: number;
  };
  tileRanges: TileRange[];
  tileCount: number;
  seamReport: {
    file: string;
    threshold: number;
    maxError: number;
  };
  materials?: MaterialDatasetBlock;
  biomes?: BiomeDatasetBlock;
}
