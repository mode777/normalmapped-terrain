#!/usr/bin/env node
/**
 * Fetch and pack the Poly Haven material library.
 *
 * The checked-in output is two 512^2 RGBA8 PNGs per material:
 *   albedo-height.png  RGB sRGB albedo + A normalized height
 *   slope-rough.png    RG tangent-space slope (object-space, V=+z) +
 *                      B roughness + A ambient occlusion
 *
 * Source files are downloaded into .cache/materials (gitignored) and are never
 * checked in. The packed output is deterministic for a given source set.
 *
 * Usage:
 *   node tools/fetch-materials.ts                    # pack all 20
 *   node tools/fetch-materials.ts --check-manifest   # API/metadata check only
 *   node tools/fetch-materials.ts --only rock_face_03
 *   node tools/fetch-materials.ts --force             # ignore the download cache
 */

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SOURCE_PATH = join(ROOT, 'tools/materials/polyhaven.json');
const PUBLIC_DIR = join(ROOT, 'public/materials');
const CACHE_DIR = join(ROOT, '.cache/materials');
const USER_AGENT = 'normalmapped-terrain/0.1 (+https://github.com/mode777/normalmapped-terrain)';
const API = 'https://api.polyhaven.com';

type Projection = 'planar' | 'triplanar';

interface SourceMaps {
  albedo?: string;
  normal?: string;
  height?: string;
  roughness?: string;
  ao?: string;
}

interface SourceMaterial {
  id: string;
  name: string;
  biome: string;
  role: string;
  tileMeters: number;
  textureScale?: number;
  projection: Projection;
  normalStrength: number;
  roughness: number;
  specular: number;
  maps: SourceMaps;
}

interface SourceManifest {
  version: number;
  source: string;
  license: string;
  attribution: string;
  sourceResolution: string;
  packSize: number;
  normalSource: string;
  materials: SourceMaterial[];
}

interface PolyAsset {
  name?: string;
  dimensions?: [number, number];
  max_resolution?: [number, number];
}

interface PolyFile {
  url: string;
  size: number;
  md5?: string;
}

type PolyFiles = Record<string, Record<string, Record<string, PolyFile>>>;

interface SourceFile {
  map: string;
  format: string;
  url: string;
  size: number;
  md5: string | null;
}

interface ResolvedSource {
  albedo: SourceFile;
  normal: SourceFile;
  normalFlipG: boolean;
  height: SourceFile | null;
  roughness: SourceFile | null;
  roughnessChannel: 'gray' | 'g';
  ao: SourceFile | null;
  aoChannel: 'gray' | 'r';
}

interface RawImage {
  data: Buffer;
  info: { width: number; height: number; channels: number };
}

type SharpInstance = ReturnType<typeof sharp>;

const clamp01 = (v: number): number => (v < 0 ? 0 : v > 1 ? 1 : v);
const md5 = (buffer: Buffer): string => createHash('md5').update(buffer).digest('hex');
const sha256 = (buffer: Buffer): string => createHash('sha256').update(buffer).digest('hex');

