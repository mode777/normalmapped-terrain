/**
 * Clipmap geometry.
 *
 * One centre block plus N square rings. Ring L occupies the band
 * [C*S_L, 2C*S_L] around its own snapped origin, with vertex spacing
 * S_L = S0*2^L.
 *
 * Origins are snapped per level (see origins.js), so neighbouring rings are
 * not exactly concentric: the finer ring can be off-centre by up to half a
 * coarse cell. Two things absorb that:
 *
 *   - every ring above level 0 is built one cell wider (hole at C-1) than
 *     the nominal boundary, so it always overlaps the ring inside it, and the
 *     fragment shader clips it back to the parent's outer square;
 *   - the level-0 ring shares the centre block's lattice, so it abuts the
 *     centre exactly and is not clipped at all.
 *
 * The outer band of each ring morphs to the next-coarse height (shaders.js),
 * so the two sides of that boundary describe the same surface even though
 * the rings snap at different times.
 *
 * A skirt is attached to every ring's outer loop; it is collapsed for
 * non-last rings (aOuter = 0) and dropped for the final ring (aOuter = 1)
 * to hide the horizon edge.
 */

import * as THREE from 'three';

class Builder {
  constructor() {
    this.positions = [];
    this.skirt = [];
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
      this.skirt.push(0);
      this.map.set(key, idx);
    }
    return idx;
  }

  /** Duplicated vertex for a skirt face. */
  raw(i, j, skirt) {
    const idx = this.positions.length / 3;
    this.positions.push(i, 0, j);
    this.skirt.push(skirt);
    return idx;
  }

  tri(a, b, c) {
    this.indices.push(a, b, c);
  }
}

function makeGeometry(builder) {
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(builder.positions), 3));
  g.setAttribute('aSkirt', new THREE.BufferAttribute(new Float32Array(builder.skirt), 1));
  g.setIndex(new THREE.BufferAttribute(new Uint32Array(builder.indices), 1));
  return g;
}

/**
 * Instances a flat footprint. Every instance carries its own snapped level
 * origin, the origin of the level inside it (used to clip the ring to the
 * parent's outer square) and the next coarser origin (the morph target).
 * All three are refreshed each frame.
 */
function toInstanced(base, levels, outer, trim) {
  const g = new THREE.InstancedBufferGeometry();
  g.index = base.index;
  for (const name of Object.keys(base.attributes)) {
    g.setAttribute(name, base.attributes[name]);
  }
  g.setAttribute('aLevel', new THREE.InstancedBufferAttribute(new Float32Array(levels), 1));
  g.setAttribute('aOuter', new THREE.InstancedBufferAttribute(new Float32Array(outer), 1));
  g.setAttribute('aTrim', new THREE.InstancedBufferAttribute(new Float32Array(trim), 1));

  const origins = new THREE.InstancedBufferAttribute(new Float32Array(levels.length * 2), 2);
  const parents = new THREE.InstancedBufferAttribute(new Float32Array(levels.length * 2), 2);
  const coarser = new THREE.InstancedBufferAttribute(new Float32Array(levels.length * 2), 2);
  origins.setUsage(THREE.DynamicDrawUsage);
  parents.setUsage(THREE.DynamicDrawUsage);
  coarser.setUsage(THREE.DynamicDrawUsage);
  g.setAttribute('aOrigin', origins);
  g.setAttribute('aParentOrigin', parents);
  g.setAttribute('aCoarseOrigin', coarser);

  g.instanceCount = levels.length;
  return g;
}

/** Solid centre block, half-extent `centerCells` cells, one instance at LOD 0. */
export function buildCenterInstances(centerCells) {
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

  return toInstanced(makeGeometry(b), [0], [0], [0]);
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
 *
 * `holeCells` is where the ring's inner edge sits, in this ring's cells.
 * Rings that touch a *different* lattice (every level above 0) use C-1 so
 * they still cover the parent square when the two origins are off by half a
 * coarse cell. The level-0 ring shares the centre block's exact lattice, so
 * it uses C and abuts it with no clipping at all.
 */
export function buildRingGeometry(centerCells, holeCells) {
  const C = centerCells;
  const H = holeCells;
  const R = 2 * C;
  const b = new Builder();

  for (let j = -R; j < R; j++) {
    for (let i = -R; i < R; i++) {
      // Skip cells entirely inside the centre hole.
      if (i >= -H && i < H && j >= -H && j < H) continue;

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

    const t0 = b.raw(x0, z0, 0);
    const t1 = b.raw(x1, z1, 0);
    const b0 = b.raw(x0, z0, 1);
    const b1 = b.raw(x1, z1, 1);

    // Both windings: the skirt can be seen from either side of a ridge.
    b.tri(t0, t1, b0);
    b.tri(t1, b1, b0);
    b.tri(t0, b0, t1);
    b.tri(t1, b0, b1);
  }

  return makeGeometry(b);
}

/**
 * Instances one ring footprint for a list of LODs.
 *
 * `trim` enables the fragment-shader clip to the parent square; only the
 * level-0 ring leaves it off (it abuts the centre block on the same lattice).
 */
export function buildRingInstances(centerCells, levelList, {
  hole = centerCells - 1,
  trim = 1,
  outerLevel = -1,
} = {}) {
  const base = buildRingGeometry(centerCells, hole);
  const outer = levelList.map((level) => (level === outerLevel ? 1 : 0));
  return toInstanced(base, levelList, outer, levelList.map(() => trim));
}
