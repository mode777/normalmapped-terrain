#!/usr/bin/env node
/**
 * Validate the checked-in packed material library.
 *
 * Checks the 24-material cap, required metadata, PNG dimensions, SHA-256
 * hashes, physical tile sizes and the source map record. The packed files are
 * what the runtime loads, so this is the gate for a stale or hand-edited pack.
 */

import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { PNG } from 'pngjs';

interface MaterialSource {
  id: string;
  resolution: string;
  maps: {
    albedo: string;
    normal: string;
    height: string | null;
    roughness: string | null;
    ao: string | null;
  };
  hashes: Record<string, string>;
}

interface MaterialEntry {
  id: string;
  name: string;
  biome: string;
  role: string;
  tileMeters: number;
  projection: 'planar' | 'triplanar';
  normalStrength: number;
  roughness: number;
  specular: number;
  slopeScale: number;
  averageColor: [number, number, number];
  albedoHeight: string;
  slopeRough: string;
  hashes: { albedoHeight: string; slopeRough: string };
  source: MaterialSource;
  packSize: number;
}

interface MaterialManifest {
  version: number;
  source: string;
  license: string;
  attribution: string;
  packSize: number;
  albedoEncoding: string;
  slopeEncoding: string;
  normalConvention: string;
  sourceResolution: string;
  materials: MaterialEntry[];
}

const sha256 = (buffer: Buffer): string => createHash('sha256').update(buffer).digest('hex');
const isFiniteNumber = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const isHex64 = (v: unknown): v is string => typeof v === 'string' && /^[0-9a-f]{64}$/.test(v);

function validate(root: string, manifestPath: string): string[] {
  const errors: string[] = [];
  if (!existsSync(manifestPath)) return [`missing manifest: ${manifestPath}`];
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as MaterialManifest;

  if (manifest.version !== 1) errors.push(`manifest: version ${manifest.version}, expected 1`);
  if (manifest.packSize !== 512) errors.push(`manifest: packSize ${manifest.packSize}, expected 512`);
  if (!Array.isArray(manifest.materials)) return [...errors, 'manifest: materials is not an array'];
  if (manifest.materials.length > 24) {
    errors.push(`manifest: ${manifest.materials.length} materials exceeds the 24 cap`);
  }
  if (manifest.materials.length !== 20) {
    errors.push(`manifest: ${manifest.materials.length} materials, expected 20`);
  }
  if (!manifest.license) errors.push('manifest: missing license');
  if (!manifest.attribution) errors.push('manifest: missing attribution');

  const seen = new Set<string>();
  for (const entry of manifest.materials) {
    const prefix = `material ${entry.id ?? '<missing id>'}`;
    if (!entry.id) { errors.push(`${prefix}: missing id`); continue; }
    if (seen.has(entry.id)) errors.push(`${prefix}: duplicate id`);
    seen.add(entry.id);
    if (!entry.name) errors.push(`${prefix}: missing name`);
    if (!entry.biome) errors.push(`${prefix}: missing biome`);
    if (!entry.role) errors.push(`${prefix}: missing role`);
    if (!isFiniteNumber(entry.tileMeters) || entry.tileMeters < 0.5 || entry.tileMeters > 100) {
      errors.push(`${prefix}: tileMeters ${String(entry.tileMeters)} outside 0.5..100`);
    }
    if (entry.projection !== 'planar' && entry.projection !== 'triplanar') {
      errors.push(`${prefix}: projection ${String(entry.projection)}`);
    }
    for (const key of ['normalStrength', 'roughness', 'specular', 'slopeScale'] as const) {
      if (!isFiniteNumber(entry[key]) || entry[key] < 0) errors.push(`${prefix}: ${key} invalid`);
    }
    if (!Array.isArray(entry.averageColor) || entry.averageColor.length !== 3
      || entry.averageColor.some((v) => !isFiniteNumber(v) || v < 0 || v > 1)) {
      errors.push(`${prefix}: averageColor invalid`);
    }
    if (!entry.source || entry.source.id !== entry.id) errors.push(`${prefix}: source.id mismatch`);
    if (!entry.source?.maps?.albedo) errors.push(`${prefix}: source.maps.albedo missing`);
    if (!entry.source?.maps?.normal) errors.push(`${prefix}: source.maps.normal missing`);
    if (!entry.source?.hashes || Object.keys(entry.source.hashes).length === 0) {
      errors.push(`${prefix}: source.hashes missing`);
    }

    for (const [fileKey, hashKey] of [
      ['albedoHeight', 'albedoHeight'],
      ['slopeRough', 'slopeRough'],
    ] as const) {
      const relative = entry[fileKey];
      if (!relative) { errors.push(`${prefix}: ${fileKey} path missing`); continue; }
      const filePath = join(root, relative);
      if (!existsSync(filePath)) { errors.push(`${prefix}: ${fileKey} missing (${relative})`); continue; }
      const buffer = readFileSync(filePath);
      const png = PNG.sync.read(buffer);
      if (png.width !== 512 || png.height !== 512) {
        errors.push(`${prefix}: ${fileKey} is ${png.width}x${png.height}, expected 512x512`);
      }
      if (png.data.length !== 512 * 512 * 4) {
        errors.push(`${prefix}: ${fileKey} is not RGBA8 (${png.data.length} bytes)`);
      }
      const expected = entry.hashes?.[hashKey];
      if (!isHex64(expected)) errors.push(`${prefix}: hashes.${hashKey} invalid`);
      else if (sha256(buffer) !== expected) errors.push(`${prefix}: hashes.${hashKey} mismatch`);
    }
  }

  return errors;
}

const args = process.argv.slice(2);
const manifestIndex = args.indexOf('--manifest');
const defaultRoot = join(process.cwd(), 'public/materials');
const manifestPath = manifestIndex >= 0
  ? args[manifestIndex + 1] ?? join(defaultRoot, 'manifest.json')
  : join(defaultRoot, 'manifest.json');
const rootIndex = args.indexOf('--root');
const root = rootIndex >= 0 ? args[rootIndex + 1] ?? dirname(manifestPath) : dirname(manifestPath);

const errors = validate(root, manifestPath);
if (errors.length > 0) {
  for (const error of errors) console.error(`FAIL ${error}`);
  process.exitCode = 1;
} else {
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as MaterialManifest;
  const bytes = manifest.materials.reduce((sum, entry) => {
    return sum + readFileSync(join(root, entry.albedoHeight)).length
      + readFileSync(join(root, entry.slopeRough)).length;
  }, 0);
  console.log(
    `material library OK: ${manifest.materials.length} materials, `
    + `${(bytes / 1024 / 1024).toFixed(1)} MiB packed`,
  );
}
