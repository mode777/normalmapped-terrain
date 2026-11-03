/**
 * Terrain tile worker.
 *
 * Owns the procedural height function and bakes float-Sobel normal tiles
 * off the main thread. Tile results are transferred as ArrayBuffers.
 */

import { makeHeightField, generateTile } from './heightfield.js';

let heightField = null;

self.onmessage = (event) => {
  const msg = event.data;

  if (msg.type === 'init') {
    heightField = makeHeightField(msg.seed);
    self.postMessage({ type: 'ready', seed: msg.seed });
    return;
  }

  if (msg.type === 'tile') {
    if (!heightField) {
      self.postMessage({ type: 'error', id: msg.id, message: 'worker not initialized' });
      return;
    }

    try {
      const { heights, normals } = generateTile(heightField, {
        level: msg.level,
        tx: msg.tx,
        ty: msg.ty,
        tileSize: msg.tileSize,
        baseSpacing: msg.baseSpacing,
        heightScale: msg.heightScale,
        normalScale: msg.normalScale,
      });

      self.postMessage({
        type: 'tile',
        id: msg.id,
        level: msg.level,
        tx: msg.tx,
        ty: msg.ty,
        heights: heights.buffer,
        normals: normals.buffer,
      }, [heights.buffer, normals.buffer]);
    } catch (err) {
      self.postMessage({ type: 'error', id: msg.id, message: String(err && err.message || err) });
    }
  }
};
