/**
 * Packed material library loader.
 *
 * The library is two RGBA8 texture arrays, one layer per material:
 *   albedoHeight  RGB sRGB albedo + A normalized height
 *   slopeRough    RG object-space slope + B roughness + A ambient occlusion
 *
 * The arrays are standalone (not an atlas), so mips and repeat wrapping are
 * valid. The loader validates the 24-material cap before allocating.
 */

import * as THREE from 'three';

export type MaterialProjection = 'planar' | 'triplanar';

export interface MaterialManifestEntry {
  id: string;
  name: string;
  biome: string;
  role: string;
  tileMeters: number;
  projection: MaterialProjection;
  normalStrength: number;
  roughness: number;
  specular: number;
  slopeScale: number;
  averageColor: [number, number, number];
  albedoHeight: string;
  slopeRough: string;
  hashes: { albedoHeight: string; slopeRough: string };
  source: {
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
  };
  packSize: number;
}

export interface MaterialManifest {
  version: number;
  source: string;
  license: string;
  attribution: string;
  packSize: number;
  albedoEncoding: string;
  slopeEncoding: string;
  normalConvention: string;
  sourceResolution: string;
  materials: MaterialManifestEntry[];
}

export interface MaterialLibrary {
  manifest: MaterialManifest;
  entries: readonly MaterialManifestEntry[];
  albedoHeight: THREE.DataArrayTexture;
  slopeRough: THREE.DataArrayTexture;
  count: number;
  indexOf(id: string): number;
  averageColor(index: number): [number, number, number];
  dispose(): void;
}

const MAX_MATERIALS = 24;

function isPowerOfTwo(value: number): boolean {
  return value > 0 && (value & (value - 1)) === 0;
}

function validateManifest(manifest: MaterialManifest): void {
  if (manifest.version !== 1) throw new Error(`unsupported material manifest version ${manifest.version}`);
  if (!isPowerOfTwo(manifest.packSize) || manifest.packSize < 64 || manifest.packSize > 2048) {
    throw new Error(`invalid material pack size ${manifest.packSize}`);
  }
  if (!Array.isArray(manifest.materials) || manifest.materials.length === 0) {
    throw new Error('material manifest has no materials');
  }
  if (manifest.materials.length > MAX_MATERIALS) {
    throw new Error(`material library has ${manifest.materials.length} entries, cap is ${MAX_MATERIALS}`);
  }
  const seen = new Set<string>();
  for (const entry of manifest.materials) {
    if (!entry.id) throw new Error('material entry is missing an id');
    if (seen.has(entry.id)) throw new Error(`duplicate material id ${entry.id}`);
    seen.add(entry.id);
    if (!entry.albedoHeight || !entry.slopeRough) {
      throw new Error(`material ${entry.id} is missing a packed texture path`);
    }
    if (!(entry.tileMeters > 0)) throw new Error(`material ${entry.id} has an invalid tile size`);
    if (!(entry.slopeScale > 0)) throw new Error(`material ${entry.id} has an invalid slope scale`);
    if (entry.projection !== 'planar' && entry.projection !== 'triplanar') {
      throw new Error(`material ${entry.id} has an invalid projection`);
    }
    if (!Array.isArray(entry.averageColor) || entry.averageColor.length !== 3) {
      throw new Error(`material ${entry.id} is missing an average color`);
    }
    if (entry.packSize !== undefined && entry.packSize !== manifest.packSize) {
      throw new Error(`material ${entry.id} pack size does not match the manifest`);
    }
  }
}

async function loadLayerData(url: string, size: number): Promise<Uint8ClampedArray> {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`material texture HTTP ${response.status}: ${url}`);
  const bitmap = await createImageBitmap(await response.blob());
  try {
    if (bitmap.width !== size || bitmap.height !== size) {
      throw new Error(`material texture is ${bitmap.width}x${bitmap.height}, expected ${size}: ${url}`);
    }
    const canvas = new OffscreenCanvas(size, size);
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('OffscreenCanvas 2D context unavailable');
    ctx.drawImage(bitmap, 0, 0);
    return ctx.getImageData(0, 0, size, size).data;
  } finally {
    bitmap.close();
  }
}

export async function loadMaterialLibrary(
  manifestUrl: string,
  renderer: THREE.WebGLRenderer,
  onProgress?: (done: number, total: number) => void,
): Promise<MaterialLibrary> {
  const response = await fetch(manifestUrl);
  if (!response.ok) throw new Error(`material manifest HTTP ${response.status}: ${manifestUrl}`);
  const manifest = await response.json() as MaterialManifest;
  validateManifest(manifest);

  const size = manifest.packSize;
  const count = manifest.materials.length;
  const layerBytes = size * size * 4;
  const albedoData = new Uint8Array(layerBytes * count);
  const slopeData = new Uint8Array(layerBytes * count);

  for (let i = 0; i < count; i++) {
    const entry = manifest.materials[i];
    if (!entry) throw new Error(`material ${i} is missing`);
    const albedoUrl = new URL(entry.albedoHeight, manifestUrl).toString();
    const slopeUrl = new URL(entry.slopeRough, manifestUrl).toString();
    let albedo: Uint8ClampedArray;
    let slope: Uint8ClampedArray;
    try {
      [albedo, slope] = await Promise.all([
        loadLayerData(albedoUrl, size),
        loadLayerData(slopeUrl, size),
      ]);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`material ${entry.id}: ${message}`);
    }
    albedoData.set(albedo, i * layerBytes);
    slopeData.set(slope, i * layerBytes);
    onProgress?.(i + 1, count);
  }

  const anisotropy = Math.min(8, Math.max(1, renderer.capabilities.getMaxAnisotropy()));
  const makeArray = (data: Uint8Array<ArrayBuffer>, colorSpace: THREE.ColorSpace): THREE.DataArrayTexture => {
    const texture = new THREE.DataArrayTexture(data, size, size, count);
    texture.format = THREE.RGBAFormat;
    texture.type = THREE.UnsignedByteType;
    texture.colorSpace = colorSpace;
    texture.wrapS = THREE.RepeatWrapping;
    texture.wrapT = THREE.RepeatWrapping;
    texture.magFilter = THREE.LinearFilter;
    texture.minFilter = THREE.LinearMipmapLinearFilter;
    texture.generateMipmaps = true;
    texture.anisotropy = anisotropy;
    texture.flipY = false;
    texture.needsUpdate = true;
    renderer.initTexture(texture);
    // Tiles are uploaded; free the CPU copy. The GPU keeps the array and mips.
    (texture.image as { data: Uint8Array | null }).data = null;
    return texture;
  };

  const albedoHeight = makeArray(albedoData, THREE.SRGBColorSpace);
  const slopeRough = makeArray(slopeData, THREE.NoColorSpace);
  const byId = new Map(manifest.materials.map((entry, index) => [entry.id, index]));

  return {
    manifest,
    entries: manifest.materials,
    albedoHeight,
    slopeRough,
    count,
    indexOf(id: string): number {
      const index = byId.get(id);
      if (index === undefined) throw new Error(`material ${id} is not in the library`);
      return index;
    },
    averageColor(index: number): [number, number, number] {
      return manifest.materials[index]?.averageColor ?? [0.5, 0.5, 0.5];
    },
    dispose(): void {
      albedoHeight.dispose();
      slopeRough.dispose();
    },
  };
}
