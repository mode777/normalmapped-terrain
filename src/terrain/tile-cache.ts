/**
 * Toroidal clipmap tile cache.
 *
 * The cache owns residency, priority and GPU uploads. It asks a TileSource for
 * missing tiles and does not care whether the source runs workers or loads
 * files. One DataArrayTexture layer is used per LOD; each layer is a K x K grid
 * of tile slots, with world tile (tx,ty) always stored at (tx mod K, ty mod K).
 */

import * as THREE from 'three';
import type {
  GeneratedTile,
  TerrainConfig,
  TileSource,
  TileSourceKind,
} from './tile-source.ts';
import { spacingForLevel, tileWorldForLevel } from './config.ts';

const mod = (n: number, m: number): number => ((n % m) + m) % m;

export interface TileProgress {
  done: number;
  total: number;
}

export interface TileJob {
  key: string;
  level: number;
  tx: number;
  ty: number;
  priority: number;
}

interface DesiredTile {
  tx: number;
  ty: number;
  key: string;
  priority: number;
}

interface TileLevel {
  level: number;
  spacing: number;
  tileWorld: number;
  cacheWorld: number;
  slots: Array<string | null>;
  desired: Array<DesiredTile | null>;
  lastCamTx: number | null;
  lastCamTy: number | null;
}

interface TileDst {
  x: number;
  y: number;
  z: number;
}

export interface TileUploadError {
  heightErr: number;
  normalErr: number;
  heightType: THREE.TextureDataType;
  level: number;
  tx: number;
  ty: number;
  heightDst: TileDst;
  normalDst: TileDst;
}

export interface TileStats {
  resident: number;
  generated: number;
  uploaded: number;
  uploadErrors: number;
  queued: number;
  inFlight: number;
  workers: number;
  source: TileSourceKind;
}

export interface TileCacheOptions {
  renderer: THREE.WebGLRenderer;
  source: TileSource;
  config: TerrainConfig;
  heightTexture: THREE.DataArrayTexture;
  normalTexture: THREE.DataArrayTexture;
  heightType: THREE.TextureDataType;
  maxInFlight?: number;
  onProgress?: ((ratio: number, progress: TileProgress) => void) | undefined;
  onTile?: ((job: TileJob) => void) | undefined;
  onError?: ((error: unknown, job: TileJob) => void) | undefined;
}

interface PendingWaiter {
  resolve: () => void;
  reject: (error: Error) => void;
}

export class TileCache {
  readonly renderer: THREE.WebGLRenderer;
  readonly source: TileSource;
  readonly config: TerrainConfig;
  readonly heightTexture: THREE.DataArrayTexture;
  readonly normalTexture: THREE.DataArrayTexture;
  readonly heightType: THREE.TextureDataType;
  readonly levels: TileLevel[];
  readonly heightScratch: THREE.DataTexture;
  readonly normalScratch: THREE.DataTexture;
  readonly maxInFlight: number;

  onProgress: ((ratio: number, progress: TileProgress) => void) | undefined;
  onTile: ((job: TileJob) => void) | undefined;
  onError: ((error: unknown, job: TileJob) => void) | undefined;

  queue: TileJob[] = [];
  jobs = new Map<number, TileJob>();
  requested = new Set<string>();
  failed = new Set<string>();
  jobId = 0;
  generated = 0;
  uploaded = 0;
  inFlight = 0;
  lastUploadError: TileUploadError | null = null;
  uploadErrorCount = 0;

  private _initPromise: Promise<void> | null = null;
  private _initialized = false;
  private _disposed = false;
  private _prime: PendingWaiter | null = null;
  private _waitDesired: PendingWaiter | null = null;
  private _visibleFailure: Error | null = null;
  private _desiredFailure: Error | null = null;
  private _glLogCount = 0;

