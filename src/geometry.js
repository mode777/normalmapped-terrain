/**
 * Terrain mesh builder: a regular grid displaced by bilinear sampling of
 * the heightfield. Vertex normals come straight from
 * geometry.computeVertexNormals() — i.e. exactly what you would get
 * "out of the box" in three.js. Mode A of the PoC shades with these;
 * mode B ignores them and reads the baked normal map instead.
 */

import * as THREE from 'three';
import { sampleHeight } from './terrain-data.js';

/**
 * @returns {{geometry: THREE.BufferGeometry, triangles: number}}
 */
export function buildTerrainGeometry(dataset, segments) {
  const n = segments + 1;
  const positions = new Float32Array(n * n * 3);
  const uvs = new Float32Array(n * n * 2);
  const sx = dataset.worldSizeX / segments;
  const sz = dataset.worldSizeZ / segments;

  for (let j = 0; j < n; j++) {
    const v = j / segments;
    for (let i = 0; i < n; i++) {
      const u = i / segments;
      const idx = j * n + i;
      positions[idx * 3] = (u - 0.5) * dataset.worldSizeX;
      positions[idx * 3 + 1] = sampleHeight(dataset.heights, dataset.res, u, v) * dataset.heightScale;
      positions[idx * 3 + 2] = (v - 0.5) * dataset.worldSizeZ;
      uvs[idx * 2] = u;
      uvs[idx * 2 + 1] = v;
    }
  }

  const indices = new Uint32Array(segments * segments * 6);
  let o = 0;
  for (let j = 0; j < segments; j++) {
    for (let i = 0; i < segments; i++) {
      const a = j * n + i;
      const b = a + 1;
      const c = a + n;
      const d = c + 1;
      indices[o++] = a; indices[o++] = c; indices[o++] = b;
      indices[o++] = b; indices[o++] = c; indices[o++] = d;
    }
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geometry.setAttribute('uv', new THREE.BufferAttribute(uvs, 2));
  geometry.setIndex(new THREE.BufferAttribute(indices, 1));
  geometry.computeVertexNormals(); // <- the baseline this PoC argues against

  return { geometry, triangles: segments * segments * 2 };
}