async function fetchJson<T>(url: string): Promise<T> {
  let lastError: unknown;
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      const response = await fetch(url, {
        headers: { 'User-Agent': USER_AGENT, Accept: 'application/json' },
      });
      if (!response.ok) throw new Error(`HTTP ${response.status} for ${url}`);
      return await response.json() as T;
    } catch (error) {
      lastError = error;
      await new Promise((r) => setTimeout(r, 400 * (attempt + 1)));
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

async function fetchBuffer(url: string): Promise<Buffer> {
  let lastError: unknown;
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      const response = await fetch(url, { headers: { 'User-Agent': USER_AGENT } });
      if (!response.ok) throw new Error(`HTTP ${response.status} for ${url}`);
      return Buffer.from(await response.arrayBuffer());
    } catch (error) {
      lastError = error;
      await new Promise((r) => setTimeout(r, 600 * (attempt + 1)));
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

function pickFile(files: PolyFiles, map: string, resolution: string): SourceFile | null {
  const versions = files[map]?.[resolution];
  if (!versions) return null;
  for (const format of ['jpg', 'png']) {
    const file = versions[format];
    if (file) {
      return {
        map,
        format,
        url: file.url,
        size: file.size,
        md5: file.md5 ?? null,
      };
    }
  }
  return null;
}

function resolveSource(files: PolyFiles, entry: SourceMaterial, resolution: string): ResolvedSource {
  const albedo = pickFile(files, entry.maps.albedo ?? 'Diffuse', resolution);
  if (!albedo) throw new Error(`${entry.id}: missing diffuse map`);

  let normal = pickFile(files, entry.maps.normal ?? 'nor_dx', resolution);
  let normalFlipG = false;
  if (!normal) {
    normal = pickFile(files, 'nor_gl', resolution);
    normalFlipG = true;
  }
  if (!normal) throw new Error(`${entry.id}: missing normal map`);

  const height = pickFile(files, entry.maps.height ?? 'Displacement', resolution)
    ?? pickFile(files, 'Bump', resolution);

  let roughness = pickFile(files, entry.maps.roughness ?? 'Rough', resolution);
  let roughnessChannel: 'gray' | 'g' = 'gray';
  if (!roughness) {
    roughness = pickFile(files, 'arm', resolution);
    roughnessChannel = 'g';
  }

  let ao = pickFile(files, entry.maps.ao ?? 'AO', resolution);
  let aoChannel: 'gray' | 'r' = 'gray';
  if (!ao) {
    ao = pickFile(files, 'arm', resolution);
    aoChannel = 'r';
  }

  return {
    albedo,
    normal,
    normalFlipG,
    height,
    roughness,
    roughnessChannel,
    ao,
    aoChannel,
  };
}

async function loadSourceFile(file: SourceFile, force: boolean): Promise<Buffer> {
  const cachePath = join(CACHE_DIR, file.map.replace(/[^a-z0-9_-]/gi, '_'), `${md5(Buffer.from(file.url))}.${file.format}`);
  if (!force && existsSync(cachePath) && statSync(cachePath).size === file.size) {
    const cached = readFileSync(cachePath);
    if (!file.md5 || md5(cached) === file.md5) return cached;
  }
  const buffer = await fetchBuffer(file.url);
  if (buffer.length !== file.size) {
    throw new Error(`${file.map}: size ${buffer.length}, expected ${file.size}`);
  }
  if (file.md5 && md5(buffer) !== file.md5) {
    throw new Error(`${file.map}: md5 mismatch`);
  }
  mkdirSync(dirname(cachePath), { recursive: true });
  writeFileSync(cachePath, buffer);
  return buffer;
}

async function raw(image: SharpInstance): Promise<RawImage> {
  const result = await image.raw().toBuffer({ resolveWithObject: true });
  return {
    data: result.data,
    info: {
      width: result.info.width,
      height: result.info.height,
      channels: result.info.channels,
    },
  };
}

function sample(image: RawImage, index: number, channel = 0): number {
  const { data, info } = image;
  const offset = index * info.channels + channel;
  return data[offset] / 255;
}

async function resizeRaw(buffer: Buffer, size: number, grayscale: boolean): Promise<RawImage> {
  let image = sharp(buffer).resize(size, size, { fit: 'fill' });
  if (grayscale) image = image.toColourspace('b-w');
  else image = image.removeAlpha();
  return raw(image);
}

interface PackedMaterial {
  entry: SourceMaterial;
  slopeScale: number;
  averageColor: [number, number, number];
  albedoPng: Buffer;
  slopePng: Buffer;
  albedoHash: string;
  slopeHash: string;
  sourceHashes: Record<string, string>;
  resolved: ResolvedSource;
}

async function packMaterial(
  entry: SourceMaterial,
  files: PolyFiles,
  size: number,
  resolution: string,
  force: boolean,
): Promise<PackedMaterial> {
  const resolved = resolveSource(files, entry, resolution);

  const unique = new Map<string, SourceFile>();
  for (const file of [resolved.albedo, resolved.normal, resolved.height, resolved.roughness, resolved.ao]) {
    if (file) unique.set(file.url, file);
  }
  const buffers = new Map<string, Buffer>();
  await Promise.all(Array.from(unique.values()).map(async (file) => {
    buffers.set(file.url, await loadSourceFile(file, force));
  }));
  const source = (file: SourceFile): Buffer => {
    const buffer = buffers.get(file.url);
    if (!buffer) throw new Error(`${entry.id}: ${file.map} was not downloaded`);
    return buffer;
  };

  const albedo = await resizeRaw(source(resolved.albedo), size, false);
  const normal = await resizeRaw(source(resolved.normal), size, false);
  const height = resolved.height
    ? await resizeRaw(source(resolved.height), size, true)
    : null;
  const roughness = resolved.roughness
    ? await resizeRaw(source(resolved.roughness), size, resolved.roughnessChannel === 'gray')
    : null;
  const ao = resolved.ao
    ? await resizeRaw(source(resolved.ao), size, resolved.aoChannel === 'gray')
    : null;

  const pixels = size * size;
  const slopeX = new Float32Array(pixels);
  const slopeY = new Float32Array(pixels);
  const slopeMagnitude = new Float32Array(pixels);
  for (let i = 0; i < pixels; i++) {
    const nx = sample(normal, i, 0) * 2 - 1;
    let ny = sample(normal, i, 1) * 2 - 1;
    if (resolved.normalFlipG) ny = -ny;
    const nz = Math.max(0.2, sample(normal, i, 2) * 2 - 1);
    const sx = nx / nz;
    const sy = ny / nz;
    slopeX[i] = sx;
    slopeY[i] = sy;
    slopeMagnitude[i] = Math.max(Math.abs(sx), Math.abs(sy));
  }
  slopeMagnitude.sort();
  const p99 = slopeMagnitude[Math.min(pixels - 1, Math.floor(pixels * 0.99))] ?? 0;
  const slopeScale = Math.max(0.5, Math.min(4, Math.ceil(p99 * 2) / 2));

  const albedoData = Buffer.alloc(pixels * 4);
  const slopeData = Buffer.alloc(pixels * 4);
  let sumR = 0;
  let sumG = 0;
  let sumB = 0;
  const albedoChannels = albedo.info.channels;
  for (let i = 0; i < pixels; i++) {
    const r = sample(albedo, i, 0);
    const g = albedoChannels > 2 ? sample(albedo, i, 1) : r;
    const b = albedoChannels > 2 ? sample(albedo, i, 2) : r;
    sumR += r;
    sumG += g;
    sumB += b;

    const h = height ? sample(height, i, 0) : 0.5;
    const rough = roughness
      ? sample(roughness, i, resolved.roughnessChannel === 'g' ? 1 : 0)
      : 0.9;
    const occ = ao ? sample(ao, i, 0) : 1;

    const o = i * 4;
    albedoData[o] = Math.round(clamp01(r) * 255);
    albedoData[o + 1] = Math.round(clamp01(g) * 255);
    albedoData[o + 2] = Math.round(clamp01(b) * 255);
    albedoData[o + 3] = Math.round(clamp01(h) * 255);

    slopeData[o] = Math.round(clamp01(slopeX[i] / (2 * slopeScale) + 0.5) * 255);
    slopeData[o + 1] = Math.round(clamp01(slopeY[i] / (2 * slopeScale) + 0.5) * 255);
    slopeData[o + 2] = Math.round(clamp01(rough) * 255);
    slopeData[o + 3] = Math.round(clamp01(occ) * 255);
  }

  const outDir = join(PUBLIC_DIR, entry.id);
  mkdirSync(outDir, { recursive: true });
  const albedoPath = join(outDir, 'albedo-height.png');
  const slopePath = join(outDir, 'slope-rough.png');
  await sharp(albedoData, { raw: { width: size, height: size, channels: 4 } })
    .png({ compressionLevel: 9 })
    .toFile(albedoPath);
  await sharp(slopeData, { raw: { width: size, height: size, channels: 4 } })
    .png({ compressionLevel: 9 })
    .toFile(slopePath);

  const albedoPng = readFileSync(albedoPath);
  const slopePng = readFileSync(slopePath);
  const sourceHashes: Record<string, string> = {};
  for (const file of unique.values()) sourceHashes[file.map] = file.md5 ?? md5(source(file));

  return {
    entry,
    slopeScale,
    averageColor: [
      Math.round((sumR / pixels) * 10000) / 10000,
      Math.round((sumG / pixels) * 10000) / 10000,
      Math.round((sumB / pixels) * 10000) / 10000,
    ],
    albedoPng,
    slopePng,
    albedoHash: sha256(albedoPng),
    slopeHash: sha256(slopePng),
    sourceHashes,
    resolved,
  };
}

function outputEntry(packed: PackedMaterial, size: number): Record<string, unknown> {
  const { entry, resolved } = packed;
  const textureScale = entry.textureScale ?? 1;
  if (!(textureScale > 0)) throw new Error(`${entry.id}: textureScale must be positive`);
  return {
    id: entry.id,
    name: entry.name,
    biome: entry.biome,
    role: entry.role,
    tileMeters: entry.tileMeters,
    textureScale,
    projection: entry.projection,
    normalStrength: entry.normalStrength,
    roughness: entry.roughness,
    specular: entry.specular,
    slopeScale: packed.slopeScale,
    averageColor: packed.averageColor,
    albedoHeight: `${entry.id}/albedo-height.png`,
    slopeRough: `${entry.id}/slope-rough.png`,
    hashes: {
      albedoHeight: packed.albedoHash,
      slopeRough: packed.slopeHash,
    },
    source: {
      id: entry.id,
      resolution: '1k',
      maps: {
        albedo: resolved.albedo.map,
        normal: resolved.normal.map,
        height: resolved.height?.map ?? null,
        roughness: resolved.roughness?.map ?? null,
        ao: resolved.ao?.map ?? null,
      },
      hashes: packed.sourceHashes,
    },
    packSize: size,
  };
}

async function bake(options: { force: boolean; only: string | null }): Promise<void> {
  const manifest = JSON.parse(readFileSync(SOURCE_PATH, 'utf8')) as SourceManifest;
  if (manifest.materials.length > 24) {
    throw new Error(`material library has ${manifest.materials.length} entries, cap is 24`);
  }
  const entries = options.only
    ? manifest.materials.filter((m) => m.id === options.only)
    : manifest.materials;
  if (entries.length === 0) throw new Error(`no material matches --only ${options.only}`);

  mkdirSync(PUBLIC_DIR, { recursive: true });
  const outputPath = join(PUBLIC_DIR, 'manifest.json');
  const entriesOut: Record<string, unknown>[] = [];
  if (options.only && existsSync(outputPath)) {
    const previous = JSON.parse(readFileSync(outputPath, 'utf8')) as {
      materials?: Record<string, unknown>[];
    };
    if (Array.isArray(previous.materials)) entriesOut.push(...previous.materials);
  }
  const total = entries.length;
  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i];
    process.stderr.write(`[${i + 1}/${total}] ${entry.id}: resolving maps...\n`);
    const files = await fetchJson<PolyFiles>(`${API}/files/${entry.id}`);
    const packed = await packMaterial(entry, files, manifest.packSize, manifest.sourceResolution, options.force);
    const packedEntry = outputEntry(packed, manifest.packSize);
    if (options.only) {
      const index = entriesOut.findIndex((m) => (m as { id?: string }).id === entry.id);
      if (index >= 0) entriesOut[index] = packedEntry;
      else entriesOut.push(packedEntry);
    } else {
      entriesOut.push(packedEntry);
    }
    process.stderr.write(
      `[${i + 1}/${total}] ${entry.id}: packed (slope ${packed.slopeScale}, `
      + `avg ${packed.averageColor.map((v) => v.toFixed(3)).join(',')})\n`,
    );
  }

  const outManifest = {
    version: 1,
    source: 'polyhaven',
    license: manifest.license,
    attribution: manifest.attribution,
    packSize: manifest.packSize,
    albedoEncoding: 'rgba8-albedo-height',
    slopeEncoding: 'rgba8-slope-rough-ao',
    normalConvention: 'object-space-slope-v+z',
    sourceResolution: manifest.sourceResolution,
    materials: entriesOut,
  };
  writeFileSync(outputPath, `${JSON.stringify(outManifest, null, 2)}\n`);
  process.stderr.write(`Wrote ${outputPath} (${entriesOut.length} materials)\n`);
}