  constructor({
    renderer,
    source,
    config,
    heightTexture,
    normalTexture,
    heightType,
    maxInFlight = 4,
    onProgress,
    onTile,
    onError,
  }: TileCacheOptions) {
    this.renderer = renderer;
    this.source = source;
    this.config = config;
    this.heightTexture = heightTexture;
    this.normalTexture = normalTexture;
    this.heightType = heightType;
    this.maxInFlight = maxInFlight;
    this.onProgress = onProgress;
    this.onTile = onTile;
    this.onError = onError;

    this.levels = Array.from({ length: config.levels }, (_, level): TileLevel => {
      const spacing = spacingForLevel(config, level);
      const tileWorld = tileWorldForLevel(config, level);
      return {
        level,
        spacing,
        tileWorld,
        cacheWorld: config.cacheTiles * tileWorld,
        slots: new Array<string | null>(config.cacheTiles * config.cacheTiles).fill(null),
        desired: new Array<DesiredTile | null>(config.cacheTiles * config.cacheTiles).fill(null),
        lastCamTx: null,
        lastCamTy: null,
      };
    });

    const tileSize = config.tileSize;
    const normalTileSize = tileSize * config.normalScale;
    const scratchHeightData = heightType === THREE.FloatType
      ? new Float32Array(tileSize * tileSize)
      : new Uint16Array(tileSize * tileSize);

    this.heightScratch = new THREE.DataTexture(
      scratchHeightData, tileSize, tileSize, THREE.RedFormat, heightType,
    );
    this.heightScratch.minFilter = THREE.NearestFilter;
    this.heightScratch.magFilter = THREE.NearestFilter;
    this.heightScratch.wrapS = THREE.ClampToEdgeWrapping;
    this.heightScratch.wrapT = THREE.ClampToEdgeWrapping;
    this.heightScratch.generateMipmaps = false;
    this.heightScratch.flipY = false;
    this.heightScratch.unpackAlignment = 1;

    this.normalScratch = new THREE.DataTexture(
      new Uint8Array(normalTileSize * normalTileSize * 4),
      normalTileSize, normalTileSize, THREE.RGBAFormat, THREE.UnsignedByteType,
    );
    this.normalScratch.minFilter = THREE.NearestFilter;
    this.normalScratch.magFilter = THREE.NearestFilter;
    this.normalScratch.wrapS = THREE.ClampToEdgeWrapping;
    this.normalScratch.wrapT = THREE.ClampToEdgeWrapping;
    this.normalScratch.generateMipmaps = false;
    this.normalScratch.flipY = false;
    this.normalScratch.unpackAlignment = 1;
  }

  /** Initializes the source once. Safe to call repeatedly. */
  init(): Promise<void> {
    if (!this._initPromise) {
      this._initPromise = this.source.init().then(() => {
        this._initialized = true;
        this._pump();
        this._checkPrime();
        this._checkWaitDesired();
      });
    }
    return this._initPromise;
  }

  private _key(level: number, tx: number, ty: number): string {
    return `${level}/${tx}/${ty}`;
  }

  private _slot(tx: number, ty: number): number {
    return mod(tx, this.config.cacheTiles) + mod(ty, this.config.cacheTiles) * this.config.cacheTiles;
  }

  private _isDesired(level: number, tx: number, ty: number): boolean {
    const l = this.levels[level];
    const slot = this._slot(tx, ty);
    const d = l.desired[slot];
    return d !== null && d.tx === tx && d.ty === ty;
  }

  private _jobPriority(tx: number, ty: number, camTx: number, camTy: number): number {
    return Math.max(Math.abs(tx - camTx), Math.abs(ty - camTy));
  }

  update(absX: number, absZ: number, { force = false }: { force?: boolean } = {}): void {
    if (this._disposed) return;
    let changed = false;

    for (const l of this.levels) {
      const camTx = Math.floor(absX / l.tileWorld);
      const camTy = Math.floor(absZ / l.tileWorld);

      if (!force && camTx === l.lastCamTx && camTy === l.lastCamTy) continue;
      l.lastCamTx = camTx;
      l.lastCamTy = camTy;
      changed = true;

      l.desired.fill(null);

      // Square window of cacheTiles around the camera tile. For the default
      // 4x4 this is camTile-2 ... camTile+1; the visible ring needs 3x3.
      const half = Math.floor(this.config.cacheTiles / 2);
      for (let dy = -half; dy < -half + this.config.cacheTiles; dy++) {
        for (let dx = -half; dx < -half + this.config.cacheTiles; dx++) {
          const tx = camTx + dx;
          const ty = camTy + dy;
          const slot = this._slot(tx, ty);
          const key = this._key(l.level, tx, ty);
          const priority = this._jobPriority(tx, ty, camTx, camTy);
          l.desired[slot] = { tx, ty, key, priority };

          if (l.slots[slot] === key) continue;
          if (this.failed.has(key)) continue;

          if (!this.requested.has(key)) {
            this.requested.add(key);
            this.queue.push({
              key,
              level: l.level,
              tx,
              ty,
              priority,
            });
          } else {
            // Already queued/in flight; refresh its priority if it is queued.
            for (const job of this.queue) {
              if (job.key === key) { job.priority = priority; break; }
            }
          }
        }
      }
    }

    if (changed) {
      // Drop queued jobs that are no longer in any desired window.
      this.queue = this.queue.filter((job) => {
        if (this._isDesired(job.level, job.tx, job.ty)) return true;
        this.requested.delete(job.key);
        return false;
      });

      this.queue.sort((a, b) => a.priority - b.priority);
      this._pump();
      this._checkPrime();
      this._checkWaitDesired();
    }
  }

