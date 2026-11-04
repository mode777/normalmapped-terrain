/**
 * Pre-baked TileSource.
 *
 * Loads a self-describing manifest and the checked-in height/normal tiles.
 * The renderer configuration is derived from the manifest so the page does
 * not hardcode the dataset's spacing, LOD count or normal scale.
 */

import type { TerrainConfig, GeneratedTile, TileSource } from '../terrain/tile-source.ts';

export interface DemManifestRange {
  level: number;
  minTx: number;
  maxTx: number;
  minTy: number;
  maxTy: number;
  count: number;
}

export interface DemMaterialBlock {
  library: string;
  slots: [string, string, string, string];
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

export interface DemManifest {
  version: number;
  dataset: string;
  bakeVersion: number;
  source: {
    type: string;
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
  tileRanges: DemManifestRange[];
  tileCount: number;
  seamReport: { file: string; threshold: number; maxError: number };
  materials?: DemMaterialBlock;
}

const clamp = (v: number, a: number, b: number): number => Math.max(a, Math.min(b, v));

export async function loadDemManifest(url: string): Promise<DemManifest> {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`failed to load DEM manifest: HTTP ${response.status}`);
  const manifest = await response.json() as DemManifest;
  if (manifest.version !== 1 && manifest.version !== 2) {
    throw new Error(`unsupported DEM manifest version ${manifest.version}`);
  }
  if (manifest.heightEncoding !== 'uint16le-normalized') {
    throw new Error(`unsupported height encoding ${manifest.heightEncoding}`);
  }
  if (manifest.normalEncoding !== 'rgba8-objectspace') {
    throw new Error(`unsupported normal encoding ${manifest.normalEncoding}`);
  }
  if (!Array.isArray(manifest.tileRanges) || manifest.tileRanges.length !== manifest.levels) {
    throw new Error('DEM manifest tileRanges do not match levels');
  }
  if (manifest.materials) {
    const m = manifest.materials;
    if (m.slots.length !== 4) throw new Error('DEM material slots must contain four IDs');
    if (m.stack.encoding !== 'rgba8-ids-weights') {
      throw new Error(`unsupported material stack encoding ${m.stack.encoding}`);
    }
    if (m.stack.size <= 0 || m.stack.extent <= 0 || m.macroSize <= 0) {
      throw new Error('DEM material stack/macro dimensions must be positive');
    }
  }
  return manifest;
}

/** Renderer config fields that the dataset itself defines. */
export function configFromManifest(manifest: DemManifest): TerrainConfig {
  return {
    baseSpacing: manifest.baseSpacing,
    levels: manifest.levels,
    tileSize: manifest.tileSize,
    // The normal LOD bias samples layer L-1; a symmetric 5x5 window is
    // required for that finer layer to cover the whole coarse ring.
    cacheTiles: 5,
    normalScale: manifest.normalScale,
    heightScale: manifest.heightScale,
    centerCells: 24,
    morphCells: 3,
    skirtDepth: 200,
  };
}

function expandPath(pattern: string, level: number, tx: number, ty: number): string {
  return pattern
    .replaceAll('{level}', String(level))
    .replaceAll('{tx}', String(tx))
    .replaceAll('{ty}', String(ty));
}

function decodeHeight(buffer: ArrayBuffer, tileSize: number): Float32Array {
  const u16 = new Uint16Array(buffer);
  if (u16.length !== tileSize * tileSize) {
    throw new Error(`height tile has ${u16.length} samples, expected ${tileSize * tileSize}`);
  }
  const out = new Float32Array(u16.length);
  for (let i = 0; i < u16.length; i++) out[i] = u16[i] / 65535;
  return out;
}

async function decodeNormal(blob: Blob, tileSize: number): Promise<Uint8Array> {
  const bitmap = await createImageBitmap(blob);
  if (bitmap.width !== tileSize || bitmap.height !== tileSize) {
    throw new Error(`normal tile is ${bitmap.width}x${bitmap.height}, expected ${tileSize}x${tileSize}`);
  }
  const canvas = typeof OffscreenCanvas !== 'undefined'
    ? new OffscreenCanvas(tileSize, tileSize)
    : Object.assign(document.createElement('canvas'), { width: tileSize, height: tileSize });
  const ctx = canvas.getContext('2d') as
    | OffscreenCanvasRenderingContext2D
    | CanvasRenderingContext2D
    | null;
  if (!ctx) throw new Error('could not create a 2D canvas for normal decoding');
  ctx.drawImage(bitmap, 0, 0);
  bitmap.close();
  const image = ctx.getImageData(0, 0, tileSize, tileSize);
  return new Uint8Array(image.data.buffer.slice(
    image.data.byteOffset,
    image.data.byteOffset + image.data.byteLength,
  ));
}

export interface PrebakedTileSourceOptions {
  manifest: DemManifest;
  manifestUrl: string;
}

export class PrebakedTileSource implements TileSource {
  readonly kind = 'prebaked' as const;
  readonly manifest: DemManifest;
  readonly config: TerrainConfig;
  readonly manifestUrl: string;
  readonly baseUrl: URL;

