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

export type DemSourceConfig = WcsSourceConfig | LocalGeoTiffSourceConfig;

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
}
