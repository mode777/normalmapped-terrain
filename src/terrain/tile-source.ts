/**
 * Shared terrain source contract.
 *
 * A tile source produces the two payloads the renderer needs for one world
 * tile: normalized float heights and object-space RGBA8 normals. The cache
 * owns residency and uploads; the renderer owns geometry and shading. Neither
 * side needs to know whether the source generates tiles or loads them from
 * disk.
 */

export interface TerrainConfig {
  /** Metres between LOD 0 vertices. */
  baseSpacing: number;
  /** Number of clipmap LODs. */
  levels: number;
  /** Height samples per tile side. */
  tileSize: number;
  /** Tile slots per square cache layer. */
  cacheTiles: number;
  /** Normal texels per height sample. */
  normalScale: number;
  /** Metres of relief for normalized height 1. */
  heightScale: number;
  /** Centre-block half-size and ring width, in cells. */
  centerCells: number;
  /** Outer cells of each ring that morph into the next-coarser mesh. */
  morphCells: number;
  /** Metres of horizon skirt on the last ring. */
  skirtDepth: number;
}

export interface GeneratedTile {
  /** `tileSize^2` normalized heights, row-major, row j -> +z. */
  heights: Float32Array;
  /** `(tileSize * normalScale)^2 * 4` RGBA8 object-space normals. */
  normals: Uint8Array;
}

export type TileSourceKind = 'procedural' | 'prebaked';

export interface TileSource {
  readonly kind: TileSourceKind;
  /** Load manifests or start workers. Must resolve before the first getTile. */
  init(): Promise<void>;
  /** Resolve one world tile. Rejections are surfaced by the cache. */
  getTile(level: number, tx: number, ty: number): Promise<GeneratedTile>;
  /** Optional CPU height query, normalized [0,1], for camera clearance. */
  heightAt?(x: number, z: number): number;
  /** Optional worker count, for diagnostics. */
  readonly workerCount?: number;
  dispose(): void;
}