  private coarse: Float32Array | null = null;
  private coarseSize = 0;
  private coarseSpacing = 0;
  private initPromise: Promise<void> | null = null;
  private disposed = false;

  constructor({ manifest, manifestUrl }: PrebakedTileSourceOptions) {
    this.manifest = manifest;
    this.manifestUrl = manifestUrl;
    this.baseUrl = new URL('.', manifestUrl);
    this.config = configFromManifest(manifest);
  }

  async init(): Promise<void> {
    if (this.initPromise) return this.initPromise;
    this.initPromise = (async () => {
      const url = new URL(this.manifest.coarseHeight.file, this.baseUrl);
      const response = await fetch(url);
      if (!response.ok) throw new Error(`failed to load coarse height: HTTP ${response.status}`);
      const buffer = await response.arrayBuffer();
      const size = this.manifest.coarseHeight.size;
      const u16 = new Uint16Array(buffer);
      if (u16.length !== size * size) {
        throw new Error(`coarse height has ${u16.length} samples, expected ${size * size}`);
      }
      const out = new Float32Array(u16.length);
      for (let i = 0; i < u16.length; i++) out[i] = u16[i] / 65535;
      this.coarse = out;
      this.coarseSize = size;
      this.coarseSpacing = this.manifest.localFrame.sizeMeters / (size - 1);
    })();
    return this.initPromise;
  }

  private _range(level: number): DemManifestRange {
    const range = this.manifest.tileRanges[level];
    if (!range) throw new Error(`no tile range for level ${level}`);
    return range;
  }

  /** Clamps to the nearest edge tile, the finite-world edge policy. */
  private _clampTile(level: number, tx: number, ty: number): [number, number] {
    const r = this._range(level);
    return [clamp(tx, r.minTx, r.maxTx), clamp(ty, r.minTy, r.maxTy)];
  }

  async getTile(level: number, tx: number, ty: number): Promise<GeneratedTile> {
    await this.init();
    if (this.disposed) throw new Error('pre-baked tile source disposed');
    const [ctx, cty] = this._clampTile(level, tx, ty);
    const heightUrl = new URL(expandPath(this.manifest.paths.height, level, ctx, cty), this.baseUrl);
    const normalUrl = new URL(expandPath(this.manifest.paths.normal, level, ctx, cty), this.baseUrl);

    const [heightResponse, normalResponse] = await Promise.all([
      fetch(heightUrl),
      fetch(normalUrl),
    ]);
    if (!heightResponse.ok) {
      throw new Error(`height tile ${level}/${ctx}/${cty}: HTTP ${heightResponse.status}`);
    }
    if (!normalResponse.ok) {
      throw new Error(`normal tile ${level}/${ctx}/${cty}: HTTP ${normalResponse.status}`);
    }

    const [heightBuffer, normalBlob] = await Promise.all([
      heightResponse.arrayBuffer(),
      normalResponse.blob(),
    ]);
    const normalTileSize = this.manifest.tileSize * this.manifest.normalScale;
    return {
      heights: decodeHeight(heightBuffer, this.manifest.tileSize),
      normals: await decodeNormal(normalBlob, normalTileSize),
    };
  }

  /**
   * Coarse CPU height query, normalized [0,1], with a 3x3 max filter so a
   * coarse cell cannot hide a peak from the camera guard.
   */
  heightAt(x: number, z: number): number {
    if (!this.coarse) return 0;
    const size = this.coarseSize;
    const half = this.manifest.localFrame.sizeMeters / 2;
    const fx = clamp((x + half) / this.coarseSpacing, 0, size - 1);
    const fz = clamp((z + half) / this.coarseSpacing, 0, size - 1);
    const i0 = Math.floor(fx);
    const j0 = Math.floor(fz);
    let max = 0;
    for (let dj = -1; dj <= 1; dj++) {
      for (let di = -1; di <= 1; di++) {
        const i = clamp(i0 + di, 0, size - 1);
        const j = clamp(j0 + dj, 0, size - 1);
        max = Math.max(max, this.coarse[j * size + i]);
      }
    }
    return max;
  }

  dispose(): void {
    this.disposed = true;
    this.coarse = null;
  }
}