  private _pump(): void {
    if (!this._initialized || this._disposed) return;

    while (this.inFlight < this.maxInFlight && this.queue.length > 0) {
      const job = this.queue.shift();
      if (!job) break;
      if (!this._isDesired(job.level, job.tx, job.ty) || this.failed.has(job.key)) {
        this.requested.delete(job.key);
        continue;
      }

      const id = ++this.jobId;
      this.inFlight++;
      this.jobs.set(id, job);
      this.source.getTile(job.level, job.tx, job.ty).then(
        (tile) => this._onTile(id, job, tile),
        (error: unknown) => this._onError(id, job, error),
      );
    }
  }

  private _onTile(id: number, job: TileJob, tile: GeneratedTile): void {
    if (this._disposed) return;
    this.jobs.delete(id);
    this.inFlight = Math.max(0, this.inFlight - 1);
    this.requested.delete(job.key);
    this.generated++;

    if (this._isDesired(job.level, job.tx, job.ty)) {
      this._uploadTile(job.level, job.tx, job.ty, tile.heights, tile.normals);
      this.uploaded++;
      const l = this.levels[job.level];
      l.slots[this._slot(job.tx, job.ty)] = job.key;
      this.onTile?.(job);
    }

    this._pump();
    this._checkPrime();
    this._checkWaitDesired();
    this._notifyProgress();
  }

  private _onError(id: number, job: TileJob, error: unknown): void {
    if (this._disposed) return;
    this.jobs.delete(id);
    this.inFlight = Math.max(0, this.inFlight - 1);
    this.requested.delete(job.key);
    this.failed.add(job.key);

    const err = error instanceof Error ? error : new Error(String(error));
    this.onError?.(err, job);

    if (job.priority <= 1) {
      this._visibleFailure ??= err;
    }
    this._desiredFailure ??= err;

    this._pump();
    this._checkPrime();
    this._checkWaitDesired();
    this._notifyProgress();
  }

  private _rawUpload(
    texture: THREE.Texture,
    x: number,
    y: number,
    layer: number,
    w: number,
    h: number,
    format: number,
    type: number,
    data: ArrayBufferView,
  ): void {
    const gl = this.renderer.getContext() as WebGL2RenderingContext;
    const props = this.renderer.properties.get(texture) as { __webglTexture?: WebGLTexture | null };
    const webglTexture = props.__webglTexture;
    if (!webglTexture) {
      this.renderer.initTexture(texture);
      if (!props.__webglTexture) return;
    }

    gl.bindTexture(gl.TEXTURE_2D_ARRAY, props.__webglTexture ?? null);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
    gl.pixelStorei(gl.UNPACK_ROW_LENGTH, 0);
    gl.pixelStorei(gl.UNPACK_IMAGE_HEIGHT, 0);
    gl.pixelStorei(gl.UNPACK_SKIP_PIXELS, 0);
    gl.pixelStorei(gl.UNPACK_SKIP_ROWS, 0);
    gl.pixelStorei(gl.UNPACK_SKIP_IMAGES, 0);
    gl.texSubImage3D(gl.TEXTURE_2D_ARRAY, 0, x, y, layer, w, h, 1, format, type, data);
    gl.bindTexture(gl.TEXTURE_2D_ARRAY, null);
    this.renderer.resetState();
  }

  private _uploadTile(
    level: number,
    tx: number,
    ty: number,
    heightsBuffer: Float32Array,
    normals: Uint8Array,
  ): void {
    const t = this.config.tileSize;
    const normalTileSize = t * this.config.normalScale;
    const slotX = mod(tx, this.config.cacheTiles);
    const slotY = mod(ty, this.config.cacheTiles);
    const heightDst: TileDst = { x: slotX * t, y: slotY * t, z: level };
    const normalDst: TileDst = {
      x: slotX * normalTileSize,
      y: slotY * normalTileSize,
      z: level,
    };

    if (this.heightType === THREE.FloatType) {
      (this.heightScratch.image.data as Float32Array).set(heightsBuffer);
    } else {
      const half = this.heightScratch.image.data as Uint16Array;
      for (let i = 0; i < heightsBuffer.length; i++) {
        half[i] = THREE.DataUtils.toHalfFloat(heightsBuffer[i]);
      }
    }

    (this.normalScratch.image.data as Uint8Array).set(normals);

    const gl = this.renderer.getContext() as WebGL2RenderingContext;
    gl.getError();
    // Direct texSubImage3D. copyTextureToTexture() works for RGBA8 but has
    // proven unreliable for R16F array layers on the SwiftShader QA renderer.
    this._rawUpload(
      this.heightTexture,
      heightDst.x, heightDst.y, heightDst.z,
      t, t,
      gl.RED,
      this.heightType === THREE.FloatType ? gl.FLOAT : gl.HALF_FLOAT,
      this.heightScratch.image.data as ArrayBufferView,
    );
    const heightErr = gl.getError();

    this._rawUpload(
      this.normalTexture,
      normalDst.x, normalDst.y, normalDst.z,
      normalTileSize, normalTileSize,
      gl.RGBA,
      gl.UNSIGNED_BYTE,
      this.normalScratch.image.data as ArrayBufferView,
    );
    const normalErr = gl.getError();

    if (heightErr || normalErr) {
      this.uploadErrorCount++;
      this.lastUploadError = {
        heightErr,
        normalErr,
        heightType: this.heightType,
        level,
        tx,
        ty,
        heightDst,
        normalDst,
      };
      if (this._glLogCount < 4) {
        this._glLogCount++;
        console.warn('tile upload GL error', JSON.stringify(this.lastUploadError));
      }
    } else {
      this.lastUploadError = null;
    }
  }

