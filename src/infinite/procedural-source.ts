/**
 * Procedural TileSource: a worker pool around generateTile.
 *
 * The source decides how tiles are produced; the shared TileCache decides
 * which tiles are resident and when to upload them.
 */

import { makeHeightField } from './heightfield.ts';
import type { HeightField } from './heightfield.ts';
import type { TerrainConfig, GeneratedTile, TileSource } from '../terrain/tile-source.ts';
import type {
  TerrainWorkerRequest,
  TerrainWorkerResponse,
} from './worker-protocol.ts';

interface PendingJob {
  id: number;
  level: number;
  tx: number;
  ty: number;
  resolve: (tile: GeneratedTile) => void;
  reject: (error: Error) => void;
}

interface WorkerSlot {
  worker: Worker;
  ready: boolean;
  inFlight: number;
  currentId: number | null;
}

export interface ProceduralTileSourceOptions {
  seed: number;
  config: TerrainConfig;
  workerCount?: number;
}

export class ProceduralTileSource implements TileSource {
  readonly kind = 'procedural' as const;
  readonly workerCount: number;

  private readonly seed: number;
  private readonly config: TerrainConfig;
  private readonly field: HeightField;
  private readonly slots: WorkerSlot[] = [];
  private readonly queue: PendingJob[] = [];
  private readonly jobs = new Map<number, PendingJob>();
  private jobId = 0;
  private readyCount = 0;
  private initPromise: Promise<void> | null = null;
  private initResolve: (() => void) | null = null;
  private initReject: ((error: Error) => void) | null = null;
  private disposed = false;

  constructor({ seed, config, workerCount }: ProceduralTileSourceOptions) {
    this.seed = seed;
    this.config = config;
    this.field = makeHeightField(seed);
    this.workerCount = workerCount
      ?? Math.max(1, Math.min(2, (navigator.hardwareConcurrency || 4) - 1));
  }

  heightAt(x: number, z: number): number {
    return this.field.heightAt(x, z);
  }

  init(): Promise<void> {
    if (this.initPromise) return this.initPromise;

    this.initPromise = new Promise<void>((resolve, reject) => {
      this.initResolve = resolve;
      this.initReject = reject;

      for (let i = 0; i < this.workerCount; i++) {
        const worker = new Worker(new URL('./terrain-worker.ts', import.meta.url), {
          type: 'module',
        });
        const slot: WorkerSlot = { worker, ready: false, inFlight: 0, currentId: null };
        worker.onmessage = (event: MessageEvent<TerrainWorkerResponse>) => {
          this._onMessage(slot, event.data);
        };
        worker.onerror = (event: ErrorEvent) => {
          this._onWorkerError(slot, event);
        };
        const init: TerrainWorkerRequest = {
          type: 'init',
          seed: this.seed,
          config: {
            baseSpacing: this.config.baseSpacing,
            tileSize: this.config.tileSize,
            heightScale: this.config.heightScale,
            normalScale: this.config.normalScale,
          },
        };
        worker.postMessage(init);
        this.slots.push(slot);
      }
    });

    return this.initPromise;
  }

  getTile(level: number, tx: number, ty: number): Promise<GeneratedTile> {
    return this.init().then(() => new Promise<GeneratedTile>((resolve, reject) => {
      const id = ++this.jobId;
      const job: PendingJob = { id, level, tx, ty, resolve, reject };
      this.jobs.set(id, job);
      this.queue.push(job);
      this._pump();
    }));
  }

  private _pump(): void {
    if (this.disposed) return;
    while (this.queue.length > 0) {
      const slot = this.slots.find((s) => s.ready && s.inFlight === 0);
      if (!slot) break;
      const job = this.queue.shift();
      if (!job) break;
      slot.inFlight++;
      slot.currentId = job.id;
      const request: TerrainWorkerRequest = {
        type: 'tile',
        id: job.id,
        level: job.level,
        tx: job.tx,
        ty: job.ty,
      };
      slot.worker.postMessage(request);
    }
  }

  private _onMessage(slot: WorkerSlot, msg: TerrainWorkerResponse): void {
    if (msg.type === 'ready') {
      if (!slot.ready) {
        slot.ready = true;
        this.readyCount++;
      }
      if (this.readyCount === this.slots.length && this.initResolve) {
        const resolve = this.initResolve;
        this.initResolve = null;
        this.initReject = null;
        resolve();
      }
      this._pump();
      return;
    }

    if (msg.type === 'tile') {
      const job = this.jobs.get(msg.id);
      if (!job) return;
      this.jobs.delete(msg.id);
      slot.inFlight = Math.max(0, slot.inFlight - 1);
      slot.currentId = null;
      job.resolve({
        heights: new Float32Array(msg.heights),
        normals: new Uint8Array(msg.normals),
      });
      this._pump();
      return;
    }

    if (msg.type === 'error') {
      if (msg.id !== undefined) {
        const job = this.jobs.get(msg.id);
        if (job) {
          this.jobs.delete(msg.id);
          slot.inFlight = Math.max(0, slot.inFlight - 1);
          slot.currentId = null;
          job.reject(new Error(msg.message));
        }
        this._pump();
        return;
      }

      console.error('Terrain worker error:', msg.message);
      if (this.initReject) {
        const reject = this.initReject;
        this.initResolve = null;
        this.initReject = null;
        reject(new Error(msg.message));
      }
    }
  }

  private _onWorkerError(slot: WorkerSlot, event: ErrorEvent): void {
    const error = new Error(event.message || 'terrain worker failed');
    console.error('Terrain worker error:', error);
    slot.ready = false;
    if (slot.currentId !== null) {
      const job = this.jobs.get(slot.currentId);
      if (job) {
        this.jobs.delete(job.id);
        job.reject(error);
      }
      slot.currentId = null;
      slot.inFlight = 0;
    }
    if (this.initReject) {
      const reject = this.initReject;
      this.initResolve = null;
      this.initReject = null;
      reject(error);
    }
  }

  dispose(): void {
    this.disposed = true;
    for (const slot of this.slots) slot.worker.terminate();
    this.slots.length = 0;
    const error = new Error('procedural tile source disposed');
    for (const job of this.jobs.values()) job.reject(error);
    for (const job of this.queue) job.reject(error);
    this.jobs.clear();
    this.queue.length = 0;
  }
}
