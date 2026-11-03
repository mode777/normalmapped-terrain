/**
 * Toroidal clipmap tile streamer.
 *
 * One DataArrayTexture layer per LOD. Each layer is a 4x4 grid of 64x64
 * height tiles / 512x512 normal tiles. A tile at world tile coordinate
 * (tx,ty) always lives in slot (tx mod 4, ty mod 4); the shader uses the
 * same mapping, so no texture data ever has to be shifted when the camera
 * moves.
 *
 * Tiles are generated in workers and uploaded with texSubImage3D. The visible
 * ring only needs 3x3; the 4th row/column is prefetch margin for fast flight.
 */

import * as THREE from 'three';

const mod = (n, m) => ((n % m) + m) % m;

export class TileStreamer {
  constructor({
    renderer,
    seed,
    baseSpacing,
    tileSize,
    cacheTiles,
    levels,
    heightScale,
    heightTexture,
    normalTexture,
    heightType,
    normalScale = 1,
    onProgress,
    onTile,
  }) {
    this.renderer = renderer;
    this.seed = seed;
    this.baseSpacing = baseSpacing;
    this.tileSize = tileSize;
    this.normalScale = normalScale;
    this.normalTileSize = tileSize * normalScale;
    this.cacheTiles = cacheTiles;
    this.heightScale = heightScale;
    this.heightTexture = heightTexture;
    this.normalTexture = normalTexture;
    this.heightType = heightType;
    this.onProgress = onProgress;
    this.onTile = onTile;

    this.levels = Array.from({ length: levels }, (_, level) => {
      const spacing = baseSpacing * Math.pow(2, level);
      const tileWorld = tileSize * spacing;
      return {
        level,
        spacing,
        tileWorld,
        cacheWorld: cacheTiles * tileWorld,
        slots: new Array(cacheTiles * cacheTiles).fill(null),
        desired: new Array(cacheTiles * cacheTiles).fill(null),
        lastCamTx: null,
        lastCamTy: null,
      };
    });

    this.queue = [];
    this.jobs = new Map();
    this.requested = new Set();
    this.jobId = 0;
    this.workers = [];
    this.readyWorkers = 0;
    this.workerCount = Math.max(1, Math.min(2, (navigator.hardwareConcurrency || 4) - 1));
    this.generated = 0;
    this.uploaded = 0;
    this._prime = null;
    this._waitDesired = null;
    this._glLogCount = 0;
    this.lastUploadError = null;
    this.uploadErrorCount = 0;

    // Scratch textures used as the source of sub-texture uploads.
    const scratchHeightData = heightType === THREE.FloatType
      ? new Float32Array(tileSize * tileSize)
      : new Uint16Array(tileSize * tileSize);

    this.heightScratch = new THREE.DataTexture(
      scratchHeightData, tileSize, tileSize, THREE.RedFormat, heightType
    );
    this.heightScratch.minFilter = THREE.NearestFilter;
    this.heightScratch.magFilter = THREE.NearestFilter;
    this.heightScratch.wrapS = THREE.ClampToEdgeWrapping;
    this.heightScratch.wrapT = THREE.ClampToEdgeWrapping;
    this.heightScratch.generateMipmaps = false;
    this.heightScratch.flipY = false;
    this.heightScratch.unpackAlignment = 1;

    this.normalScratch = new THREE.DataTexture(
      new Uint8Array(this.normalTileSize * this.normalTileSize * 4),
      this.normalTileSize, this.normalTileSize, THREE.RGBAFormat, THREE.UnsignedByteType
    );
    this.normalScratch.minFilter = THREE.NearestFilter;
    this.normalScratch.magFilter = THREE.NearestFilter;
    this.normalScratch.wrapS = THREE.ClampToEdgeWrapping;
    this.normalScratch.wrapT = THREE.ClampToEdgeWrapping;
    this.normalScratch.generateMipmaps = false;
    this.normalScratch.flipY = false;
    this.normalScratch.unpackAlignment = 1;

    for (let i = 0; i < this.workerCount; i++) {
      const worker = new Worker(new URL('./terrain-worker.js', import.meta.url), { type: 'module' });
      const slot = { worker, ready: false, inFlight: 0 };
      worker.onmessage = (event) => this._onWorkerMessage(event.data, slot);
      worker.onerror = (event) => {
        console.error('Terrain worker error:', event.message || event);
      };
      worker.postMessage({ type: 'init', seed });
      this.workers.push(slot);
    }
  }

