/**
 * Terrain tile worker.
 *
 * Owns the procedural height function and bakes float-Sobel normal tiles off
 * the main thread. Tile results are transferred as ArrayBuffers.
 */

import { makeHeightField, generateTile } from './heightfield.ts';
import type { HeightField } from './heightfield.ts';
import type {
  TerrainWorkerRequest,
  TerrainWorkerResponse,
  WorkerTileConfig,
} from './worker-protocol.ts';

// The app tsconfig includes the DOM lib, so `self` is typed as a Window.
// Narrow it to the small surface this module actually uses.
interface WorkerScope {
  onmessage: ((event: MessageEvent<TerrainWorkerRequest>) => void) | null;
  postMessage(message: TerrainWorkerResponse, transfer?: Transferable[]): void;
}

const scope = self as unknown as WorkerScope;
let heightField: HeightField | null = null;
let config: WorkerTileConfig | null = null;

scope.onmessage = (event) => {
  const msg = event.data;

  if (msg.type === 'init') {
    heightField = makeHeightField(msg.seed);
    config = msg.config;
    scope.postMessage({ type: 'ready', seed: msg.seed });
    return;
  }

  if (msg.type === 'tile') {
    if (!heightField || !config) {
      scope.postMessage({ type: 'error', id: msg.id, message: 'worker not initialized' });
      return;
    }

    try {
      const { heights, normals } = generateTile(heightField, {
        level: msg.level,
        tx: msg.tx,
        ty: msg.ty,
        ...config,
      });

      const heightsBuffer = heights.buffer as ArrayBuffer;
      const normalsBuffer = normals.buffer as ArrayBuffer;

      scope.postMessage({
        type: 'tile',
        id: msg.id,
        level: msg.level,
        tx: msg.tx,
        ty: msg.ty,
        heights: heightsBuffer,
        normals: normalsBuffer,
      }, [heightsBuffer, normalsBuffer]);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      scope.postMessage({ type: 'error', id: msg.id, message });
    }
  }
};
