/**
 * Normal map generation from a float heightfield.
 *
 * This is the core of the PoC: we bake the *detailed* surface normals
 * (Sobel-filtered gradient of the high-res heightfield, in real world
 * units) into an RGB texture. The mesh shader then reads this texture
 * per-pixel instead of using interpolated vertex normals.
 *
 * Encoding: object-space normals in the terrain's local frame
 *   R = N.x (east)   G = N.z (south)   B = N.y (up)
 * B "up" keeps the map looking like a classic blue-dominated normal map.
 */

/**
 * @param {Float32Array} heights   res*res, normalised 0..1, row-major (row = +z)
 * @param {number} res             resolution per side
 * @param {number} worldSizeX      world metres covered along x (columns)
 * @param {number} worldSizeZ      world metres covered along z (rows)
 * @param {number} heightScale     world metres for heights going 0 -> 1
 * @returns {Uint8Array} RGBA res*res*4
 */
export function generateNormalMap(heights, res, worldSizeX, worldSizeZ, heightScale) {
  const out = new Uint8Array(res * res * 4);
  const sx = worldSizeX / (res - 1); // metres per pixel along x
  const sz = worldSizeZ / (res - 1); // metres per pixel along z

  // Sobel responses are in normalised height units per (8 * pixel step),
  // so converting to world-units gradient needs heightScale / (8 * spacing).
  const gxScale = heightScale / (8 * sx);
  const gzScale = heightScale / (8 * sz);

  for (let j = 0; j < res; j++) {
    const jm = j > 0 ? j - 1 : 0;
    const jp = j < res - 1 ? j + 1 : res - 1;
    const row = j * res;

    for (let i = 0; i < res; i++) {
      const im = i > 0 ? i - 1 : 0;
      const ip = i < res - 1 ? i + 1 : res - 1;

      const r0 = jm * res; // row j-1
      const r2 = jp * res; // row j+1

      const tl = heights[r0 + im], t = heights[r0 + i], tr = heights[r0 + ip];
      const l = heights[row + im], r = heights[row + ip];
      const bl = heights[r2 + im], b = heights[r2 + i], br = heights[r2 + ip];

      // Sobel X (gradient along columns = world x)
      const gx = (tr + 2 * r + br) - (tl + 2 * l + bl);
      // Sobel Z (gradient along rows = world z)
      const gz = (bl + 2 * b + br) - (tl + 2 * t + tr);

      // Surface y = h(x, z)  ->  N ∝ (-dh/dx, 1, -dh/dz)
      let nx = -gx * gxScale;
      let ny = 1.0;
      let nz = -gz * gzScale;
      const inv = 1.0 / Math.sqrt(nx * nx + ny * ny + nz * nz);
      nx *= inv; ny *= inv; nz *= inv;

      const o = (row + i) * 4;
      out[o] = Math.round((nx * 0.5 + 0.5) * 255);
      out[o + 1] = Math.round((nz * 0.5 + 0.5) * 255);
      out[o + 2] = Math.round((ny * 0.5 + 0.5) * 255);
      out[o + 3] = 255;
    }
  }
  return out;
}

/** Grayscale RGBA preview of the heightfield itself. */
export function heightPreviewRGBA(heights, res) {
  const out = new Uint8Array(res * res * 4);
  for (let i = 0; i < res * res; i++) {
    const v = Math.max(0, Math.min(255, Math.round(heights[i] * 255)));
    out[i * 4] = v; out[i * 4 + 1] = v; out[i * 4 + 2] = v; out[i * 4 + 3] = 255;
  }
  return out;
}