  _key(level, tx, ty) {
    return `${level}/${tx}/${ty}`;
  }

  _slot(tx, ty) {
    return mod(tx, this.cacheTiles) + mod(ty, this.cacheTiles) * this.cacheTiles;
  }

  _isDesired(level, tx, ty) {
    const l = this.levels[level];
    const slot = this._slot(tx, ty);
    const d = l.desired[slot];
    return d !== null && d.tx === tx && d.ty === ty;
  }

  _jobPriority(tx, ty, camTx, camTy) {
    return Math.max(Math.abs(tx - camTx), Math.abs(ty - camTy));
  }

  update(absX, absZ, { force = false } = {}) {
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
      const half = Math.floor(this.cacheTiles / 2);
      for (let dy = -half; dy < -half + this.cacheTiles; dy++) {
        for (let dx = -half; dx < -half + this.cacheTiles; dx++) {
          const tx = camTx + dx;
          const ty = camTy + dy;
          const slot = this._slot(tx, ty);
          const key = this._key(l.level, tx, ty);
          const priority = this._jobPriority(tx, ty, camTx, camTy);
          l.desired[slot] = { tx, ty, key, priority };

          if (l.slots[slot] === key) continue;

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

  _pump() {
    if (this.readyWorkers === 0) return;

    while (this.queue.length > 0) {
      const slot = this.workers.find((w) => w.ready && w.inFlight === 0);
      if (!slot) break;

      const job = this.queue.shift();
      if (!this._isDesired(job.level, job.tx, job.ty)) {
        this.requested.delete(job.key);
        continue;
      }

      const id = ++this.jobId;
      slot.inFlight++;
      this.jobs.set(id, job);
      slot.worker.postMessage({
        type: 'tile',
        id,
        level: job.level,
        tx: job.tx,
        ty: job.ty,
        tileSize: this.tileSize,
        baseSpacing: this.baseSpacing,
        heightScale: this.heightScale,
        normalScale: this.normalScale,
      });
    }
  }

  _onWorkerMessage(msg, slot) {
    if (msg.type === 'ready') {
      if (!slot.ready) {
        slot.ready = true;
        this.readyWorkers++;
      }
      this._pump();
      this._checkPrime();
      this._checkWaitDesired();
      return;
    }

    if (msg.type === 'error') {
      console.error('Terrain tile generation failed:', msg.message);
      const job = this.jobs.get(msg.id);
      if (job) {
        this.jobs.delete(msg.id);
        slot.inFlight = Math.max(0, slot.inFlight - 1);
        this.requested.delete(job.key);
      }
      this._pump();
      return;
    }

    if (msg.type !== 'tile') return;

    const job = this.jobs.get(msg.id);
    if (!job) return;

    this.jobs.delete(msg.id);
    slot.inFlight = Math.max(0, slot.inFlight - 1);
    this.requested.delete(job.key);
    this.generated++;

    if (this._isDesired(job.level, job.tx, job.ty)) {
      this._uploadTile(job.level, job.tx, job.ty, msg.heights, msg.normals);
      this.uploaded++;
      const l = this.levels[job.level];
      l.slots[this._slot(job.tx, job.ty)] = job.key;
      this.onTile?.(job);
    }

    this._pump();
    this._checkPrime();
    this._checkWaitDesired();
  }

  _rawUpload(texture, x, y, layer, w, h, format, type, data) {
    const gl = this.renderer.getContext();
    const props = this.renderer.properties.get(texture);
    const webglTexture = props.__webglTexture;
    if (!webglTexture) {
      this.renderer.initTexture(texture);
      if (!props.__webglTexture) return;
    }

    gl.bindTexture(gl.TEXTURE_2D_ARRAY, props.__webglTexture);
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

  _uploadTile(level, tx, ty, heightsBuffer, normalsBuffer) {
    const t = this.tileSize;
    const heights = new Float32Array(heightsBuffer);
    const normals = new Uint8Array(normalsBuffer);
    const slotX = mod(tx, this.cacheTiles);
    const slotY = mod(ty, this.cacheTiles);
    const heightDst = { x: slotX * t, y: slotY * t, z: level };
    const normalDst = {
      x: slotX * this.normalTileSize,
      y: slotY * this.normalTileSize,
      z: level,
    };

    if (this.heightType === THREE.FloatType) {
      this.heightScratch.image.data.set(heights);
    } else {
      const half = this.heightScratch.image.data;
      for (let i = 0; i < heights.length; i++) {
        half[i] = THREE.DataUtils.toHalfFloat(heights[i]);
      }
    }

    this.normalScratch.image.data.set(normals);

    const gl = this.renderer.getContext();
    gl.getError();
    // Direct texSubImage3D. copyTextureToTexture() works for RGBA8 but has
    // proven unreliable for R16F array layers on the SwiftShader QA
    // renderer (format/type/internalFormat mismatch), so use the explicit
    // path for both maps.
    this._rawUpload(
      this.heightTexture,
      heightDst.x, heightDst.y, heightDst.z,
      t, t,
      gl.RED,
      this.heightType === THREE.FloatType ? gl.FLOAT : gl.HALF_FLOAT,
      this.heightScratch.image.data
    );
    const heightErr = gl.getError();

    this._rawUpload(
      this.normalTexture,
      normalDst.x, normalDst.y, normalDst.z,
      this.normalTileSize, this.normalTileSize,
      gl.RGBA,
      gl.UNSIGNED_BYTE,
      this.normalScratch.image.data
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

  _allDesiredLoaded() {
    for (const l of this.levels) {
      for (const d of l.desired) {
        if (d === null) continue;
        if (l.slots[this._slot(d.tx, d.ty)] !== d.key) return false;
      }
    }
    return true;
  }

  /** The 3x3 tiles actually covered by the visible ring (priority <= 1). */
  _allVisibleLoaded() {
    for (const l of this.levels) {
      for (const d of l.desired) {
        if (d === null || d.priority > 1) continue;
        if (l.slots[this._slot(d.tx, d.ty)] !== d.key) return false;
      }
    }
    return true;
  }

  _progress(visibleOnly = false) {
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

  _notifyProgress() {
    if (!this.onProgress) return;
    const p = this._progress(true);
    this.onProgress(p.total > 0 ? p.done / p.total : 1, p);
  }

  _checkPrime() {
    if (!this._prime) return;
    this._notifyProgress();
    if (this._allVisibleLoaded()) {
      const resolve = this._prime;
      this._prime = null;
      resolve();
    }
  }

  _checkWaitDesired() {
    if (!this._waitDesired) return;
    if (this._allDesiredLoaded()) {
      const resolve = this._waitDesired;
      this._waitDesired = null;
      resolve();
    }
  }

  /** Resolve when the visible 3x3 tiles are resident; prefetch continues. */
  prime(absX, absZ) {
    this.update(absX, absZ, { force: true });
    if (this._allVisibleLoaded()) return Promise.resolve();
    return new Promise((resolve) => {
      this._prime = resolve;
      this._checkPrime();
    });
  }

  /** Resolve when the current desired window is fully resident. */
  waitForDesired(absX, absZ) {
    this.update(absX, absZ, { force: true });
    if (this._allDesiredLoaded()) return Promise.resolve();
    return new Promise((resolve) => {
      this._waitDesired = resolve;
      this._checkWaitDesired();
    });
  }

  getStats() {
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
      inFlight: this.workers.reduce((sum, w) => sum + w.inFlight, 0),
      workers: this.workerCount,
    };
  }

  dispose() {
    for (const slot of this.workers) slot.worker.terminate();
  }
}
