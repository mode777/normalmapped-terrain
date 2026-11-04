/**
 * Terrain configuration helpers shared by the renderer, cache and pages.
 *
 * Keeping the derived metrics here prevents the procedural and pre-baked
 * pages from growing their own copies of the cache/phase/origin formulas.
 */

import type { TerrainConfig } from './tile-source.ts';

/** WebGL2's guaranteed minimum `MAX_TEXTURE_SIZE`. */
export const MAX_CACHE_TEXELS = 2048;

export interface TerrainMetrics {
  /** Half-extent of the last ring, metres. */
  outerExtent: number;
  /** Texels per side of one height array layer. */
  cacheSize: number;
  /** Texels per side of one normal array layer. */
  normalCacheSize: number;
  /** Normal texels per side of one tile. */
  normalTileSize: number;
  /** Largest tile-cache world size; used to keep the phase bounded. */
  phaseWrap: number;
  /** Floating-origin rebase granularity, metres. */
  renderOriginStep: number;
  /** Default fog density for the last ring's outer extent. */
  fogDensity: number;
}

export function deriveTerrainMetrics(config: TerrainConfig): TerrainMetrics {
  const outerExtent = 2 * config.centerCells * config.baseSpacing
    * Math.pow(2, config.levels - 1);
  const cacheSize = config.cacheTiles * config.tileSize;
  const normalTileSize = config.tileSize * config.normalScale;
  return {
    outerExtent,
    cacheSize,
    normalCacheSize: cacheSize * config.normalScale,
    normalTileSize,
    phaseWrap: config.cacheTiles * config.tileSize * config.baseSpacing
      * Math.pow(2, config.levels - 1),
    renderOriginStep: config.baseSpacing * Math.pow(2, config.levels + 1),
    fogDensity: 2.4 / outerExtent,
  };
}

/** Throws when the configured cache would exceed WebGL2's safe texture size. */
export function assertTextureBudget(config: TerrainConfig, metrics: TerrainMetrics): void {
  if (metrics.cacheSize > MAX_CACHE_TEXELS || metrics.normalCacheSize > MAX_CACHE_TEXELS) {
    throw new Error(
      `tile cache ${metrics.cacheSize}/${metrics.normalCacheSize} exceeds ${MAX_CACHE_TEXELS} texels`,
    );
  }
  if (config.tileSize < 1 || config.levels < 1 || config.cacheTiles < 1 || config.normalScale < 1) {
    throw new Error('terrain config requires positive tileSize, levels, cacheTiles and normalScale');
  }
}

/** Vertex spacing for a LOD, metres. */
export function spacingForLevel(config: TerrainConfig, level: number): number {
  return config.baseSpacing * Math.pow(2, level);
}

/** World size of one tile at a LOD, metres. */
export function tileWorldForLevel(config: TerrainConfig, level: number): number {
  return config.tileSize * spacingForLevel(config, level);
}