async function checkManifest(): Promise<void> {
  const manifest = JSON.parse(readFileSync(SOURCE_PATH, 'utf8')) as SourceManifest;
  const assets = await fetchJson<Record<string, PolyAsset>>(`${API}/assets?t=textures`);
  let failures = 0;
  for (const entry of manifest.materials) {
    const asset = assets[entry.id];
    if (!asset) {
      process.stderr.write(`FAIL ${entry.id}: not found in /assets\n`);
      failures++;
      continue;
    }
    const tile = asset.dimensions ? asset.dimensions[0] / 1000 : NaN;
    if (!Number.isFinite(tile) || Math.abs(tile - entry.tileMeters) > 0.06) {
      process.stderr.write(`FAIL ${entry.id}: tile ${tile} m, expected ${entry.tileMeters} m\n`);
      failures++;
      continue;
    }
    if (entry.textureScale !== undefined && !(entry.textureScale > 0)) {
      process.stderr.write(`FAIL ${entry.id}: textureScale must be positive\n`);
      failures++;
      continue;
    }
    try {
      const files = await fetchJson<PolyFiles>(`${API}/files/${entry.id}`);
      const resolved = resolveSource(files, entry, manifest.sourceResolution);
      process.stderr.write(
        `ok   ${entry.id}: albedo ${resolved.albedo.map}, normal ${resolved.normal.map}, `
        + `height ${resolved.height?.map ?? 'neutral'}, `
        + `rough ${resolved.roughness?.map ?? 'default'}, ao ${resolved.ao?.map ?? 'default'}, `
        + `tile ${tile.toFixed(2)} m\n`,
      );
    } catch (error) {
      process.stderr.write(`FAIL ${entry.id}: ${error instanceof Error ? error.message : String(error)}\n`);
      failures++;
    }
  }
  if (failures > 0) throw new Error(`${failures} material manifest check(s) failed`);
  process.stderr.write(`Manifest OK: ${manifest.materials.length} materials\n`);
}

const args = process.argv.slice(2);
const onlyIndex = args.indexOf('--only');
const only = onlyIndex >= 0 ? args[onlyIndex + 1] ?? null : null;
const run = args.includes('--check-manifest')
  ? checkManifest()
  : bake({ force: args.includes('--force'), only });
run.catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
