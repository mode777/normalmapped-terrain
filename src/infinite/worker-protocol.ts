/**
 * Typed message protocol between the main thread and terrain tiles workers.
 *
 * Transferables are listed explicitly on the responses so the worker can
 * hand off tile buffers without cloning.
 */

export interface InitRequest {
  type: 'init';
  seed: number;
}

export interface TileRequest {
  type: 'tile';
  id: number;
  level: number;
  tx: number;
  ty: number;
  tileSize: number;
  baseSpacing: number;
  heightScale: number;
  normalScale: number;
}

export type TerrainWorkerRequest = InitRequest | TileRequest;

export interface ReadyResponse {
  type: 'ready';
  seed: number;
}

export interface TileResponse {
  type: 'tile';
  id: number;
  level: number;
  tx: number;
  ty: number;
  heights: ArrayBuffer;
  normals: ArrayBuffer;
}

export interface ErrorResponse {
  type: 'error';
  id?: number;
  message: string;
}

export type TerrainWorkerResponse = ReadyResponse | TileResponse | ErrorResponse;
