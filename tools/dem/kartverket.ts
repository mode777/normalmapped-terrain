/**
 * DEM source adapters.
 *
 * The primary adapter downloads the Kartverket national DTM through its WCS in
 * small chunks, because a single 3000-square request times out. A local
 * GeoTIFF adapter exists for reproducible tests and offline re-bakes.
 */

import { fromArrayBuffer, fromFile } from 'geotiff';
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { DemConfig, DemGrid, SourceGridResult } from './types.ts';

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

function bboxFor(config: DemConfig): SourceGridResult['bbox'] {
  const half = config.sizeMeters / 2;
  return {
    west: config.centerE - half,
    south: config.centerN - half,
    east: config.centerE + half,
    north: config.centerN + half,
  };
}

function gridDimensions(config: DemConfig): { cols: number; rows: number } {
  const cols = Math.round(config.sizeMeters / config.spacing);
  const rows = Math.round(config.sizeMeters / config.spacing);
  if (Math.abs(cols * config.spacing - config.sizeMeters) > 1e-6) {
    throw new Error('sizeMeters must be an integer multiple of spacing');
  }
  return { cols, rows };
}

async function fetchWithRetry(url: string): Promise<{ buffer: ArrayBuffer; lastModified?: string }> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(180_000) });
      if (!response.ok) {
        throw new Error(`WCS request failed: HTTP ${response.status}`);
      }
      const buffer = await response.arrayBuffer();
      if (buffer.byteLength === 0) throw new Error('WCS request returned an empty body');
      const lastModified = response.headers.get('last-modified') ?? undefined;
      return lastModified === undefined ? { buffer } : { buffer, lastModified };
    } catch (error) {
      lastError = error;
      if (attempt < 3) await sleep(1000 * attempt);
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

async function loadKartverketWcs(config: DemConfig): Promise<SourceGridResult> {
  if (config.source.type !== 'kartverket-wcs') {
    throw new Error('loadKartverketWcs requires a kartverket-wcs source');
  }
  const source = config.source;
  const { cols, rows } = gridDimensions(config);
  const bbox = bboxFor(config);
  const chunkPixels = source.chunkPixels ?? 1536;
  const data = new Float32Array(cols * rows);
  let lastModified: string | undefined;
  const cacheDir = config.cacheDir ?? join('.cache', 'dem', config.dataset);
  mkdirSync(cacheDir, { recursive: true });

  for (let y0 = 0; y0 < rows; y0 += chunkPixels) {
    const y1 = Math.min(rows, y0 + chunkPixels);
    for (let x0 = 0; x0 < cols; x0 += chunkPixels) {
      const x1 = Math.min(cols, x0 + chunkPixels);
      const width = x1 - x0;
      const height = y1 - y0;
      const cachePath = join(cacheDir, `${x0}_${y0}_${width}x${height}.tif`);
      const west = bbox.west + x0 * config.spacing;
      const east = bbox.west + x1 * config.spacing;
      const north = bbox.north - y0 * config.spacing;
      const south = bbox.north - y1 * config.spacing;

      const url = new URL(source.url);
      url.searchParams.set('service', 'WCS');
      url.searchParams.set('version', '1.0.0');
      url.searchParams.set('request', 'GetCoverage');
      url.searchParams.set('coverage', source.coverage);
      url.searchParams.set('crs', source.crs);
      url.searchParams.set('bbox', `${west},${south},${east},${north}`);
      url.searchParams.set('width', String(width));
      url.searchParams.set('height', String(height));
      url.searchParams.set('format', 'GeoTIFF');

      let buffer: ArrayBuffer;
      let modified: string | undefined;
      if (existsSync(cachePath)) {
        const cached = readFileSync(cachePath);
        buffer = cached.buffer.slice(
          cached.byteOffset,
          cached.byteOffset + cached.byteLength,
        ) as ArrayBuffer;
        modified = statSync(cachePath).mtime.toISOString();
      } else {
        const fetched = await fetchWithRetry(url.toString());
        buffer = fetched.buffer;
        modified = fetched.lastModified;
        writeFileSync(cachePath, Buffer.from(buffer));
      }
      lastModified ??= modified;

      const tiff = await fromArrayBuffer(buffer);
      const image = await tiff.getImage();
      const rasters = await image.readRasters({ interleave: false });
      const band = rasters[0] as Float32Array;
      if (band.length !== width * height) {
        throw new Error(`WCS chunk returned ${band.length} samples, expected ${width * height}`);
      }

      for (let j = 0; j < height; j++) {
        const row = (y0 + j) * cols + x0;
        data.set(band.subarray(j * width, (j + 1) * width), row);
      }
      process.stderr.write(`  source chunk ${x0},${y0} ${width}x${height}\n`);
    }
  }

  const grid: DemGrid = { data, cols, rows, spacing: config.spacing };
  const result: SourceGridResult = {
    grid,
    elevations: data,
    bbox,
    sourceType: source.type,
  };
  if (lastModified !== undefined) result.lastModified = lastModified;
  return result;
}

async function loadLocalGeoTiff(config: DemConfig): Promise<SourceGridResult> {
  if (config.source.type !== 'local-geotiff') {
    throw new Error('loadLocalGeoTiff requires a local-geotiff source');
  }
  const { cols, rows } = gridDimensions(config);
  const bbox = bboxFor(config);
  const tiff = await fromFile(config.source.path);
  const image = await tiff.getImage();
  const [originX, originY] = image.getOrigin();
  const [resX, resY] = image.getResolution();
  const rasters = await image.readRasters({ interleave: false });
  const band = rasters[0] as Float32Array;
  const width = image.getWidth();
  const height = image.getHeight();
  const data = new Float32Array(cols * rows);

  for (let j = 0; j < rows; j++) {
    const northing = bbox.north - j * config.spacing;
    const py = Math.round((northing - originY) / resY);
    for (let i = 0; i < cols; i++) {
      const easting = bbox.west + i * config.spacing;
      const px = Math.round((easting - originX) / resX);
      if (px < 0 || px >= width || py < 0 || py >= height) {
        throw new Error(`local GeoTIFF does not cover sample ${easting}, ${northing}`);
      }
      data[j * cols + i] = band[py * width + px];
    }
  }

  const lastModified = statSync(config.source.path).mtime.toISOString();
  return {
    grid: { data, cols, rows, spacing: config.spacing },
    elevations: data,
    bbox,
    lastModified,
    sourceType: config.source.type,
  };
}

export async function loadSourceGrid(config: DemConfig): Promise<SourceGridResult> {
  if (config.source.type === 'kartverket-wcs') return loadKartverketWcs(config);
  return loadLocalGeoTiff(config);
}
