/**
 * Clipmap geometry.
 *
 * One centre block plus N square rings. Ring L occupies the band
 * [C*S_L, 2C*S_L] and uses vertex spacing S_L = S0*2^L. The ring's outer
 * boundary is at the same world line as ring L+1's inner boundary.
 *
 * Cracks are handled by a separate zero-width stitch strip: the fine loop
 * has two vertices per coarse vertex, and one vertical triangle per coarse
 * segment absorbs the height difference between the fine polyline and the
 * coarse chord. The next ring's inner edge uses exactly the coarse chord
 * vertices, so the seams are watertight.
 *
 * A skirt is attached to every ring's outer loop; it is collapsed for
 * non-last rings (aOuter = 0) and dropped for the final ring (aOuter = 1)
 * to hide the horizon edge.
 */

import * as THREE from 'three';

class Builder {
  constructor() {
    this.positions = [];
    this.stitch = [];
    this.skirt = [];
    this.coarse = [];
    this.indices = [];
    this.map = new Map();
  }

  /** Shared terrain vertex at cell (i,j). */
  vertex(i, j) {
    const key = `${i},${j}`;
    let idx = this.map.get(key);
    if (idx === undefined) {
      idx = this.positions.length / 3;
      this.positions.push(i, 0, j);
      this.stitch.push(0);
      this.skirt.push(0);
      this.coarse.push(0);
      this.map.set(key, idx);
    }
    return idx;
  }

  /** Duplicated vertex for a stitch or skirt face. */
  raw(i, j, stitch, skirt, coarse = 0) {
    const idx = this.positions.length / 3;
    this.positions.push(i, 0, j);
    this.stitch.push(stitch);
    this.skirt.push(skirt);
    this.coarse.push(coarse);
    return idx;
  }

  tri(a, b, c) {
    this.indices.push(a, b, c);
  }
}

function makeGeometry(builder) {
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(builder.positions), 3));
  g.setAttribute('aStitch', new THREE.BufferAttribute(new Float32Array(builder.stitch), 1));
  g.setAttribute('aSkirt', new THREE.BufferAttribute(new Float32Array(builder.skirt), 1));
  g.setAttribute('aCoarse', new THREE.BufferAttribute(new Float32Array(builder.coarse), 1));
  g.setIndex(new THREE.BufferAttribute(new Uint32Array(builder.indices), 1));
  return g;
}

function toInstanced(base, levels, outer) {
  const g = new THREE.InstancedBufferGeometry();
  g.index = base.index;
  for (const name of Object.keys(base.attributes)) {
    g.setAttribute(name, base.attributes[name]);
  }
  g.setAttribute('aLevel', new THREE.InstancedBufferAttribute(new Float32Array(levels), 1));
  g.setAttribute('aOuter', new THREE.InstancedBufferAttribute(new Float32Array(outer), 1));
  g.instanceCount = levels.length;
  return g;
}

/** Solid centre block, half-extent `centerCells` cells. */
export function buildCenterGeometry(centerCells) {
  const C = centerCells;
  const b = new Builder();

  for (let j = -C; j <= C; j++) {
    for (let i = -C; i <= C; i++) b.vertex(i, j);
  }

  for (let j = -C; j < C; j++) {
    for (let i = -C; i < C; i++) {
      const a = b.vertex(i, j);
      const bb = b.vertex(i + 1, j);
      const c = b.vertex(i, j + 1);
      const d = b.vertex(i + 1, j + 1);
      b.tri(a, c, bb);
      b.tri(bb, c, d);
    }
  }

  const g = makeGeometry(b);
  // The shared material reads aLevel/aOuter for every vertex. The centre
  // block is a normal (non-instanced) geometry, so provide constant arrays.
  g.setAttribute('aLevel', new THREE.BufferAttribute(new Float32Array(b.positions.length / 3), 1));
  g.setAttribute('aOuter', new THREE.BufferAttribute(new Float32Array(b.positions.length / 3), 1));
  return g;
}