  private _allDesiredLoaded(): boolean {
    for (const l of this.levels) {
      for (const d of l.desired) {
        if (d === null) continue;
        if (l.slots[this._slot(d.tx, d.ty)] !== d.key) return false;
      }
    }
    return true;
  }

  /** The 3x3 tiles actually covered by the visible ring (priority <= 1). */
  private _allVisibleLoaded(): boolean {
    for (const l of this.levels) {
      for (const d of l.desired) {
        if (d === null || d.priority > 1) continue;
        if (l.slots[this._slot(d.tx, d.ty)] !== d.key) return false;
      }
    }
    return true;
  }

  private _progress(visibleOnly = false): TileProgress {
    let done = 0;
    let total = 0;
    for (const l of this.levels) {
      for (const d of l.desired) {
        if (d === null || (visibleOnly && d.priority > 1)) continue;
        total++;
        if (l.slots[this._slot(d.tx, d.ty)] === d.key) done++;
      }
    }
    return { done, total };
  }

  private _notifyProgress(): void {
    if (!this.onProgress) return;
    const p = this._progress(true);
    this.onProgress(p.total > 0 ? p.done / p.total : 1, p);
  }

  private _checkPrime(): void {
    if (!this._prime) return;
    this._notifyProgress();
    if (this._allVisibleLoaded()) {
      const pending = this._prime;
      this._prime = null;
      pending.resolve();
    } else if (this._visibleFailure) {
      const pending = this._prime;
      this._prime = null;
      pending.reject(new Error(`visible terrain tile failed: ${this._visibleFailure.message}`));
    }
  }

  private _checkWaitDesired(): void {
    if (!this._waitDesired) return;
    if (this._allDesiredLoaded()) {
      const pending = this._waitDesired;
      this._waitDesired = null;
      pending.resolve();
    } else if (this._desiredFailure) {
      const pending = this._waitDesired;
      this._waitDesired = null;
      pending.reject(new Error(`terrain tile failed: ${this._desiredFailure.message}`));
    }
  }

  /** Resolve when the visible 3x3 tiles are resident; prefetch continues. */
  async prime(absX: number, absZ: number): Promise<void> {
    await this.init();
    this.update(absX, absZ, { force: true });
    if (this._allVisibleLoaded()) return;
    if (this._visibleFailure) {
      throw new Error(`visible terrain tile failed: ${this._visibleFailure.message}`);
    }
    return new Promise<void>((resolve, reject) => {
      this._prime = { resolve, reject };
      this._checkPrime();
      this._pump();
    });
  }

  /** Resolve when the current desired window is fully resident. */
  async waitForDesired(absX: number, absZ: number): Promise<void> {
    await this.init();
    this.update(absX, absZ, { force: true });
    if (this._allDesiredLoaded()) return;
    if (this._desiredFailure) {
      throw new Error(`terrain tile failed: ${this._desiredFailure.message}`);
    }
    return new Promise<void>((resolve, reject) => {
      this._waitDesired = { resolve, reject };
      this._checkWaitDesired();
      this._pump();
    });
  }

  getStats(): TileStats {
    let resident = 0;
    for (const l of this.levels) {
      for (const s of l.slots) if (s !== null) resident++;
    }
    return {
      resident,
      generated: this.generated,
      uploaded: this.uploaded,
      uploadErrors: this.uploadErrorCount,
      queued: this.queue.length,
      inFlight: this.inFlight,
      workers: this.source.workerCount ?? 0,
      source: this.source.kind,
    };
  }

  dispose(): void {
    this._disposed = true;
    this.source.dispose();
    if (this._prime) {
      this._prime.reject(new Error('tile cache disposed'));
      this._prime = null;
    }
    if (this._waitDesired) {
      this._waitDesired.reject(new Error('tile cache disposed'));
      this._waitDesired = null;
    }
  }
}
