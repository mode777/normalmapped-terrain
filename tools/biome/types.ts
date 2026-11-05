/** Shared types for the synthetic biome world bake. */

export interface BiomeMaterialPalette {
  id: string;
  slots: [string, string, string, string];
}

export interface BiomeMaterialTransition {
  from: string;
  to: string;
  slots: [string, string, string, string];
  /** Full transition width in metres. */
  width: number;
}

export interface BiomeRegionConfig {
  id: string;
  label: string;
  center: [number, number];
  color: [number, number, number];
}

export interface BiomeWorldConfig {
  dataset: string;
  seed: number;
  sizeMeters: number;
  spacing: number;
  heightScale: number;
  normalScale: number;
  levels: number;
  tileSize: number;
  outputDir: string;
  license: string;
  attribution: string;
  materials: {
    library: string;
    palettes: BiomeMaterialPalette[];
    transitions: BiomeMaterialTransition[];
    stackSize: number;
    macroSize: number;
    seed: number;
  };
  biomes: {
    mapSize: number;
    regions: BiomeRegionConfig[];
  };
}

export interface ClimateSample {
  /** 0 north, 1 south, after boundary warp. */
  climate: number;
  /** Region index 0..5, clamped at the edges. */
  regionIndex: number;
  /** -1 outside a transition band, otherwise 0..4. */
  transitionIndex: number;
  /** 0..1 across a transition band; 0 outside it. */
  progress: number;
  temperature: number;
  moisture: number;
}