/** Perimeter loop of the square of radius R, in order, step 1. */
function perimeterLoop(R) {
  const loop = [];
  for (let i = -R; i <= R; i++) loop.push([i, -R]);           // top
  for (let j = -R + 1; j <= R; j++) loop.push([R, j]);        // right
  for (let i = R - 1; i >= -R; i--) loop.push([i, R]);        // bottom
  for (let j = R - 1; j >= -R + 1; j--) loop.push([-R, j]);   // left
  return loop;
}

/**
 * Ring terrain grid + outer skirt.
 * The grid extends to the outer boundary at 2C; its perimeter is stitched
 * separately by buildStitchGeometry().
 */
export function buildRingGeometry(centerCells) {
  const C = centerCells;
  const R = 2 * C;
  const b = new Builder();

  for (let j = -R; j < R; j++) {
    for (let i = -R; i < R; i++) {
      // Skip cells entirely inside the centre hole.
      if (i >= -C && i < C && j >= -C && j < C) continue;

      const a = b.vertex(i, j);
      const bb = b.vertex(i + 1, j);
      const c = b.vertex(i, j + 1);
      const d = b.vertex(i + 1, j + 1);
      b.tri(a, c, bb);
      b.tri(bb, c, d);
    }
  }

  // Outer skirt. Top vertices sit on the ring's outer loop; bottom vertices
  // are dropped in the vertex shader. For non-last rings aOuter=0 collapses
  // the skirt to zero height.
  const loop = perimeterLoop(R);
  for (let k = 0; k < loop.length; k++) {
    const [x0, z0] = loop[k];
    const [x1, z1] = loop[(k + 1) % loop.length];

    const t0 = b.raw(x0, z0, 0, 0);
    const t1 = b.raw(x1, z1, 0, 0);
    const b0 = b.raw(x0, z0, 0, 1);
    const b1 = b.raw(x1, z1, 0, 1);

    // Both windings: the skirt can be seen from either side of a ridge.
    b.tri(t0, t1, b0);
    b.tri(t1, b1, b0);
    b.tri(t0, b0, t1);
    b.tri(t1, b0, b1);
  }

  return makeGeometry(b);
}

/**
 * Zero-width stitch strips for rings 0..LEVELS-2.
 * Each coarse segment spans two fine segments and gets a vertical triangle
 * (plus its reverse winding) that closes the gap between the fine polyline
 * and the coarse chord used by the next ring.
 */
export function buildStitchGeometry(centerCells, levels) {
  const C = centerCells;
  const R = 2 * C;
  const loop = perimeterLoop(R);
  const b = new Builder();

  for (let k = 0; k < loop.length; k += 2) {
    const [x0, z0] = loop[k];
    const [x1, z1] = loop[(k + 1) % loop.length];
    const [x2, z2] = loop[(k + 2) % loop.length];

    // Fine edge: matches ring L's outer boundary and samples layer L.
    const f0 = b.raw(x0, z0, 1, 0, 0);
    const f1 = b.raw(x1, z1, 1, 0, 0);
    const f2 = b.raw(x2, z2, 1, 0, 0);

    // Coarse chord: matches ring L+1's inner boundary and samples layer L+1.
    // The position is still scaled by ring L's spacing; only the height fetch
    // and its tile-cache mapping use the coarse level.
    const c0 = b.raw(x0, z0, 1, 0, 1);
    const c2 = b.raw(x2, z2, 1, 0, 1);

    // Three-triangle 2:1 stitch; both windings so either slope is visible.
    b.tri(f0, c0, f1);
    b.tri(f1, c0, c2);
    b.tri(f1, c2, f2);
    b.tri(f0, f1, c0);
    b.tri(f1, c2, c0);
    b.tri(f1, f2, c2);
  }

  const base = makeGeometry(b);
  const innerLevels = Array.from({ length: Math.max(0, levels - 1) }, (_, i) => i);
  return toInstanced(base, innerLevels, new Array(innerLevels.length).fill(0));
}

/** Instanced rings for all levels; the last instance gets a real skirt. */
export function buildRingInstances(centerCells, levels) {
  const base = buildRingGeometry(centerCells);
  const levelValues = Array.from({ length: levels }, (_, i) => i);
  const outer = levelValues.map((level) => (level === levels - 1 ? 1 : 0));
  return toInstanced(base, levelValues, outer);
}
