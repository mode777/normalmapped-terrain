/**
 * Whole-window material stack loader.
 *
 * The stack is a pair of world-space 2D maps plus a macro albedo:
 *   IDs      RGBA8: four material library indices per texel (nearest)
 *   weights  RGBA8: four normalized weights per texel (linear + mips)
 *   macro    RGBA8: low-frequency far-field albedo (sRGB + mips)
 *
 * The maps are sampled in world space with an absolute-render-origin offset,
 * so floating-origin rebases do not shift the distribution.
 */

import * as THREE from 'three';
import type { MaterialLibrary } from './materials.ts';

export interface MaterialStackPalette {
  id: string;
  slots: [string, string, string, string];
}

export interface MaterialStackTransition {
  from: string;
  to: string;
  slots: [string, string, string, string];
  width: number;
}

export interface MaterialStackManifest {
  library: string;
  /** Legacy/default palette; per-texel IDs are authoritative when palettes exist. */
  slots: [string, string, string, string];
  palettes?: MaterialStackPalette[];
  transitions?: MaterialStackTransition[];
  stack: {
    ids: string;
    weights: string;
    size: number;
    extent: number;
    encoding: 'rgba8-ids-weights';
  };
  macro: string;
  macroSize: number;
  macroEncoding: 'rgba8';
  bakeVersion: number;
  seed: number;
  hashes: {
    ids: string;
    weights: string;
    macro: string;
  };
}

export interface MaterialStack {
  block: MaterialStackManifest;
  ids: THREE.Texture;
  weights: THREE.Texture;
  macro: THREE.Texture;
  slotIndices: [number, number, number, number];
  size: number;
  extent: number;
  macroSize: number;
  /** UV offset for a render-space position; pass the absolute render origin. */
  uvOffset(originX: number, originZ: number): { x: number; y: number };
  dispose(): void;
}

function loadTexture(
  url: string,
  configure: (texture: THREE.Texture) => void,
): Promise<THREE.Texture> {
  return new Promise((resolve, reject) => {
    new THREE.TextureLoader().load(
      url,
      (texture) => {
        configure(texture);
        texture.needsUpdate = true;
        resolve(texture);
      },
      undefined,
      (error: unknown) => {
        const message = error instanceof Error ? error.message : String(error);
        reject(new Error(`material stack texture failed: ${url}: ${message}`));
      },
    );
  });
}

function validateBlock(block: MaterialStackManifest, library: MaterialLibrary): void {
  if (block.stack.encoding !== 'rgba8-ids-weights') {
    throw new Error(`unsupported material stack encoding ${block.stack.encoding}`);
  }
  if (!(block.stack.size > 0) || !(block.macroSize > 0) || !(block.stack.extent > 0)) {
    throw new Error('material stack dimensions must be positive');
  }
  if (block.stack.size > 4096 || block.macroSize > 4096) {
    throw new Error('material stack/macro exceeds the 4096 texel budget');
  }
  if (block.slots.length !== 4) throw new Error('material stack must have four slots');
  if (new Set(block.slots).size !== 4) throw new Error('material stack slots are not unique');
  for (const id of block.slots) library.indexOf(id);
  for (const palette of block.palettes ?? []) {
    if (!palette.id) throw new Error('material palette is missing an id');
    if (palette.slots.length !== 4) {
      throw new Error(`material palette ${palette.id} must have four slots`);
    }
    if (new Set(palette.slots).size !== 4) {
      throw new Error(`material palette ${palette.id} slots are not unique`);
    }
    for (const id of palette.slots) library.indexOf(id);
  }
  for (const transition of block.transitions ?? []) {
    if (!transition.from || !transition.to) {
      throw new Error('material transition is missing a region id');
    }
    if (transition.slots.length !== 4) {
      throw new Error(
        `material transition ${transition.from}->${transition.to} must have four slots`,
      );
    }
    if (new Set(transition.slots).size !== 4) {
      throw new Error(`material transition ${transition.from}->${transition.to} slots are not unique`);
    }
    if (!(transition.width > 0)) {
      throw new Error(`material transition ${transition.from}->${transition.to} has invalid width`);
    }
    for (const id of transition.slots) library.indexOf(id);
  }
}

export async function loadMaterialStack(
  manifestUrl: string,
  block: MaterialStackManifest,
  library: MaterialLibrary,
  renderer: THREE.WebGLRenderer,
): Promise<MaterialStack> {
  validateBlock(block, library);
  const anisotropy = Math.min(4, Math.max(1, renderer.capabilities.getMaxAnisotropy()));
  const absolute = (path: string): string => new URL(path, manifestUrl).toString();

  const [ids, weights, macro] = await Promise.all([
    loadTexture(absolute(block.stack.ids), (texture) => {
      texture.colorSpace = THREE.NoColorSpace;
      texture.wrapS = THREE.ClampToEdgeWrapping;
      texture.wrapT = THREE.ClampToEdgeWrapping;
      texture.magFilter = THREE.NearestFilter;
      texture.minFilter = THREE.NearestFilter;
      texture.generateMipmaps = false;
      texture.flipY = false;
      texture.anisotropy = 1;
    }),
    loadTexture(absolute(block.stack.weights), (texture) => {
      texture.colorSpace = THREE.NoColorSpace;
      texture.wrapS = THREE.ClampToEdgeWrapping;
      texture.wrapT = THREE.ClampToEdgeWrapping;
      texture.magFilter = THREE.LinearFilter;
      texture.minFilter = THREE.LinearMipmapLinearFilter;
      texture.generateMipmaps = true;
      texture.flipY = false;
      texture.anisotropy = anisotropy;
    }),
    loadTexture(absolute(block.macro), (texture) => {
      texture.colorSpace = THREE.SRGBColorSpace;
      texture.wrapS = THREE.ClampToEdgeWrapping;
      texture.wrapT = THREE.ClampToEdgeWrapping;
      texture.magFilter = THREE.LinearFilter;
      texture.minFilter = THREE.LinearMipmapLinearFilter;
      texture.generateMipmaps = true;
      texture.flipY = false;
      texture.anisotropy = anisotropy;
    }),
  ]);

  const slotIndices: [number, number, number, number] = [
    library.indexOf(block.slots[0]),
    library.indexOf(block.slots[1]),
    library.indexOf(block.slots[2]),
    library.indexOf(block.slots[3]),
  ];

  return {
    block,
    ids,
    weights,
    macro,
    slotIndices,
    size: block.stack.size,
    extent: block.stack.extent,
    macroSize: block.macroSize,
    uvOffset(originX: number, originZ: number): { x: number; y: number } {
      return { x: originX / block.stack.extent, y: originZ / block.stack.extent };
    },
    dispose(): void {
      ids.dispose();
      weights.dispose();
      macro.dispose();
    },
  };
}
